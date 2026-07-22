import { describe, expect, it } from "vitest";
import { ACTIVITY_OUTPUT_MAX_BYTES, ACTIVITY_OUTPUT_MAX_LINES, boundedOutputTail } from "./output-tail.js";

describe("boundedOutputTail", () => {
	it("keeps the newest byte and line bounded output", () => {
		const text = Array.from({ length: 80 }, (_, index) => `${index}:${"x".repeat(1_000)}`).join("\n");
		const tail = boundedOutputTail(text);
		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_BYTES);
		expect(tail.split("\n").length).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_LINES);
		expect(tail).toContain("79:");
		expect(tail.split("\n")).not.toContainEqual(expect.stringMatching(/^0:/));
	});

	it("never splits a multibyte codepoint at the byte boundary", () => {
		const emoji = "🧘";
		const bytes = Buffer.from(`${"x".repeat(ACTIVITY_OUTPUT_MAX_BYTES)}${emoji}`, "utf8");
		const tail = boundedOutputTail(bytes);
		expect(tail.endsWith(emoji)).toBe(true);
		expect(tail).not.toContain("�");
	});

	it("drops an incomplete concurrently-written UTF-8 suffix", () => {
		const complete = Buffer.from("ready 🧘", "utf8");
		const truncated = complete.subarray(0, complete.length - 1);
		const tail = boundedOutputTail(truncated);
		expect(tail).toBe("ready ");
		expect(tail).not.toContain("�");
	});

	it("strips ANSI and controls before enforcing the final bound", () => {
		const tail = boundedOutputTail(`\u001b[31mred\u001b[0m\tvalue\rnext\u0000`);
		expect(tail).toBe("red    value\nnext");
		expect(tail).not.toContain("\u001b");
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_BYTES);
	});
});
