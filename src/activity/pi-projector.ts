import {
	safeValuePreview,
	sanitizeActivityText,
	type ActivityBody,
	type ActivitySnapshot,
	type ActivityStatus,
} from "./domain.js";

export interface PiToolProjectionScope {
	readonly messageId: string;
	readonly blockIndex: number;
	readonly fallbackStatus?: ActivityStatus;
	/** Live event projectors set this so an uncorrelatable record is rejected. */
	readonly requireToolCallId?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const sanitized = sanitizeActivityText(value).trim();
		if (sanitized.length > 0) return sanitized;
	}
	return undefined;
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return sanitizeActivityText(content);
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part): string[] => {
		const record = asRecord(part);
		return record?.type === "text" && typeof record.text === "string" ? [sanitizeActivityText(record.text)] : [];
	}).join("");
	return text.length > 0 ? text : undefined;
}

export function normalizePiActivityStatus(value: unknown, fallback: ActivityStatus = "queued"): ActivityStatus {
	if (value === "pending" || value === "queued") return "queued";
	if (value === "running") return "running";
	if (value === "success" || value === "done" || value === "ok" || value === "completed") return "succeeded";
	if (value === "error" || value === "failed" || value === "failure") return "failed";
	if (value === "cancelled" || value === "canceled" || value === "aborted") return "cancelled";
	if (value === "lost") return "lost";
	return fallback;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map(sanitizeActivityText);
}

function sourceLineCount(text: string): number {
	const lines = text.split("\n");
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines.length;
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
	output: string | undefined,
	error: string | undefined,
): ActivityBody {
	const args = asRecord(invocation);
	const excerpt = stringArray(details?.excerpt);
	const invocationContent = name === "write" && typeof args?.content === "string"
		? sanitizeActivityText(args.content)
		: undefined;
	const startLine = typeof details?.startLine === "number"
		? details.startLine
		: name === "read" && typeof args?.offset === "number" ? args.offset : undefined;
	const readOutput = name === "read" ? projectReadOutput(output, startLine ?? 1) : undefined;
	const projectedOutput = readOutput?.text ?? output;
	const text = invocationContent ?? (excerpt.length > 0 ? excerpt.join("\n") : error ?? projectedOutput ?? "");
	const truncation = asRecord(details?.truncation);
	const declaredTotal = typeof details?.totalLines === "number"
		? details.totalLines
		: typeof details?.lineCount === "number"
			? details.lineCount
			: typeof truncation?.totalLines === "number" ? truncation.totalLines : undefined;
	const totalLines = declaredTotal
		?? (name === "read" ? readOutput?.totalLines : sourceLineCount(text));
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
		? sanitizeActivityText(rawDiff)
		: stringArray(rawDiff).join("\n") || error || output || "";
	const collapsed = typeof details?.collapsedLines === "number" && details.collapsedLines > 0
		? `… ${details.collapsedLines} lines collapsed`
		: undefined;
	return { kind: "diff", text: [base, collapsed].filter(Boolean).join("\n") };
}

function terminalBody(invocation: unknown, output: string | undefined, error: string | undefined): ActivityBody {
	const args = asRecord(invocation);
	return {
		kind: "terminal",
		command: firstString(args?.command),
		text: error ?? output ?? "",
	};
}

function genericBody(invocation: unknown, output: string | undefined, error: string | undefined): ActivityBody {
	return {
		kind: "text",
		text: error ?? output ?? (invocation === undefined ? "" : safeValuePreview(invocation)),
	};
}

function bodyForTool(
	name: string,
	invocation: unknown,
	output: string | undefined,
	error: string | undefined,
	details: Record<string, unknown> | undefined,
): ActivityBody {
	if (name === "read" || name === "write") return sourceBody(name, invocation, details, output, error);
	if (name === "edit") return diffBody(details, output, error);
	if (name === "bash") return terminalBody(invocation, output, error);
	return genericBody(invocation, output, error);
}

/** Project one ordinary Pi tool call/result record into the renderer-neutral domain. */
export function projectPiToolActivity(recordValue: unknown, scope: PiToolProjectionScope): ActivitySnapshot | undefined {
	const record = asRecord(recordValue);
	if (!record) return undefined;
	const toolCallId = firstString(record.toolCallId);
	if (scope.requireToolCallId && !toolCallId) return undefined;
	const id = toolCallId ?? firstString(record.id) ?? `pi-tool:${scope.messageId}:${Math.max(0, Math.floor(scope.blockIndex))}`;
	const name = firstString(record.name, record.toolName, record.command) ?? "tool";
	const invocation = record.arguments ?? record.input ?? (record.command ? { command: record.command } : undefined);
	const details = asRecord(record.details);
	const output = textFromContent(record.content) ?? (typeof record.output === "string" ? sanitizeActivityText(record.output) : undefined);
	const declaredError = firstString(record.errorMessage, record.error);
	const isError = record.isError === true || declaredError !== undefined;
	const error = declaredError ?? (isError ? firstString(output) : undefined);
	const fallback = isError ? "failed" : scope.fallbackStatus ?? "queued";
	const status = normalizePiActivityStatus(record.status, fallback);
	const args = asRecord(invocation);
	const subject = firstString(args?.path, args?.filePath, args?.target, args?.command, details?.path, details?.filePath, details?.target, details?.command);
	const summary = firstString(details?.summary, details?.note, details?.description);
	return {
		id,
		kind: "tool",
		title: name,
		status: isError ? "failed" : status,
		...(invocation === undefined ? {} : { invocation }),
		...(subject ? { subject } : {}),
		...(output ? { outputTail: output } : {}),
		body: bodyForTool(name, invocation, output, error, details),
		...(summary || error ? { result: { ...(summary ? { summary } : {}), ...(error ? { error } : {}) } } : {}),
	};
}
