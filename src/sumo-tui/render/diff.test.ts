import { describe, expect, it } from "vitest";
import { CellBuffer } from "./buffer.js";
import { diffFrames } from "./diff.js";

function frame(lines: string[]): CellBuffer {
	const cols = Math.max(...lines.map((line) => line.length));
	const buffer = new CellBuffer(lines.length, cols);
	lines.forEach((line, row) => buffer.paintRow(row, line));
	return buffer;
}

describe("frame diff", () => {
	it("returns empty diff for unchanged frames", () => {
		const previous = frame(["aaa", "bbb"]);
		const next = frame(["aaa", "bbb"]);
		expect(diffFrames(previous, next)).toEqual([]);
	});

	it("returns one row patch for one fully changed row", () => {
		const previous = frame(["aaa", "bbb"]);
		const next = frame(["aaa", "ccc"]);
		expect(diffFrames(previous, next)).toEqual([
			{ row: 1, startCol: 0, ansi: "ccc", type: "row" },
		]);
	});

	it("emits a column-range patch when only the right side of a row changes", () => {
		const previous = frame(["abcdef", "stable"]);
		const next = frame(["abcDEF", "stable"]);
		const patches = diffFrames(previous, next);
		expect(patches).toEqual([
			{ row: 0, startCol: 3, ansi: "DEF", type: "row" },
		]);
	});

	it("emits a column-range patch when only one cell in the middle changes", () => {
		const previous = frame(["abcdef"]);
		const next = frame(["abcXef"]);
		const patches = diffFrames(previous, next);
		expect(patches).toHaveLength(1);
		// The slice covers exactly the changed cell — no left or right padding.
		expect(patches[0]).toEqual({ row: 0, startCol: 3, ansi: "X", type: "row" });
	});

	it("falls back to full-row repaint when the change starts at column 0", () => {
		const previous = frame(["abcdef"]);
		const next = frame(["XBCdef"]);
		const patches = diffFrames(previous, next);
		expect(patches).toEqual([
			{ row: 0, startCol: 0, ansi: "XBCdef", type: "row" },
		]);
	});

	it("repaints all rows when dimensions change", () => {
		const previous = frame(["aa"]);
		const next = frame(["aa", "bb"]);
		expect(diffFrames(previous, next)).toEqual([
			{ row: 0, startCol: 0, ansi: "aa", type: "row" },
			{ row: 1, startCol: 0, ansi: "bb", type: "row" },
		]);
	});

	it("detects scroll-up regions instead of repainting every shifted row", () => {
		const previous = frame(["one", "two", "tre", "for", "fiv"]);
		const next = frame(["two", "tre", "for", "fiv", "six"]);
		const patches = diffFrames(previous, next);

		expect(patches[0]).toMatchObject({ type: "scroll", direction: "up", count: 1, top: 0, bottom: 4 });
		expect(patches[0]?.ansi).toContain("\x1b[1;5r\x1b[1S\x1b[r");
		expect(patches).toHaveLength(2);
		expect(patches[1]).toEqual({ row: 4, startCol: 0, ansi: "six", type: "row" });
	});
});
