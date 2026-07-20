import { execFileSync, type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	readdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SplitDirection as CmuxSplitDirection } from "../terminal-host/index.js";
import { detectTerminalHost, getTerminalHost, getTerminalHostForPane } from "../terminal-host/index.js";
import { removeWorktreeSync } from "../git/worktree.js";
import {
	BACKGROUND_TASK_META_SCHEMA_VERSION,
	type BackgroundTask,
	type BackgroundTaskSnapshot,
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
/** How often the running-task log size guard runs (writer-safe truncate). */
const LOG_CAP_INTERVAL_MS = 5_000;
const DEFAULT_VISIBLE_DIRECTION: CmuxSplitDirection = "right";

/** Max grace period before stopTask escalates SIGTERM to SIGKILL. */
const STOP_SIGTERM_GRACE_MS = 5_000;
/** Bounded tail-read for poll/harvest — avoids O(file_size) re-reads. */
const LOG_TAIL_READ_BYTES = 16 * 1024;
const DEFAULT_BACKGROUND_TASK_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FINISHED_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECOVERED_FINISHED_TASKS = 100;

interface InternalTask extends BackgroundTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	logCapTimer?: ReturnType<typeof setInterval>;
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

export interface BackgroundTaskManagerOptions {
	readonly logMaxBytes?: number;
	readonly finishedTaskMaxAgeMs?: number;
	readonly maxRecoveredFinishedTasks?: number;
	readonly onTaskFinalized?: (task: BackgroundTaskSnapshot) => void;
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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function enforceLogSizeCap(logFile: string, maxBytes: number): void {
	if (!existsSync(logFile)) return;
	try {
		const { size } = statSync(logFile);
		if (size <= maxBytes) return;
		const keepBytes = Math.max(0, maxBytes - 80);
		const tail = readLogTail(logFile, keepBytes);
		const prefix = `[sumocode-bg] log truncated to last ${keepBytes} bytes\n`;
		const next = `${prefix}${tail}`;
		writeFileSync(logFile, next.length <= maxBytes ? next : next.slice(-maxBytes));
	} catch {
		// best-effort; logging must never interrupt task lifecycle
	}
}

/**
 * Writer-safe running cap. While a task is live its output.log is written by an
 * EXTERNAL O_APPEND writer (the visible-shell `tee -a` pipeline or the detached
 * shell's `>>` redirect). We must NOT rewrite the file from this process the way
 * `enforceLogSizeCap` does — that races the writer and corrupts the log, which is
 * why `enforceLogSizeCap` only runs at finalize. `truncate(0)` writes no bytes, so
 * an O_APPEND writer simply resumes at the new EOF: it bounds disk without
 * clobbering. History is dropped (not a tail-keep) precisely because keeping a
 * tail would require writing bytes back into a file another process is appending.
 */
function truncateLogIfOverCap(logFile: string, maxBytes: number): void {
	if (!existsSync(logFile)) return;
	try {
		if (statSync(logFile).size > maxBytes) truncateSync(logFile, 0);
	} catch {
		// best-effort; logging must never interrupt task lifecycle
	}
}

function appendLogLine(logFile: string, line: string): void {
	try {
		writeFileSync(logFile, line, { flag: "a" });
	} catch {
		// best-effort; logging must never interrupt task lifecycle
	}
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

function getTaskRootDir(): string {
	return join(process.env.TMPDIR ?? "/tmp", "sumocode-bg");
}

function generateTaskId(): string {
	return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isProcessAlive(pid: number | undefined): boolean {
	if (pid == null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function getProcessStartTime(pid: number | undefined): string | undefined {
	if (pid == null) return undefined;
	try {
		if (process.platform === "win32") {
			return execFileSync(
				"powershell.exe",
				["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`],
				{ encoding: "utf8" },
			).trim() || undefined;
		}
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function getProcessIdentityStatus(
	pid: number | undefined,
	expectedStartTime: string | undefined,
): "same" | "different" | "unknown" {
	if (!isProcessAlive(pid)) return "different";
	if (!expectedStartTime) return "unknown";
	const actualStartTime = getProcessStartTime(pid);
	if (!actualStartTime) return "unknown";
	return actualStartTime === expectedStartTime ? "same" : "different";
}

function signalProcessOrGroup(pid: number, signal: NodeJS.Signals): void {
	let groupKilled = false;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			groupKilled = true;
		} catch {
			groupKilled = false;
		}
	}
	if (!groupKilled) {
		try {
			process.kill(pid, signal);
		} catch {
			// process already gone
		}
	}
}

function parseRecoveredTask(raw: unknown, metaFile: string): InternalTask | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const snapshot = raw as Partial<BackgroundTaskSnapshot>;
	if (snapshot.schemaVersion !== BACKGROUND_TASK_META_SCHEMA_VERSION && snapshot.schemaVersion !== 2) return undefined;
	const status = snapshot.status;
	if (status !== "running" && status !== "completed" && status !== "failed" && status !== "stopped") return undefined;
	if (
		typeof snapshot.id !== "string" ||
		typeof snapshot.command !== "string" ||
		typeof snapshot.cwd !== "string" ||
		typeof snapshot.startedAt !== "number" ||
		typeof snapshot.updatedAt !== "number" ||
		typeof snapshot.logFile !== "string" ||
		typeof snapshot.visible !== "boolean" ||
		(snapshot.runner !== "shell" && snapshot.runner !== "sumocode")
	) {
		return undefined;
	}
	const pane = snapshot.pane ?? (snapshot.cmux ? { host: "cmux" as const, workspaceId: snapshot.cmux.workspaceRef, paneId: snapshot.cmux.surfaceRef } : undefined);
	return {
		id: snapshot.id,
		pid: snapshot.pid,
		command: snapshot.command,
		cwd: snapshot.cwd,
		title: snapshot.title,
		status,
		startedAt: snapshot.startedAt,
		updatedAt: snapshot.updatedAt,
		exitCode: snapshot.exitCode,
		logFile: snapshot.logFile,
		exitFile: snapshot.exitFile,
		metaFile,
		markerFile: snapshot.markerFile,
		promptFile: snapshot.promptFile,
		responseFile: snapshot.responseFile,
		diagFile: snapshot.diagFile,
		processStartTime: snapshot.processStartTime,
		visible: snapshot.visible,
		runner: snapshot.runner,
		model: snapshot.model,
		thinking: snapshot.thinking,
		pane,
		worktree: snapshot.worktree,
		resultDelivery: snapshot.resultDelivery === "typed" ? ("typed" as const) : undefined,
	};
}

export class BackgroundTaskManager {
	private tasks = new Map<string, InternalTask>();
	private readonly pi: ExtensionAPI;
	private readonly logMaxBytes: number;
	private readonly finishedTaskMaxAgeMs: number;
	private readonly maxRecoveredFinishedTasks: number;
	private readonly onTaskFinalized?: (task: BackgroundTaskSnapshot) => void;
	/** True while persisted state is being reconciled at startup/reload. */
	private recovering = false;

	constructor(pi: ExtensionAPI, options: BackgroundTaskManagerOptions = {}) {
		this.pi = pi;
		this.logMaxBytes = normalizePositiveInteger(options.logMaxBytes, DEFAULT_BACKGROUND_TASK_LOG_MAX_BYTES);
		this.finishedTaskMaxAgeMs = normalizePositiveInteger(options.finishedTaskMaxAgeMs, DEFAULT_FINISHED_TASK_MAX_AGE_MS);
		this.maxRecoveredFinishedTasks = normalizePositiveInteger(options.maxRecoveredFinishedTasks, DEFAULT_MAX_RECOVERED_FINISHED_TASKS);
		this.onTaskFinalized = options.onTaskFinalized;
		this.recoverTasks();
	}

	listTasks(): BackgroundTaskSnapshot[] {
		return [...this.tasks.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.map(toBackgroundTaskSnapshot);
	}

	private recoverTasks(): void {
		const root = getTaskRootDir();
		if (!existsSync(root)) return;
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			return;
		}
		this.recovering = true;
		try {
			const recovered: InternalTask[] = [];
			for (const entry of entries) {
				const metaFile = join(root, entry, "meta.json");
				if (!existsSync(metaFile)) continue;
				try {
					const task = parseRecoveredTask(JSON.parse(readFileSync(metaFile, "utf8")), metaFile);
					if (!task || this.tasks.has(task.id)) continue;
					this.reconcileRecoveredTask(task);
					recovered.push(task);
				} catch {
					// Ignore malformed/unknown legacy metadata; recovery is best-effort.
				}
			}
			for (const task of this.pruneRecoveredFinishedTasks(recovered)) {
				this.tasks.set(task.id, task);
			}
		} finally {
			this.recovering = false;
		}
	}

	private pruneRecoveredFinishedTasks(tasks: readonly InternalTask[]): InternalTask[] {
		const now = Date.now();
		const finished = tasks
			.filter((task) => task.status !== "running")
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const keepFinished = new Set(finished.slice(0, this.maxRecoveredFinishedTasks).map((task) => task.id));
		const kept: InternalTask[] = [];
		for (const task of tasks) {
			if (task.status === "running") {
				kept.push(task);
				continue;
			}
			const tooOld = now - task.updatedAt > this.finishedTaskMaxAgeMs;
			const overCount = !keepFinished.has(task.id);
			if (tooOld || overCount) {
				this.removeTaskArtifacts(task);
				continue;
			}
			kept.push(task);
		}
		return kept;
	}

	private reconcileRecoveredTask(task: InternalTask): void {
		if (task.status !== "running") {
			task.finalized = true;
			enforceLogSizeCap(task.logFile, this.logMaxBytes);
			return;
		}
		const exitCode = task.exitFile && existsSync(task.exitFile)
			? readExitCodeFromFile(readFileSync(task.exitFile, "utf8"))
			: null;
		if (exitCode != null) {
			this.finalizeTask(task, exitCode, "self-exit");
			return;
		}

		if (task.runner === "shell" && !task.visible && task.pid != null && task.processStartTime) {
			const identityStatus = getProcessIdentityStatus(task.pid, task.processStartTime);
			if (identityStatus === "different") {
				this.finalizeTask(task, null, "self-exit");
				return;
			}
		}

		// Legacy agent tasks cannot be safely reattached after the response watcher
		// is retired. Keep their metadata readable, reconcile them once, and never
		// re-arm a watcher that could revive the removed runner path.
		if (task.runner === "sumocode") {
			this.finalizeTask(task, null, "self-exit");
			return;
		}

		this.armLogCap(task);
		task.pollTimer = setInterval(() => this.pollVisibleTask(task), POLL_INTERVAL_MS);
		if (typeof task.pollTimer.unref === "function") task.pollTimer.unref();
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
				const pane = task.pane ? ` · ${task.pane.host} ${task.pane.paneId}` : "";
				const worktree = task.worktree ? ` · ${task.worktree.branch}` : "";
				const pid = task.pid != null ? ` · pid ${task.pid}` : "";
				return `${task.id} · ${summarizeStatus(task)}${pid}${pane}${worktree} · ${label}`;
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
		if (visible && detectTerminalHost() === "none") {
			throw new Error("visible background tasks require a terminal host (cmux or herdr)");
		}

		let id = generateTaskId();
		while (this.tasks.has(id)) id = generateTaskId();
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
			visible,
			runner,
			resultDelivery: options.resultDelivery,
		};

		this.tasks.set(id, task);
		writeTaskMeta(task);
		this.armLogCap(task);

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
			? `{ ( ${command} ); code=$?; printf '%s' "$code" > ${shellEscapeForBash(task.exitFile ?? `${logFile}.exit`)}; exit "$code"; } >>${shellEscapeForBash(logFile)} 2>&1`
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
		task.processStartTime = getProcessStartTime(task.pid);
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

		if (task.pid != null && !task.processStartTime) {
			appendLogLine(logFile, "\n[bg-task] warning: failed to capture process identity; recovered stop will require identity recapture\n");
		}

		writeTaskMeta(task);

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
		writeFileSync(
			paths.scriptFile,
			buildVisibleTaskScript({
				cwd: task.cwd,
				command: task.command,
				paths,
				taskId: task.id,
			}),
		);
		chmodSync(paths.scriptFile, 0o700);

		const respawnCommand = buildVisibleTaskCommand({
			cwd: task.cwd,
			command: task.command,
			paths,
			taskId: task.id,
		});

		const host = getTerminalHost();
		const splitResult = await host.openCommandInSplit(this.pi, direction, { cwd: task.cwd, shellCommand: respawnCommand });
		if (!splitResult.ok) {
			appendLogLine(task.logFile, `\n[terminal-host error] ${splitResult.error}\n`);
			this.finalizeTask(task, 1, "self-exit");
			return;
		}
		if (task.stopRequested) {
			// Stop arrived while we were waiting for cmux. Close the surface we
			// just created so it doesn't become orphaned, then finalize stopped.
			try {
				await host.closePane(this.pi, splitResult.pane);
			} catch {
				// best-effort
			}
			this.finalizeTask(task, null, "stopped");
			return;
		}

		task.pane = splitResult.pane;
		task.updatedAt = Date.now();
		writeTaskMeta(task);

		task.pollTimer = setInterval(() => {
			this.pollVisibleTask(task);
		}, POLL_INTERVAL_MS);
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

	/**
	 * Arm a writer-safe periodic size guard for a running task so a long-lived
	 * watcher cannot grow output.log without bound between finalizations.
	 */
	private armLogCap(task: InternalTask): void {
		if (task.logCapTimer || task.status !== "running") return;
		truncateLogIfOverCap(task.logFile, this.logMaxBytes);
		task.logCapTimer = setInterval(() => truncateLogIfOverCap(task.logFile, this.logMaxBytes), LOG_CAP_INTERVAL_MS);
		if (typeof task.logCapTimer.unref === "function") task.logCapTimer.unref();
	}

	private clearLogCap(task: InternalTask): void {
		if (!task.logCapTimer) return;
		clearInterval(task.logCapTimer);
		task.logCapTimer = undefined;
	}

	private finalizeTask(task: InternalTask, exitCode: number | null, reason: "self-exit" | "stopped"): void {
		if (task.finalized) return;
		task.finalized = true;

		if (task.pollTimer) {
			clearInterval(task.pollTimer);
			task.pollTimer = undefined;
		}
		this.clearLogCap(task);
		// Cap the log exactly once, now that the task is finalized and no external
		// writer (the visible-shell `tee -a` pipeline / detached shell redirect) is
		// still appending to output.log. The running guard only truncates-to-zero
		// (writer-safe); here, with no live writer, we keep the tail.
		enforceLogSizeCap(task.logFile, this.logMaxBytes);

		task.exitCode = exitCode;
		task.updatedAt = Date.now();

		if (reason === "stopped" || task.stopRequested) {
			// A user-initiated stop may resolve via `child.on("close")` AFTER
			// `stopTask` has signalled, in which case `reason` is still
			// "self-exit". Honor the original stop intent.
			task.status = "stopped";
		} else if (exitCode === 0) {
			task.status = "completed";
		} else if (exitCode === null) {
			task.status = "failed";
		} else {
			task.status = "failed";
		}

		writeTaskMeta(task);

		if (reason === "self-exit") {
			// Passive completion signal: a cmux desktop toast that informs the user
			// (across workspaces and reloads) WITHOUT waking the agent. Fires for every
			// terminal self-exit, including fire-and-forget tasks and during startup
			// recovery.
			this.fireHostNotify(task);

			// Typed completion consumers share this finalized snapshot only for live
			// self-exits. Recovery and explicit stops must never synthesize a result.
			if (!this.recovering && task.status !== "stopped") {
				try {
					this.onTaskFinalized?.(toBackgroundTaskSnapshot(task));
				} catch {
					// Completion delivery is best-effort and must not break finalization.
				}
			}
		}
	}

	/**
	 * Surface task completion through the active terminal host so the user sees
	 * it across workspaces and SumoCode session reloads. Best-effort,
	 * fire-and-forget — never throws into the finalize path.
	 */
	private fireHostNotify(task: BackgroundTask): void {
		const host = task.pane ? getTerminalHostForPane(task.pane) : getTerminalHost();
		if (host.kind === "none") return;
		const status = summarizeStatus(task);
		const title = `bg-task ${task.id} · ${status}`;
		const body = task.title ?? task.command;
		void host.notify(this.pi, title, body, task.pane).catch(() => undefined);
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
		if (task.visible && task.spawnPromise && !task.finalized && !task.pane) {
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
				task.stopRequested = false;
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

		if (!task.visible && task.pid != null) {
			if (!task.processStartTime) {
				task.processStartTime = getProcessStartTime(task.pid);
				if (task.processStartTime) writeTaskMeta(task);
			}
			const identityStatus = getProcessIdentityStatus(task.pid, task.processStartTime);
			if (identityStatus === "unknown") {
				task.stopRequested = false;
				return {
					ok: false,
					message: `Refusing to stop task ${task.id}: recovered pid ${task.pid} process identity could not be verified.`,
				};
			}
			if (identityStatus === "different") {
				task.stopRequested = false;
				this.finalizeTask(task, null, "self-exit");
				return {
					ok: false,
					message: `Refusing to stop task ${task.id}: recovered pid ${task.pid} no longer matches the original background process.`,
				};
			}
			const killed = await this.terminatePidAndWait(task.pid);
			if (!killed) {
				task.stopRequested = false;
				return {
					ok: false,
					message: `Failed to stop task ${task.id}: recovered process (pid ${task.pid}) did not exit after SIGTERM + SIGKILL within ${Math.round(STOP_SIGTERM_GRACE_MS / 1000)}s.`,
				};
			}
			this.finalizeTask(task, null, "stopped");
			return { ok: true, message: `Stopped background task ${task.id} (pid ${task.pid}).` };
		}

		if (task.visible && task.pane) {
			const host = getTerminalHostForPane(task.pane);
			const result = await host.closePane(this.pi, task.pane).catch((error: unknown) => ({
				ok: false as const,
				error: error instanceof Error ? error.message : String(error),
			}));
			if (!result.ok) {
				task.stopRequested = false;
				return {
					ok: false,
					message: `Failed to close ${task.pane.host} pane ${task.pane.paneId}: ${result.error}`,
				};
			}
			this.finalizeTask(task, null, "stopped");
			return { ok: true, message: `Stopped background task ${task.id} (closed ${task.pane.host} ${task.pane.paneId}).` };
		}

		// No child process and no pane ref — nothing to actually kill (rare).
		this.finalizeTask(task, null, "stopped");
		return { ok: true, message: `Stopped background task ${task.id} (no process attached).` };
	}

	/**
	 * Send SIGTERM, wait up to `STOP_SIGTERM_GRACE_MS`, escalate to SIGKILL,
	 * then wait a final short window for the kernel to clean up. Returns true
	 * if the process exited, false otherwise.
	 */
	private async terminatePidAndWait(pid: number): Promise<boolean> {
		const awaitExit = (timeoutMs: number): Promise<boolean> =>
			new Promise<boolean>((resolve) => {
				if (!isProcessAlive(pid)) {
					resolve(true);
					return;
				}
				const startedAt = Date.now();
				const timer = setInterval(() => {
					if (!isProcessAlive(pid)) {
						clearInterval(timer);
						resolve(true);
						return;
					}
					if (Date.now() - startedAt >= timeoutMs) {
						clearInterval(timer);
						resolve(false);
					}
				}, 50);
				if (typeof timer.unref === "function") timer.unref();
			});

		signalProcessOrGroup(pid, "SIGTERM");
		if (await awaitExit(STOP_SIGTERM_GRACE_MS)) return true;
		signalProcessOrGroup(pid, "SIGKILL");
		return await awaitExit(2_000);
	}

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

	private taskArtifactDir(task: BackgroundTask): string | undefined {
		if (task.metaFile) return dirname(task.metaFile);
		if (task.logFile) return dirname(task.logFile);
		return undefined;
	}

	private removeTaskArtifacts(task: BackgroundTask): void {
		const dir = this.taskArtifactDir(task);
		if (!dir) return;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; never fail clear/recovery on filesystem races
		}
	}

	clearFinishedTasks(options: { pruneWorktrees?: boolean } = {}): number {
		let removed = 0;
		for (const [id, task] of this.tasks) {
			if (task.status === "running") continue;
			if (task.pollTimer) clearInterval(task.pollTimer);
			this.clearLogCap(task);
			if (options.pruneWorktrees && task.worktree) {
				const pruned = removeWorktreeSync({ path: task.worktree.path, repoRoot: task.worktree.repoRoot });
				if (!pruned.ok) {
					appendLogLine(task.logFile, `\n[bg-task] worktree prune failed: ${pruned.message}\n`);
					continue;
				}
			}
			this.removeTaskArtifacts(task);
			this.tasks.delete(id);
			removed += 1;
		}
		return removed;
	}

	getTaskHarvest(task: BackgroundTask, maxChars = 50_000): {
		kind: "log";
		content: string;
		ready: true;
	} {
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
			} else if (!task.visible && task.pid != null) {
				if (!task.processStartTime) {
					task.processStartTime = getProcessStartTime(task.pid);
					if (task.processStartTime) writeTaskMeta(task);
				}
				if (getProcessIdentityStatus(task.pid, task.processStartTime) === "same") {
					signalProcessOrGroup(task.pid, "SIGTERM");
				}
			}
			if (task.pollTimer) clearInterval(task.pollTimer);
			this.clearLogCap(task);
		}
	}
}

export function isInCmuxEnvironment(): boolean {
	return detectTerminalHost() === "cmux";
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
