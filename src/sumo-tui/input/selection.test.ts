import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CellBuffer } from "../render/buffer.js";
import { SelectionController } from "./selection.js";

function bufferWithRow(text: string, cols = text.length): CellBuffer {
	const buffer = new CellBuffer(1, cols);
	buffer.paintRow(0, text.padEnd(cols, " "));
	return buffer;
}

describe("SelectionController", () => {
	it("does not start semantic selection from non-selectable frame cells", () => {
		const buffer = bufferWithRow("│ selectable │", 16);
		for (let col = 2; col <= 11; col += 1) buffer.setSelectionMeta(0, col, { selectable: true });
		const selection = new SelectionController();

		expect(selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 0, modifiers: { shift: false, alt: false, ctrl: false } }, buffer)).toBe(false);
		expect(selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 8, modifiers: { shift: false, alt: false, ctrl: false } }, buffer)).toBe(false);
		selection.applySelectionHighlight(buffer);

		expect(selection.extractSelectedText(buffer)).toBe("");
		expect(buffer.getCell(0, 2).attrs.inverse).toBe(false);
	});

	it("uses semantic selection metadata instead of rectangular row cells", () => {
		const buffer = bufferWithRow("│ abc                         │", 32);
		for (let col = 2; col <= 4; col += 1) buffer.setSelectionMeta(0, col, { selectable: true });
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 30, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.applySelectionHighlight(buffer);

		expect(selection.extractSelectedText(buffer)).toBe("abc");
		expect(buffer.getCell(0, 2).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 4).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 5).attrs.inverse).toBe(false);
		expect(buffer.getCell(0, 30).attrs.inverse).toBe(false);
	});

	it("clips same-row selection highlight to selectable text, not frame padding", () => {
		const buffer = bufferWithRow("│ `dd of=`                         │", 36);
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 35, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.applySelectionHighlight(buffer);

		expect(selection.extractSelectedText(buffer)).toBe("`dd of=`");
		expect(buffer.getCell(0, 2).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 9).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 10).attrs.inverse).toBe(false);
		expect(buffer.getCell(0, 35).attrs.inverse).toBe(false);
	});

	it("clips non-breaking trailing whitespace too", () => {
		const buffer = bufferWithRow("│ text\u00a0\u00a0\u00a0\u00a0│", 12);
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 10, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.applySelectionHighlight(buffer);

		expect(selection.extractSelectedText(buffer)).toBe("text");
		expect(buffer.getCell(0, 2).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 5).attrs.inverse).toBe(true);
		expect(buffer.getCell(0, 6).attrs.inverse).toBe(false);
	});

	describe("selection diagnostics", () => {
		let tmp: string;
		let diagFile: string;
		let previousDiag: string | undefined;

		beforeEach(() => {
			tmp = mkdtempSync(join(tmpdir(), "sumocode-selection-"));
			diagFile = join(tmp, "diag.jsonl");
			previousDiag = process.env.SUMO_TUI_DIAG_FILE;
			process.env.SUMO_TUI_DIAG_FILE = diagFile;
		});

		afterEach(() => {
			if (previousDiag === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
			else process.env.SUMO_TUI_DIAG_FILE = previousDiag;
			rmSync(tmp, { recursive: true, force: true });
		});

		it("records semantic highlight ranges that match selectable cells", () => {
			const buffer = bufferWithRow("│ Hello world                  │", 32);
			for (let col = 2; col <= 12; col += 1) buffer.setSelectionMeta(0, col, { selectable: true });
			const selection = new SelectionController();

			selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
			selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 30, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
			selection.applySelectionHighlight(buffer);

			const events = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const highlight = events.find((event) => event.event === "selection_highlight");
			expect(highlight).toMatchObject({
				semantic: true,
				rowsTouched: 1,
				cellsInverted: 11,
				totalRows: 1,
			});
			expect(highlight.sampleRows).toEqual([{ row: 0, ranges: [[2, 12]] }]);
		});

		it("reports semantic mode even when selectable cells span less than rectangular range", () => {
			const buffer = bufferWithRow("│ Hi                               │", 36);
			for (let col = 2; col <= 3; col += 1) buffer.setSelectionMeta(0, col, { selectable: true });
			const selection = new SelectionController();

			selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
			selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 35, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
			selection.applySelectionHighlight(buffer);

			const events = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const highlight = events.find((event) => event.event === "selection_highlight");
			expect(highlight).toMatchObject({
				semantic: true,
				rowsTouched: 1,
				cellsInverted: 2,
			});
			expect(highlight.sampleRows).toEqual([{ row: 0, ranges: [[2, 3]] }]);
		});

		it("logs selection copy metadata without a plaintext preview", () => {
			const buffer = bufferWithRow("secret text", 16);
			const selection = new SelectionController();

			selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 0, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
			selection.handleMouseEvent({ type: "up", button: 0, row: 0, col: 10, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

			const events = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const copy = events.find((event) => event.event === "selection_copy_success");
			expect(copy).toBeDefined();
			expect(copy.chars).toBeGreaterThan(0);
			expect(copy).not.toHaveProperty("preview");
			const finish = events.find((event) => event.event === "selection_finish");
			expect(finish).toBeDefined();
			expect(finish.selectedChars).toBeGreaterThan(0);
			expect(finish).not.toHaveProperty("preview");
			expect(readFileSync(diagFile, "utf8")).not.toContain("secret text");
		});
	});

	it("snaps focus back to the anchor row when drag drifts onto a non-selectable gap row", () => {
		const buffer = new CellBuffer(3, 80);
		buffer.paintRow(0, " ".repeat(80));
		buffer.paintRow(1, "│ hello world here is some text                                              │");
		buffer.paintRow(2, " ".repeat(80));
		for (let col = 2; col <= 32; col += 1) buffer.setSelectionMeta(1, col, { selectable: true });
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 8, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 0, col: 12, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		const range = selection.getRange();
		expect(range?.focus.row).toBe(1);
		expect(range?.focus.col).toBe(12);
		expect(selection.extractSelectedText(buffer)).toBe("world");
	});

	it("snaps mouse-up focus back to the anchor row when release lands on a gap row", () => {
		const buffer = new CellBuffer(3, 80);
		buffer.paintRow(0, " ".repeat(80));
		buffer.paintRow(1, "│ word boundary check                                                          │");
		buffer.paintRow(2, " ".repeat(80));
		for (let col = 2; col <= 22; col += 1) buffer.setSelectionMeta(1, col, { selectable: true });
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 7, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "up", button: 0, row: 0, col: 11, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		const range = selection.getRange();
		expect(range?.focus.row).toBe(1);
		expect(range?.focus.col).toBe(11);
	});

	it("keeps multi-row drag intact when focus row has selectable content", () => {
		const buffer = new CellBuffer(4, 80);
		buffer.paintRow(0, " ".repeat(80));
		buffer.paintRow(1, "│ first message line                                                            │");
		buffer.paintRow(2, "│ second message line                                                           │");
		buffer.paintRow(3, " ".repeat(80));
		for (let col = 2; col <= 22; col += 1) buffer.setSelectionMeta(1, col, { selectable: true });
		for (let col = 2; col <= 22; col += 1) buffer.setSelectionMeta(2, col, { selectable: true });
		const selection = new SelectionController();

		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 8, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 2, col: 12, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		const range = selection.getRange();
		expect(range?.focus.row).toBe(2);
		expect(range?.focus.col).toBe(12);
	});

	it("emits a copied callback after OSC 52 copy succeeds", () => {
		const buffer = bufferWithRow("copy me", 12);
		const onCopied = vi.fn();
		const emitClipboard = vi.fn();
		const selection = new SelectionController({ onCopied, emitClipboard });

		selection.handleMouseEvent({ type: "down", button: 0, row: 0, col: 0, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "up", button: 0, row: 0, col: 6, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		expect(emitClipboard).toHaveBeenCalledWith(expect.stringContaining("\u001b]52;c;"), "copy me");
		expect(onCopied).toHaveBeenCalledWith("copy me");
	});
});
