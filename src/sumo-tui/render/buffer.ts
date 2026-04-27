import { visibleWidth } from "@mariozechner/pi-tui";
import { BLANK_CELL, attrsEqual, attrsToMask, createAttrs, maskToAttrs, type Cell } from "./cell.js";

export interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

interface TextSegmenter {
	segment(input: string): Iterable<{ segment: string }>;
}

const SEGMENTER_CTOR = (Intl as unknown as {
	Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => TextSegmenter;
}).Segmenter;

const GRAPHEME_SEGMENTER = SEGMENTER_CTOR ? new SEGMENTER_CTOR(undefined, { granularity: "grapheme" }) : undefined;

const ANSI_16: readonly string[] = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

function splitGraphemes(text: string): string[] {
	if (!text) return [];
	if (!GRAPHEME_SEGMENTER) return Array.from(text);
	return [...GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment);
}

function clampRect(rect: Rect, rows: number, cols: number): Rect {
	const top = Math.max(0, Math.min(rows, Math.floor(rect.top)));
	const left = Math.max(0, Math.min(cols, Math.floor(rect.left)));
	const bottom = Math.max(top, Math.min(rows, Math.floor(rect.top + rect.height)));
	const right = Math.max(left, Math.min(cols, Math.floor(rect.left + rect.width)));
	return { top, left, width: right - left, height: bottom - top };
}

function normalizeHex(r: number, g: number, b: number): string {
	const toHex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isColorByte(value: number | undefined): value is number {
	return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
}

function indexedColor(index: number): string | undefined {
	if (!isColorByte(index)) return undefined;
	if (index < ANSI_16.length) return ANSI_16[index];
	if (index >= 16 && index <= 231) {
		const value = index - 16;
		const r = Math.floor(value / 36);
		const g = Math.floor((value % 36) / 6);
		const b = value % 6;
		const cube = [0, 95, 135, 175, 215, 255];
		return normalizeHex(cube[r] ?? 0, cube[g] ?? 0, cube[b] ?? 0);
	}
	if (index >= 232 && index <= 255) {
		const gray = 8 + (index - 232) * 10;
		return normalizeHex(gray, gray, gray);
	}
	return undefined;
}

function sameStyle(left: Cell, right: Cell): boolean {
	return left.fg === right.fg && left.bg === right.bg && attrsEqual(left.attrs, right.attrs);
}

export class CellBuffer {
	private rows: number;
	private cols: number;
	private chars: Uint16Array;
	private readonly extendedChars = new Map<number, string>();
	private readonly fg = new Map<number, string>();
	private readonly bg = new Map<number, string>();
	private readonly attrs = new Map<number, number>();
	private defaultBg: string | null = null;
	private defaultFg: string | null = null;

	public constructor(rows: number, cols: number) {
		this.rows = Math.max(0, Math.floor(rows));
		this.cols = Math.max(0, Math.floor(cols));
		this.chars = new Uint16Array(this.rows * this.cols);
		this.chars.fill(32);
	}

	public getDimensions(): { rows: number; cols: number } {
		return { rows: this.rows, cols: this.cols };
	}

	public setDefaultBackground(hex: string): void {
		this.defaultBg = hex;
	}

	public setDefaultForeground(hex: string): void {
		this.defaultFg = hex;
	}

	public getDefaultBackground(): string | null {
		return this.defaultBg;
	}

	public getDefaultForeground(): string | null {
		return this.defaultFg;
	}

	public resize(rows: number, cols: number): void {
		const nextRows = Math.max(0, Math.floor(rows));
		const nextCols = Math.max(0, Math.floor(cols));
		const nextChars = new Uint16Array(nextRows * nextCols);
		nextChars.fill(32);
		const nextExtended = new Map<number, string>();
		const nextFg = new Map<number, string>();
		const nextBg = new Map<number, string>();
		const nextAttrs = new Map<number, number>();
		const totalCells = nextRows * nextCols;
		if (this.defaultFg) {
			for (let index = 0; index < totalCells; index += 1) nextFg.set(index, this.defaultFg);
		}
		if (this.defaultBg) {
			for (let index = 0; index < totalCells; index += 1) nextBg.set(index, this.defaultBg);
		}
		const copyRows = Math.min(this.rows, nextRows);
		const copyCols = Math.min(this.cols, nextCols);

		for (let row = 0; row < copyRows; row += 1) {
			for (let col = 0; col < copyCols; col += 1) {
				const oldIndex = this.index(row, col);
				const newIndex = row * nextCols + col;
				nextChars[newIndex] = this.chars[oldIndex] ?? 32;
				const extended = this.extendedChars.get(oldIndex);
				if (extended !== undefined) nextExtended.set(newIndex, extended);
				const fg = this.fg.get(oldIndex);
				if (fg !== undefined) nextFg.set(newIndex, fg);
				const bg = this.bg.get(oldIndex);
				if (bg !== undefined) nextBg.set(newIndex, bg);
				const attrs = this.attrs.get(oldIndex);
				if (attrs !== undefined) nextAttrs.set(newIndex, attrs);
			}
		}

		this.rows = nextRows;
		this.cols = nextCols;
		this.chars = nextChars;
		this.extendedChars.clear();
		this.fg.clear();
		this.bg.clear();
		this.attrs.clear();
		for (const [key, value] of nextExtended) this.extendedChars.set(key, value);
		for (const [key, value] of nextFg) this.fg.set(key, value);
		for (const [key, value] of nextBg) this.bg.set(key, value);
		for (const [key, value] of nextAttrs) this.attrs.set(key, value);
	}

	public setCell(row: number, col: number, cell: Cell): void {
		if (!this.inBounds(row, col)) return;
		const glyph = cell.char.length === 0 ? " " : cell.char;
		const width = Math.max(1, visibleWidth(glyph));
		if (col + width > this.cols) return;
		for (let offset = 0; offset < width; offset += 1) {
			this.setSingleCell(row, col + offset, offset === 0 ? glyph : "", cell);
		}
	}

	public getCell(row: number, col: number): Cell {
		if (!this.inBounds(row, col)) return { char: BLANK_CELL.char, attrs: createAttrs() };
		const index = this.index(row, col);
		const stored = this.extendedChars.get(index);
		const code = this.chars[index] ?? 32;
		const char = stored ?? (code === 0 ? "" : String.fromCharCode(code));
		return {
			char,
			fg: this.fg.get(index),
			bg: this.bg.get(index),
			attrs: maskToAttrs(this.attrs.get(index) ?? 0),
		};
	}

	public clear(rect?: Rect): void {
		const area = rect ? clampRect(rect, this.rows, this.cols) : { top: 0, left: 0, width: this.cols, height: this.rows };
		for (let row = area.top; row < area.top + area.height; row += 1) {
			for (let col = area.left; col < area.left + area.width; col += 1) {
				this.clearCell(row, col);
			}
		}
	}

	public paint(rect: Rect, cell: Cell): void {
		const area = clampRect(rect, this.rows, this.cols);
		for (let row = area.top; row < area.top + area.height; row += 1) {
			for (let col = area.left; col < area.left + area.width; col += 1) {
				this.setCell(row, col, cell);
			}
		}
	}

	public paintRow(row: number, ansiString: string, startCol = 0, maxCols = this.cols - startCol): void {
		if (row < 0 || row >= this.rows || maxCols <= 0) return;
		let col = Math.max(0, Math.floor(startCol));
		const endCol = Math.min(this.cols, col + Math.floor(maxCols));
		let index = 0;
		const style: Omit<Cell, "char"> = { attrs: createAttrs() };
		if (this.defaultFg) style.fg = this.defaultFg;
		// Inherit cathedral bg by default so chat messages render on the cathedral
		// surface rather than terminal-default black. Explicit `\x1b[48;...m` in the
		// ANSI input still overrides via consumeEscape.
		if (this.defaultBg) style.bg = this.defaultBg;

		while (index < ansiString.length && col < endCol) {
			const char = ansiString[index];
			if (char === "\x1b") {
				index = this.consumeEscape(ansiString, index, style);
				continue;
			}

			let nextEscape = ansiString.indexOf("\x1b", index);
			if (nextEscape === -1) nextEscape = ansiString.length;
			const text = ansiString.slice(index, nextEscape);
			for (const glyph of splitGraphemes(text)) {
				const glyphWidth = visibleWidth(glyph);
				if (glyphWidth === 0) {
					if (col > startCol) {
						const previous = this.getCell(row, col - 1);
						this.setCell(row, col - 1, { ...previous, char: previous.char + glyph });
					}
					continue;
				}
				if (col + glyphWidth > endCol) return;
				this.setCell(row, col, { char: glyph, fg: style.fg, bg: style.bg, attrs: createAttrs(style.attrs) });
				col += glyphWidth;
			}
			index = nextEscape;
		}
	}

	public rowEquals(other: CellBuffer, row: number): boolean {
		const dimensions = other.getDimensions();
		if (this.cols !== dimensions.cols || row < 0 || row >= this.rows || row >= dimensions.rows) return false;
		for (let col = 0; col < this.cols; col += 1) {
			const left = this.getCell(row, col);
			const right = other.getCell(row, col);
			if (left.char !== right.char || !sameStyle(left, right)) return false;
		}
		return true;
	}

	public clone(): CellBuffer {
		const next = new CellBuffer(this.rows, this.cols);
		next.defaultBg = this.defaultBg;
		next.defaultFg = this.defaultFg;
		next.chars.set(this.chars);
		for (const [key, value] of this.extendedChars) next.extendedChars.set(key, value);
		for (const [key, value] of this.fg) next.fg.set(key, value);
		for (const [key, value] of this.bg) next.bg.set(key, value);
		for (const [key, value] of this.attrs) next.attrs.set(key, value);
		return next;
	}

	public toPlainRow(row: number): string {
		let result = "";
		for (let col = 0; col < this.cols; col += 1) {
			const cell = this.getCell(row, col);
			result += cell.char;
		}
		return result;
	}

	private consumeEscape(input: string, offset: number, style: Omit<Cell, "char">): number {
		const next = input[offset + 1];
		if (next === "[") {
			let end = offset + 2;
			while (end < input.length && !/[A-Za-z~]/.test(input[end] ?? "")) end += 1;
			if (end >= input.length) return input.length;
			if (input[end] === "m") this.applySgr(input.slice(offset + 2, end), style);
			return end + 1;
		}
		if (next === "]" || next === "_") {
			const bel = input.indexOf("\x07", offset + 2);
			const st = input.indexOf("\x1b\\", offset + 2);
			const terminator = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
			return terminator === -1 ? input.length : terminator + (terminator === st ? 2 : 1);
		}
		return Math.min(input.length, offset + 2);
	}

	private applySgr(params: string, style: Omit<Cell, "char">): void {
		const codes = params.length === 0 ? [0] : params.split(";").map((part) => (part.length === 0 ? 0 : Number.parseInt(part, 10)));
		for (let index = 0; index < codes.length; index += 1) {
			const code = codes[index] ?? 0;
			if (code === 0) {
				style.fg = this.defaultFg ?? undefined;
				style.bg = undefined;
				style.attrs = createAttrs();
			} else if (code === 1) {
				style.attrs.bold = true;
			} else if (code === 2) {
				style.attrs.dim = true;
			} else if (code === 3) {
				style.attrs.italic = true;
			} else if (code === 4) {
				style.attrs.underline = true;
			} else if (code === 7) {
				style.attrs.inverse = true;
			} else if (code === 22) {
				style.attrs.bold = false;
				style.attrs.dim = false;
			} else if (code === 23) {
				style.attrs.italic = false;
			} else if (code === 24) {
				style.attrs.underline = false;
			} else if (code === 27) {
				style.attrs.inverse = false;
			} else if (code === 39) {
				style.fg = this.defaultFg ?? undefined;
			} else if (code === 49) {
				style.bg = undefined;
			} else if (code >= 30 && code <= 37) {
				style.fg = indexedColor(code - 30);
			} else if (code >= 90 && code <= 97) {
				style.fg = indexedColor(code - 90 + 8);
			} else if (code >= 40 && code <= 47) {
				style.bg = indexedColor(code - 40);
			} else if (code >= 100 && code <= 107) {
				style.bg = indexedColor(code - 100 + 8);
			} else if (code === 38 || code === 48) {
				const color = this.readExtendedColor(codes, index + 1);
				if (color) {
					if (code === 38) style.fg = color.value;
					else style.bg = color.value;
					index = color.nextIndex;
				}
			}
		}
	}

	private readExtendedColor(codes: number[], offset: number): { value: string; nextIndex: number } | undefined {
		const mode = codes[offset];
		if (mode === 2) {
			const r = codes[offset + 1];
			const g = codes[offset + 2];
			const b = codes[offset + 3];
			if (!isColorByte(r) || !isColorByte(g) || !isColorByte(b)) return undefined;
			return { value: normalizeHex(r, g, b), nextIndex: offset + 3 };
		}
		if (mode === 5) {
			const color = indexedColor(codes[offset + 1] ?? -1);
			return color ? { value: color, nextIndex: offset + 1 } : undefined;
		}
		return undefined;
	}

	private inBounds(row: number, col: number): boolean {
		return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
	}

	private index(row: number, col: number): number {
		return row * this.cols + col;
	}

	private setSingleCell(row: number, col: number, glyph: string, source: Cell): void {
		const index = this.index(row, col);
		this.extendedChars.delete(index);
		const codePoint = glyph.codePointAt(0);
		if (glyph.length === 0) {
			this.chars[index] = 0;
		} else if (codePoint !== undefined && codePoint <= 0xffff && glyph.length === 1) {
			this.chars[index] = codePoint;
		} else {
			this.chars[index] = 0xfffd;
			this.extendedChars.set(index, glyph);
		}
		this.setStyle(index, source);
	}

	private clearCell(row: number, col: number): void {
		const index = this.index(row, col);
		this.chars[index] = 32;
		this.extendedChars.delete(index);
		if (this.defaultFg) this.fg.set(index, this.defaultFg);
		else this.fg.delete(index);
		if (this.defaultBg) this.bg.set(index, this.defaultBg);
		else this.bg.delete(index);
		this.attrs.delete(index);
	}

	private setStyle(index: number, source: Cell): void {
		if (source.fg) this.fg.set(index, source.fg);
		else this.fg.delete(index);
		if (source.bg) this.bg.set(index, source.bg);
		else if (!this.bg.has(index) && this.defaultBg) this.bg.set(index, this.defaultBg);
		const mask = attrsToMask(source.attrs);
		if (mask === 0) this.attrs.delete(index);
		else this.attrs.set(index, mask);
	}
}
