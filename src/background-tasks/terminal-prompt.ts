import { sanitizeActivityText } from "../activity/domain.js";
import type { TerminalStopResult, TerminalTaskObservation, TerminalTaskSnapshot, TerminalWaitResult } from "./task-types.js";

export const TERMINAL_TOOL_GUIDELINES = [
	"Use terminal_start for servers, watchers, long builds, and other non-interactive shell commands that should continue while you work; use bash for quick commands.",
	"terminal_start completion is passive by default and never triggers an agent turn. Use completion: wake only when the terminal result must resume work automatically.",
	"Use terminal_check for a non-blocking snapshot, terminal_wait for explicit bounded waiting, terminal_stop to cancel process trees, and terminal_list for a side-effect-free inventory.",
	"Managed terminals receive no stdin. Never use terminal_start for interactive commands, prompts, or terminal user interfaces.",
] as const;

export const TERMINAL_TOOL_DESCRIPTIONS = {
	start: "Start a non-interactive shell command in a durable managed terminal and return its stable id immediately. Completion is passive unless completion is set to wake.",
	check: "Return one current or final immutable terminal snapshot and a bounded output tail without blocking. Observing settlement suppresses an unclaimed wake.",
	wait: "Wait for all requested terminal ids, or return settled and pending ids normally when the bounded timeout expires. Aborting cancels only this wait.",
	stop: "Signal every requested running terminal process tree, escalate after the grace period, and report cancellation only after each whole tree is gone.",
	list: "List current-session managed terminals newest first, including completion disposition, without observing or consuming them.",
} as const;

function bounded(value: string, maxChars: number): string {
	const clean = sanitizeActivityText(value).trimEnd();
	if (clean.length <= maxChars) return clean;
	return `[output tail truncated]\n${clean.slice(-maxChars)}`;
}

function elapsed(task: TerminalTaskSnapshot): string {
	const end = task.settledAt ?? task.updatedAt;
	const milliseconds = Math.max(0, end - task.createdAt);
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	const seconds = Math.floor(milliseconds / 1_000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function describeTerminal(task: TerminalTaskSnapshot): string {
	const exit = task.exitCode === undefined ? "" : ` · exit ${task.exitCode ?? "unknown"}`;
	return `${task.id} · ${task.status}${exit} · ${task.deliveryState} · ${elapsed(task)} · ${sanitizeActivityText(task.title)}`;
}

export function buildStartResult(task: TerminalTaskSnapshot): string {
	return [
		`Started terminal ${task.id} · ${sanitizeActivityText(task.title)}.`,
		`status: ${task.status} · completion: ${task.completionPolicy} · pid: ${task.pid ?? "pending"}`,
		`cwd: ${sanitizeActivityText(task.cwd)}`,
		"stdin: unavailable — interactive commands will not work",
		`Full log: ${task.logFile}`,
	].join("\n");
}

export function buildObservationResult(observation: TerminalTaskObservation): string {
	return [
		describeTerminal(observation.task),
		`cwd: ${sanitizeActivityText(observation.task.cwd)}`,
		`Full log: ${observation.task.logFile}`,
		"",
		"Output tail:",
		bounded(observation.output, 16 * 1024) || "(no output)",
	].join("\n");
}

export function buildWaitResult(result: TerminalWaitResult): string {
	const sections = result.settled.map(buildObservationResult);
	const summary = [
		`settled: ${result.settled.map(({ task }) => task.id).join(", ") || "none"}`,
		`pending: ${result.pendingIds.join(", ") || "none"}`,
		`unknown: ${result.unknownIds.join(", ") || "none"}`,
		`timed out: ${result.timedOut ? "yes" : "no"}`,
	].join("\n");
	return [summary, ...sections].join("\n\n---\n\n");
}

export function buildStopResult(results: readonly TerminalStopResult[]): string {
	return results.map((result) => {
		const output = result.output ? `\n${bounded(result.output, 8 * 1024)}` : "";
		return `${result.message}${output}`;
	}).join("\n\n");
}

export function buildTerminalResultMessage(task: TerminalTaskSnapshot, output: string): string {
	return [
		`Terminal ${task.id} "${sanitizeActivityText(task.title)}" ${task.status}.`,
		`exit: ${task.exitCode ?? "unknown"} · elapsed: ${elapsed(task)} · cwd: ${sanitizeActivityText(task.cwd)}`,
		"",
		"Final output tail:",
		bounded(output, 8 * 1024) || "(no output)",
		"",
		`Full log: ${task.logFile}`,
	].join("\n");
}
