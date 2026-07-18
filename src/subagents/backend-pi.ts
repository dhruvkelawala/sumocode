import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SubagentEvent } from "./domain.js";
import { resolveTaskConfig } from "../native-task-config.js";
import { isRecord, type TaskThinking, type ThinkingLevel } from "../native-task-params.js";

const BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
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
				tokens: messageValue.usage?.totalTokens,
				contextWindow: messageValue.usage?.input,
				costUsd: messageValue.usage?.cost?.total,
			});
		}
		return events;
	}
	return [];
};

const attachAbortSignal = (proc: ChildProcessWithoutNullStreams, signal: AbortSignal | undefined): { isAborted: () => boolean; interrupt: () => void } => {
	let aborted = false;
	const interrupt = () => {
		aborted = true;
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
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
	signal?: AbortSignal;
}): SpawnedChild => {
	const config = resolveTaskConfig({
		item: { prompt: options.prompt, model: options.model, thinking: options.thinking as TaskThinking | undefined, fork: false },
		defaultModel: undefined,
		defaultThinking: "inherit",
		inheritedThinking: (options.inherited.thinking ?? "low") as ThinkingLevel,
		ctxModel: options.inherited.model,
		builtInTools: [...BUILT_IN_TOOLS],
	});
	if (!config.ok) {
		return {
			events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: config.error } }),
			interrupt: () => undefined,
		};
	}

	let interrupt = () => undefined;
	const events = (emit: (event: SubagentEvent) => void): void => {
		emit({ kind: "run-started" });
		const proc = spawnImpl("pi", [...config.subprocessArgs, options.prompt], {
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
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
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (abortState.isAborted()) {
				emit({ kind: "run-settled", outcome: { kind: "interrupted", partialText: finalAssistantText || undefined } });
				return;
			}
			if ((code ?? 0) === 0 && stopReason !== "error" && finalAssistantText) {
				emit({ kind: "run-settled", outcome: { kind: "completed", finalText: finalAssistantText } });
				return;
			}
			emit({
				kind: "run-settled",
				outcome: {
					kind: "failed",
					errorText: (errorMessage || stderr || `pi exited with code ${code ?? 0}`).slice(0, ERROR_MAX),
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
