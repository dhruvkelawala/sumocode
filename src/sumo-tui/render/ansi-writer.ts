import { visibleWidth } from "@mariozechner/pi-tui";
import type { Cell, CellAttrs } from "./cell.js";
import { attrsEqual, createAttrs } from "./cell.js";
import type { CellBuffer } from "./buffer.js";

interface StyleState {
	fg?: string;
	bg?: string;
	attrs: CellAttrs;
}

const DEFAULT_STYLE: StyleState = { attrs: createAttrs() };

function parseHexColor(color: string | undefined): [number, number, number] | undefined {
	if (!color) return undefined;
	const hex = color.startsWith("#") ? color.slice(1) : color;
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

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

/** Convert one retained cell row into an ANSI string, emitting SGR only when style changes. */
export function cellRowToAnsi(buffer: CellBuffer, row: number): string {
	const { cols } = buffer.getDimensions();
	let output = "";
	let current: StyleState = DEFAULT_STYLE;
	let styled = false;

	for (let col = 0; col < cols; col += 1) {
		const cell = buffer.getCell(row, col);
		if (cell.char === "") continue;
		const nextStyle = styleFromCell(cell);
		if (!styleEqual(current, nextStyle)) {
			output += sgrForStyle(nextStyle);
			current = nextStyle;
			styled = !isDefaultStyle(nextStyle);
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
