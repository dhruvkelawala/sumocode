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
		readonly tokensIn?: number;
		readonly tokensOut?: number;
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
}

const ACTIVITY_KINDS = new Set<ActivityKind>(["tool", "task", "subagent", "terminal"]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["queued", "running", "succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_STATUS = new Set<ActivityStatus>(["succeeded", "failed", "cancelled", "lost"]);
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

export function isSettledActivityStatus(status: ActivityStatus): boolean {
	return TERMINAL_STATUS.has(status);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function parseActivityBody(value: unknown): ActivityBody | undefined {
	if (value === undefined) return undefined;
	const body = recordOf(value);
	if (!body || typeof body.kind !== "string" || typeof body.text !== "string") return undefined;
	switch (body.kind) {
		case "text":
		case "diff":
			return { kind: body.kind, text: body.text };
		case "source":
			if (!optionalFiniteNumber(body.startLine) || !optionalFiniteNumber(body.totalLines)) return undefined;
			return {
				kind: "source",
				text: body.text,
				...(body.startLine === undefined ? {} : { startLine: body.startLine }),
				...(body.totalLines === undefined ? {} : { totalLines: body.totalLines }),
			};
		case "terminal":
			if (!optionalString(body.command)) return undefined;
			return { kind: "terminal", text: body.text, ...(body.command === undefined ? {} : { command: body.command }) };
		default:
			return undefined;
	}
}

/** Strictly deserialize an ActivitySnapshot from persisted or extension-owned data. */
export function parseActivitySnapshot(value: unknown, depth = 0): ActivitySnapshot | undefined {
	if (depth > 8) return undefined;
	const record = recordOf(value);
	if (!record || typeof record.id !== "string" || typeof record.title !== "string") return undefined;
	if (typeof record.kind !== "string" || !ACTIVITY_KINDS.has(record.kind as ActivityKind)) return undefined;
	if (typeof record.status !== "string" || !ACTIVITY_STATUSES.has(record.status as ActivityStatus)) return undefined;
	for (const candidate of [record.sourceId, record.subject, record.currentStep, record.outputTail, record.ownerSessionId, record.model, record.thinking]) {
		if (!optionalString(candidate)) return undefined;
	}
	for (const candidate of [record.createdAt, record.updatedAt, record.settledAt]) {
		if (!optionalFiniteNumber(candidate)) return undefined;
	}
	const sourceId = typeof record.sourceId === "string" ? record.sourceId : undefined;
	const subject = typeof record.subject === "string" ? record.subject : undefined;
	const currentStep = typeof record.currentStep === "string" ? record.currentStep : undefined;
	const outputTail = typeof record.outputTail === "string" ? record.outputTail : undefined;
	const ownerSessionId = typeof record.ownerSessionId === "string" ? record.ownerSessionId : undefined;
	const model = typeof record.model === "string" ? record.model : undefined;
	const thinking = typeof record.thinking === "string" ? record.thinking : undefined;
	const createdAt = typeof record.createdAt === "number" ? record.createdAt : undefined;
	const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : undefined;
	const settledAt = typeof record.settledAt === "number" ? record.settledAt : undefined;
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
		result = {
			...(resultRecord.summary === undefined ? {} : { summary: resultRecord.summary }),
			...(resultRecord.error === undefined ? {} : { error: resultRecord.error }),
		};
	}
	let metrics: ActivitySnapshot["metrics"];
	if (record.metrics !== undefined) {
		const metricRecord = recordOf(record.metrics);
		if (!metricRecord) return undefined;
		for (const candidate of [metricRecord.tokensIn, metricRecord.tokensOut, metricRecord.costUsd, metricRecord.turns, metricRecord.elapsedMs]) {
			if (!optionalFiniteNumber(candidate)) return undefined;
		}
		metrics = {
			...(typeof metricRecord.tokensIn === "number" ? { tokensIn: metricRecord.tokensIn } : {}),
			...(typeof metricRecord.tokensOut === "number" ? { tokensOut: metricRecord.tokensOut } : {}),
			...(typeof metricRecord.costUsd === "number" ? { costUsd: metricRecord.costUsd } : {}),
			...(typeof metricRecord.turns === "number" ? { turns: metricRecord.turns } : {}),
			...(typeof metricRecord.elapsedMs === "number" ? { elapsedMs: metricRecord.elapsedMs } : {}),
		};
	}
	return {
		id: record.id,
		kind: record.kind as ActivityKind,
		title: record.title,
		status: record.status as ActivityStatus,
		...(sourceId === undefined ? {} : { sourceId }),
		...(record.invocation === undefined ? {} : { invocation: record.invocation }),
		...(subject === undefined ? {} : { subject }),
		...(currentStep === undefined ? {} : { currentStep }),
		...(outputTail === undefined ? {} : { outputTail }),
		...(body === undefined ? {} : { body }),
		...(activeTools === undefined ? {} : { activeTools }),
		...(result === undefined ? {} : { result }),
		...(ownerSessionId === undefined ? {} : { ownerSessionId }),
		...(createdAt === undefined ? {} : { createdAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
		...(settledAt === undefined ? {} : { settledAt }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(metrics === undefined ? {} : { metrics }),
	};
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

/** Circular-safe, size-bounded preview intended for untrusted invocation values. */
export function safeValuePreview(value: unknown, options: SafeValuePreviewOptions = {}): string {
	const maxChars = Math.max(1, Math.floor(options.maxChars ?? 2_000));
	const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 4));
	const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 20));
	const maxStringChars = Math.max(1, Math.floor(options.maxStringChars ?? 500));
	const seen = new WeakSet<object>();

	const visit = (current: unknown, depth: number): unknown => {
		if (typeof current === "string") return boundedText(sanitizeActivityText(current), maxStringChars);
		if (current === null || typeof current === "boolean" || typeof current === "number") return current;
		if (typeof current === "bigint") return `${current.toString()}n`;
		if (current === undefined) return "[undefined]";
		if (typeof current === "function") return "[Function]";
		if (typeof current === "symbol") return current.toString();
		if (typeof current !== "object") return sanitizeActivityText(String(current));
		if (seen.has(current)) return "[Circular]";
		if (depth >= maxDepth) return "[Truncated]";
		seen.add(current);
		if (Array.isArray(current)) {
			const result = current.slice(0, maxEntries).map((item) => visit(item, depth + 1));
			if (current.length > maxEntries) result.push(`… ${current.length - maxEntries} more`);
			return result;
		}
		const result: Record<string, unknown> = {};
		let keys: string[];
		try {
			keys = Object.keys(current);
		} catch {
			return "[Uninspectable]";
		}
		for (const key of keys.slice(0, maxEntries)) {
			if (isSecretKey(key)) {
				result[key] = "[REDACTED]";
				continue;
			}
			try {
				result[key] = visit((current as Record<string, unknown>)[key], depth + 1);
			} catch {
				result[key] = "[Uninspectable]";
			}
		}
		if (keys.length > maxEntries) result["…"] = `${keys.length - maxEntries} more`;
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

function isToolTaskTransition(existing: ActivitySnapshot, incoming: ActivitySnapshot): boolean {
	return (existing.kind === "tool" && incoming.kind === "task")
		|| (existing.kind === "task" && incoming.kind === "tool");
}

export function sameActivity(existing: ActivitySnapshot, incoming: ActivitySnapshot): boolean {
	if (existing.id === incoming.id) return true;
	if (!isToolTaskTransition(existing, incoming)) return false;
	return existing.sourceId === incoming.id
		|| incoming.sourceId === existing.id
		|| (existing.sourceId !== undefined && existing.sourceId === incoming.sourceId);
}

function canonicalIdentity(
	existing: ActivitySnapshot,
	incoming: ActivitySnapshot,
): Pick<ActivitySnapshot, "id" | "kind" | "title" | "sourceId"> {
	if (!isToolTaskTransition(existing, incoming) || !sameActivity(existing, incoming)) {
		const sourceId = incoming.sourceId ?? existing.sourceId;
		return {
			id: incoming.id,
			kind: incoming.kind,
			title: incoming.title,
			...(sourceId ? { sourceId } : {}),
		};
	}
	const task = existing.kind === "task" ? existing : incoming;
	const tool = existing.kind === "tool" ? existing : incoming;
	const sourceId = task.sourceId && task.sourceId !== task.id
		? task.sourceId
		: tool.id !== task.id ? tool.id : tool.sourceId;
	return {
		id: task.id,
		kind: "task",
		title: task.title,
		...(sourceId ? { sourceId } : {}),
	};
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
	if (!existing || existing.length === 0) return incoming;
	const merged = [...existing];
	for (const child of incoming) {
		const index = merged.findIndex((candidate) => sameActivity(candidate, child));
		if (index === -1) merged.push(child);
		else merged[index] = mergeActivitySnapshot(merged[index]!, child);
	}
	return merged;
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
	return {
		...existing,
		...incoming,
		...identity,
		status,
		...(invocation === undefined ? {} : { invocation }),
		...(subject === undefined ? {} : { subject }),
		...(currentStep === undefined ? {} : { currentStep }),
		...(outputTail === undefined ? {} : { outputTail }),
		...(body === undefined ? {} : { body }),
		...(activeTools === undefined ? {} : { activeTools }),
		...(result === undefined ? {} : { result }),
		...(ownerSessionId === undefined ? {} : { ownerSessionId }),
		...(createdAt === undefined ? {} : { createdAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
		...(settledAt === undefined ? {} : { settledAt }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(metrics === undefined ? {} : { metrics }),
	};
}
