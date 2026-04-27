import { describe, expect, it } from "vitest";
import { cellRowToAnsi } from "./ansi-writer.js";
import { CellBuffer } from "./buffer.js";

describe("truecolor ANSI preservation", () => {
	it("round-trips a 24-bit foreground SGR through the cell buffer", () => {
		const buffer = new CellBuffer(1, 1);
		buffer.paintRow(0, "\x1b[38;2;217;119;6mX\x1b[0m");

		expect(buffer.getCell(0, 0).fg).toBe("#d97706");
		expect(cellRowToAnsi(buffer, 0)).toBe("\x1b[38;2;217;119;6mX\x1b[0m");
	});

	it("preserves the cathedral accent as the original 24-bit SGR on write", () => {
		const buffer = new CellBuffer(1, 1);
		buffer.paintRow(0, "\x1b[38;2;217;119;6m◆\x1b[0m");

		expect(buffer.getCell(0, 0).fg).toBe("#d97706");
		expect(cellRowToAnsi(buffer, 0)).toContain("\x1b[38;2;217;119;6m");
	});

	it("parses combined bold, truecolor foreground, and truecolor background SGR params", () => {
		const buffer = new CellBuffer(1, 1);
		buffer.paintRow(0, "\x1b[1;38;2;217;119;6;48;2;26;21;17mX\x1b[0m");
		const cell = buffer.getCell(0, 0);

		expect(cell.attrs.bold).toBe(true);
		expect(cell.fg).toBe("#d97706");
		expect(cell.bg).toBe("#1a1511");
		expect(cellRowToAnsi(buffer, 0)).toBe("\x1b[1;38;2;217;119;6;48;2;26;21;17mX\x1b[0m");
	});

	it("parses 256-color foreground and background SGR params", () => {
		const buffer = new CellBuffer(1, 1);
		buffer.paintRow(0, "\x1b[38;5;208;48;5;235mX\x1b[0m");
		const cell = buffer.getCell(0, 0);

		expect(cell.fg).toBe("#ff8700");
		expect(cell.bg).toBe("#262626");
		expect(cellRowToAnsi(buffer, 0)).toBe("\x1b[38;2;255;135;0;48;2;38;38;38mX\x1b[0m");
	});

	it("ignores invalid extended-color escapes without crashing or leaking bad color", () => {
		const buffer = new CellBuffer(1, 2);
		buffer.paintRow(0, "\x1b[38;2;999;0;6mX\x1b[38;5;999mY\x1b[0m");

		expect(buffer.getCell(0, 0).fg).toBeUndefined();
		expect(buffer.getCell(0, 1).fg).toBeUndefined();
		expect(cellRowToAnsi(buffer, 0)).toBe("XY");
	});
});
