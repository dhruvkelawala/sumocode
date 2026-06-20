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
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isInCmux,
	openCommandInNewSplitWithRefs,
	type SplitDirection as CmuxSplitDirection,
} from "../commands/cmux-split.js";
import { createWorktree, removeWorktreeSync, resolveCreateOptions } from "../git/worktree.js";
import {
	BACKGROUND_TASK_META_SCHEMA_VERSION,
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
const DEFAULT_AGENT_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_VISIBLE_DIRECTION: CmuxSplitDirection = "right";
export const DEFAULT_SUMOCODE_AGENT_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_SUMOCODE_AGENT_THINKING: BackgroundTaskThinking = "low";
const AGENT_MODEL_ENV = "SUMOCODE_BG_AGENT_MODEL";
const AGENT_THINKING_ENV = "SUMOCODE_BG_AGENT_THINKING";
const AGENT_CAPACITY_ENV = "SUMOCODE_BG_AGENT_CAPACITY";
const DEFAULT_SUMOCODE_AGENT_CAPACITY = 4;
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
/** Bounded tail-read for poll/harvest — avoids O(file_size) re-reads. */
const LOG_TAIL_READ_BYTES = 16 * 1024;
const DEFAULT_BACKGROUND_TASK_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FINISHED_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECOVERED_FINISHED_TASKS = 100;

interface InternalTask extends BackgroundTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	responseTimer?: ReturnType<typeof setInterval>;
	startupDeadline?: number;
	/**
	 * Promise that resolves once the visible-spawn coroutine finishes (success
	 * OR caught failure). `stopTask` awaits this so it can never finalize a task
	 * while a `new-split`/`respawn-pane` is still in flight — otherwise the
	 * stopped-then-launched race leaves a runaway pane.
	 */
	spawnPromise?: Promise<void>;
	worktreePending?: boolean;
	stopRequested?: boolean;
	finalized?: boolean;
}

export interface BackgroundTaskManagerOptions {
	readonly agentCapacity?: number;
	readonly logMaxBytes?: number;
	readonly finishedTaskMaxAgeMs?: number;
	readonly maxRecoveredFinishedTasks?: number;
}

export interface AgentCapacityTaskSummary {
	readonly id: string;
	readonly title?: string;
	readonly status: BackgroundTask["status"];
	readonly ageMs: number;
}

export interface AgentCapacityDetails {
	readonly status: "at_capacity";
	readonly capacity: number;
	readonly runningCount: number;
	readonly running: readonly AgentCapacityTaskSummary[];
	readonly retryHint: string;
}

export class BackgroundTaskCapacityError extends Error {
	public readonly details: AgentCapacityDetails;

	public constructor(details: AgentCapacityDetails) {
		super(`agent capacity reached (${details.runningCount}/${details.capacity})`);
		this.name = "BackgroundTaskCapacityError";
		this.details = details;
	}
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

function resolveAgentCapacity(value: number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
	const fromEnv = Number.parseInt(process.env[AGENT_CAPACITY_ENV] ?? "", 10);
	return Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : DEFAULT_SUMOCODE_AGENT_CAPACITY;
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

function readStartedMarkerPid(markerFile: string | undefined): number | undefined {
	if (!markerFile || !existsSync(markerFile)) return undefined;
	try {
		const first = readFileSync(markerFile, "utf8").trim().split("\n")[0] ?? "";
		if (!/^\d+$/.test(first)) return undefined;
		const pid = Number.parseInt(first, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
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
	if (snapshot.schemaVersion !== BACKGROUND_TASK_META_SCHEMA_VERSION) return undefined;
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
		cmux: snapshot.cmux,
		worktree: snapshot.worktree,
		notifyOnExit: snapshot.notifyOnExit === true,
	};
}

export class BackgroundTaskManager {
	private tasks = new Map<string, InternalTask>();
	private readonly pi: ExtensionAPI;
	private readonly agentCapacity: number;
	private readonly logMaxBytes: number;
	private readonly finishedTaskMaxAgeMs: number;
	private readonly maxRecoveredFinishedTasks: number;
	/**
	 * True only while `recoverTasks` is reconciling persisted state on
	 * startup/reload. Used by `finalizeTask` to suppress the message-queue
	 * followUp injection (which would wake the agent with a turn the user never
	 * requested) while still allowing the passive cmux desktop notify to fire.
	 */
	private recovering = false;

	constructor(pi: ExtensionAPI, options: BackgroundTaskManagerOptions = {}) {
		this.pi = pi;
		this.agentCapacity = resolveAgentCapacity(options.agentCapacity);
		this.logMaxBytes = normalizePositiveInteger(options.logMaxBytes, DEFAULT_BACKGROUND_TASK_LOG_MAX_BYTES);
		this.finishedTaskMaxAgeMs = normalizePositiveInteger(options.finishedTaskMaxAgeMs, DEFAULT_FINISHED_TASK_MAX_AGE_MS);
		this.maxRecoveredFinishedTasks = normalizePositiveInteger(options.maxRecoveredFinishedTasks, DEFAULT_MAX_RECOVERED_FINISHED_TASKS);
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

		if (task.runner === "shell") {
			task.pollTimer = setInterval(() => this.pollVisibleTask(task), POLL_INTERVAL_MS);
			if (typeof task.pollTimer.unref === "function") task.pollTimer.unref();
		} else if (task.exitFile) {
			this.armAgentStartupDeadline(task);
			this.armResponseWatcher(task);
		}
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
				const worktree = task.worktree ? ` · ${task.worktree.branch}` : "";
				const pid = task.pid != null ? ` · pid ${task.pid}` : "";
				return `${task.id} · ${summarizeStatus(task)}${pid}${cmux}${worktree} · ${label}`;
			})
			.join("\n");
	}

	getAgentCapacityDetails(): AgentCapacityDetails {
		const now = Date.now();
		const running = [...this.tasks.values()]
			.filter((task) => task.runner === "sumocode" && task.status === "running")
			.sort((a, b) => a.startedAt - b.startedAt)
			.map((task) => ({
				id: task.id,
				title: task.title,
				status: task.status,
				ageMs: Math.max(0, now - task.startedAt),
			}));
		return {
			status: "at_capacity",
			capacity: this.agentCapacity,
			runningCount: running.length,
			running,
			retryHint: "poll bg_task action=log on a running task until one completes, then retry this spawn; stop an unneeded task with bg_task action=stop",
		};
	}

	private assertAgentCapacityAvailable(runner: BackgroundTask["runner"]): void {
		if (runner !== "sumocode") return;
		const details = this.getAgentCapacityDetails();
		if (details.runningCount >= details.capacity) {
			throw new BackgroundTaskCapacityError(details);
		}
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
		this.assertAgentCapacityAvailable(runner);

		let id = generateTaskId();
		while (this.tasks.has(id)) id = generateTaskId();
		const now = Date.now();
		let cwd = options.cwd.trim() || process.cwd();
		let worktree: BackgroundTask["worktree"];
		let worktreePending = false;
		if (options.worktree === true) {
			if (runner !== "sumocode" || !visible) {
				throw new Error("worktree=true requires runner='sumocode' and visible=true");
			}
			const repoRoot = cwd;
			const target = resolveCreateOptions({
				repoRoot,
				branch: options.branch,
				baseRef: options.baseRef,
				task: options.title ?? command,
			});
			worktree = { path: target.path, branch: target.branch, baseRef: target.baseRef, repoRoot };
			cwd = target.path;
			worktreePending = true;
		}
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
			markerFile: runner === "shell" ? undefined : paths.markerFile,
			promptFile: runner === "shell" ? undefined : paths.promptFile,
			responseFile: runner === "shell" ? undefined : paths.responseFile,
			diagFile: runner === "shell" ? undefined : paths.diagFile,
			visible,
			runner,
			model: resolveAgentModel(runner, options.model),
			thinking: resolveAgentThinking(runner, options.thinking),
			worktree,
			worktreePending,
			notifyOnExit: options.notifyOnExit === true,
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
		if (task.worktreePending && task.worktree) {
			const created = await createWorktree({
				repoRoot: task.worktree.repoRoot,
				branch: task.worktree.branch,
				baseRef: task.worktree.baseRef,
				path: task.worktree.path,
			});
			if (!created.ok) {
				appendLogLine(task.logFile, `\n[bg-task] worktree create failed: ${created.message}\n`);
				// No worktree exists on disk; drop the speculative ref so a later
				// clearFinishedTasks({ pruneWorktrees: true }) does not try to remove
				// a nonexistent worktree and get stuck.
				task.worktree = undefined;
				task.worktreePending = false;
				this.finalizeTask(task, 1, "self-exit");
				return;
			}
			task.worktreePending = false;
			task.updatedAt = Date.now();
			writeTaskMeta(task);
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
		} else if (task.exitFile) {
			// Agent runners: response.md is only the latest assistant response.
			// Completion is keyed to the real process-exit marker written by
			// src/task-mode.ts so multi-turn child sessions are not marked done on
			// their first agent_end.
			this.armAgentStartupDeadline(task);
			this.armResponseWatcher(task);
		}
	}

	private armAgentStartupDeadline(task: InternalTask): void {
		if (!task.markerFile || existsSync(task.markerFile)) {
			task.startupDeadline = undefined;
			return;
		}
		task.startupDeadline = task.startedAt + DEFAULT_AGENT_STARTUP_TIMEOUT_MS;
	}

	/**
	 * Poll for the child agent's real exit marker. Pi has no cross-process event
	 * bus we could subscribe to, so a 750ms file-poll is the simplest reliable
	 * way to detect hand-off completion. The interval is cancelled once the
	 * exit marker appears, on explicit stop, or on manager shutdown. Absence of
	 * the exit marker is deliberately non-terminal after the child writes its
	 * task-mode started marker: visible child agents may run for longer than a
	 * fixed response-era timeout, and some panes are intentionally left open for
	 * user takeover. Before that started marker appears, a bounded startup
	 * timeout catches launcher/Pi crashes that happened before task-mode could
	 * install the exit marker.
	 */
	private armResponseWatcher(task: InternalTask): void {
		if (!task.exitFile) return;
		if (task.responseTimer) clearInterval(task.responseTimer);
		task.responseTimer = setInterval(() => {
			if (task.finalized) {
				if (task.responseTimer) clearInterval(task.responseTimer);
				task.responseTimer = undefined;
				return;
			}
			if (task.exitFile && existsSync(task.exitFile)) {
				const exitCode = readExitCodeFromFile(readFileSync(task.exitFile, "utf8"));
				this.finalizeTask(task, exitCode, "self-exit");
				return;
			}
			if (task.markerFile && existsSync(task.markerFile)) {
				task.startupDeadline = undefined;
				const pid = readStartedMarkerPid(task.markerFile);
				if (pid !== undefined && !isProcessAlive(pid)) {
					appendLogLine(
						task.logFile,
						`[bg-task] agent process ${pid} is gone and no exit marker was written; marking task failed (likely SIGKILL/crash)\n`,
					);
					this.finalizeTask(task, null, "self-exit");
					return;
				}
			} else if (task.startupDeadline && Date.now() > task.startupDeadline) {
				appendLogLine(
					task.logFile,
					`[bg-task] startup timeout: task-mode started marker not written within ${Math.round(DEFAULT_AGENT_STARTUP_TIMEOUT_MS / 1000)}s; marking task failed before handoff became live\n`,
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
		// Cap the log exactly once, now that the task is finalized and no external
		// writer (the visible-shell `tee -a` pipeline / detached shell redirect) is
		// still appending to output.log. Capping while the writer is live would race
		// it across processes and corrupt the log.
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
			this.fireCmuxNotify(task);

			// Active wake: inject a follow-up turn so the orchestrator agent reacts to
			// the result (e.g. to continue chained background work). Opt-in only —
			// notifyOnExit defaults to false — and never during startup recovery, where
			// it would wake the agent for a task the user never started this session.
			if (task.notifyOnExit && !this.recovering) {
				const label = task.title ?? task.command;
				const cmuxHint = task.cmux ? ` (cmux ${task.cmux.surfaceRef})` : "";
				const message = `background task ${task.id} ${summarizeStatus(task)}: ${label}${cmuxHint}`;
				try {
					this.pi.sendUserMessage(message, { deliverAs: "followUp" });
				} catch {
					this.pi.sendUserMessage(message);
				}
			}
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
				task.stopRequested = false;
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
			if (task.responseTimer) clearInterval(task.responseTimer);
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

	/**
	 * For the sumocode runner, the harvest output lives in `response.md`, but
	 * that file is harvestable only after the child writes its real process-exit
	 * marker. For shell runners output lives in `output.log`. This wrapper
	 * returns the right one per runner.
	 *
	 * `ready: false` means the harvest is pending AND the task is still
	 * running. If the task has transitioned to a terminal state (stopped by
	 * user, crashed/nonzero exit, etc.) without ever writing response.md,
	 * callers should NOT poll forever — we return `ready: true` with empty
	 * content and the terminal state surfaces via task.status.
	 */
	getTaskHarvest(task: BackgroundTask, maxChars = 50_000): {
		kind: "response" | "log";
		content: string;
		ready: boolean;
	} {
		if (task.runner === "sumocode" && task.responseFile) {
			const content = existsSync(task.responseFile) ? readFileSync(task.responseFile, "utf8") : "";
			return {
				kind: "response",
				content: content.length <= maxChars ? content : content.slice(-maxChars),
				// response.md may be written before a child truly exits. Treat it as
				// harvestable only after the real exit marker has finalized the task.
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
