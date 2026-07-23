import { sanitizeActivityTextTail } from "./domain.js";

export const ACTIVITY_OUTPUT_MAX_BYTES = 16 * 1024;
export const ACTIVITY_OUTPUT_MAX_LINES = 25;

export interface OutputTailOptions {
	readonly maxBytes?: number;
	readonly maxLines?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function startsWithUtf8Continuation(bytes: Uint8Array): boolean {
	return bytes.length > 0 && (bytes[0]! & 0xc0) === 0x80;
}

function decodeValidUtf8Tail(bytes: Uint8Array, maxBytes: number): string {
	let tail = bytes.subarray(Math.max(0, bytes.byteLength - maxBytes));
	while (startsWithUtf8Continuation(tail)) tail = tail.subarray(1);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let endTrim = 0; endTrim <= Math.min(3, tail.byteLength); endTrim += 1) {
		try {
			return decoder.decode(endTrim === 0 ? tail : tail.subarray(0, tail.byteLength - endTrim));
		} catch {
			// A concurrent append may leave an incomplete final codepoint. Try the
			// only possible UTF-8 suffix lengths before falling back for invalid data.
		}
	}
	return new TextDecoder("utf-8").decode(tail);
}

function trimStringToUtf8Tail(text: string, maxBytes: number): string {
	return decodeValidUtf8Tail(Buffer.from(text, "utf8"), maxBytes);
}

/**
 * Return the newest bounded, terminal-safe output. Byte and row limits are
 * applied after control stripping so tab expansion cannot exceed the feed cap.
 */
export function boundedOutputTail(value: string | Uint8Array, options: OutputTailOptions = {}): string {
	const maxBytes = positiveInteger(options.maxBytes, ACTIVITY_OUTPUT_MAX_BYTES);
	const maxLines = positiveInteger(options.maxLines, ACTIVITY_OUTPUT_MAX_LINES);
	const decoded = typeof value === "string" ? value : decodeValidUtf8Tail(value, maxBytes + 4);
	const sanitized = sanitizeActivityTextTail(decoded, { maxChars: maxBytes, maxLines });
	const byteBounded = trimStringToUtf8Tail(sanitized, maxBytes);
	const lines = byteBounded.split("\n");
	const rowBounded = lines.length > maxLines ? lines.slice(lines.length - maxLines).join("\n") : byteBounded;
	return trimStringToUtf8Tail(rowBounded, maxBytes);
}
