import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { CellBuffer } from "./buffer.js";
import {
	lineToAnsi,
	lineToCells,
	lineWidth,
	plainLine,
	renderBox,
	renderRule,
	span,
	textLine,
	truncateLine,
} from "./primitives.js";

function chars(buffer: CellBuffer, width: number): string {
	return Array.from({ length: width }, (_value, col) => buffer.getCell(0, col).char).join("");
}

describe("typed render primitives", () => {
	it("fills the full row background when padding ANSI output", () => {
		const width = 8;
		const ansi = lineToAnsi(plainLine("REG", {
			fg: CATHEDRAL_TOKENS.colors.foreground,
			bg: CATHEDRAL_TOKENS.colors.surface,
		}), { width });
		const buffer = new CellBuffer(1, width);

		buffer.paintRow(0, ansi);

		expect(chars(buffer, width)).toBe("REG     ");
		for (let col = 0; col < width; col += 1) {
			expect(buffer.getCell(0, col).bg?.toUpperCase()).toBe(CATHEDRAL_TOKENS.colors.surface.toUpperCase());
		}
	});

	it("re-applies row style after styled spans and emits a final reset", () => {
		const ansi = lineToAnsi(textLine([
			span("A", { fg: CATHEDRAL_TOKENS.colors.accent, bold: true }),
			"B",
		], {
			fg: CATHEDRAL_TOKENS.colors.foregroundDim,
			bg: CATHEDRAL_TOKENS.colors.surface,
		}), { width: 3 });
		const buffer = new CellBuffer(1, 3);

		buffer.paintRow(0, ansi);

		expect(ansi.endsWith("\u001b[0m")).toBe(true);
		expect(buffer.getCell(0, 0).fg?.toUpperCase()).toBe(CATHEDRAL_TOKENS.colors.accent.toUpperCase());
		expect(buffer.getCell(0, 0).attrs.bold).toBe(true);
		expect(buffer.getCell(0, 1).fg?.toUpperCase()).toBe(CATHEDRAL_TOKENS.colors.foregroundDim.toUpperCase());
		expect(buffer.getCell(0, 1).attrs.bold).toBe(false);
		expect(buffer.getCell(0, 1).bg?.toUpperCase()).toBe(CATHEDRAL_TOKENS.colors.surface.toUpperCase());
		expect(buffer.getCell(0, 2).bg?.toUpperCase()).toBe(CATHEDRAL_TOKENS.colors.surface.toUpperCase());
	});

	it("truncates typed lines by visible width while preserving span styles", () => {
		const source = textLine([
			span("abcd", { fg: CATHEDRAL_TOKENS.colors.accent }),
			span("ef", { fg: CATHEDRAL_TOKENS.colors.foreground }),
		]);
		const truncated = truncateLine(source, 5);
		const cells = lineToCells(truncated, { width: 5 });

		expect(lineWidth(truncated)).toBe(5);
		expect(cells.map((cell) => cell.char).join("")).toBe("abcde");
		expect(cells[0]?.fg).toBe(CATHEDRAL_TOKENS.colors.accent);
		expect(cells[4]?.fg).toBe(CATHEDRAL_TOKENS.colors.foreground);
	});

	it("renders shared rule and box helpers as typed lines", () => {
		const ruleCells = lineToCells(renderRule(6, {
			indent: "  ",
			char: "━",
			style: { fg: CATHEDRAL_TOKENS.colors.divider },
		}), { width: 6 });
		expect(ruleCells.map((cell) => cell.char).join("")).toBe("  ━━━━");
		expect(ruleCells[2]?.fg).toBe(CATHEDRAL_TOKENS.colors.divider);

		const box = renderBox([plainLine("ok")], {
			width: 6,
			style: { bg: CATHEDRAL_TOKENS.colors.surfaceRecess },
			borderStyle: { fg: CATHEDRAL_TOKENS.colors.divider },
			fillStyle: { fg: CATHEDRAL_TOKENS.colors.foreground, bg: CATHEDRAL_TOKENS.colors.surfaceRecess },
		});

		expect(box).toHaveLength(3);
		expect(lineToCells(box[1]!, { width: 6 }).map((cell) => cell.char).join("")).toBe("│ok  │");
	});
});
