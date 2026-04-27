import { describe, expect, it } from "vitest";
import { CellBuffer } from "./buffer.js";

describe("paintRow inherits defaultBg per #58", () => {
	it("ANSI text with no explicit bg writes cells with the buffer's defaultBg", () => {
		const buffer = new CellBuffer(1, 12);
		buffer.setDefaultBackground("#1A1511");
		buffer.setDefaultForeground("#F5E6C8");
		buffer.clear();
		// Cathedral foreground only; no explicit bg in the ANSI input
		buffer.paintRow(0, "\x1b[38;2;245;230;200mhello\x1b[0m");
		const cell = buffer.getCell(0, 0);
		expect(cell.bg?.toUpperCase()).toBe("#1A1511");
	});

	it("explicit bg in ANSI overrides defaultBg", () => {
		const buffer = new CellBuffer(1, 12);
		buffer.setDefaultBackground("#1A1511");
		buffer.clear();
		buffer.paintRow(0, "\x1b[48;2;36;29;23mhello\x1b[0m");
		const cell = buffer.getCell(0, 0);
		expect(cell.bg?.toUpperCase()).toBe("#241D17");
	});

	it("rows ALL receive defaultBg even past the painted text", () => {
		const buffer = new CellBuffer(1, 20);
		buffer.setDefaultBackground("#1A1511");
		buffer.clear();
		buffer.paintRow(0, "hi");
		const cellBeyond = buffer.getCell(0, 15);
		expect(cellBeyond.bg?.toUpperCase()).toBe("#1A1511");
	});
});
