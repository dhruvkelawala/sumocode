import {
	safeValuePreview,
	sanitizeActivityText,
	type ActivityBody,
	type ActivitySnapshot,
	type ActivityStatus,
} from "./domain.js";
import {
	ACTIVITY_OUTPUT_MAX_BYTES,
	ACTIVITY_OUTPUT_MAX_LINES,
	boundedOutputTail,
} from "./output-tail.js";

export interface PiToolProjectionScope {
	readonly messageId: string;
	readonly blockIndex: number;
	readonly fallbackStatus?: ActivityStatus;
	/** Live event projectors set this so an uncorrelatable record is rejected. */
	readonly requireToolCallId?: boolean;
}

const MAX_ID_CHARS = 512;
const MAX_TITLE_CHARS = 512;
const MAX_SUBJECT_CHARS = 2 * 1024;
const MAX_COMMAND_CHARS = 4 * 1024;
const MAX_INVOCATION_CHARS = 4 * 1024;
const MAX_SOURCE_INSPECT_CHARS = ACTIVITY_OUTPUT_MAX_BYTES * 4;
const MAX_CONTENT_PARTS = 64;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedSanitizedHead(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const inspected = value.slice(0, Math.max(1, maxChars * 2));
	const sanitized = sanitizeActivityText(inspected).slice(0, maxChars).trim();
	return sanitized.length > 0 ? sanitized : undefined;
}

function firstString(maxChars: number, ...values: unknown[]): string | undefined {
	for (const value of values) {
		const sanitized = boundedSanitizedHead(value, maxChars);
		if (sanitized) return sanitized;
	}
	return undefined;
}

function firstContentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const inspected = Math.min(content.length, MAX_CONTENT_PARTS);
	for (let index = 0; index < inspected; index += 1) {
		const record = asRecord(content[index]);
		if (record?.type === "text" && typeof record.text === "string") return record.text;
	}
	return undefined;
}

/** Preserve the newest useful text parts without joining an unbounded MCP result. */
function tailFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return boundedOutputTail(content);
	if (!Array.isArray(content)) return undefined;
	let tail = "";
	let inspected = 0;
	for (let index = content.length - 1; index >= 0 && inspected < MAX_CONTENT_PARTS; index -= 1) {
		const record = asRecord(content[index]);
		if (record?.type !== "text" || typeof record.text !== "string") continue;
		inspected += 1;
		const part = boundedOutputTail(record.text);
		if (!part) continue;
		tail = boundedOutputTail(tail ? `${part}${tail}` : part);
		if (tail.length >= ACTIVITY_OUTPUT_MAX_BYTES) break;
	}
	return tail || undefined;
}

export function normalizePiActivityStatus(value: unknown, fallback: ActivityStatus = "queued"): ActivityStatus {
	if (value === "pending" || value === "queued") return "queued";
	if (value === "running") return "running";
	if (value === "success" || value === "succeeded" || value === "done" || value === "ok" || value === "completed") return "succeeded";
	if (value === "error" || value === "failed" || value === "failure") return "failed";
	if (value === "cancelled" || value === "canceled" || value === "aborted") return "cancelled";
	if (value === "lost") return "lost";
	return fallback;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceLineCount(text: string): number {
	let line = 1;
	let lastContentLine = 0;
	let currentHasContent = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (char === "\r" || char === "\n") {
			if (currentHasContent) lastContentLine = line;
			currentHasContent = false;
			line += 1;
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			continue;
		}
		currentHasContent = true;
	}
	return currentHasContent ? line : lastContentLine;
}

function boundedSourceHead(text: string, maxLines = ACTIVITY_OUTPUT_MAX_LINES): string {
	const sanitized = sanitizeActivityText(text.slice(0, MAX_SOURCE_INSPECT_CHARS));
	const lines = sanitized.split("\n").slice(0, maxLines);
	return lines.join("\n").slice(0, ACTIVITY_OUTPUT_MAX_BYTES);
}

function excerptText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	let raw = "";
	for (const item of value.slice(0, ACTIVITY_OUTPUT_MAX_LINES)) {
		if (typeof item !== "string") continue;
		const remaining = MAX_SOURCE_INSPECT_CHARS - raw.length;
		if (remaining <= 0) break;
		raw += `${raw ? "\n" : ""}${item.slice(0, remaining)}`;
	}
	return raw ? boundedSourceHead(raw) : undefined;
}

const READ_SHOWING_NOTICE = /\n\n\[Showing lines \d+-\d+ of (\d+)(?: \([^\n\]]+\))?\. Use offset=\d+ to continue\.\]\s*$/i;
const READ_REMAINING_NOTICE = /\n\n\[(\d+) more lines in file\. Use offset=\d+ to continue\.\]\s*$/i;

function projectReadOutput(output: string | undefined, startLine: number): { text?: string; totalLines?: number } {
	if (!output) return {};
	const showing = READ_SHOWING_NOTICE.exec(output);
	if (showing) return { text: output.slice(0, showing.index), totalLines: Number(showing[1]) };
	const remaining = READ_REMAINING_NOTICE.exec(output);
	if (remaining) {
		const text = output.slice(0, remaining.index);
		return { text, totalLines: startLine - 1 + sourceLineCount(text) + Number(remaining[1]) };
	}
	return { text: output, totalLines: startLine - 1 + sourceLineCount(output) };
}

function sourceBody(
	name: string,
	invocation: unknown,
	details: Record<string, unknown> | undefined,
	sourceOutput: string | undefined,
	outputTail: string | undefined,
	error: string | undefined,
): ActivityBody {
	const args = asRecord(invocation);
	const excerpt = excerptText(details?.excerpt);
	const invocationContent = name === "write" && typeof args?.content === "string" ? args.content : undefined;
	const startLine = finiteNumber(details?.startLine)
		?? (name === "read" ? finiteNumber(args?.offset) : undefined);
	const readOutput = name === "read" ? projectReadOutput(sourceOutput, startLine ?? 1) : undefined;
	const projectedOutput = readOutput?.text ?? sourceOutput;
	const rawText = invocationContent ?? excerpt ?? error ?? projectedOutput ?? outputTail ?? "";
	const text = boundedSourceHead(rawText);
	const truncation = asRecord(details?.truncation);
	const declaredTotal = finiteNumber(details?.totalLines) ?? finiteNumber(details?.lineCount);
	const truncationTotal = finiteNumber(truncation?.totalLines);
	const totalLines = declaredTotal
		?? (name === "read"
			? readOutput?.totalLines ?? truncationTotal
			: truncationTotal ?? sourceLineCount(rawText));
	return {
		kind: "source",
		text,
		...(startLine === undefined ? {} : { startLine }),
		...(totalLines === undefined ? {} : { totalLines }),
	};
}

function diffBody(details: Record<string, unknown> | undefined, output: string | undefined, error: string | undefined): ActivityBody {
	const rawDiff = details?.diff;
	const base = typeof rawDiff === "string"
		? boundedSourceHead(rawDiff)
		: excerptText(rawDiff) ?? error ?? output ?? "";
	const collapsedLines = finiteNumber(details?.collapsedLines);
	const collapsed = collapsedLines !== undefined && collapsedLines > 0
		? `… ${collapsedLines} lines collapsed`
		: undefined;
	return { kind: "diff", text: boundedSourceHead([base, collapsed].filter(Boolean).join("\n")) };
}

function terminalBody(invocation: unknown, output: string | undefined, error: string | undefined): ActivityBody {
	const args = asRecord(invocation);
	return {
		kind: "terminal",
		command: firstString(MAX_COMMAND_CHARS, args?.command),
		text: error ?? output ?? "",
	};
}

function genericBody(invocationPreview: string | undefined, output: string | undefined, error: string | undefined): ActivityBody {
	return {
		kind: "text",
		text: error ?? output ?? invocationPreview ?? "",
	};
}

function bodyForTool(
	name: string,
	rawInvocation: unknown,
	invocationPreview: string | undefined,
	sourceOutput: string | undefined,
	output: string | undefined,
	error: string | undefined,
	details: Record<string, unknown> | undefined,
): ActivityBody {
	if (name === "read" || name === "write") return sourceBody(name, rawInvocation, details, sourceOutput, output, error);
	if (name === "edit") return diffBody(details, output, error);
	if (name === "bash") return terminalBody(rawInvocation, output, error);
	return genericBody(invocationPreview, output, error);
}

function boundedInvocation(value: unknown): { readonly snapshot: unknown; readonly preview: string } {
	const preview = safeValuePreview(value, {
		maxChars: MAX_INVOCATION_CHARS,
		maxDepth: 6,
		maxEntries: 32,
		maxStringChars: 1_000,
		maxNodes: 256,
		maxTotalStringChars: MAX_INVOCATION_CHARS,
	});
	try {
		return { snapshot: JSON.parse(preview) as unknown, preview };
	} catch {
		return { snapshot: preview, preview };
	}
}

/** Project one ordinary Pi tool call/result record into the renderer-neutral domain. */
export function projectPiToolActivity(recordValue: unknown, scope: PiToolProjectionScope): ActivitySnapshot | undefined {
	const record = asRecord(recordValue);
	if (!record) return undefined;
	const toolCallId = firstString(MAX_ID_CHARS, record.toolCallId);
	if (scope.requireToolCallId && !toolCallId) return undefined;
	const fallbackScope = boundedSanitizedHead(scope.messageId, MAX_ID_CHARS) ?? "message";
	const fallbackId = `pi-tool:${fallbackScope}:${Math.max(0, Math.floor(scope.blockIndex))}`;
	const id = toolCallId ?? firstString(MAX_ID_CHARS, record.id) ?? fallbackId.slice(0, MAX_ID_CHARS);
	const name = firstString(MAX_TITLE_CHARS, record.name, record.toolName, record.command) ?? "tool";
	const rawInvocation = record.arguments ?? record.input ?? (record.command ? { command: record.command } : undefined);
	const invocation = rawInvocation === undefined ? undefined : boundedInvocation(rawInvocation);
	const details = asRecord(record.details);
	const contentOutput = tailFromContent(record.content);
	const directOutput = typeof record.output === "string" ? boundedOutputTail(record.output) : undefined;
	const output = contentOutput ?? directOutput;
	const sourceOutput = firstContentText(record.content) ?? (typeof record.output === "string" ? record.output : undefined);
	const declaredErrorRaw = firstString(ACTIVITY_OUTPUT_MAX_BYTES, record.errorMessage, record.error);
	const declaredError = declaredErrorRaw ? boundedOutputTail(declaredErrorRaw) : undefined;
	const isError = record.isError === true || declaredError !== undefined;
	const error = declaredError ?? (isError && output ? boundedOutputTail(output) : undefined);
	const fallback = isError ? "failed" : scope.fallbackStatus ?? "queued";
	const status = normalizePiActivityStatus(record.status, fallback);
	const args = asRecord(rawInvocation);
	const subject = firstString(MAX_SUBJECT_CHARS, args?.path, args?.filePath, args?.target, args?.command, details?.path, details?.filePath, details?.target, details?.command);
	const summary = firstString(ACTIVITY_OUTPUT_MAX_BYTES, details?.summary, details?.note, details?.description);
	return {
		id,
		kind: "tool",
		title: name,
		status: isError ? "failed" : status,
		...(invocation === undefined ? {} : { invocation: invocation.snapshot }),
		...(subject ? { subject } : {}),
		...(output ? { outputTail: output } : {}),
		body: bodyForTool(name, rawInvocation, invocation?.preview, sourceOutput, output, error, details),
		...(summary || error ? { result: { ...(summary ? { summary } : {}), ...(error ? { error } : {}) } } : {}),
	};
}
