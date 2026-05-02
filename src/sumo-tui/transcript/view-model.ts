import { renderCompactToolPill } from "./tool-renderer.js";

export type ChatMessageRole = "user" | "sumo" | "system";

export type ToolStatus = "pending" | "running" | "success" | "error" | "cancelled";
export type DelegationStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface ToolCallViewModel {
	readonly id?: string;
	readonly name: string;
	readonly status: ToolStatus;
	readonly input?: unknown;
	readonly output?: string;
	readonly details?: unknown;
	readonly error?: string;
	readonly expanded?: boolean;
}

export interface QuestionViewModel {
	readonly id?: string;
	readonly prompt: string;
	readonly choices: readonly string[];
	readonly selected?: string;
	readonly required?: boolean;
}

export interface DelegationViewModel {
	readonly id?: string;
	readonly title: string;
	readonly agent?: string;
	readonly status: DelegationStatus;
	readonly summary?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly nestedTools?: readonly ToolCallViewModel[];
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly elapsedMs?: number;
}

export type ChatBlock =
	| { readonly type: "markdown"; readonly text: string }
	| { readonly type: "thinking"; readonly text: string; readonly hidden?: boolean }
	| { readonly type: "code"; readonly lang: string; readonly source: string; readonly collapsed?: boolean }
	| { readonly type: "tool"; readonly tool: ToolCallViewModel }
	| { readonly type: "skill"; readonly name: string; readonly expanded: boolean }
	| { readonly type: "question"; readonly question: QuestionViewModel }
	| { readonly type: "delegation"; readonly delegation: DelegationViewModel };

export interface ChatMessageViewModel {
	readonly id: string;
	readonly role: ChatMessageRole;
	readonly displayName: string;
	readonly timestamp?: Date;
	readonly blocks: readonly ChatBlock[];
}

export interface TranscriptViewModel {
	readonly messages: readonly ChatMessageViewModel[];
}

const FENCED_CODE_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function timestampFrom(value: unknown): Date | undefined {
	if (value instanceof Date) return value;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
	if (typeof value === "string") {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return new Date(timestamp);
	}
	return undefined;
}

function messageId(record: Record<string, unknown>, fallbackIndex: number): string {
	return firstString(record.id, record.messageId, record.responseId, record.toolCallId) ?? `message-${fallbackIndex}`;
}

function roleFromMessage(record: Record<string, unknown>): ChatMessageRole {
	if (record.role === "user") return "user";
	if (record.role === "assistant") return "sumo";
	return "system";
}

function displayName(role: ChatMessageRole): string {
	if (role === "user") return "YOU";
	if (role === "sumo") return "SUMO";
	return "SYSTEM";
}

function normalizeStatus(value: unknown, fallback: ToolStatus): ToolStatus {
	if (value === "pending" || value === "running" || value === "success" || value === "error" || value === "cancelled") return value;
	if (value === "ok" || value === "done") return "success";
	if (value === "failed" || value === "failure") return "error";
	return fallback;
}

function normalizeDelegationStatus(value: unknown): DelegationStatus {
	if (value === "queued" || value === "running" || value === "success" || value === "error" || value === "cancelled") return value;
	if (value === "ok" || value === "done") return "success";
	if (value === "failed" || value === "failure") return "error";
	return "running";
}

export function markdownAndCodeBlocksFromText(text: string): ChatBlock[] {
	if (text.length === 0) return [];

	const blocks: ChatBlock[] = [];
	let cursor = 0;
	for (const match of text.matchAll(FENCED_CODE_PATTERN)) {
		const index = match.index ?? 0;
		const before = text.slice(cursor, index);
		if (before.length > 0) blocks.push({ type: "markdown", text: before });
		blocks.push({
			type: "code",
			lang: (match[1] ?? "").trim(),
			source: (match[2] ?? "").replace(/\n$/, ""),
		});
		cursor = index + match[0].length;
	}

	const after = text.slice(cursor);
	if (after.length > 0) blocks.push({ type: "markdown", text: after });
	return blocks.length > 0 ? blocks : [{ type: "markdown", text }];
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			if (!record || record.type !== "text") return undefined;
			return asString(record.text);
		})
		.filter((part): part is string => part !== undefined)
		.join("");
}

function thinkingBlockFromRecord(record: Record<string, unknown>): ChatBlock[] {
	const text = firstString(record.thinking, record.reasoning, record.text, record.content, record.delta);
	const hidden = record.hidden === true || record.redacted === true || record.encrypted === true;
	if (hidden && (!text || text.trim().length === 0)) return [{ type: "thinking", text: "Thinking...", hidden: true }];
	if (!text || text.trim().length === 0) return [];
	return [{ type: "thinking", text: text.trim(), ...(hidden ? { hidden: true } : {}) }];
}

function toolBlockFromRecord(record: Record<string, unknown>, fallbackStatus: ToolStatus): ChatBlock {
	const name = firstString(record.name, record.toolName, record.command) ?? "tool";
	const output = textFromContent(record.content) || asString(record.output);
	const error = asString(record.errorMessage) ?? asString(record.error);
	const isError = record.isError === true || error !== undefined;
	const expanded = asBoolean(record.expanded) ?? asBoolean(asRecord(record.details)?.expanded) ?? true;
	return {
		type: "tool",
		tool: {
			id: firstString(record.id, record.toolCallId),
			name,
			status: normalizeStatus(record.status, isError ? "error" : fallbackStatus),
			input: record.arguments ?? record.input ?? (record.command ? { command: record.command } : undefined),
			output,
			details: record.details,
			error,
			...(expanded === undefined ? {} : { expanded }),
		},
	};
}

function skillBlockFromRecord(record: Record<string, unknown>): ChatBlock {
	return {
		type: "skill",
		name: firstString(record.name, record.skill, record.skillName) ?? "unknown-skill",
		expanded: asBoolean(record.expanded) ?? false,
	};
}

function questionBlockFromRecord(record: Record<string, unknown>): ChatBlock {
	return {
		type: "question",
		question: {
			id: firstString(record.id, record.questionId),
			prompt: firstString(record.prompt, record.question, record.title, record.message) ?? "question",
			choices: asStringArray(record.choices).length > 0 ? asStringArray(record.choices) : asStringArray(record.options),
			selected: firstString(record.selected, record.defaultChoice),
			required: asBoolean(record.required),
		},
	};
}

function parseDelegationTools(value: unknown): ToolCallViewModel[] {
	if (!Array.isArray(value)) return [];
	const results: ToolCallViewModel[] = [];
	for (const item of value) {
		const r = asRecord(item);
		if (!r) continue;
		results.push({
			name: firstString(r.name, r.toolName) ?? "tool",
			status: normalizeStatus(r.status, "success") as ToolStatus,
			input: r.input ?? r.arguments,
			output: asString(r.output),
		});
	}
	return results;
}

function taskBlockFromRecord(record: Record<string, unknown>, fallbackStatus: ToolStatus): ChatBlock {
	// Pi built-in `task` tool call → Cathedral scroll/scribe (Element 12).
	// Extract title, agent metadata, and status from the task arguments/output.
	const args = asRecord(record.arguments ?? record.input);
	const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
	const firstTask = asRecord(tasks[0]);
	const model = firstString(
		firstTask?.model,
		args?.model,
		record.model,
	);
	const thinking = firstString(firstTask?.thinking, args?.thinking, record.thinking);
	const rawPrompt = firstString(firstTask?.prompt, args?.prompt, record.prompt) ?? "task";
	// Title: use first non-empty line, capped at 80 chars
	const firstLine = rawPrompt.split("\n").find((l) => l.trim().length > 0) ?? rawPrompt;
	const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
	// Status from toolResult output
	const outputText = (() => {
		const content = record.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const first = asRecord(content[0]);
			return asString(first?.text);
		}
		return undefined;
	})();
	const isError = record.isError === true;
	const status = isError ? "error" : fallbackStatus;
	return {
		type: "delegation",
		delegation: {
			id: firstString(record.id, record.toolCallId),
			title,
			agent: "scribe",
			model,
			thinking,
			status: normalizeDelegationStatus(status),
			summary: outputText ? outputText.split("\n").find((l) => l.trim().length > 0) : undefined,
			nestedTools: [],
			tokensIn: undefined,
			tokensOut: undefined,
			elapsedMs: undefined,
		},
	};
}

function delegationBlockFromRecord(record: Record<string, unknown>): ChatBlock {
	const details = asRecord(record.details);
	return {
		type: "delegation",
		delegation: {
			id: firstString(record.id, record.delegationId),
			title: firstString(record.title, record.name, record.agent, record.target) ?? "delegation",
			agent: firstString(record.agent, record.target),
			status: normalizeDelegationStatus(record.status),
			summary: firstString(record.summary, record.text, record.description),
			model: firstString(details?.model, record.model),
			thinking: firstString(details?.thinking, record.thinking),
			nestedTools: parseDelegationTools(details?.tools ?? record.tools),
			tokensIn: typeof (details?.tokensIn ?? record.tokensIn) === "number" ? (details?.tokensIn ?? record.tokensIn) as number : undefined,
			tokensOut: typeof (details?.tokensOut ?? record.tokensOut) === "number" ? (details?.tokensOut ?? record.tokensOut) as number : undefined,
			elapsedMs: typeof (details?.elapsedMs ?? record.elapsedMs) === "number" ? (details?.elapsedMs ?? record.elapsedMs) as number : undefined,
		},
	};
}

function blocksFromContentPart(part: unknown): ChatBlock[] {
	const record = asRecord(part);
	if (!record) return [];
	switch (record.type) {
		case "text":
			return markdownAndCodeBlocksFromText(asString(record.text) ?? "");
		case "thinking":
		case "reasoning":
		case "thinking_delta":
		case "reasoning_delta":
			return thinkingBlockFromRecord(record);
		case "toolCall":
		case "tool_call":
		case "tool":
			if (asString(record.name) === "task") return [taskBlockFromRecord(record, "running")];
			return [toolBlockFromRecord(record, record.status === "running" ? "running" : "pending")];
		case "toolResult":
		case "tool_result":
			if (asString(record.name) === "task") return [taskBlockFromRecord(record, "success")];
			return [toolBlockFromRecord(record, "success")];
		case "skill":
		case "skill_invocation":
			return [skillBlockFromRecord(record)];
		case "question":
		case "confirm":
		case "select":
			return [questionBlockFromRecord(record)];
		case "delegation":
		case "scroll":
		case "subagent":
			return [delegationBlockFromRecord(record)];
		default:
			return [];
	}
}

function blocksFromContent(content: unknown): ChatBlock[] {
	if (typeof content === "string") return markdownAndCodeBlocksFromText(content);
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => blocksFromContentPart(part));
}

function blocksFromMessage(record: Record<string, unknown>): ChatBlock[] {
	if (record.role === "bashExecution") {
		const status = record.cancelled === true ? "cancelled" : record.exitCode === 0 || record.exitCode === undefined ? "success" : "error";
		return [toolBlockFromRecord({ ...record, type: "tool", name: "bash", status }, status)];
	}
	if (record.role === "toolResult") {
		const toolName = firstString(asString(record.toolName), asString(record.name));
		if (toolName === "task") return [taskBlockFromRecord(record, "success")];
		return [toolBlockFromRecord(record, "success")];
	}
	if (record.role === "custom" && typeof record.customType === "string") {
		if (record.customType === "skill") return [skillBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "question") return [questionBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "delegation") return [delegationBlockFromRecord(asRecord(record.details) ?? record)];
	}

	const blocks = blocksFromContent(record.content);
	if (blocks.length > 0) return blocks;
	const errorMessage = asString(record.errorMessage);
	return errorMessage ? [{ type: "markdown", text: errorMessage }] : [];
}

export function chatMessageViewModelFromPiMessage(message: unknown, index = 0): ChatMessageViewModel | undefined {
	const record = asRecord(message);
	if (!record) return undefined;
	if (record.role === "custom" && record.display === false) return undefined;

	const role = roleFromMessage(record);
	const blocks = blocksFromMessage(record);
	return {
		id: messageId(record, index),
		role,
		displayName: displayName(role),
		timestamp: timestampFrom(record.timestamp),
		blocks: blocks.length > 0 ? blocks : [{ type: "markdown", text: "" }],
	};
}

export function transcriptFromSessionContext(sessionContext: unknown): TranscriptViewModel {
	const messages = asRecord(sessionContext)?.messages;
	if (!Array.isArray(messages)) return { messages: [] };
	return {
		messages: messages
			.map((message, index) => chatMessageViewModelFromPiMessage(message, index))
			.filter((message): message is ChatMessageViewModel => message !== undefined),
	};
}

export function chatMessageViewModelToPlainText(message: ChatMessageViewModel): string {
	return message.blocks
		.map((block) => {
			switch (block.type) {
				case "markdown":
					return block.text;
				case "thinking":
					return block.hidden ? "Thinking..." : block.text;
				case "code":
					return `\`\`\`${block.lang}\n${block.source}\n\`\`\``;
				case "tool":
					return renderCompactToolPill(block.tool);
				case "skill":
					return `[skill] ${block.name}${block.expanded ? " (expanded)" : " (⌘O to expand)"}`;
				case "question":
					return [`[question] ${block.question.prompt}`, ...block.question.choices.map((choice) => `- ${choice}`)].join("\n");
				case "delegation":
					return [`[scroll] ${block.delegation.title} · ${block.delegation.status}`, block.delegation.summary].filter(Boolean).join("\n");
			}
		})
		.join("\n");
}
