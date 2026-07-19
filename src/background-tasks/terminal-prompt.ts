import type { BackgroundTaskSnapshot } from "./task-types.js";

export const TERMINAL_TOOL_GUIDELINES = [
	"Use bg_start for servers, watchers, long builds, and other shell commands that should continue while you work; use bash for quick commands.",
	"After bg_start returns, keep working. A typed completion message with the final output tail arrives automatically when the terminal exits.",
	"Background terminals receive no stdin. Never use bg_start for interactive commands, prompts, or terminal user interfaces.",
] as const;

export const BG_START_DESCRIPTION = [
	"Start a long-running shell command as a background terminal and return immediately with its id.",
	"The command receives no stdin, so interactive commands do not work.",
	"A typed message containing tail-truncated final output arrives when it exits; the full log remains on disk.",
].join(" ");

export const BG_STATUS_DESCRIPTION = "Peek at a background terminal's status and current output tail without blocking.";

export const BG_KILL_DESCRIPTION =
	"Stop one or more running background terminals with SIGTERM to each process group, escalating to SIGKILL when needed.";

export const BG_LIST_DESCRIPTION = "List all background terminals with pid, elapsed time, and exit status.";

const STATUS_OUTPUT_BUDGET = 16 * 1024;
const COMPLETION_OUTPUT_BUDGET = 8 * 1024;

function truncateTail(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `[output tail truncated]\n${value.slice(-maxChars)}`;
}

function elapsedText(task: BackgroundTaskSnapshot, now = Date.now()): string {
	const end = task.status === "running" ? now : task.updatedAt;
	const elapsedMs = Math.max(0, end - task.startedAt);
	if (elapsedMs < 1_000) return `${elapsedMs}ms`;
	const seconds = Math.floor(elapsedMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

function terminalTitle(task: BackgroundTaskSnapshot): string {
	return task.title?.trim() || task.command;
}

function terminalExit(task: BackgroundTaskSnapshot): string {
	if (task.status === "running") return "running";
	if (task.status === "stopped") return "stopped";
	return `exited (${task.exitCode ?? "unknown"})`;
}

export function buildStartResult(task: BackgroundTaskSnapshot): string {
	return [
		`Started background terminal ${task.id} · ${terminalTitle(task)}.`,
		`pid: ${task.pid ?? "pending"} · cwd: ${task.cwd}`,
		"stdin: unavailable — interactive commands will not work",
		`Full log: ${task.logFile}`,
	].join("\n");
}

export function describeTerminal(task: BackgroundTaskSnapshot): string {
	return [
		task.id,
		terminalTitle(task),
		terminalExit(task),
		`pid ${task.pid ?? "—"}`,
		`elapsed ${elapsedText(task)}`,
	].join(" · ");
}

export function buildStatusResult(task: BackgroundTaskSnapshot, output: string): string {
	const tail = truncateTail(output.trimEnd(), STATUS_OUTPUT_BUDGET);
	return [
		describeTerminal(task),
		`cwd: ${task.cwd}`,
		`Full log: ${task.logFile}`,
		"",
		"Output tail:",
		tail || "(no output)",
	].join("\n");
}

export function buildTerminalResultMessage(task: BackgroundTaskSnapshot, output: string): string {
	const tail = truncateTail(output.trimEnd(), COMPLETION_OUTPUT_BUDGET);
	return [
		`Background terminal ${task.id} "${terminalTitle(task)}" ${terminalExit(task)}.`,
		`elapsed: ${elapsedText(task)} · cwd: ${task.cwd}`,
		"",
		"Final output tail:",
		tail || "(no output)",
		"",
		`Full log: ${task.logFile}`,
	].join("\n");
}
