export interface CellAttrs {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	dim: boolean;
	inverse: boolean;
}

export interface Cell {
	char: string;
	fg?: string;
	bg?: string;
	attrs: CellAttrs;
}

export const DEFAULT_CELL_ATTRS: CellAttrs = Object.freeze({
	bold: false,
	italic: false,
	underline: false,
	dim: false,
	inverse: false,
});

export const BLANK_CELL: Cell = Object.freeze({
	char: " ",
	attrs: DEFAULT_CELL_ATTRS,
});

const pool: Cell[] = [];

export function createAttrs(overrides: Partial<CellAttrs> = {}): CellAttrs {
	return {
		bold: overrides.bold ?? false,
		italic: overrides.italic ?? false,
		underline: overrides.underline ?? false,
		dim: overrides.dim ?? false,
		inverse: overrides.inverse ?? false,
	};
}

export function attrsEqual(left: CellAttrs, right: CellAttrs): boolean {
	return (
		left.bold === right.bold &&
		left.italic === right.italic &&
		left.underline === right.underline &&
		left.dim === right.dim &&
		left.inverse === right.inverse
	);
}

export function attrsToMask(attrs: CellAttrs): number {
	return (attrs.bold ? 1 : 0) | (attrs.italic ? 2 : 0) | (attrs.underline ? 4 : 0) | (attrs.dim ? 8 : 0) | (attrs.inverse ? 16 : 0);
}

export function maskToAttrs(mask: number): CellAttrs {
	return {
		bold: (mask & 1) !== 0,
		italic: (mask & 2) !== 0,
		underline: (mask & 4) !== 0,
		dim: (mask & 8) !== 0,
		inverse: (mask & 16) !== 0,
	};
}

export function normalizeCell(cell: Cell): Cell {
	return {
		char: cell.char.length === 0 ? " " : cell.char,
		fg: cell.fg,
		bg: cell.bg,
		attrs: createAttrs(cell.attrs),
	};
}

export function acquireCell(overrides: Partial<Omit<Cell, "attrs">> & { attrs?: Partial<CellAttrs> } = {}): Cell {
	const cell = pool.pop() ?? { char: " ", attrs: createAttrs() };
	cell.char = overrides.char ?? " ";
	cell.fg = overrides.fg;
	cell.bg = overrides.bg;
	cell.attrs = createAttrs(overrides.attrs);
	return cell;
}

export function releaseCell(cell: Cell): void {
	cell.char = " ";
	cell.fg = undefined;
	cell.bg = undefined;
	cell.attrs = createAttrs();
	pool.push(cell);
}

export function getCellPoolSize(): number {
	return pool.length;
}
