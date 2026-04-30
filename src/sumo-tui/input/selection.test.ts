import { describe, expect, it, vi } from "vitest";
import { CellBuffer } from "../render/buffer.js";
import { SelectionController } from "./selection.js";

function bufferWithRow(text: string, cols = text.length): CellBuffer {
	const buffer = new CellBuffer(1, cols);
	buffer.paintRow(0, text.padEnd(cols, " "));
	return buffer;
}

describe("SelectionController", () => {
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
