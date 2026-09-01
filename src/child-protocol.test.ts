import { describe, expect, it, vi } from "vitest";
import {
	BoundedUtf8Head,
	BoundedUtf8Tail,
	CHILD_JSON_FRAME_MAX_BYTES,
	CHILD_RETAINED_RESULT_MAX_BYTES,
	CHILD_STDERR_TAIL_MAX_BYTES,
	CHILD_UNTERMINATED_MAX_BYTES,
	JsonLineDecoder,
	TRUNCATED_HEAD_MARKER,
	TRUNCATED_TAIL_MARKER,
	boundRetainedResult,
} from "./child-protocol.js";

function decoder(options: { frame?: number; unterminated?: number } = {}) {
	const lines: string[] = [];
	const errors: Error[] = [];
	return {
		lines,
		errors,
		value: new JsonLineDecoder({
			onLine: (line) => lines.push(line),
			onError: (error) => errors.push(error),
			maxFrameBytes: options.frame,
			maxUnterminatedBytes: options.unterminated,
		}),
	};
}

describe("JsonLineDecoder", () => {
	it.each([
		["just below", CHILD_JSON_FRAME_MAX_BYTES - 1, false],
		["at", CHILD_JSON_FRAME_MAX_BYTES, false],
		["above", CHILD_JSON_FRAME_MAX_BYTES + 1, true],
	] as const)("enforces the documented frame limit %s the boundary", (_label, size, fails) => {
		const stream = decoder();
		stream.value.write(Buffer.concat([Buffer.alloc(size, 0x61), Buffer.from("\n")]));

		expect(stream.errors).toHaveLength(fails ? 1 : 0);
		expect(stream.lines).toHaveLength(fails ? 0 : 1);
		if (fails) {
			expect(stream.errors[0]?.message).toContain(`${CHILD_JSON_FRAME_MAX_BYTES} bytes`);
			expect(stream.errors[0]?.message).not.toContain("aaaa");
		}
	});

	it.each([
		["just below", CHILD_UNTERMINATED_MAX_BYTES - 1, false],
		["at", CHILD_UNTERMINATED_MAX_BYTES, false],
		["above", CHILD_UNTERMINATED_MAX_BYTES + 1, true],
	] as const)("enforces the documented unterminated limit %s the boundary", (_label, size, fails) => {
		const stream = decoder();
		stream.value.write(Buffer.alloc(size, 0x62));

		expect(stream.errors).toHaveLength(fails ? 1 : 0);
		if (fails) expect(stream.errors[0]?.message).toContain(`${CHILD_UNTERMINATED_MAX_BYTES} bytes`);
	});

	it("rejects many small delimiter-free chunks before retaining more than the cap", () => {
		const stream = decoder({ frame: 20_000, unterminated: 10_000 });
		for (let index = 0; index < 10_001; index += 1) stream.value.write(Buffer.from("x"));

		expect(stream.errors).toHaveLength(1);
		expect(stream.lines).toEqual([]);
		expect(stream.value.bufferedBytes).toBe(0);
	});

	it("decodes split multibyte input and emits a final partial line once", () => {
		const stream = decoder();
		const payload = Buffer.from('{"text":"🧘"}', "utf8");
		const split = payload.indexOf(0xf0) + 2;
		stream.value.write(payload.subarray(0, split));
		stream.value.write(payload.subarray(split));
		stream.value.end();
		stream.value.end();

		expect(stream.lines).toEqual(['{"text":"🧘"}']);
		expect(stream.errors).toEqual([]);
	});

	it("never parses a truncated oversized frame", () => {
		const onLine = vi.fn();
		const onError = vi.fn();
		const stream = new JsonLineDecoder({ onLine, onError, maxFrameBytes: 8, maxUnterminatedBytes: 8 });
		stream.write('{"x":"123456789"}\n{"ok":true}\n');

		expect(onError).toHaveBeenCalledOnce();
		expect(onLine).not.toHaveBeenCalled();
	});

	it("grows retained storage from a small buffer and releases it at end", () => {
		const stream = decoder({ frame: 1024 * 1024, unterminated: 1024 * 1024 });
		expect(stream.value.retainedCapacityBytes).toBe(0);

		stream.value.write("x");
		expect(stream.value.retainedCapacityBytes).toBe(1024);
		expect(stream.value.retainedCapacityBytes).toBeLessThan(1024 * 1024);

		stream.value.write(Buffer.alloc(2000, 0x79));
		expect(stream.value.retainedCapacityBytes).toBe(2048);
		stream.value.end();
		expect(stream.value.retainedCapacityBytes).toBe(0);
	});

	it("drops oversized frame capacity after emitting a line", () => {
		const stream = decoder({ frame: 1024 * 1024, unterminated: 1024 * 1024 });
		stream.value.write(Buffer.concat([Buffer.alloc(128 * 1024, 0x7a), Buffer.from("\n")]));

		expect(stream.lines).toHaveLength(1);
		expect(stream.value.retainedCapacityBytes).toBe(0);
		stream.value.write("next");
		expect(stream.value.retainedCapacityBytes).toBe(1024);
	});
});

describe("BoundedUtf8Head", () => {
	it("accounts for each multibyte delta once instead of rescanning retained text", () => {
		const head = new BoundedUtf8Head();
		const byteLength = vi.spyOn(Buffer, "byteLength");
		try {
			for (let index = 0; index < 5000; index += 1) head.append("🧘");

			expect(head.retainedBytes).toBe(20_000);
			expect(byteLength).toHaveBeenCalledTimes(5000);
			expect(byteLength.mock.calls.every(([value]) => value === "🧘")).toBe(true);
		} finally {
			byteLength.mockRestore();
		}
	});

	it("caps split multibyte deltas without breaking a codepoint", () => {
		const head = new BoundedUtf8Head(40);
		head.append("a".repeat(20));
		head.append("🧘".repeat(10));

		const value = head.toString();
		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(40);
		expect(value).toContain(TRUNCATED_HEAD_MARKER);
		expect(value).not.toContain("�");
	});

	it("applies the retained-result cap and marker across many deltas", () => {
		const head = new BoundedUtf8Head();
		for (let index = 0; index < 5; index += 1) head.append("x".repeat(1024 * 1024));

		const value = head.toString();
		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(value).toContain(TRUNCATED_HEAD_MARKER);
	});
});

describe("BoundedUtf8Tail", () => {
	it.each([
		["just below", CHILD_STDERR_TAIL_MAX_BYTES - 1, false],
		["at", CHILD_STDERR_TAIL_MAX_BYTES, false],
		["above", CHILD_STDERR_TAIL_MAX_BYTES + 1, true],
	] as const)("enforces the documented stderr limit %s the boundary", (_label, size, truncated) => {
		const tail = new BoundedUtf8Tail();
		tail.append(Buffer.alloc(size, 0x78));
		const value = tail.toString();

		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(CHILD_STDERR_TAIL_MAX_BYTES);
		expect(value.startsWith(TRUNCATED_TAIL_MARKER)).toBe(truncated);
	});

	it("keeps the newest complete multibyte text and marks dropped output", () => {
		const tail = new BoundedUtf8Tail(40);
		const bytes = Buffer.from(`${"old".repeat(20)}🧘new`, "utf8");
		for (const byte of bytes) tail.append(Buffer.from([byte]));

		const value = tail.toString();
		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(40);
		expect(value).toContain(TRUNCATED_TAIL_MARKER);
		expect(value).toContain("🧘new");
		expect(value).not.toContain("�");
	});

	it("does not recopy the retained tail for every small append after truncation", () => {
		const tail = new BoundedUtf8Tail();
		tail.append(Buffer.alloc(CHILD_STDERR_TAIL_MAX_BYTES + 1, 0x78));
		const concat = vi.spyOn(Buffer, "concat");
		try {
			for (let index = 0; index < 16; index += 1) tail.append(Buffer.from("y"));
			expect(concat).not.toHaveBeenCalled();
			expect(tail.toString()).toContain(TRUNCATED_TAIL_MARKER);
		} finally {
			concat.mockRestore();
		}
	});

	it("caps replacement characters from malformed bytes while keeping a useful valid suffix", () => {
		const suffix = "useful stderr suffix";
		const suffixBytes = Buffer.from(suffix, "utf8");
		const tail = new BoundedUtf8Tail();
		tail.append(Buffer.concat([
			Buffer.alloc(CHILD_STDERR_TAIL_MAX_BYTES - suffixBytes.byteLength, 0xff),
			suffixBytes,
		]));

		const value = tail.toString();
		expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(CHILD_STDERR_TAIL_MAX_BYTES);
		expect(value.split(TRUNCATED_TAIL_MARKER)).toHaveLength(2);
		expect(value.endsWith(suffix)).toBe(true);
	});
});

describe("boundRetainedResult", () => {
	it.each([
		["just below", CHILD_RETAINED_RESULT_MAX_BYTES - 1, false],
		["at", CHILD_RETAINED_RESULT_MAX_BYTES, false],
		["above", CHILD_RETAINED_RESULT_MAX_BYTES + 1, true],
	] as const)("enforces the documented retained-result limit %s the boundary", (_label, size, truncated) => {
		const value = boundRetainedResult("r".repeat(size));

		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(value.endsWith(TRUNCATED_HEAD_MARKER)).toBe(truncated);
	});

	it("does not split a multibyte codepoint at the retained-result boundary", () => {
		const value = boundRetainedResult(`${"x".repeat(28)}🧘tail`, 32);
		expect(Buffer.byteLength(value)).toBeLessThanOrEqual(32);
		expect(value).not.toContain("�");
		expect(value).toContain(TRUNCATED_HEAD_MARKER);
	});
});
