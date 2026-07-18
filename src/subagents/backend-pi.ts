import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SubagentEvent } from "./domain.js";
import { type BuiltInToolName, resolveTaskConfig } from "../native-task-config.js";
import { isRecord, type TaskThinking, type ThinkingLevel } from "../native-task-params.js";

/** Fallback only — callers should thread the parent's active tool set through. */
const DEFAULT_BUILT_IN_TOOLS: readonly BuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"] as BuiltInToolName[];
const PREVIEW_MAX = 160;
const ERROR_MAX = 4096;

export interface SpawnedChild {
	readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
	readonly sessionFilePath?: string;
	interrupt(): void;
}

type SpawnLike = typeof nodeSpawn;

interface Message {
	role: "assistant" | "user" | "toolResult";
	content?: unknown;
	text?: unknown;
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
	stopReason?: unknown;
	errorMessage?: unknown;
}

const sanitizePreview = (value: unknown, max = PREVIEW_MAX): string | undefined => {
	if (value === undefined) return undefined;
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	const flattened = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\t\r\n]+/g, " ").trim();
	return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
};

const stringifyToolOutput = (value: unknown): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		const content = value.content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined)
				.filter((part): part is string => part !== undefined)
				.join("\n");
			if (text.trim().length > 0) return text;
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
	if (!line.trim()) return undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const isMessage = (value: unknown): value is Message => {
	return isRecord(value) && (value.role === "assistant" || value.role === "user" || value.role === "toolResult");
};

const messageText = (message: Message): string => {
	if (typeof message.text === "string") return message.text;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
			.join("");
	}
	return "";
};

const mapPiEvent = (event: Record<string, unknown>): SubagentEvent[] => {
	const typeText = typeof event.type === "string" ? event.type : "";
	if (typeText === "message_update") {
		const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			return [{ kind: "assistant-delta", delta: assistantEvent.delta }];
		}
	}
	if (typeText === "tool_execution_start") {
		return [{
			kind: "tool-start",
			toolId: typeof event.toolCallId === "string" ? event.toolCallId : `${event.toolName ?? "tool"}`,
			name: typeof event.toolName === "string" ? event.toolName : "tool",
			argsPreview: sanitizePreview(event.args),
		}];
	}
	if (typeText === "tool_execution_update") {
		return [{
			kind: "tool-update",
			toolId: typeof event.toolCallId === "string" ? event.toolCallId : `${event.toolName ?? "tool"}`,
			outputPreview: sanitizePreview(stringifyToolOutput(event.partialResult)),
		}];
	}
	if (typeText === "tool_execution_end") {
		return [{
			kind: "tool-end",
			toolId: typeof event.toolCallId === "string" ? event.toolCallId : `${event.toolName ?? "tool"}`,
			name: typeof event.toolName === "string" ? event.toolName : "tool",
			isError: event.isError === true,
			outputPreview: sanitizePreview(stringifyToolOutput(event.result)),
		}];
	}
	const messageValue = event.message;
	if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage(messageValue)) {
		const events: SubagentEvent[] = [{ kind: "message-end", role: messageValue.role, text: messageText(messageValue) }];
		if (messageValue.role === "assistant") {
			events.push({
				kind: "usage",
				// totalTokens is the child's cumulative context occupancy; the JSON
				// event stream does not carry the model's context-window capacity,
				// so leave contextWindow unset rather than mislabeling input tokens.
				tokens: messageValue.usage?.totalTokens,
				costUsd: messageValue.usage?.cost?.total,
			});
		}
		return events;
	}
	return [];
};

/**
 * Signal the child's whole PROCESS GROUP on POSIX (negative pid), falling back
 * to the single pid. Signalling only the `pi` pid leaves tool grandchildren
 * (e.g. a long-running command under the child's bash tool) alive and mutating
 * files after a cancel — the same reason background-tasks' task-manager uses
 * `signalProcessOrGroup`. Requires the child to be spawned `detached` so it
 * leads its own group.
 */
const signalGroup = (proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
	if (process.platform !== "win32" && proc.pid != null) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// group gone or not a leader — fall through to single-pid kill
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// process already gone
	}
};

const attachAbortSignal = (proc: ChildProcessWithoutNullStreams, signal: AbortSignal | undefined): { isAborted: () => boolean; interrupt: () => void } => {
	let aborted = false;
	// `proc.killed` only means a signal was successfully SENT, not that the
	// process exited — gating SIGKILL on it means a child that ignores SIGTERM
	// is never force-killed. Track real exit via the close event instead.
	let exited = false;
	proc.once("close", () => {
		exited = true;
	});
	const interrupt = () => {
		aborted = true;
		signalGroup(proc, "SIGTERM");
		setTimeout(() => {
			if (!exited) signalGroup(proc, "SIGKILL");
		}, 5000).unref?.();
	};
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });
	return { isAborted: () => aborted, interrupt };
};

export const createPiChildSpawner = (spawnImpl: SpawnLike = nodeSpawn) => (options: {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	inherited: { model?: { provider: string; id: string }; thinking?: string };
	builtInTools?: readonly BuiltInToolName[];
	signal?: AbortSignal;
}): SpawnedChild => {
	const config = resolveTaskConfig({
		item: { prompt: options.prompt, model: options.model, thinking: options.thinking as TaskThinking | undefined, fork: false },
		defaultModel: undefined,
		defaultThinking: "inherit",
		inheritedThinking: (options.inherited.thinking ?? "low") as ThinkingLevel,
		ctxModel: options.inherited.model,
		// Children inherit the PARENT's active built-in tool set (mirroring
		// native-task-tool's getActiveTools threading) so a narrowed parent
		// session cannot spawn children with broader tool access.
		//
		// TRUST MODEL (conscious, documented — parity with native-task): children
		// run --no-extensions, so SumoCode's approval gate is NOT installed in
		// them. A headless child has no UI to prompt anyway; a child-side gate
		// would hang or fail-closed all bash including legitimate worktree git
		// work. The model-facing guidelines warn against delegating destructive
		// commands; a non-interactive child-side deny-list is a possible future
		// opt-in, tracked in plan 065's maintenance notes.
		builtInTools: [...(options.builtInTools ?? DEFAULT_BUILT_IN_TOOLS)],
	});
	if (!config.ok) {
		return {
			events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: config.error } }),
			interrupt: () => undefined,
		};
	}

	let interrupt: () => void = () => undefined;
	const events = (emit: (event: SubagentEvent) => void): void => {
		emit({ kind: "run-started" });
		const proc = spawnImpl("pi", [...config.subprocessArgs, options.prompt], {
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX so interrupt/SIGKILL can signal the
			// whole tree (see signalGroup) instead of just the pi pid.
			detached: process.platform !== "win32",
		}) as ChildProcessWithoutNullStreams;
		proc.stdin.end();
		const abortState = attachAbortSignal(proc, options.signal);
		interrupt = abortState.interrupt;
		let stdoutBuffer = "";
		let stderr = "";
		let finalAssistantText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		const processLine = (line: string) => {
			const parsed = parseJsonLine(line);
			if (!parsed) return;
			for (const event of mapPiEvent(parsed)) {
				if (event.kind === "message-end" && event.role === "assistant") finalAssistantText = event.text;
				emit(event);
			}
			const messageValue = parsed.message;
			if (isMessage(messageValue) && messageValue.role === "assistant") {
				if (typeof messageValue.stopReason === "string") stopReason = messageValue.stopReason;
				if (typeof messageValue.errorMessage === "string") errorMessage = messageValue.errorMessage;
			}
		};
		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code, closeSignal) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (abortState.isAborted()) {
				emit({ kind: "run-settled", outcome: { kind: "interrupted", partialText: finalAssistantText || undefined } });
				return;
			}
			// Success gates on exit code + stop reason, matching native-task-tool's
			// isTaskError semantics. Empty final text at exit 0 is a successful run
			// with empty output, not a failure. Strictly `code === 0`: a null code
			// means the child was killed by an EXTERNAL signal (operator kill,
			// host cleanup) — that must never fold as completed.
			if (code === 0 && stopReason !== "error" && stopReason !== "aborted") {
				emit({ kind: "run-settled", outcome: { kind: "completed", finalText: finalAssistantText } });
				return;
			}
			emit({
				kind: "run-settled",
				outcome: {
					kind: "failed",
					errorText: (errorMessage || stderr || (closeSignal ? `pi killed by ${closeSignal}` : `pi exited with code ${code ?? "unknown"}`)).slice(0, ERROR_MAX),
					partialText: finalAssistantText || undefined,
				},
			});
		});
		proc.on("error", (error) => {
			emit({ kind: "run-settled", outcome: { kind: "failed", errorText: error.message.slice(0, ERROR_MAX), partialText: finalAssistantText || undefined } });
		});
	};
	return { events, interrupt: () => interrupt() };
};

export const spawnPiChild = createPiChildSpawner();
