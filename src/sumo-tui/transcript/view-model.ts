import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { expandKey } from "./expand-key.js";
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
	/** Initial task prompt/body shown in the outer [scroll] frame. */
	readonly prompt?: string;
	/** Live/final scribe output shown inside the scribe frame. */
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
	| { readonly type: "image"; readonly data: string; readonly mime: string; readonly filename?: string }
	| { readonly type: "tool"; readonly tool: ToolCallViewModel }
	| { readonly type: "skill"; readonly name: string; readonly expanded: boolean; readonly content?: string }
	| { readonly type: "summary"; readonly kind: "branch" | "compaction"; readonly label: string; readonly content: string; readonly expanded: boolean }
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

function authFailureHintFromMessage(record: Record<string, unknown>): string | undefined {
	const errorMessage = asString(record.errorMessage) ?? asString(record.error);
	const provider = asString(record.provider) ?? errorMessage?.match(/^No API key for provider: ([A-Za-z0-9_-]+)$/)?.[1];
	if (!errorMessage || !provider || !errorMessage.includes(`No API key for provider: ${provider}`)) return undefined;
	return `${provider} auth failed — run pi directly and /login to re-authenticate`;
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

function summaryBlockFromRecord(record: Record<string, unknown>, kind: "branch" | "compaction"): ChatBlock {
	const content = firstString(record.summary, record.text, asString(record.content)) ?? "";
	const tokens = typeof record.tokensBefore === "number" ? record.tokensBefore.toLocaleString() : undefined;
	const label = kind === "compaction"
		? (tokens ? `[compaction] Compacted from ${tokens} tokens` : "[compaction] Compacted")
		: "[branch] Branch summary";
	return { type: "summary", kind, label, content, expanded: false };
}

function imageBlockFromRecord(record: Record<string, unknown>): ChatBlock[] {
	const source = asRecord(record.source);
	const data = firstString(record.data, record.base64, record.base64Data, source?.data, source?.base64, source?.base64Data);
	const mime = firstString(record.mime, record.mimeType, record.mediaType, record.media_type, source?.mime, source?.mimeType, source?.mediaType, source?.media_type);
	if (!data || !mime) return [];
	return [{ type: "image", data, mime, filename: firstString(record.filename, record.name, source?.filename) }];
}

/**
 * Display-only collapse of image file paths in USER message text. The
 * Cathedral editor expands `[Image N]` tokens into (quoted, when spaced)
 * real paths on submit; showing those temp paths verbatim in the user card
 * is noise. Matches quoted paths (`"/…/Screenshot 2026….png"`) and bare
 * absolute/home paths ending in an image extension, replacing each with
 * `[Image: <basename>]`. Scoped to user-role display — assistant/tool text
 * is never rewritten (paths inside code or command output must stay exact).
 */
export function collapseImagePathsForDisplay(text: string): string {
	const pattern = /"((?:\/|~\/)[^"\n]+\.(?:png|jpe?g|gif|webp))"|(?<=^|\s)((?:\/|~\/)[^\s"'\n]+\.(?:png|jpe?g|gif|webp))(?=$|\s)/gim;
	return text.replace(pattern, (_match, quoted: string | undefined, bare: string | undefined) => {
		const path = quoted ?? bare ?? "";
		const basename = path.split("/").pop() ?? path;
		return `[Image: ${basename}]`;
	});
}

/**
 * Extract just the image blocks from a content array. Used for tool results
 * (e.g. Read on a PNG), whose text is folded into the tool pill's `output`
 * while any image parts would otherwise be dropped on the floor — they
 * become sibling image blocks so the chat card renders them (inline pixels
 * where supported, `[Image: …]` chip otherwise).
 */
function imageBlocksFromContent(content: unknown): ChatBlock[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		const record = asRecord(part);
		if (!record) return [];
		if (record.type === "image" || record.type === "input_image") return imageBlockFromRecord(record);
		return [];
	});
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

interface TaskMetadata {
	readonly id: string;
	readonly arguments?: Record<string, unknown>;
	readonly prompt?: string;
	readonly model?: string;
	readonly thinking?: string;
}

function taskRecordId(record: Record<string, unknown>): string | undefined {
	return firstString(record.id, record.toolCallId);
}

function isTaskToolRecord(record: Record<string, unknown>): boolean {
	return firstString(record.name, record.toolName) === "task";
}

function taskArgumentsFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
	return asRecord(record.arguments ?? record.input);
}

function firstTaskFromArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
	return asRecord(tasks[0]);
}

function taskMetadataFromRecord(record: Record<string, unknown>): TaskMetadata | undefined {
	if (!isTaskToolRecord(record)) return undefined;
	const id = taskRecordId(record);
	if (!id) return undefined;
	const args = taskArgumentsFromRecord(record);
	const firstTask = firstTaskFromArgs(args);
	return {
		id,
		arguments: args,
		prompt: firstString(firstTask?.prompt, firstTask?.task, args?.prompt, args?.task, record.prompt, record.task),
		model: firstString(firstTask?.model, args?.model, record.model),
		thinking: firstString(firstTask?.thinking, args?.thinking, record.thinking),
	};
}

function collectTaskMetadataFromRecord(record: Record<string, unknown>, cache: Map<string, TaskMetadata>): void {
	const metadata = taskMetadataFromRecord(record);
	if (metadata && (metadata.arguments || metadata.prompt || metadata.model || metadata.thinking)) cache.set(metadata.id, metadata);
	if (!Array.isArray(record.content)) return;
	for (const part of record.content) {
		const partRecord = asRecord(part);
		if (partRecord) collectTaskMetadataFromRecord(partRecord, cache);
	}
}

function enrichTaskRecordFromCache(record: Record<string, unknown>, cache: Map<string, TaskMetadata>): Record<string, unknown> {
	const id = taskRecordId(record);
	if (!id || !isTaskToolRecord(record)) return record;
	const metadata = cache.get(id);
	if (!metadata) return record;
	return {
		...record,
		arguments: record.arguments ?? record.input ?? metadata.arguments,
		prompt: record.prompt ?? metadata.prompt,
		model: record.model ?? metadata.model,
		thinking: record.thinking ?? metadata.thinking,
	};
}

function enrichTaskResultsFromCache(record: Record<string, unknown>, cache: Map<string, TaskMetadata>): Record<string, unknown> {
	const enriched = enrichTaskRecordFromCache(record, cache);
	if (!Array.isArray(enriched.content)) return enriched;
	return {
		...enriched,
		content: enriched.content.map((part) => {
			const partRecord = asRecord(part);
			return partRecord ? enrichTaskRecordFromCache(partRecord, cache) : part;
		}),
	};
}

function truncateTaskTitle(title: string): string {
	return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}

function taskPromptLines(rawPrompt: string): string[] {
	return rawPrompt
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^you(?: are|'re)\b/i.test(line));
}

function taskHeadingFromLine(line: string): string | undefined {
	return line.match(/^#{2,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
}

function taskTitleFromPrompt(rawPrompt: string): string {
	const lines = taskPromptLines(rawPrompt);
	const heading = lines
		.map(taskHeadingFromLine)
		.find((line): line is string => line !== undefined && line.length > 0);
	if (heading) return truncateTaskTitle(heading);

	const meaningful = lines.find((line) => line.length > 0);
	return truncateTaskTitle(meaningful ?? (rawPrompt.trim() || "task"));
}

function taskPromptBody(rawPrompt: string): string | undefined {
	const lines = taskPromptLines(rawPrompt);
	const headingIndex = lines.findIndex((line) => taskHeadingFromLine(line) !== undefined);
	const body = (headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines.slice(1))
		.filter((line) => taskHeadingFromLine(line) === undefined)
		.slice(0, 6);
	return body.length > 0 ? body.join("\n") : undefined;
}

function firstOutputLine(outputText: string | undefined): string | undefined {
	return outputText?.split("\n").find((line) => line.trim().length > 0);
}

function taskResultStatus(result: Record<string, unknown>, fallbackStatus: ToolStatus): DelegationStatus {
	const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
	const stopReason = asString(result.stopReason);
	if (exitCode === -2) return "queued";
	if (exitCode === -1) return "running";
	if (exitCode === undefined) return normalizeDelegationStatus(fallbackStatus);
	if (exitCode > 0 || stopReason === "error" || stopReason === "aborted") return stopReason === "aborted" ? "cancelled" : "error";
	return "success";
}

function textFromTaskMessages(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = asRecord(messages[index]);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const record = asRecord(part);
			if (record?.type === "text") return asString(record.text);
		}
	}
	return undefined;
}

function taskToolStatusFrom(value: unknown): ToolStatus {
	if (value === "success" || value === "error" || value === "cancelled" || value === "running" || value === "pending") return value;
	if (value === "Done") return "success";
	if (value === "Failed") return "error";
	if (value === "Running") return "running";
	return "pending";
}

function parseTaskToolEvents(value: unknown): ToolCallViewModel[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ToolCallViewModel[] => {
		const event = asRecord(item);
		if (!event) return [];
		return [{
			id: firstString(event.id, event.toolCallId),
			name: firstString(event.name, event.toolName) ?? "tool",
			status: taskToolStatusFrom(event.status),
			input: event.args ?? event.input ?? event.arguments,
			output: firstString(event.output, event.text),
		}];
	});
}

function parseTaskToolCallsFromMessages(messages: unknown): ToolCallViewModel[] {
	if (!Array.isArray(messages)) return [];
	const results = new Map<string, ToolCallViewModel>();
	for (const messageValue of messages) {
		const message = asRecord(messageValue);
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				const record = asRecord(part);
				if (record?.type !== "toolCall") continue;
				const id = firstString(record.id, record.toolCallId) ?? `${results.size}`;
				results.set(id, {
					id,
					name: firstString(record.name, record.toolName) ?? "tool",
					status: "running",
					input: record.arguments ?? record.input,
				});
			}
		}
		if (message.role === "toolResult") {
			const id = firstString(message.toolCallId, message.id) ?? `${results.size}`;
			const existing = results.get(id);
			results.set(id, {
				...existing,
				id,
				name: firstString(message.toolName, message.name, existing?.name) ?? "tool",
				status: message.isError === true ? "error" : "success",
				output: textFromContent(message.content) || asString(message.output),
			});
		}
	}
	return [...results.values()];
}

function aggregateTaskStatus(statuses: readonly DelegationStatus[]): DelegationStatus {
	if (statuses.includes("error")) return "error";
	if (statuses.includes("cancelled")) return "cancelled";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("queued")) return "running";
	return "success";
}

function taskResultLabel(result: Record<string, unknown>, index: number, total: number): string {
	if (total === 1) return "";
	const rawIndex = typeof result.index === "number" ? result.index : index + 1;
	return `Task ${rawIndex}: `;
}

function taskResultSummaryLine(result: Record<string, unknown>, index: number, total: number, status: DelegationStatus): string | undefined {
	const finalOutput = firstString(result.finalOutput, result.streamingText, textFromTaskMessages(result.messages));
	const errorText = firstString(result.errorMessage, result.stderr);
	const text = status === "running" || status === "queued"
		? firstOutputLine(finalOutput)
		: firstString(finalOutput, errorText);
	if (!text) return undefined;
	return `${taskResultLabel(result, index, total)}${text}`;
}

function taskPromptForResults(results: readonly Record<string, unknown>[], record: Record<string, unknown>): string | undefined {
	if (results.length === 0) return undefined;
	if (results.length === 1) return taskPromptBody(firstString(results[0]?.prompt, record.prompt) ?? "task");
	return results
		.map((result, index) => {
			const prompt = firstString(result.prompt, record.prompt) ?? "task";
			return `${taskResultLabel(result, index, results.length)}${taskTitleFromPrompt(prompt)}`;
		})
		.join("\n");
}

function numberFrom(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(values: readonly (number | undefined)[]): number | undefined {
	const numbers = values.filter((value): value is number => value !== undefined);
	return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : undefined;
}

function taskBlockFromDetails(record: Record<string, unknown>, fallbackStatus: ToolStatus): ChatBlock | undefined {
	const details = asRecord(record.details);
	const resultRecords = (Array.isArray(details?.results) ? details.results : [])
		.map(asRecord)
		.filter((result): result is Record<string, unknown> => result !== undefined);
	if (resultRecords.length === 0) return undefined;

	const firstResult = resultRecords[0]!;
	const statuses = resultRecords.map((result) => taskResultStatus(result, fallbackStatus));
	const status = aggregateTaskStatus(statuses);
	const summary = resultRecords
		.map((result, index) => taskResultSummaryLine(result, index, resultRecords.length, statuses[index]!))
		.filter((line): line is string => line !== undefined && line.trim().length > 0)
		.join("\n") || undefined;
	const nestedTools = resultRecords.flatMap((result) => {
		const toolEvents = parseTaskToolEvents(result.toolEvents);
		return toolEvents.length > 0 ? toolEvents : parseTaskToolCallsFromMessages(result.messages);
	});
	const tokensIn = sumNumbers(resultRecords.map((result) => numberFrom(asRecord(result.usage)?.input)));
	const tokensOut = sumNumbers(resultRecords.map((result) => numberFrom(asRecord(result.usage)?.output)));
	const prompt = firstString(firstResult.prompt, record.prompt) ?? "task";
	return {
		type: "delegation",
		delegation: {
			id: firstString(record.id, record.toolCallId),
			title: taskTitleFromPrompt(prompt),
			agent: "scribe",
			model: firstString(...resultRecords.map((result) => result.model), record.model),
			thinking: firstString(...resultRecords.map((result) => result.thinking), record.thinking),
			status,
			prompt: taskPromptForResults(resultRecords, record),
			summary,
			nestedTools,
			tokensIn,
			tokensOut,
			elapsedMs: undefined,
		},
	};
}

function taskBlockFromRecord(record: Record<string, unknown>, fallbackStatus: ToolStatus): ChatBlock {
	const fromDetails = taskBlockFromDetails(record, fallbackStatus);
	if (fromDetails) return fromDetails;
	// Pi task tool call → Cathedral scroll/scribe (Element 12).
	// Extract title, agent metadata, and status from the task arguments/output.
	const args = taskArgumentsFromRecord(record);
	const firstTask = firstTaskFromArgs(args);
	const model = firstString(
		firstTask?.model,
		args?.model,
		record.model,
	);
	const thinking = firstString(firstTask?.thinking, args?.thinking, record.thinking);
	const rawPrompt = firstString(firstTask?.prompt, firstTask?.task, args?.prompt, args?.task, record.prompt, record.task) ?? "task";
	const title = taskTitleFromPrompt(rawPrompt);
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
			prompt: taskPromptBody(rawPrompt),
			summary: firstOutputLine(outputText),
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
		case "image":
		case "input_image":
			return imageBlockFromRecord(record);
		case "toolCall":
		case "tool_call":
		case "tool":
			if (asString(record.name) === "task") return [taskBlockFromRecord(record, "running")];
			return [toolBlockFromRecord(record, record.status === "running" ? "running" : "pending")];
		case "toolResult":
		case "tool_result":
			if (asString(record.name) === "task") return [taskBlockFromRecord(record, "success")];
			return [toolBlockFromRecord(record, "success"), ...imageBlocksFromContent(record.content)];
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
	if (record.role === "branchSummary") return [summaryBlockFromRecord(record, "branch")];
	if (record.role === "compactionSummary") return [summaryBlockFromRecord(record, "compaction")];
	if (record.role === "bashExecution") {
		const status = record.cancelled === true ? "cancelled" : record.exitCode === 0 || record.exitCode === undefined ? "success" : "error";
		return [toolBlockFromRecord({ ...record, type: "tool", name: "bash", status }, status)];
	}
	if (record.role === "toolResult") {
		const toolName = firstString(asString(record.toolName), asString(record.name));
		if (toolName === "task") return [taskBlockFromRecord(record, "success")];
		return [toolBlockFromRecord(record, "success"), ...imageBlocksFromContent(record.content)];
	}
	if (record.role === "custom" && typeof record.customType === "string") {
		if (record.customType === "skill") return [skillBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "question") return [questionBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "delegation") return [delegationBlockFromRecord(asRecord(record.details) ?? record)];
		// Unrecognized custom type: preserve provenance (mirrors Pi's CustomMessageComponent default).
		const labeled: ChatBlock[] = [{ type: "markdown", text: `[${record.customType}]` }];
		labeled.push(...blocksFromContent(record.content));
		return labeled;
	}

	if (record.role === "user") {
		const text = textFromContent(record.content);
		const skill = parseSkillBlock(text);
		if (skill) {
			const blocks: ChatBlock[] = [{ type: "skill", name: skill.name, expanded: false, content: skill.content }];
			if (skill.userMessage) blocks.push(...markdownAndCodeBlocksFromText(skill.userMessage));
			return blocks;
		}
		// Display-only: the editor collapses pasted screenshots to [Image N]
		// but expands them back to (quoted) paths on submit for the agent.
		// Mirror the collapse in the transcript so the user card shows a
		// compact tag instead of a wall of temp path. The underlying message
		// (what the agent and session file contain) is untouched.
		const display = collapseImagePathsForDisplay(text);
		if (display !== text) return markdownAndCodeBlocksFromText(display);
	}

	const blocks = blocksFromContent(record.content);
	if (blocks.length > 0) return blocks;
	const authFailureHint = authFailureHintFromMessage(record);
	if (authFailureHint) return [{ type: "markdown", text: authFailureHint }];
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

export interface TranscriptViewModelMapper {
	reset(): void;
	messageFromPiMessage(message: unknown, index?: number): ChatMessageViewModel | undefined;
	transcriptFromSessionContext(sessionContext: unknown): TranscriptViewModel;
}

export function createTranscriptViewModelMapper(): TranscriptViewModelMapper {
	const taskMetadata = new Map<string, TaskMetadata>();
	return {
		reset(): void {
			taskMetadata.clear();
		},
		messageFromPiMessage(message: unknown, index = 0): ChatMessageViewModel | undefined {
			const record = asRecord(message);
			if (!record) return undefined;
			const enriched = enrichTaskResultsFromCache(record, taskMetadata);
			const viewModel = chatMessageViewModelFromPiMessage(enriched, index);
			collectTaskMetadataFromRecord(enriched, taskMetadata);
			return viewModel;
		},
		transcriptFromSessionContext(sessionContext: unknown): TranscriptViewModel {
			const messages = asRecord(sessionContext)?.messages;
			if (!Array.isArray(messages)) return { messages: [] };
			return {
				messages: messages
					.map((message, index) => this.messageFromPiMessage(message, index))
					.filter((message): message is ChatMessageViewModel => message !== undefined),
			};
		},
	};
}

export function transcriptFromSessionContext(sessionContext: unknown): TranscriptViewModel {
	const mapper = createTranscriptViewModelMapper();
	return mapper.transcriptFromSessionContext(sessionContext);
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
				case "image":
					return `[image] ${block.mime}`;
				case "tool":
					return renderCompactToolPill(block.tool);
				case "skill":
					return `[skill] ${block.name}${block.expanded ? " (expanded)" : ` (${expandKey()} to expand)`}`;
				case "summary":
					return block.label;
				case "question":
					return [`[question] ${block.question.prompt}`, ...block.question.choices.map((choice) => `- ${choice}`)].join("\n");
				case "delegation":
					return [`[scroll] ${block.delegation.title} · ${block.delegation.status}`, block.delegation.summary].filter(Boolean).join("\n");
			}
		})
		.join("\n");
}
