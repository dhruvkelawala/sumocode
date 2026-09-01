// oxlint-disable anti-slop/no-runtime-typeof -- stream chunks cross Node's string/byte I/O boundary here.
const MEBIBYTE = 1024 * 1024;

/** Largest newline-delimited JSON payload accepted from a child process. */
export const CHILD_JSON_FRAME_MAX_BYTES = 8 * MEBIBYTE;
/** Largest in-progress JSON payload retained while waiting for its newline. */
export const CHILD_UNTERMINATED_MAX_BYTES = 8 * MEBIBYTE;
/** Largest diagnostic tail retained from child stderr, including its marker. */
export const CHILD_STDERR_TAIL_MAX_BYTES = 64 * 1024;
/** Largest human-readable result retained from one child run, including its marker. */
export const CHILD_RETAINED_RESULT_MAX_BYTES = 4 * MEBIBYTE;

export const TRUNCATED_TAIL_MARKER = "[earlier output truncated]\n";
export const TRUNCATED_HEAD_MARKER = "\n[output truncated]";

type Chunk = string | Uint8Array;

function bytesFrom(chunk: Chunk): Buffer {
	return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function isUtf8Continuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

function decodeUtf8Tail(bytes: Uint8Array): string {
	let value = bytes;
	while (isUtf8Continuation(value[0])) value = value.subarray(1);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let trim = 0; trim <= Math.min(3, value.byteLength); trim += 1) {
		try {
			return decoder.decode(trim === 0 ? value : value.subarray(0, value.byteLength - trim));
		} catch {
			// A stream can end inside one UTF-8 codepoint. Drop only that suffix.
		}
	}
	return new TextDecoder("utf-8").decode(value);
}

function decodeUtf8Head(bytes: Uint8Array): string {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let trim = 0; trim <= Math.min(3, bytes.byteLength); trim += 1) {
		try {
			return decoder.decode(trim === 0 ? bytes : bytes.subarray(0, bytes.byteLength - trim));
		} catch {
			// The byte cap can land inside one UTF-8 codepoint. Drop only that suffix.
		}
	}
	return new TextDecoder("utf-8").decode(bytes);
}

/** Keep the start of a child result within a UTF-8 byte cap and mark omitted output. */
export function boundRetainedResult(text: string, maxBytes = CHILD_RETAINED_RESULT_MAX_BYTES): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	const markerBytes = Buffer.byteLength(TRUNCATED_HEAD_MARKER, "utf8");
	if (maxBytes < markerBytes) throw new Error("retained-result limit is smaller than its truncation marker");
	const head = decodeUtf8Head(bytes.subarray(0, maxBytes - markerBytes));
	return `${head}${TRUNCATED_HEAD_MARKER}`;
}

/** Retain only the newest stderr bytes without ever splitting a UTF-8 codepoint. */
export class BoundedUtf8Tail {
	private bytes = Buffer.alloc(0);
	private truncated = false;
	private readonly contentMaxBytes: number;

	public constructor(private readonly maxBytes = CHILD_STDERR_TAIL_MAX_BYTES) {
		const markerBytes = Buffer.byteLength(TRUNCATED_TAIL_MARKER, "utf8");
		if (maxBytes < markerBytes) throw new Error("tail limit is smaller than its truncation marker");
		this.contentMaxBytes = maxBytes - markerBytes;
	}

	public append(chunk: Chunk): void {
		const incoming = bytesFrom(chunk);
		const allowed = this.truncated ? this.contentMaxBytes : this.maxBytes;
		if (this.bytes.byteLength + incoming.byteLength <= allowed) {
			this.bytes = Buffer.concat([this.bytes, incoming], this.bytes.byteLength + incoming.byteLength);
			return;
		}

		this.truncated = true;
		if (incoming.byteLength >= this.contentMaxBytes) {
			this.bytes = Buffer.from(incoming.subarray(incoming.byteLength - this.contentMaxBytes));
			return;
		}
		const oldBytes = Math.min(this.bytes.byteLength, this.contentMaxBytes - incoming.byteLength);
		this.bytes = Buffer.concat(
			[this.bytes.subarray(this.bytes.byteLength - oldBytes), incoming],
			oldBytes + incoming.byteLength,
		);
	}

	public toString(): string {
		const tail = decodeUtf8Tail(this.bytes);
		return this.truncated ? `${TRUNCATED_TAIL_MARKER}${tail}` : tail;
	}
}

export class ChildProtocolLimitError extends Error {
	public constructor(
		public readonly kind: "frame" | "unterminated",
		public readonly limitBytes: number,
		public readonly receivedBytes: number,
	) {
		super(`Child protocol ${kind} exceeded ${limitBytes} bytes (received at least ${receivedBytes} bytes)`);
		this.name = "ChildProtocolLimitError";
	}
}

export interface JsonLineDecoderOptions {
	readonly onLine: (line: string) => void;
	readonly onError: (error: ChildProtocolLimitError) => void;
	readonly maxFrameBytes?: number;
	readonly maxUnterminatedBytes?: number;
}

/**
 * Decode newline-delimited UTF-8 without retaining or parsing an oversized frame.
 * One limit owns complete frames; the other bounds bytes held while no delimiter arrives.
 */
export class JsonLineDecoder {
	private buffer: Buffer | undefined;
	private bytes = 0;
	private stopped = false;
	private readonly maxFrameBytes: number;
	private readonly maxUnterminatedBytes: number;

	public constructor(private readonly options: JsonLineDecoderOptions) {
		this.maxFrameBytes = options.maxFrameBytes ?? CHILD_JSON_FRAME_MAX_BYTES;
		this.maxUnterminatedBytes = options.maxUnterminatedBytes ?? CHILD_UNTERMINATED_MAX_BYTES;
	}

	public get bufferedBytes(): number {
		return this.bytes;
	}

	public write(chunk: Chunk): void {
		if (this.stopped) return;
		const incoming = bytesFrom(chunk);
		let offset = 0;
		while (offset < incoming.byteLength) {
			const newline = incoming.indexOf(0x0a, offset);
			if (newline === -1) {
				this.append(incoming.subarray(offset), false);
				return;
			}
			if (!this.append(incoming.subarray(offset, newline), true)) return;
			this.emitLine();
			offset = newline + 1;
		}
	}

	/** Emit one final non-empty frame when the producer closes without a newline. */
	public end(): void {
		if (this.stopped) return;
		if (this.bytes > 0) this.emitLine();
		this.stopped = true;
	}

	private append(chunk: Uint8Array, terminated: boolean): boolean {
		const nextBytes = this.bytes + chunk.byteLength;
		if (nextBytes > this.maxFrameBytes) return this.fail("frame", this.maxFrameBytes, nextBytes);
		if (!terminated && nextBytes > this.maxUnterminatedBytes) {
			return this.fail("unterminated", this.maxUnterminatedBytes, nextBytes);
		}
		if (chunk.byteLength > 0) {
			this.buffer ??= Buffer.allocUnsafe(this.maxFrameBytes);
			Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(this.buffer, this.bytes);
		}
		this.bytes = nextBytes;
		return true;
	}

	private emitLine(): void {
		const line = decodeUtf8Head(this.buffer?.subarray(0, this.bytes) ?? Buffer.alloc(0));
		this.bytes = 0;
		this.options.onLine(line);
	}

	private fail(kind: "frame" | "unterminated", limit: number, received: number): false {
		this.stopped = true;
		this.buffer = undefined;
		this.bytes = 0;
		this.options.onError(new ChildProtocolLimitError(kind, limit, received));
		return false;
	}
}
