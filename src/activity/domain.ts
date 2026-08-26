// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- I/O boundary parser (strict activity snapshot/parser boundary): inputs are untrusted producer JSON,
// so `unknown` parameters and open string-keyed records are this module's real input contract.
export type ActivityKind = "tool" | "task" | "subagent" | "terminal";
export type ActivityStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost";
export type ActivityBody =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "source"; readonly text: string; readonly startLine?: number; readonly totalLines?: number }
	| { readonly kind: "diff"; readonly text: string }
	| { readonly kind: "terminal"; readonly command?: string; readonly text: string };

export interface ActivitySnapshot {
	readonly id: string;
	/** Optional producer correlation ID used only when a later update learns a canonical ID. */
	readonly sourceId?: string;
	readonly kind: ActivityKind;
	readonly title: string;
	readonly status: ActivityStatus;
	readonly invocation?: unknown;
	readonly subject?: string;
	readonly currentStep?: string;
	readonly outputTail?: string;
	readonly body?: ActivityBody;
	readonly activeTools?: readonly ActivitySnapshot[];
	readonly result?: { readonly summary?: string; readonly error?: string };
	readonly ownerSessionId?: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly settledAt?: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly metrics?: {
		/** Producer-reported aggregate tokens when input/output are not separately available. */
		readonly tokens?: number;
		readonly tokensIn?: number;
		readonly tokensOut?: number;
		readonly contextWindow?: number;
		readonly costUsd?: number;
		readonly turns?: number;
		readonly elapsedMs?: number;
	};
}

export interface SafeValuePreviewOptions {
	readonly maxChars?: number;
	readonly maxDepth?: number;
	readonly maxEntries?: number;
	readonly maxStringChars?: number;
	/** Global traversal cap across arrays and objects, independent of depth. */
	readonly maxNodes?: number;
	/** Global cap on raw string characters inspected across the value. */
	readonly maxTotalStringChars?: number;
}

const ACTIVITY_KINDS = new Set<ActivityKind>(["tool", "task", "subagent", "terminal"]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["queued", "running", "succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_STATUS = new Set<ActivityStatus>(["succeeded", "failed", "cancelled", "lost"]);
const MAX_MERGED_ACTIVE_TOOLS = 16;
const SECRET_KEY_WORDS = new Set([
	"apikey",
	"authorization",
	"cookie",
	"credential",
	"credentials",
	"password",
	"passwd",
	"secret",
	"token",
]);

function isActivityKind(value: unknown): value is ActivityKind {
	if (!isStringValue(value)) return false;
	// SAFETY: membership in ACTIVITY_KINDS proves this string is an ActivityKind.
	return ACTIVITY_KINDS.has(value as ActivityKind);
}

function isActivityStatus(value: unknown): value is ActivityStatus {
	if (!isStringValue(value)) return false;
	// SAFETY: membership in ACTIVITY_STATUSES proves this string is an ActivityStatus.
	return ACTIVITY_STATUSES.has(value as ActivityStatus);
}

export function isSettledActivityStatus(status: ActivityStatus): boolean {
	return TERMINAL_STATUS.has(status);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringValue(value: unknown): value is string {
	return typeof value === "string";
}

function isNumberValue(value: unknown): value is number {
	return typeof value === "number";
}

function stringOrUndefined(value: unknown): string | undefined {
	return isStringValue(value) ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return isNumberValue(value) ? value : undefined;
}

/** Writable mirrors used to assemble snapshots field-by-field before returning them. */
type MutableActivitySnapshot = { -readonly [K in keyof ActivitySnapshot]: ActivitySnapshot[K] };
type MutableActivityMetrics = {
	-readonly [K in keyof NonNullable<ActivitySnapshot["metrics"]>]: NonNullable<ActivitySnapshot["metrics"]>[K];
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return isRecordLike(value) ? value : undefined;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

interface ActivityResultSummary {
	summary?: string;
	error?: string;
}

type ActivityIdentity = Pick<ActivitySnapshot, "id" | "kind" | "title" | "sourceId">;
type MutableActivityIdentity = { -readonly [K in keyof ActivityIdentity]: ActivityIdentity[K] };

/** Writable mirror of ActivitySnapshot["result"]. */
type MutableActivityResultSummary = { -readonly [K in keyof ActivityResultSummary]: ActivityResultSummary[K] };

type MutableSourceBody = {
	-readonly [K in keyof Extract<ActivityBody, { kind: "source" }>]: Extract<ActivityBody, { kind: "source" }>[K];
};

function parseActivityBody(value: unknown): ActivityBody | undefined {
	if (value === undefined) return undefined;
	const body = recordOf(value);
	if (!body || !isStringValue(body.kind) || !isStringValue(body.text)) return undefined;
	switch (body.kind) {
		case "text":
		case "diff":
			return { kind: body.kind, text: body.text };
		case "source": {
			if (!optionalFiniteNumber(body.startLine) || !optionalFiniteNumber(body.totalLines)) return undefined;
			const parsed: MutableSourceBody = { kind: "source", text: body.text };
			if (body.startLine !== undefined) parsed.startLine = body.startLine;
			if (body.totalLines !== undefined) parsed.totalLines = body.totalLines;
			return parsed;
		}
		case "terminal":
			if (!optionalString(body.command)) return undefined;
			if (body.command === undefined) return { kind: "terminal", text: body.text };
			return { kind: "terminal", text: body.text, command: body.command };
		default:
			return undefined;
	}
}

/** Strictly deserialize an ActivitySnapshot from persisted or extension-owned data. */
export function parseActivitySnapshot(value: unknown, depth = 0): ActivitySnapshot | undefined {
	if (depth > 8) return undefined;
	const record = recordOf(value);
	if (!record || !isStringValue(record.id) || !isStringValue(record.title)) return undefined;
	if (!isActivityKind(record.kind) || !isActivityStatus(record.status)) return undefined;
	for (const candidate of [record.sourceId, record.subject, record.currentStep, record.outputTail, record.ownerSessionId, record.model, record.thinking]) {
		if (!optionalString(candidate)) return undefined;
	}
	for (const candidate of [record.createdAt, record.updatedAt, record.settledAt]) {
		if (!optionalFiniteNumber(candidate)) return undefined;
	}
	const sourceId = stringOrUndefined(record.sourceId);
	const subject = stringOrUndefined(record.subject);
	const currentStep = stringOrUndefined(record.currentStep);
	const outputTail = stringOrUndefined(record.outputTail);
	const ownerSessionId = stringOrUndefined(record.ownerSessionId);
	const model = stringOrUndefined(record.model);
	const thinking = stringOrUndefined(record.thinking);
	const createdAt = numberOrUndefined(record.createdAt);
	const updatedAt = numberOrUndefined(record.updatedAt);
	const settledAt = numberOrUndefined(record.settledAt);
	const body = parseActivityBody(record.body);
	if (record.body !== undefined && body === undefined) return undefined;
	let activeTools: ActivitySnapshot[] | undefined;
	if (record.activeTools !== undefined) {
		if (!Array.isArray(record.activeTools) || record.activeTools.length > 256) return undefined;
		activeTools = [];
		for (const child of record.activeTools) {
			const parsed = parseActivitySnapshot(child, depth + 1);
			if (!parsed) return undefined;
			activeTools.push(parsed);
		}
	}
	let result: ActivitySnapshot["result"];
	if (record.result !== undefined) {
		const resultRecord = recordOf(record.result);
		if (!resultRecord || !optionalString(resultRecord.summary) || !optionalString(resultRecord.error)) return undefined;
		const parsedResult: MutableActivityResultSummary = {};
		if (resultRecord.summary !== undefined) parsedResult.summary = resultRecord.summary;
		if (resultRecord.error !== undefined) parsedResult.error = resultRecord.error;
		result = parsedResult;
	}
	let metrics: ActivitySnapshot["metrics"];
	if (record.metrics !== undefined) {
		const metricRecord = recordOf(record.metrics);
		if (!metricRecord) return undefined;
		for (const candidate of [metricRecord.tokens, metricRecord.tokensIn, metricRecord.tokensOut, metricRecord.contextWindow, metricRecord.costUsd, metricRecord.turns, metricRecord.elapsedMs]) {
			if (!optionalFiniteNumber(candidate)) return undefined;
		}
		const parsedMetrics: MutableActivityMetrics = {};
		if (isNumberValue(metricRecord.tokens)) parsedMetrics.tokens = metricRecord.tokens;
		if (isNumberValue(metricRecord.tokensIn)) parsedMetrics.tokensIn = metricRecord.tokensIn;
		if (isNumberValue(metricRecord.tokensOut)) parsedMetrics.tokensOut = metricRecord.tokensOut;
		if (isNumberValue(metricRecord.contextWindow)) parsedMetrics.contextWindow = metricRecord.contextWindow;
		if (isNumberValue(metricRecord.costUsd)) parsedMetrics.costUsd = metricRecord.costUsd;
		if (isNumberValue(metricRecord.turns)) parsedMetrics.turns = metricRecord.turns;
		if (isNumberValue(metricRecord.elapsedMs)) parsedMetrics.elapsedMs = metricRecord.elapsedMs;
		metrics = parsedMetrics;
	}
	const snapshot: MutableActivitySnapshot = { id: record.id, kind: record.kind, title: record.title, status: record.status };
	if (sourceId !== undefined) snapshot.sourceId = sourceId;
	if (record.invocation !== undefined) snapshot.invocation = record.invocation;
	if (subject !== undefined) snapshot.subject = subject;
	if (currentStep !== undefined) snapshot.currentStep = currentStep;
	if (outputTail !== undefined) snapshot.outputTail = outputTail;
	if (body !== undefined) snapshot.body = body;
	if (activeTools !== undefined) snapshot.activeTools = activeTools;
	if (result !== undefined) snapshot.result = result;
	if (ownerSessionId !== undefined) snapshot.ownerSessionId = ownerSessionId;
	if (createdAt !== undefined) snapshot.createdAt = createdAt;
	if (updatedAt !== undefined) snapshot.updatedAt = updatedAt;
	if (settledAt !== undefined) snapshot.settledAt = settledAt;
	if (model !== undefined) snapshot.model = model;
	if (thinking !== undefined) snapshot.thinking = thinking;
	if (metrics !== undefined) snapshot.metrics = metrics;
	return snapshot;
}

function skipControlString(text: string, start: number): number {
	let index = start + 2;
	while (index < text.length && text[index] !== "\n") {
		if (text[index] === "\u0007" || text.charCodeAt(index) === 0x9c) return index + 1;
		if (text[index] === "\u001b" && text[index + 1] === "\\") return index + 2;
		index += 1;
	}
	return index;
}

function skipC1ControlString(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length && text[index] !== "\n") {
		if (text[index] === "\u0007" || text.charCodeAt(index) === 0x9c) return index + 1;
		if (text[index] === "\u001b" && text[index + 1] === "\\") return index + 2;
		index += 1;
	}
	return index;
}

function skipEscapeSequence(text: string, start: number): number {
	const next = text[start + 1];
	if (next === undefined || next === "\n") return start + 1;
	if (next === "]" || next === "_" || next === "P" || next === "X" || next === "^") return skipControlString(text, start);
	if (next === "[") {
		let index = start + 2;
		while (index < text.length && text[index] !== "\n") {
			const code = text.charCodeAt(index);
			index += 1;
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return index;
	}
	if (next === "(" || next === ")" || next === "%" || next === "*" || next === "+" || next === "#") {
		return start + (text[start + 2] === undefined || text[start + 2] === "\n" ? 2 : 3);
	}
	return start + 2;
}

/** Remove terminal controls while preserving printable text and line structure. */
export function sanitizeActivityText(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (char === "\u001b") {
			index = skipEscapeSequence(text, index);
			continue;
		}
		const code = text.charCodeAt(index);
		if (code === 0x9b) {
			index += 1;
			while (index < text.length && text[index] !== "\n") {
				const finalCode = text.charCodeAt(index);
				index += 1;
				if (finalCode >= 0x40 && finalCode <= 0x7e) break;
			}
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index = skipC1ControlString(text, index);
			continue;
		}
		if (char === "\t") {
			output += "    ";
			index += 1;
			continue;
		}
		if (char === "\r") {
			output += "\n";
			index += text[index + 1] === "\n" ? 2 : 1;
			continue;
		}
		if ((code < 0x20 || (code >= 0x7f && code <= 0x9f)) && char !== "\n") {
			index += 1;
			continue;
		}
		output += char;
		index += 1;
	}
	return output;
}

/**
 * Remove controls while retaining only a bounded newest text window. Unlike
 * sanitizing and then slicing, this scans arbitrarily large producer strings
 * without allocating a second string proportional to the input. Scanning from
 * the beginning still preserves control-string state, so a long OSC/DCS payload
 * cannot become printable merely because the retained tail starts inside it.
 */
export function sanitizeActivityTextTail(
	text: string,
	options: { readonly maxChars: number; readonly maxLines: number },
): string {
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const maxLines = Math.max(1, Math.floor(options.maxLines));
	const completedLines: string[] = [];
	let currentLine = "";
	let chunk = "";
	let index = 0;
	const flushChunk = (): void => {
		if (!chunk) return;
		currentLine += chunk;
		chunk = "";
		if (currentLine.length > maxChars) currentLine = currentLine.slice(-maxChars);
	};
	const finishLine = (): void => {
		flushChunk();
		completedLines.push(currentLine);
		if (completedLines.length > maxLines) completedLines.shift();
		currentLine = "";
	};
	const append = (value: string): void => {
		chunk += value;
		if (chunk.length >= 4_096) flushChunk();
	};

	while (index < text.length) {
		const char = text[index]!;
		if (char === "\u001b") {
			index = skipEscapeSequence(text, index);
			continue;
		}
		const code = text.charCodeAt(index);
		if (code === 0x9b) {
			index += 1;
			while (index < text.length && text[index] !== "\n") {
				const finalCode = text.charCodeAt(index);
				index += 1;
				if (finalCode >= 0x40 && finalCode <= 0x7e) break;
			}
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index = skipC1ControlString(text, index);
			continue;
		}
		if (char === "\t") {
			append("    ");
			index += 1;
			continue;
		}
		if (char === "\r") {
			finishLine();
			index += text[index + 1] === "\n" ? 2 : 1;
			continue;
		}
		if (char === "\n") {
			finishLine();
			index += 1;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			index += 1;
			continue;
		}
		append(char);
		index += 1;
	}
	flushChunk();
	const lines = [...completedLines, currentLine].slice(-maxLines);
	const output = lines.join("\n");
	return output.length <= maxChars ? output : output.slice(-maxChars);
}

function isSecretKey(key: string): boolean {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
	const normalized = words.join("");
	const hasCompoundApiKey = words.some((word, index) => word === "api" && words[index + 1] === "key");
	return words.some((word) => SECRET_KEY_WORDS.has(word))
		|| SECRET_KEY_WORDS.has(normalized)
		|| normalized === "privatekey"
		|| hasCompoundApiKey;
}

function boundedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** JSON-shaped preview tree produced by safeValuePreview. */
type PreviewValue =
	| string
	| number
	| boolean
	| null
	| readonly PreviewValue[]
	| { [key: string]: PreviewValue };

function isBooleanValue(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isBigIntValue(value: unknown): value is bigint {
	return typeof value === "bigint";
}

function isSymbolValue(value: unknown): value is symbol {
	return typeof value === "symbol";
}

function isPreviewContainer(value: unknown): value is object {
	return typeof value === "object";
}

/** Circular-safe, size-bounded preview intended for untrusted invocation values. */
export function safeValuePreview(value: unknown, options: SafeValuePreviewOptions = {}): string {
	const maxChars = Math.max(1, Math.floor(options.maxChars ?? 2_000));
	const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 4));
	const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 20));
	const maxStringChars = Math.max(1, Math.floor(options.maxStringChars ?? 500));
	let remainingNodes = Math.max(1, Math.floor(options.maxNodes ?? 256));
	let remainingStringChars = Math.max(1, Math.floor(options.maxTotalStringChars ?? maxChars));
	const seen = new WeakSet<object>();
	const inspectString = (text: string) => {
		if (remainingStringChars <= 0) return { text: "[Truncated]", truncated: true };
		const inspectedChars = Math.min(text.length, maxStringChars, remainingStringChars);
		remainingStringChars -= inspectedChars;
		const sanitized = sanitizeActivityText(text.slice(0, inspectedChars));
		const truncated = text.length > inspectedChars;
		return {
			text: truncated ? boundedText(`${sanitized}…`, maxStringChars) : boundedText(sanitized, maxStringChars),
			truncated,
		};
	};

	const visit = (current: unknown, depth: number): PreviewValue => {
		if (remainingNodes <= 0) return "[Truncated]";
		remainingNodes -= 1;
		if (isStringValue(current)) return inspectString(current).text;
		if (current === null || isBooleanValue(current) || isNumberValue(current)) return current;
		if (isBigIntValue(current)) return `${current.toString()}n`;
		if (current === undefined) return "[undefined]";
		if (current instanceof Function) return "[Function]";
		if (isSymbolValue(current)) return current.toString();
		if (!isPreviewContainer(current)) return sanitizeActivityText(String(current));
		if (seen.has(current)) return "[Circular]";
		if (depth >= maxDepth) return "[Truncated]";
		seen.add(current);
		if (Array.isArray(current)) {
			const inspected = current.slice(0, maxEntries);
			const result = inspected.map((item) => visit(item, depth + 1));
			if (current.length > inspected.length) result.push(`… ${current.length - inspected.length} more`);
			return result;
		}
		const result: { [key: string]: PreviewValue } = {};
		const keys: string[] = [];
		let hasMore = false;
		try {
			for (const key in current) {
				if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
				if (keys.length >= maxEntries) {
					hasMore = true;
					break;
				}
				keys.push(key);
			}
		} catch {
			return "[Uninspectable]";
		}
		for (const key of keys) {
			const inspectedKey = inspectString(key);
			const displayKey = inspectedKey.text || "[empty key]";
			// If the complete key cannot be inspected, fail closed rather than let a
			// secret suffix beyond the character budget evade key-based redaction.
			if (inspectedKey.truncated || isSecretKey(displayKey)) {
				result[displayKey] = "[REDACTED]";
				continue;
			}
			try {
				// SAFETY: current was narrowed above to a non-array object and `key` came from its own enumerable properties.
				result[displayKey] = visit((current as Record<string, unknown>)[key], depth + 1);
			} catch {
				result[displayKey] = "[Uninspectable]";
			}
		}
		if (hasMore) result["…"] = "more";
		return result;
	};

	let serialized: string;
	try {
		serialized = JSON.stringify(visit(value, 0));
	} catch {
		serialized = "[Unserializable]";
	}
	return boundedText(sanitizeActivityText(serialized ?? "[undefined]"), maxChars);
}

function isToolCanonicalTransition(existing: ActivitySnapshot, incoming: ActivitySnapshot): boolean {
	return (existing.kind === "tool" && incoming.kind !== "tool")
		|| (existing.kind !== "tool" && incoming.kind === "tool");
}

export function sameActivity(existing: ActivitySnapshot, incoming: ActivitySnapshot): boolean {
	if (existing.id === incoming.id) {
		if (existing.kind === "subagent" && incoming.kind === "subagent") {
			if (existing.sourceId !== undefined || incoming.sourceId !== undefined) {
				return existing.sourceId !== undefined && existing.sourceId === incoming.sourceId;
			}
			if (existing.createdAt !== undefined && incoming.createdAt !== undefined) {
				return existing.createdAt === incoming.createdAt;
			}
		}
		return true;
	}
	if (
		existing.kind === "subagent" && incoming.kind === "subagent" &&
		existing.sourceId !== undefined && existing.sourceId === incoming.sourceId
	) return true;
	if (!isToolCanonicalTransition(existing, incoming)) return false;
	return existing.sourceId === incoming.id
		|| incoming.sourceId === existing.id
		|| (existing.sourceId !== undefined && existing.sourceId === incoming.sourceId);
}

function canonicalIdentity(
	existing: ActivitySnapshot,
	incoming: ActivitySnapshot,
): Pick<ActivitySnapshot, "id" | "kind" | "title" | "sourceId"> {
	if (!isToolCanonicalTransition(existing, incoming) || !sameActivity(existing, incoming)) {
		const sourceId = incoming.sourceId ?? existing.sourceId;
		const identity: MutableActivityIdentity = {
			id: incoming.id,
			kind: incoming.kind,
			title: incoming.title,
		};
		if (sourceId) identity.sourceId = sourceId;
		return identity;
	}
	const canonical = existing.kind === "tool" ? incoming : existing;
	const tool = existing.kind === "tool" ? existing : incoming;
	const sourceId = canonical.sourceId && canonical.sourceId !== canonical.id
		? canonical.sourceId
		: tool.id !== canonical.id ? tool.id : tool.sourceId;
	const identity: MutableActivityIdentity = {
		id: canonical.id,
		kind: canonical.kind,
		title: canonical.title,
	};
	if (sourceId) identity.sourceId = sourceId;
	return identity;
}

function mergeBody(existing: ActivityBody | undefined, incoming: ActivityBody | undefined): ActivityBody | undefined {
	if (!incoming) return existing;
	if (!existing || existing.kind !== incoming.kind) return incoming;
	if (existing.kind === "source" && incoming.kind === "source") {
		return {
			kind: "source",
			text: incoming.text || existing.text,
			startLine: incoming.startLine ?? existing.startLine,
			totalLines: incoming.totalLines ?? existing.totalLines,
		};
	}
	if (existing.kind === "terminal" && incoming.kind === "terminal") {
		return { kind: "terminal", command: incoming.command ?? existing.command, text: incoming.text || existing.text };
	}
	return { ...existing, ...incoming, text: incoming.text || existing.text };
}

function mergeChildren(
	existing: readonly ActivitySnapshot[] | undefined,
	incoming: readonly ActivitySnapshot[] | undefined,
): readonly ActivitySnapshot[] | undefined {
	if (incoming === undefined) return existing;
	if (incoming.length === 0) return [];
	if (!existing || existing.length === 0) return incoming.slice(0, MAX_MERGED_ACTIVE_TOOLS);
	// Incoming order is the producer's current priority window (running first,
	// then recent settled work). Merge known fields for those children, then use
	// any spare bounded slots for older siblings omitted by a sparse update.
	const merged = incoming.map((child) => {
		const previous = existing.find((candidate) => sameActivity(candidate, child));
		return previous ? mergeActivitySnapshot(previous, child) : child;
	});
	for (const child of existing) {
		if (merged.length >= MAX_MERGED_ACTIVE_TOOLS) break;
		if (!incoming.some((candidate) => sameActivity(candidate, child))) merged.push(child);
	}
	return merged.slice(0, MAX_MERGED_ACTIVE_TOOLS);
}

/** Merge producer state without allowing sparse updates to erase known data. */
export function mergeActivitySnapshot(existing: ActivitySnapshot, incoming: ActivitySnapshot): ActivitySnapshot {
	const status = isSettledActivityStatus(existing.status) && !isSettledActivityStatus(incoming.status)
		? existing.status
		: incoming.status;
	const identity = canonicalIdentity(existing, incoming);
	const invocation = incoming.invocation ?? existing.invocation;
	const subject = incoming.subject ?? existing.subject;
	const currentStep = incoming.currentStep ?? existing.currentStep;
	const outputTail = incoming.outputTail ?? existing.outputTail;
	const body = mergeBody(existing.body, incoming.body);
	const activeTools = mergeChildren(existing.activeTools, incoming.activeTools);
	const result = incoming.result || existing.result ? { ...existing.result, ...incoming.result } : undefined;
	const ownerSessionId = incoming.ownerSessionId ?? existing.ownerSessionId;
	const createdAt = incoming.createdAt ?? existing.createdAt;
	const updatedAt = incoming.updatedAt ?? existing.updatedAt;
	const settledAt = incoming.settledAt ?? existing.settledAt;
	const model = incoming.model ?? existing.model;
	const thinking = incoming.thinking ?? existing.thinking;
	const metrics = incoming.metrics || existing.metrics ? { ...existing.metrics, ...incoming.metrics } : undefined;
	const merged: MutableActivitySnapshot = {
		...existing,
		...incoming,
		...identity,
		status,
	};
	if (invocation !== undefined) merged.invocation = invocation;
	if (subject !== undefined) merged.subject = subject;
	if (currentStep !== undefined) merged.currentStep = currentStep;
	if (outputTail !== undefined) merged.outputTail = outputTail;
	if (body !== undefined) merged.body = body;
	if (activeTools !== undefined) merged.activeTools = activeTools;
	if (result !== undefined) merged.result = result;
	if (ownerSessionId !== undefined) merged.ownerSessionId = ownerSessionId;
	if (createdAt !== undefined) merged.createdAt = createdAt;
	if (updatedAt !== undefined) merged.updatedAt = updatedAt;
	if (settledAt !== undefined) merged.settledAt = settledAt;
	if (model !== undefined) merged.model = model;
	if (thinking !== undefined) merged.thinking = thinking;
	if (metrics !== undefined) merged.metrics = metrics;
	return merged;
}
