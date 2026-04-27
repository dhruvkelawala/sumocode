import { describe, expect, it } from "vitest";
import { CellBuffer } from "./buffer.js";
import { createAttrs } from "./cell.js";
import { bufferToAnsiLines, cellRowToAnsi } from "./ansi-writer.js";

describe("ANSI writer", () => {
	it("emits plain rows without style noise", () => {
		const buffer = new CellBuffer(1, 5);
		buffer.paintRow(0, "hello");
		expect(cellRowToAnsi(buffer, 0)).toBe("hello");
	});

	it("RLE-compresses repeated styles and resets when style changes", () => {
		const buffer = new CellBuffer(1, 3);
		buffer.setCell(0, 0, { char: "a", fg: "#ff0000", attrs: createAttrs({ bold: true }) });
		buffer.setCell(0, 1, { char: "b", fg: "#ff0000", attrs: createAttrs({ bold: true }) });
		buffer.setCell(0, 2, { char: "c", attrs: createAttrs() });

		expect(cellRowToAnsi(buffer, 0)).toBe("\x1b[1;38;2;255;0;0mab\x1b[0mc");
	});

	it("does not emit continuation cells for wide glyphs", () => {
		const buffer = new CellBuffer(1, 4);
		buffer.paintRow(0, "界x");
		expect(cellRowToAnsi(buffer, 0)).toBe("界x ");
	});

	it("serializes all rows", () => {
		const buffer = new CellBuffer(2, 2);
		buffer.paintRow(0, "aa");
		buffer.paintRow(1, "bb");
		expect(bufferToAnsiLines(buffer)).toEqual(["aa", "bb"]);
	});
});
