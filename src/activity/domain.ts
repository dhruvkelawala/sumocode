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

const TERMINAL_STATUS = new Set<ActivityStatus>(["succeeded", "failed", "cancelled", "lost"]);
const SECRET_KEYS = new Set(["token", "authorization", "password", "secret", "cookie", "apikey"]);

export function isSettledActivityStatus(status: ActivityStatus): boolean {
	return TERMINAL_STATUS.has(status);
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
			index = skipControlString(`\u001b${text.slice(index + 1)}`, 0) + index;
			continue;
		}
		if (char === "\t") {
			output += "    ";
			index += 1;
			continue;
		}
		if (char === "\r") {
			output += "\n";
			index += 1;
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
	return SECRET_KEYS.has(key.replace(/[-_.\s]/g, "").toLowerCase());
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

export function sameActivity(existing: ActivitySnapshot, incoming: ActivitySnapshot): boolean {
	if (existing.id === incoming.id) return true;
	const canonicalTaskTransition = (existing.kind === "tool" && incoming.kind === "task") || (existing.kind === "task" && incoming.kind === "tool");
	return canonicalTaskTransition && existing.sourceId !== undefined && incoming.sourceId !== undefined && existing.sourceId === incoming.sourceId;
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
	if (!incoming || incoming.length === 0) return existing;
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
	return {
		...existing,
		...incoming,
		status,
		sourceId: incoming.sourceId ?? existing.sourceId,
		invocation: incoming.invocation ?? existing.invocation,
		subject: incoming.subject ?? existing.subject,
		currentStep: incoming.currentStep ?? existing.currentStep,
		outputTail: incoming.outputTail ?? existing.outputTail,
		body: mergeBody(existing.body, incoming.body),
		activeTools: mergeChildren(existing.activeTools, incoming.activeTools),
		result: incoming.result || existing.result
			? { ...existing.result, ...incoming.result }
			: undefined,
		ownerSessionId: incoming.ownerSessionId ?? existing.ownerSessionId,
		createdAt: incoming.createdAt ?? existing.createdAt,
		updatedAt: incoming.updatedAt ?? existing.updatedAt,
		settledAt: incoming.settledAt ?? existing.settledAt,
		model: incoming.model ?? existing.model,
		thinking: incoming.thinking ?? existing.thinking,
		metrics: incoming.metrics || existing.metrics
			? { ...existing.metrics, ...incoming.metrics }
			: undefined,
	};
}
