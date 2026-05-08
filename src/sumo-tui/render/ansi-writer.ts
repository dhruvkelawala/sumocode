import { visibleWidth } from "@earendil-works/pi-tui";
import type { Cell, CellAttrs } from "./cell.js";
import { attrsEqual, createAttrs } from "./cell.js";
import type { CellBuffer } from "./buffer.js";
import { parseHexColor } from "./truecolor.js";

interface StyleState {
	fg?: string;
	bg?: string;
	attrs: CellAttrs;
}

const DEFAULT_STYLE: StyleState = { attrs: createAttrs() };

function styleEqual(left: StyleState, right: StyleState): boolean {
	return left.fg === right.fg && left.bg === right.bg && attrsEqual(left.attrs, right.attrs);
}

function styleFromCell(cell: Cell): StyleState {
	return { fg: cell.fg, bg: cell.bg, attrs: createAttrs(cell.attrs) };
}

function sgrForStyle(style: StyleState): string {
	const codes: string[] = [];
	if (style.attrs.bold) codes.push("1");
	if (style.attrs.dim) codes.push("2");
	if (style.attrs.italic) codes.push("3");
	if (style.attrs.underline) codes.push("4");
	if (style.attrs.inverse) codes.push("7");
	const fg = parseHexColor(style.fg);
	if (fg) codes.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);
	const bg = parseHexColor(style.bg);
	if (bg) codes.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
	return codes.length === 0 ? "\x1b[0m" : `\x1b[${codes.join(";")}m`;
}

function isDefaultStyle(style: StyleState): boolean {
	return styleEqual(style, DEFAULT_STYLE);
}

/**
 * SGR codes are additive: emitting `\x1b[38;2;R;G;Bm` after `\x1b[7m` does not
 * clear the inverse bit. Whenever an attribute or color disappears between two
 * adjacent cells we must explicitly reset state with `\x1b[0m` before applying
 * the new style; otherwise the trailing cells keep the old attribute lit (this
 * was the cause of "highlight extends past the selected cells" — selection
 * inverse on cells 28-40 visually leaked across the rest of the row).
 */
function styleNeedsReset(prev: StyleState, next: StyleState): boolean {
	if (prev.attrs.bold && !next.attrs.bold) return true;
	if (prev.attrs.dim && !next.attrs.dim) return true;
	if (prev.attrs.italic && !next.attrs.italic) return true;
	if (prev.attrs.underline && !next.attrs.underline) return true;
	if (prev.attrs.inverse && !next.attrs.inverse) return true;
	if (prev.fg !== undefined && next.fg === undefined) return true;
	if (prev.bg !== undefined && next.bg === undefined) return true;
	return false;
}

/** Convert one retained cell row into an ANSI string, emitting SGR only when style changes. */
export function cellRowToAnsi(buffer: CellBuffer, row: number): string {
	const { cols } = buffer.getDimensions();
	return cellRowSliceToAnsi(buffer, row, 0, cols - 1);
}

/**
 * Convert a column slice of one retained cell row into an ANSI string, emitting
 * SGR only when style changes. `startCol` and `endCol` are inclusive cell
 * indices. Continuation cells (wide-char trailing halves) are skipped, so
 * callers that want byte-correct output for a slice must ensure `startCol` is
 * the head of a glyph — `rowChangeRange` in `diff.ts` handles this.
 */
export function cellRowSliceToAnsi(buffer: CellBuffer, row: number, startCol: number, endCol: number): string {
	const { cols } = buffer.getDimensions();
	const start = Math.max(0, startCol);
	const end = Math.min(cols - 1, endCol);
	let output = "";
	let current: StyleState = DEFAULT_STYLE;
	let styled = false;

	for (let col = start; col <= end; col += 1) {
		const cell = buffer.getCell(row, col);
		if (cell.char === "") continue;
		const nextStyle = styleFromCell(cell);
		if (!styleEqual(current, nextStyle)) {
			if (styleNeedsReset(current, nextStyle)) {
				output += "\x1b[0m";
				current = DEFAULT_STYLE;
				styled = false;
			}
			if (!isDefaultStyle(nextStyle)) {
				output += sgrForStyle(nextStyle);
				styled = true;
			}
			current = nextStyle;
		}
		output += cell.char;
		const width = visibleWidth(cell.char);
		if (width > 1) col += width - 1;
	}

	if (styled) output += "\x1b[0m";
	return output;
}

export function bufferToAnsiLines(buffer: CellBuffer): string[] {
	const { rows } = buffer.getDimensions();
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) lines.push(cellRowToAnsi(buffer, row));
	return lines;
}
