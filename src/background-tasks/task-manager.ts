import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
	type SpawnBackgroundTaskOptions,
	toBackgroundTaskSnapshot,
} from "./task-types.js";
import {
	buildVisibleTaskCommand,
	buildVisibleTaskPaths,
	buildVisibleTaskScript,
	parseExitMarkerLine,
	readExitCodeFromFile,
} from "./visible-spawn.js";

const POLL_INTERVAL_MS = 500;
const DEFAULT_VISIBLE_DIRECTION: CmuxSplitDirection = "right";

interface InternalTask extends BackgroundTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
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

function appendLogLine(logFile: string, line: string): void {
	writeFileSync(logFile, line, { flag: "a" });
}

function readLogTail(logFile: string, maxChars = 10_000): string {
	if (!existsSync(logFile)) return "";
	const content = readFileSync(logFile, "utf8");
	if (content.length <= maxChars) return content;
	return content.slice(-maxChars);
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
			visible,
			runner,
			notifyOnExit: options.notifyOnExit !== false,
		};

		this.tasks.set(id, task);
		writeTaskMeta(task);

		if (visible) {
			void this.spawnVisibleTask(task, options.direction ?? DEFAULT_VISIBLE_DIRECTION, paths);
		} else {
			this.spawnInvisibleTask(task, command, cwd, paths.logFile);
		}

		return task;
	}

	private spawnInvisibleTask(task: InternalTask, command: string, cwd: string, logFile: string): void {
		const { shell, args } = getShellConfig();
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		task.pid = child.pid ?? undefined;
		task.child = child;

		const handleChunk = (chunk: Buffer) => {
			appendLogLine(logFile, chunk.toString());
			task.updatedAt = Date.now();
		};

		child.stdout?.on("data", handleChunk);
		child.stderr?.on("data", handleChunk);
		child.on("close", (code) => {
			this.finalizeTask(task, typeof code === "number" ? code : null, "self-exit");
		});
		child.on("error", (error) => {
			appendLogLine(logFile, `\n[spawn error] ${error.message}\n`);
			this.finalizeTask(task, 1, "self-exit");
		});

		if (process.platform !== "win32" && child.pid) {
			child.unref();
		}
	}

	private async spawnVisibleTask(
		task: InternalTask,
		direction: CmuxSplitDirection,
		paths: ReturnType<typeof buildVisibleTaskPaths>,
	): Promise<void> {
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
		}

		const respawnCommand = buildVisibleTaskCommand({
			cwd: task.cwd,
			command: task.command,
			paths,
			taskId: task.id,
			runner: task.runner,
		});

		const splitResult = await openCommandInNewSplitWithRefs(this.pi, direction, respawnCommand);
		if (!splitResult.ok) {
			appendLogLine(task.logFile, `\n[cmux error] ${splitResult.error}\n`);
			this.finalizeTask(task, 1, "self-exit");
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

		task.exitCode = exitCode;
		task.updatedAt = Date.now();

		if (reason === "stopped") {
			task.status = "stopped";
		} else if (exitCode === 0) {
			task.status = "completed";
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

	stopTask(task: InternalTask): { ok: true; message: string } | { ok: false; message: string } {
		if (task.status !== "running") {
			return { ok: false, message: `Task ${task.id} is already ${task.status}.` };
		}

		if (task.child?.pid) {
			try {
				if (process.platform !== "win32") {
					process.kill(-task.child.pid, "SIGTERM");
				} else {
					task.child.kill("SIGTERM");
				}
			} catch {
				try {
					task.child.kill("SIGKILL");
				} catch {
					// best effort
				}
			}
		} else if (task.visible && task.cmux) {
			void this.pi.exec(
				"cmux",
				["close-surface", "--workspace", task.cmux.workspaceRef, "--surface", task.cmux.surfaceRef],
				{ timeout: 5000 },
			);
		}

		this.finalizeTask(task, null, "stopped");
		return { ok: true, message: `Stopped background task ${task.id}.` };
	}

	clearFinishedTasks(): number {
		let removed = 0;
		for (const [id, task] of this.tasks) {
			if (task.status === "running") continue;
			if (task.pollTimer) {
				clearInterval(task.pollTimer);
			}
			this.tasks.delete(id);
			removed += 1;
		}
		return removed;
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
			if (task.pollTimer) {
				clearInterval(task.pollTimer);
			}
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
