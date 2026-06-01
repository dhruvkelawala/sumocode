import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isInCmux,
	openCommandInNewSplitWithRefs,
	type SplitDirection as CmuxSplitDirection,
} from "../commands/cmux-split.js";
import {
	type BackgroundTask,
	type BackgroundTaskSnapshot,
	type BackgroundTaskThinking,
	type SpawnBackgroundTaskOptions,
	toBackgroundTaskSnapshot,
} from "./task-types.js";
import {
	buildVisibleTaskCommand,
	buildVisibleTaskPaths,
	buildVisibleTaskScript,
	parseExitMarkerLine,
	readExitCodeFromFile,
	shellEscape as shellEscapeForBash,
} from "./visible-spawn.js";

const POLL_INTERVAL_MS = 500;
const RESPONSE_POLL_INTERVAL_MS = 750;
const DEFAULT_VISIBLE_DIRECTION: CmuxSplitDirection = "right";
export const DEFAULT_SUMOCODE_AGENT_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_SUMOCODE_AGENT_THINKING: BackgroundTaskThinking = "low";
const AGENT_MODEL_ENV = "SUMOCODE_BG_AGENT_MODEL";
const AGENT_THINKING_ENV = "SUMOCODE_BG_AGENT_THINKING";
const THINKING_LEVELS = new Set<BackgroundTaskThinking>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/** Max grace period before stopTask escalates SIGTERM to SIGKILL. */
const STOP_SIGTERM_GRACE_MS = 5_000;
/** Default upper bound on agent-runner response.md harvest before failing. */
const DEFAULT_AGENT_WATCHDOG_MS = 10 * 60 * 1000; // 10 minutes
/** Bounded tail-read for poll/harvest — avoids O(file_size) re-reads. */
const LOG_TAIL_READ_BYTES = 16 * 1024;

interface InternalTask extends BackgroundTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	responseTimer?: ReturnType<typeof setInterval>;
	watchdogDeadline?: number;
	/**
	 * Promise that resolves once the visible-spawn coroutine finishes (success
	 * OR caught failure). `stopTask` awaits this so it can never finalize a task
	 * while a `new-split`/`respawn-pane` is still in flight — otherwise the
	 * stopped-then-launched race leaves a runaway pane.
	 */
	spawnPromise?: Promise<void>;
	stopRequested?: boolean;
	finalized?: boolean;
}

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: "cmd.exe", args: ["/d", "/s", "/c"] };
	}
	return { shell: "/bin/bash", args: ["-lc"] };
}

function summarizeStatus(task: Pick<BackgroundTask, "status" | "exitCode">): string {
	if (task.status === "running") return "running";
	if (task.status === "stopped") return "stopped";
	if (task.exitCode === 0) return "completed";
	return "failed";
}

function normalizeThinking(value: string | undefined): BackgroundTaskThinking | undefined {
	if (!value) return undefined;
	const normalized = value.trim() as BackgroundTaskThinking;
	return THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function resolveAgentModel(runner: BackgroundTask["runner"], model: string | undefined): string | undefined {
	if (runner !== "sumocode") return model?.trim() || undefined;
	return model?.trim() || process.env[AGENT_MODEL_ENV]?.trim() || DEFAULT_SUMOCODE_AGENT_MODEL;
}

function resolveAgentThinking(
	runner: BackgroundTask["runner"],
	thinking: BackgroundTaskThinking | undefined,
): BackgroundTaskThinking | undefined {
	if (runner !== "sumocode") return thinking;
	return thinking ?? normalizeThinking(process.env[AGENT_THINKING_ENV]) ?? DEFAULT_SUMOCODE_AGENT_THINKING;
}

function appendLogLine(logFile: string, line: string): void {
	writeFileSync(logFile, line, { flag: "a" });
}

/**
 * Read the tail of `logFile` without slurping the whole file.
 *
 * Visible shell tasks emit unbounded output and the poll loop runs every
 * 500ms. A naive `readFileSync` of multi-MB build logs would spike CPU/IO
 * and block the event loop. Instead, stat the file and seek to the last
 * `maxBytes`, returning only that region. Newline-trim the leading slice
 * to avoid surfacing a half-line at the top.
 */
function readLogTail(logFile: string, maxBytes = LOG_TAIL_READ_BYTES): string {
	if (!existsSync(logFile)) return "";
	let fd: number | null = null;
	try {
		const { size } = statSync(logFile);
		if (size === 0) return "";
		const readSize = Math.min(size, maxBytes);
		const offset = size - readSize;
		fd = openSync(logFile, "r");
		const buf = Buffer.allocUnsafe(readSize);
		readSync(fd, buf, 0, readSize, offset);
		let text = buf.toString("utf8");
		if (offset > 0) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline !== -1 && firstNewline < text.length - 1) {
				text = text.slice(firstNewline + 1);
			}
		}
		return text;
	} catch {
		// Fall back to a tiny full-read on stat/read failure (e.g. file truncated
		// between stat and open).
		try {
			return readFileSync(logFile, "utf8").slice(-maxBytes);
		} catch {
			return "";
		}
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}



/**
 * Persist the task snapshot as `meta.json` next to the log/exit files.
 *
 * Each spawn already owns a private directory under `$TMPDIR/sumocode-bg/`,
 * so dropping a snapshot file there lets external tools (a future `/bg-tail`,
 * a sidebar widget, a recovery command after `/reload`) discover live tasks
 * without depending on a running SumoCode session. Best-effort — swallow
 * any write error so a transient FS issue never crashes the spawn path.
 */
function writeTaskMeta(task: BackgroundTask): void {
	if (!task.metaFile) return;
	try {
		writeFileSync(task.metaFile, `${JSON.stringify(toBackgroundTaskSnapshot(task), null, 2)}\n`);
	} catch {
		// best-effort — meta.json is observational, not load-bearing
	}
}

export class BackgroundTaskManager {
	private tasks = new Map<string, InternalTask>();
	private counter = 0;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	listTasks(): BackgroundTaskSnapshot[] {
		return [...this.tasks.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.map(toBackgroundTaskSnapshot);
	}

	findTask(id?: string, pid?: number): InternalTask | undefined {
		if (id) {
			return this.tasks.get(id);
		}
		if (pid != null) {
			return [...this.tasks.values()].find((task) => task.pid === pid);
		}
		return undefined;
	}

	getTaskOutput(task: BackgroundTask, maxChars = 10_000): string {
		return readLogTail(task.logFile, maxChars);
	}

	formatTaskListText(): string {
		const tasks = this.listTasks();
		if (tasks.length === 0) {
			return "No background tasks tracked.";
		}
		return tasks
			.map((task) => {
				const label = task.title ?? task.command;
				const cmux = task.cmux ? ` · cmux ${task.cmux.surfaceRef}` : "";
				const pid = task.pid != null ? ` · pid ${task.pid}` : "";
				return `${task.id} · ${summarizeStatus(task)}${pid}${cmux} · ${label}`;
			})
			.join("\n");
	}

	spawnTask(options: SpawnBackgroundTaskOptions): BackgroundTask {
		const command = options.command.trim();
		if (!command) {
			throw new Error("command is required for background task spawn");
		}

		const visible = options.visible === true;
		const runner = options.runner ?? "shell";
		// Reject visible=false with the sumocode runner. The non-visible code
		// path just executes `command` as a shell string, which would treat a
		// natural-language prompt as bash and produce 'command not found' (or
		// worse). The sumocode runner requires a visible cmux pane by design.
		if (!visible && runner === "sumocode") {
			throw new Error(
				`runner='sumocode' requires visible=true — agent prompts cannot be executed as shell commands. Set visible=true or use runner='shell' for shell commands.`,
			);
		}
		if (visible && !isInCmux()) {
			throw new Error("visible background tasks require a cmux surface (CMUX_SURFACE_ID or CMUX_WORKSPACE_ID)");
		}

		const id = `bg-${++this.counter}`;
		const now = Date.now();
		const cwd = options.cwd.trim() || process.cwd();
		const paths = buildVisibleTaskPaths(id, now);
		mkdirSync(dirname(paths.logFile), { recursive: true });
		writeFileSync(paths.logFile, "");

		const task: InternalTask = {
			id,
			command,
			cwd,
			title: options.title?.trim() || undefined,
			status: "running",
			startedAt: now,
			updatedAt: now,
			logFile: paths.logFile,
			exitFile: paths.exitFile,
			metaFile: paths.metaFile,
			promptFile: runner === "shell" ? undefined : paths.promptFile,
			responseFile: runner === "shell" ? undefined : paths.responseFile,
			diagFile: runner === "shell" ? undefined : paths.diagFile,
			visible,
			runner,
			model: resolveAgentModel(runner, options.model),
			thinking: resolveAgentThinking(runner, options.thinking),
			notifyOnExit: options.notifyOnExit !== false,
		};

		this.tasks.set(id, task);
		writeTaskMeta(task);

		if (visible) {
			// Capture the spawn coroutine on the task so stopTask can await it.
			// Catch lets a thrown `openCommandInNewSplitWithRefs` (e.g. cmux
			// unreachable) finalize the task as failed instead of becoming an
			// unhandled rejection that leaves status="running" forever.
			task.spawnPromise = this.spawnVisibleTask(
				task,
				options.direction ?? DEFAULT_VISIBLE_DIRECTION,
				paths,
			).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				appendLogLine(task.logFile, `\n[bg-task] visible spawn failed: ${message}\n`);
				this.finalizeTask(task, 1, "self-exit");
			});
		} else {
			this.spawnInvisibleTask(task, command, cwd, paths.logFile);
		}

		return task;
	}

	private spawnInvisibleTask(task: InternalTask, command: string, cwd: string, logFile: string): void {
		const { shell, args } = getShellConfig();
		const detached = process.platform !== "win32";

		// Detached children with parent-piped stdio do not always survive parent
		// teardown on macOS/Linux — the OS keeps the kernel pipe ends tied to
		// the parent, so if SumoCode exits or its session reloads, a long
		// build/test child can die mid-run. Use `stdio: "ignore"` and have the
		// shell wrapper redirect output into the log file directly. The child
		// is then truly orphan-able and persists across orchestrator restarts.
		const wrappedCommand = detached
			? `( ${command} ) >>${shellEscapeForBash(logFile)} 2>&1`
			: command;
		const childStdio: "ignore" | ["ignore", "pipe", "pipe"] = detached
			? "ignore"
			: ["ignore", "pipe", "pipe"];

		const child = spawn(shell, [...args, wrappedCommand], {
			cwd,
			detached,
			stdio: childStdio,
			// Match the visible shell wrapper: forward the fork-bomb guard into the
			// child env so any nested pi/sumocode invocation bails on the
			// helper-subprocess check in extension.ts.
			env: { ...process.env, SUMOCODE_BG_CHILD: "1" },
		});

		task.pid = child.pid ?? undefined;
		task.child = child;

		if (!detached) {
			// On platforms where we kept stdio pipes (Windows), tee chunks into the
			// log file. On detached platforms the shell does the redirection.
			const handleChunk = (chunk: Buffer) => {
				appendLogLine(logFile, chunk.toString());
				task.updatedAt = Date.now();
			};
			child.stdout?.on("data", handleChunk);
			child.stderr?.on("data", handleChunk);
		}

		child.on("close", (code) => {
			this.finalizeTask(task, typeof code === "number" ? code : null, "self-exit");
		});
		child.on("error", (error) => {
			appendLogLine(logFile, `\n[spawn error] ${error.message}\n`);
			this.finalizeTask(task, 1, "self-exit");
		});

		if (detached && child.pid) {
			child.unref();
		}
	}

	private async spawnVisibleTask(
		task: InternalTask,
		direction: CmuxSplitDirection,
		paths: ReturnType<typeof buildVisibleTaskPaths>,
	): Promise<void> {
		// stopTask may have been called between spawnTask returning and this
		// coroutine running. Skip the split entirely in that case.
		if (task.stopRequested) {
			this.finalizeTask(task, null, "stopped");
			return;
		}
		if (task.runner === "shell") {
			writeFileSync(
				paths.scriptFile,
				buildVisibleTaskScript({
					cwd: task.cwd,
					command: task.command,
					paths,
					taskId: task.id,
					runner: task.runner,
				}),
			);
			chmodSync(paths.scriptFile, 0o700);
		} else if (task.runner === "sumocode") {
			// The cmux respawn-pane command embeds the prompt-file path, NOT the
			// prompt itself — keeps the command short so it doesn't flash a wall
			// of text in the pane before Pi takes over the screen. `sumocode task
			// --prompt-file <path>` reads this file and forwards its contents as
			// Pi's kickoff [messages...] positional.
			writeFileSync(paths.promptFile, task.command);
		}

		const respawnCommand = buildVisibleTaskCommand({
			cwd: task.cwd,
			command: task.command,
			paths,
			taskId: task.id,
			runner: task.runner,
			model: task.model,
			thinking: task.thinking,
		});

		const splitResult = await openCommandInNewSplitWithRefs(this.pi, direction, respawnCommand);
		if (!splitResult.ok) {
			appendLogLine(task.logFile, `\n[cmux error] ${splitResult.error}\n`);
			this.finalizeTask(task, 1, "self-exit");
			return;
		}
		if (task.stopRequested) {
			// Stop arrived while we were waiting for cmux. Close the surface we
			// just created so it doesn't become orphaned, then finalize stopped.
			try {
				await this.pi.exec(
					"cmux",
					[
						"close-surface",
						"--workspace",
						splitResult.workspaceRef,
						"--surface",
						splitResult.surfaceRef,
					],
					{ timeout: 5000 },
				);
			} catch {
				// best-effort
			}
			this.finalizeTask(task, null, "stopped");
			return;
		}

		task.cmux = {
			workspaceRef: splitResult.workspaceRef,
			surfaceRef: splitResult.surfaceRef,
		};
		task.updatedAt = Date.now();
		writeTaskMeta(task);

		if (task.runner === "shell") {
			task.pollTimer = setInterval(() => {
				this.pollVisibleTask(task);
			}, POLL_INTERVAL_MS);
		} else if (task.responseFile) {
			// Agent runners: watch for the child to write response.md when its
			// first agent_end fires (see src/task-mode.ts). On creation, we
			// transition the task to "completed" and persist the updated
			// snapshot so `bg_task list` and `bg_task log` reflect the harvest.
			task.watchdogDeadline = Date.now() + DEFAULT_AGENT_WATCHDOG_MS;
			this.armResponseWatcher(task);
		}
	}

	/**
	 * Poll for the child agent's `response.md`. Pi has no cross-process event
	 * bus we could subscribe to, so a 750ms file-poll is the simplest reliable
	 * way to detect a hand-off completion. The interval is cancelled once the
	 * file appears, on stop/shutdown, or after the watchdog deadline (default
	 * 10 min). Watchdog expiry covers the case where the child crashes before
	 * `agent_end` fires — without it, the task would stay `running` forever
	 * and the orchestrator would poll "still working" indefinitely.
	 */
	private armResponseWatcher(task: InternalTask): void {
		if (!task.responseFile) return;
		if (task.responseTimer) clearInterval(task.responseTimer);
		task.responseTimer = setInterval(() => {
			if (task.finalized) {
				if (task.responseTimer) clearInterval(task.responseTimer);
				task.responseTimer = undefined;
				return;
			}
			if (task.responseFile && existsSync(task.responseFile)) {
				this.finalizeTask(task, 0, "self-exit");
				return;
			}
			if (task.watchdogDeadline && Date.now() > task.watchdogDeadline) {
				if (task.responseTimer) clearInterval(task.responseTimer);
				task.responseTimer = undefined;
				appendLogLine(
					task.logFile,
					`[bg-task] watchdog timeout: response.md not written within ${Math.round(DEFAULT_AGENT_WATCHDOG_MS / 1000)}s; marking task failed (agent may have crashed before agent_end)\n`,
				);
				this.finalizeTask(task, null, "self-exit");
			}
		}, RESPONSE_POLL_INTERVAL_MS);
		if (typeof task.responseTimer.unref === "function") {
			task.responseTimer.unref();
		}
	}

	private pollVisibleTask(task: InternalTask): void {
		if (task.finalized || task.status !== "running") {
			return;
		}

		task.updatedAt = Date.now();

		if (task.exitFile && existsSync(task.exitFile)) {
			const exitCode = readExitCodeFromFile(readFileSync(task.exitFile, "utf8"));
			if (exitCode != null) {
				this.finalizeTask(task, exitCode, "self-exit");
				return;
			}
		}

		const tail = readLogTail(task.logFile, 4096);
		const lines = tail.split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const parsed = parseExitMarkerLine(lines[index] ?? "");
			if (parsed?.taskId === task.id) {
				this.finalizeTask(task, parsed.exitCode, "self-exit");
				return;
			}
		}
	}

	private finalizeTask(task: InternalTask, exitCode: number | null, reason: "self-exit" | "stopped"): void {
		if (task.finalized) return;
		task.finalized = true;

		if (task.pollTimer) {
			clearInterval(task.pollTimer);
			task.pollTimer = undefined;
		}
		if (task.responseTimer) {
			clearInterval(task.responseTimer);
			task.responseTimer = undefined;
		}

		task.exitCode = exitCode;
		task.updatedAt = Date.now();

		if (reason === "stopped" || task.stopRequested) {
			// A user-initiated stop may resolve via `child.on("close")` AFTER
			// `stopTask` has signalled, in which case `reason` is still
			// "self-exit". Honor the original stop intent.
			task.status = "stopped";
		} else if (exitCode === 0) {
			// For agent runners, exitCode=null + self-exit means watchdog timeout.
			task.status = "completed";
		} else if (exitCode === null) {
			task.status = "failed";
		} else {
			task.status = "failed";
		}

		writeTaskMeta(task);

		if (task.notifyOnExit && reason === "self-exit") {
			const label = task.title ?? task.command;
			const cmuxHint = task.cmux ? ` (cmux ${task.cmux.surfaceRef})` : "";
			const message = `background task ${task.id} ${summarizeStatus(task)}: ${label}${cmuxHint}`;
			try {
				this.pi.sendUserMessage(message, { deliverAs: "followUp" });
			} catch {
				this.pi.sendUserMessage(message);
			}
			this.fireCmuxNotify(task);
		}
	}

	/**
	 * Surface task completion through cmux so the user sees it across workspaces
	 * and across SumoCode session reloads. `pi.sendUserMessage` only reaches the
	 * orchestrator while it's alive in this process; `cmux notify` survives.
	 * Best-effort, fire-and-forget — never throws into the finalize path.
	 */
	private fireCmuxNotify(task: BackgroundTask): void {
		if (!isInCmux()) return;
		const status = summarizeStatus(task);
		const title = `bg-task ${task.id} · ${status}`;
		const body = task.title ?? task.command;
		const args: string[] = ["notify", "--title", title, "--body", body];
		if (task.cmux?.workspaceRef) {
			args.push("--workspace", task.cmux.workspaceRef);
		}
		if (task.cmux?.surfaceRef) {
			args.push("--surface", task.cmux.surfaceRef);
		}
		void this.pi
			.exec("cmux", args, { timeout: 5000 })
			.catch(() => undefined);
	}

	async stopTask(
		task: InternalTask,
	): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
		if (task.status !== "running") {
			return { ok: false, message: `Task ${task.id} is already ${task.status}.` };
		}

		// Race protection: if a visible spawn is still mid-flight (no cmux refs
		// yet), mark the request and wait for the spawn coroutine to settle. The
		// coroutine checks stopRequested at every yield point and closes its own
		// surface if it created one.
		task.stopRequested = true;
		if (task.visible && task.spawnPromise && !task.finalized && !task.cmux) {
			try {
				await task.spawnPromise;
			} catch {
				// catch was attached at spawnTask; spawnPromise itself never rejects
			}
			if (task.finalized) {
				return { ok: true, message: `Stopped background task ${task.id} (cancelled before launch).` };
			}
		}

		if (task.child?.pid) {
			const killed = await this.terminateChildAndWait(task.child);
			if (!killed) {
				return {
					ok: false,
					message: `Failed to stop task ${task.id}: child process (pid ${task.child.pid}) did not exit after SIGTERM + SIGKILL within ${Math.round(STOP_SIGTERM_GRACE_MS / 1000)}s.`,
				};
			}
			// finalizeTask is already called via child.on("close"), but ensure it
			// transitions to "stopped" rather than "failed" by short-circuiting.
			if (!task.finalized) {
				this.finalizeTask(task, null, "stopped");
			}
			return { ok: true, message: `Stopped background task ${task.id}.` };
		}

		if (task.visible && task.cmux) {
			const result = await this.pi
				.exec(
					"cmux",
					["close-surface", "--workspace", task.cmux.workspaceRef, "--surface", task.cmux.surfaceRef],
					{ timeout: 5000 },
				)
				.catch((error: unknown) => ({
					code: -1,
					stdout: "",
					stderr: error instanceof Error ? error.message : String(error),
					killed: false,
				}));
			if (result.code !== 0) {
				return {
					ok: false,
					message: `Failed to close cmux surface ${task.cmux.surfaceRef}: ${result.stderr || result.stdout || `cmux close-surface exited ${result.code}`}`,
				};
			}
			this.finalizeTask(task, null, "stopped");
			return { ok: true, message: `Stopped background task ${task.id} (closed cmux ${task.cmux.surfaceRef}).` };
		}

		// No child process and no cmux ref — nothing to actually kill (rare).
		this.finalizeTask(task, null, "stopped");
		return { ok: true, message: `Stopped background task ${task.id} (no process attached).` };
	}

	/**
	 * Send SIGTERM, wait up to `STOP_SIGTERM_GRACE_MS`, escalate to SIGKILL,
	 * then wait a final short window for the kernel to clean up. Returns true
	 * if the process exited, false otherwise.
	 */
	private async terminateChildAndWait(child: ChildProcess): Promise<boolean> {
		const sendSignal = (signal: NodeJS.Signals): void => {
			// Prefer process-group SIGTERM (negative pid) on POSIX so any
			// children of the detached shell wrapper also receive the signal.
			// Fall through to child.kill() if process.kill() throws — the most
			// common case is the process or pgid no longer existing.
			let groupKilled = false;
			if (process.platform !== "win32" && child.pid != null) {
				try {
					process.kill(-child.pid, signal);
					groupKilled = true;
				} catch {
					groupKilled = false;
				}
			}
			if (!groupKilled) {
				try {
					child.kill(signal);
				} catch {
					// process already gone
				}
			}
		};

		const awaitExit = (timeoutMs: number): Promise<boolean> =>
			new Promise<boolean>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve(true);
					return;
				}
				const onClose = (): void => {
					clearTimeout(timer);
					resolve(true);
				};
				const timer = setTimeout(() => {
					child.off("close", onClose);
					resolve(false);
				}, timeoutMs);
				child.once("close", onClose);
			});

		sendSignal("SIGTERM");
		if (await awaitExit(STOP_SIGTERM_GRACE_MS)) return true;
		sendSignal("SIGKILL");
		return await awaitExit(2_000);
	}

	clearFinishedTasks(): number {
		let removed = 0;
		for (const [id, task] of this.tasks) {
			if (task.status === "running") continue;
			if (task.pollTimer) clearInterval(task.pollTimer);
			if (task.responseTimer) clearInterval(task.responseTimer);
			this.tasks.delete(id);
			removed += 1;
		}
		return removed;
	}

	/**
	 * For the sumocode runner, the harvest output lives in `response.md`
	 * written by the child on first agent_end. For shell runners it lives in
	 * `output.log`. This wrapper returns the right one per runner.
	 *
	 * `ready: false` means the harvest is pending AND the task is still
	 * running. If the task has transitioned to a terminal state (failed via
	 * watchdog, stopped by user, etc.) without ever writing response.md,
	 * callers should NOT poll forever — we return `ready: true` with empty
	 * content and the terminal state surfaces via task.status.
	 */
	getTaskHarvest(task: BackgroundTask, maxChars = 50_000): {
		kind: "response" | "log";
		content: string;
		ready: boolean;
	} {
		if (task.runner === "sumocode" && task.responseFile) {
			if (existsSync(task.responseFile)) {
				const content = readFileSync(task.responseFile, "utf8");
				return {
					kind: "response",
					content: content.length <= maxChars ? content : content.slice(-maxChars),
					ready: true,
				};
			}
			return {
				kind: "response",
				content: "",
				// Terminal-state guard: don't keep telling callers "still working"
				// once the task has failed/stopped without writing response.md.
				ready: task.status !== "running",
			};
		}
		return { kind: "log", content: readLogTail(task.logFile, maxChars), ready: true };
	}

	shutdown(): void {
		for (const task of this.tasks.values()) {
			if (task.status !== "running") continue;
			if (task.child?.pid) {
				try {
					if (process.platform !== "win32") {
						process.kill(-task.child.pid, "SIGTERM");
					} else {
						task.child.kill("SIGTERM");
					}
				} catch {
					// ignore shutdown errors
				}
			}
			if (task.pollTimer) clearInterval(task.pollTimer);
			if (task.responseTimer) clearInterval(task.responseTimer);
		}
	}
}

export function isInCmuxEnvironment(): boolean {
	return isInCmux();
}

/** Test helper — remove stale lock/log dirs between tests. */
export function removePathIfExists(path: string): void {
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch {
		try {
			const fd = openSync(path, "r");
			closeSync(fd);
			unlinkSync(path);
		} catch {
			// ignore
		}
	}
}
