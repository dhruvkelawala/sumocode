import type { CellBuffer } from "./buffer.js";
import { cellRowToAnsi } from "./ansi-writer.js";

export interface FrameDiffPatch {
	row: number;
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

function rowsEqualAt(prev: CellBuffer, prevRow: number, next: CellBuffer, nextRow: number): boolean {
	const { cols } = prev.getDimensions();
	for (let col = 0; col < cols; col += 1) {
		const left = prev.getCell(prevRow, col);
		const right = next.getCell(nextRow, col);
		if (left.char !== right.char || left.fg !== right.fg || left.bg !== right.bg) return false;
		if (
			left.attrs.bold !== right.attrs.bold ||
			left.attrs.italic !== right.attrs.italic ||
			left.attrs.underline !== right.attrs.underline ||
			left.attrs.dim !== right.attrs.dim ||
			left.attrs.inverse !== right.attrs.inverse
		) {
			return false;
		}
	}
	return true;
}

function changedRowPatches(prev: CellBuffer, next: CellBuffer): FrameDiffPatch[] {
	const { rows } = next.getDimensions();
	const patches: FrameDiffPatch[] = [];
	for (let row = 0; row < rows; row += 1) {
		if (!rowsEqualAt(prev, row, next, row)) patches.push({ row, ansi: cellRowToAnsi(next, row), type: "row" });
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
				{ row: 0, ansi: scrollSequence(0, rows - 1, count, "up"), type: "scroll", top: 0, bottom: rows - 1, count, direction: "up" },
			];
			for (let row = rows - count; row < rows; row += 1) patches.push({ row, ansi: cellRowToAnsi(next, row), type: "row" });
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
				{ row: 0, ansi: scrollSequence(0, rows - 1, count, "down"), type: "scroll", top: 0, bottom: rows - 1, count, direction: "down" },
			];
			for (let row = 0; row < count; row += 1) patches.push({ row, ansi: cellRowToAnsi(next, row), type: "row" });
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
 */
export function diffFrames(prev: CellBuffer | null | undefined, next: CellBuffer): FrameDiffPatch[] {
	if (!prev || !dimensionsEqual(prev, next)) {
		const { rows } = next.getDimensions();
		const patches: FrameDiffPatch[] = [];
		for (let row = 0; row < rows; row += 1) patches.push({ row, ansi: cellRowToAnsi(next, row), type: "row" });
		return patches;
	}

	const patches = changedRowPatches(prev, next);
	if (patches.length === 0) return [];
	const scroll = detectScroll(prev, next);
	if (scroll && scroll.length < patches.length) return scroll;
	return patches;
}
