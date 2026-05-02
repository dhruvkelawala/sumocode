import type { CellBuffer } from "./buffer.js";
import type { Cell } from "./cell.js";
import { cellRowToAnsi, cellRowSliceToAnsi } from "./ansi-writer.js";

export interface FrameDiffPatch {
	row: number;
	/**
	 * Column offset (0-indexed) where this patch starts on the row.
	 *
	 * - For full-row repaints (`type: "row"` with `startCol === 0`) and scroll
	 *   patches the writer continues to emit `\x1b[K` after the ANSI to clear
	 *   any trailing cells.
	 * - For partial-row patches (`startCol > 0`) the writer emits ONLY the
	 *   slice and skips the line-clear so unchanged cells to the left and
	 *   right of the change region survive untouched.
	 *
	 * Borrowed from OpenTUI's per-row column-range diff (`zig/renderer.zig`
	 * 1331-1349). Saves 50–90% of bytes per streaming tick on typical chat
	 * updates because cursor blink + single-cell streaming changes no longer
	 * trigger full-row repaints. See `docs/research/OPENTUI_COMPARISON.md` §A3.
	 */
	startCol: number;
	ansi: string;
	type: "row" | "scroll";
	top?: number;
	bottom?: number;
	count?: number;
	direction?: "up" | "down";
}

function dimensionsEqual(prev: CellBuffer, next: CellBuffer): boolean {
	const left = prev.getDimensions();
	const right = next.getDimensions();
	return left.rows === right.rows && left.cols === right.cols;
}

function cellsDiffer(left: Cell, right: Cell): boolean {
	if (left.char !== right.char || left.fg !== right.fg || left.bg !== right.bg) return true;
	return (
		left.attrs.bold !== right.attrs.bold ||
		left.attrs.italic !== right.attrs.italic ||
		left.attrs.underline !== right.attrs.underline ||
		left.attrs.dim !== right.attrs.dim ||
		left.attrs.inverse !== right.attrs.inverse
	);
}

/**
 * Find the leftmost and rightmost differing columns between two rows. Returns
 * `null` when the rows are identical.
 *
 * Backs up `startCol` across wide-char continuation cells so the slice always
 * begins at the head of a glyph (continuation cells have `char === ""` and
 * `cellRowSliceToAnsi` would otherwise skip them, shifting the slice).
 */
function rowChangeRange(
	prev: CellBuffer,
	prevRow: number,
	next: CellBuffer,
	nextRow: number,
): { startCol: number; endCol: number } | null {
	const { cols } = prev.getDimensions();
	let startCol = -1;
	let endCol = -1;
	for (let col = 0; col < cols; col += 1) {
		if (cellsDiffer(prev.getCell(prevRow, col), next.getCell(nextRow, col))) {
			if (startCol === -1) startCol = col;
			endCol = col;
		}
	}
	if (startCol === -1) return null;
	while (startCol > 0 && next.getCell(nextRow, startCol).char === "") startCol -= 1;
	return { startCol, endCol };
}

function rowsEqualAt(prev: CellBuffer, prevRow: number, next: CellBuffer, nextRow: number): boolean {
	return rowChangeRange(prev, prevRow, next, nextRow) === null;
}

function changedRowPatches(prev: CellBuffer, next: CellBuffer): FrameDiffPatch[] {
	const { rows } = next.getDimensions();
	const patches: FrameDiffPatch[] = [];
	for (let row = 0; row < rows; row += 1) {
		const range = rowChangeRange(prev, row, next, row);
		if (!range) continue;
		if (range.startCol === 0) {
			// Full-row repaint matches the legacy ansi-writer + clear-line contract.
			patches.push({ row, startCol: 0, ansi: cellRowToAnsi(next, row), type: "row" });
		} else {
			// Partial-row patch: emit only the changed range. The terminal-controller
			// skips `\x1b[K` for these so unchanged cells to the right are preserved.
			patches.push({
				row,
				startCol: range.startCol,
				ansi: cellRowSliceToAnsi(next, row, range.startCol, range.endCol),
				type: "row",
			});
		}
	}
	return patches;
}

function scrollSequence(top: number, bottom: number, count: number, direction: "up" | "down"): string {
	const command = direction === "up" ? "S" : "T";
	return `\x1b[${top + 1};${bottom + 1}r\x1b[${count}${command}\x1b[r`;
}

function detectScroll(prev: CellBuffer, next: CellBuffer): FrameDiffPatch[] | null {
	const { rows } = next.getDimensions();
	if (rows < 2) return null;
	const maxScroll = Math.min(3, rows - 1);

	for (let count = 1; count <= maxScroll; count += 1) {
		let shiftedUp = true;
		for (let row = 0; row < rows - count; row += 1) {
			if (!rowsEqualAt(prev, row + count, next, row)) {
				shiftedUp = false;
				break;
			}
		}
		if (shiftedUp) {
			const patches: FrameDiffPatch[] = [
				{
					row: 0,
					startCol: 0,
					ansi: scrollSequence(0, rows - 1, count, "up"),
					type: "scroll",
					top: 0,
					bottom: rows - 1,
					count,
					direction: "up",
				},
			];
			for (let row = rows - count; row < rows; row += 1) {
				patches.push({ row, startCol: 0, ansi: cellRowToAnsi(next, row), type: "row" });
			}
			return patches;
		}

		let shiftedDown = true;
		for (let row = count; row < rows; row += 1) {
			if (!rowsEqualAt(prev, row - count, next, row)) {
				shiftedDown = false;
				break;
			}
		}
		if (shiftedDown) {
			const patches: FrameDiffPatch[] = [
				{
					row: 0,
					startCol: 0,
					ansi: scrollSequence(0, rows - 1, count, "down"),
					type: "scroll",
					top: 0,
					bottom: rows - 1,
					count,
					direction: "down",
				},
			];
			for (let row = 0; row < count; row += 1) {
				patches.push({ row, startCol: 0, ansi: cellRowToAnsi(next, row), type: "row" });
			}
			return patches;
		}
	}

	return null;
}

/**
 * Compare retained frames and return changed rows only.
 *
 * Source: borrowed the full-repaint-on-shape-change + per-row patch structure
 * from opentui-island `src/core/frame-diff.ts:46-86`; sumo-tui adapts that
 * HostFrame/HostLine algorithm to CellBuffer rows and adds a small scroll
 * detector for shifted terminal regions.
 *
 * Per-row column-range patches are an additional borrow from
 * `anomalyco/opentui` (`zig/renderer.zig` 1331-1349) — see
 * `docs/research/OPENTUI_COMPARISON.md` §A3.
 */
export interface FrameDiffOptions {
	/**
	 * Detect shifted rows and emit terminal scroll-region sequences. Useful for
	 * plain full-screen retained roots, but unsafe when only one visual region
	 * should scroll while sibling/overlay chrome must remain pinned.
	 */
	detectScroll?: boolean;
}

export function diffFrames(prev: CellBuffer | null | undefined, next: CellBuffer, options: FrameDiffOptions = {}): FrameDiffPatch[] {
	if (!prev || !dimensionsEqual(prev, next)) {
		const { rows } = next.getDimensions();
		const patches: FrameDiffPatch[] = [];
		for (let row = 0; row < rows; row += 1) {
			patches.push({ row, startCol: 0, ansi: cellRowToAnsi(next, row), type: "row" });
		}
		return patches;
	}

	const patches = changedRowPatches(prev, next);
	if (patches.length === 0) return [];
	const scroll = options.detectScroll === false ? null : detectScroll(prev, next);
	if (scroll && scroll.length < patches.length) return scroll;
	return patches;
}
