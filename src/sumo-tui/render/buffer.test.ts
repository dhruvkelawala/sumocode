import { describe, expect, it } from "vitest";
import { CellBuffer } from "./buffer.js";
import { createAttrs } from "./cell.js";

describe("CellBuffer", () => {
	it("sets, gets, clears, and paints cells", () => {
		const buffer = new CellBuffer(3, 5);
		buffer.setCell(1, 2, { char: "x", fg: "#112233", attrs: createAttrs({ bold: true }) });
		expect(buffer.getCell(1, 2)).toMatchObject({ char: "x", fg: "#112233", attrs: { bold: true } });

		buffer.paint({ top: 0, left: 0, width: 2, height: 2 }, { char: ".", attrs: createAttrs() });
		expect(buffer.toPlainRow(0).slice(0, 2)).toBe("..");
		buffer.clear({ top: 0, left: 0, width: 1, height: 1 });
		expect(buffer.getCell(0, 0).char).toBe(" ");
	});

	it("paints ANSI rows into cells while preserving styles", () => {
		const buffer = new CellBuffer(1, 8);
		buffer.paintRow(0, "a\x1b[31;1mb\x1b[0mc");

		expect(buffer.toPlainRow(0).slice(0, 3)).toBe("abc");
		expect(buffer.getCell(0, 1).fg).toBe("#800000");
		expect(buffer.getCell(0, 1).attrs.bold).toBe(true);
		expect(buffer.getCell(0, 2).fg).toBeUndefined();
	});

	it("handles wide characters with Pi visibleWidth semantics (EC-12.x)", () => {
		const buffer = new CellBuffer(1, 6);
		buffer.paintRow(0, "a界b");

		expect(buffer.getCell(0, 0).char).toBe("a");
		expect(buffer.getCell(0, 1).char).toBe("界");
		expect(buffer.getCell(0, 2).char).toBe("");
		expect(buffer.getCell(0, 3).char).toBe("b");
	});

	it("resizes while preserving overlapping cells (EC-3.1)", () => {
		const buffer = new CellBuffer(2, 4);
		buffer.paintRow(0, "abcd");
		buffer.paintRow(1, "efgh");
		buffer.resize(3, 2);

		expect(buffer.getDimensions()).toEqual({ rows: 3, cols: 2 });
		expect(buffer.toPlainRow(0)).toBe("ab");
		expect(buffer.toPlainRow(1)).toBe("ef");
		expect(buffer.toPlainRow(2)).toBe("  ");
	});

	it("clears and paints transparent rows on top of the configured default background", () => {
		const buffer = new CellBuffer(1, 4);
		buffer.setDefaultBackground("#1A1511");
		buffer.setDefaultForeground("#F5E6C8");
		buffer.clear();
		buffer.paintRow(0, "hi");

		expect(buffer.getCell(0, 0).bg).toBe("#1A1511");
		expect(buffer.getCell(0, 1).bg).toBe("#1A1511");
		expect(buffer.getCell(0, 2).bg).toBe("#1A1511");
		expect(buffer.getCell(0, 2).fg).toBe("#F5E6C8");
	});
});
