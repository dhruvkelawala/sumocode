import { sanitizeActivityText, type ActivitySnapshot, type ActivityStatus } from "../activity/domain.js";

export const TERMINAL_TASK_SCHEMA_VERSION = 4;

export type TerminalTaskStatus =
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "lost";

export type TerminalCompletionPolicy = "passive" | "wake";
export type TerminalDeliveryState = "none" | "pending" | "claimed" | "delivered" | "suppressed";

export interface TerminalTaskSnapshot {
	readonly schemaVersion: number;
	readonly revision: number;
	readonly id: string;
	readonly ownerSessionId: string;
	readonly command: string;
	readonly cwd: string;
	readonly title: string;
	readonly status: TerminalTaskStatus;
	readonly completionPolicy: TerminalCompletionPolicy;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly settledAt?: number;
	readonly exitCode?: number | null;
	readonly observedAt?: number;
	readonly consumedAt?: number;
	readonly deliveryState: TerminalDeliveryState;
	readonly completionId?: string;
	readonly pid?: number;
	readonly processGroupId?: number;
	readonly processStartTime?: string;
	readonly logFile: string;
}

export interface StartTerminalTaskOptions {
	readonly ownerSessionId: string;
	readonly command: string;
	readonly cwd: string;
	readonly title: string;
	readonly completionPolicy?: TerminalCompletionPolicy;
}

export interface TerminalTaskObservation {
	readonly task: TerminalTaskSnapshot;
	readonly output: string;
}

export interface TerminalWaitResult {
	readonly settled: readonly TerminalTaskObservation[];
	readonly pendingIds: readonly string[];
	readonly unknownIds: readonly string[];
	readonly timedOut: boolean;
}

export interface TerminalStopResult {
	readonly id: string;
	readonly outcome: "cancelled" | "already-settled" | "unknown" | "failed";
	readonly task?: TerminalTaskSnapshot;
	readonly output?: string;
	readonly message: string;
}

const SETTLED_STATUSES = new Set<TerminalTaskStatus>(["completed", "failed", "cancelled", "lost"]);

export function isTerminalTaskSettled(status: TerminalTaskStatus): boolean {
	return SETTLED_STATUSES.has(status);
}

export function terminalActivityStatus(status: TerminalTaskStatus): ActivityStatus {
	switch (status) {
		case "starting":
			return "queued";
		case "running":
		case "stopping":
			return "running";
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "lost":
			return "lost";
	}
}

const LEGACY_WAKE_MESSAGE_PATTERN = /^background task bg-[\w-]+ \w[\w-]*: /;

/** Historical transcript compatibility only; no callable bg tool is retained. */
export function isBackgroundTaskWakeMessage(text: string): boolean {
	return LEGACY_WAKE_MESSAGE_PATTERN.test(text);
}

export function terminalActivitySnapshot(task: TerminalTaskSnapshot, outputTail: string): ActivitySnapshot {
	const title = sanitizeActivityText(task.title).slice(0, 512);
	const command = sanitizeActivityText(task.command).slice(0, 4 * 1024);
	const cwd = sanitizeActivityText(task.cwd).slice(0, 2 * 1024);
	const output = sanitizeActivityText(outputTail).slice(-8 * 1024);
	return {
		id: task.id,
		kind: "terminal",
		title,
		status: terminalActivityStatus(task.status),
		invocation: { command, cwd },
		subject: cwd,
		currentStep: task.status === "stopping" ? "stopping" : undefined,
		outputTail: output,
		body: { kind: "terminal", command, text: output },
		result: task.status === "failed" || task.status === "lost"
			? { error: task.status === "lost" ? "terminal process was lost" : `terminal exited with code ${task.exitCode ?? "unknown"}` }
			: task.status === "completed" || task.status === "cancelled"
				? { summary: task.status === "cancelled" ? "terminal cancelled" : `terminal exited with code ${task.exitCode ?? 0}` }
				: undefined,
		ownerSessionId: task.ownerSessionId,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		settledAt: task.settledAt,
		metrics: task.settledAt === undefined ? undefined : { elapsedMs: Math.max(0, task.settledAt - task.createdAt) },
	};
}
