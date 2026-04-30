import { visibleWidth } from "@mariozechner/pi-tui";
import { logDiagnostic } from "../runtime/diagnostics.js";
import type { CellBuffer } from "../render/buffer.js";
import type { KeyEvent } from "./key-router.js";
import type { MouseEvent } from "./mouse.js";

export interface SelectionPoint {
	readonly row: number;
	readonly col: number;
}

export interface SelectionRange {
	readonly anchor: SelectionPoint;
	readonly focus: SelectionPoint;
	readonly dragging: boolean;
}

export interface SelectionControllerOptions {
	readonly readBuffer?: () => CellBuffer | undefined;
	readonly emitClipboard?: (sequence: string, text: string) => void;
	readonly onCopied?: (text: string) => void;
	readonly onSelectionChanged?: () => void;
}

interface OrderedRange {
	readonly start: SelectionPoint;
	readonly end: SelectionPoint;
}

const PRIMARY_BUTTON = 0;
const OSC52_PREFIX = "\x1b]52;c;";
const OSC52_SUFFIX = "\x1b\\";

function orderedRange(anchor: SelectionPoint, focus: SelectionPoint): OrderedRange {
	if (anchor.row < focus.row) return { start: anchor, end: focus };
	if (anchor.row > focus.row) return { start: focus, end: anchor };
	return anchor.col <= focus.col ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

function samePoint(left: SelectionPoint, right: SelectionPoint): boolean {
	return left.row === right.row && left.col === right.col;
}

function normalizePoint(point: SelectionPoint, buffer: CellBuffer | undefined): SelectionPoint {
	const row = Math.max(0, Math.floor(point.row));
	const col = Math.max(0, Math.floor(point.col));
	if (!buffer) return { row, col };
	const dimensions = buffer.getDimensions();
	return {
		row: Math.max(0, Math.min(dimensions.rows - 1, row)),
		col: Math.max(0, Math.min(dimensions.cols - 1, col)),
	};
}

function columnsForRow(range: OrderedRange, row: number, cols: number): { startCol: number; endCol: number } | undefined {
	if (cols <= 0 || row < range.start.row || row > range.end.row) return undefined;
	if (range.start.row === range.end.row) {
		return {
			startCol: Math.max(0, Math.min(cols - 1, range.start.col)),
			endCol: Math.max(0, Math.min(cols - 1, range.end.col)),
		};
	}
	if (row === range.start.row) return { startCol: Math.max(0, Math.min(cols - 1, range.start.col)), endCol: cols - 1 };
	if (row === range.end.row) return { startCol: 0, endCol: Math.max(0, Math.min(cols - 1, range.end.col)) };
	return { startCol: 0, endCol: cols - 1 };
}

const NON_SELECTABLE_EDGE_CHARS = new Set(["", "│", "┃", "╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "─", "━", "═", "┬", "┴", "├", "┤", "┼"]);

function isSelectableEdgeGlyph(glyph: string): boolean {
	return !NON_SELECTABLE_EDGE_CHARS.has(glyph) && glyph.trim().length > 0;
}

function hasSemanticSelection(buffer: CellBuffer | undefined): boolean {
	return buffer?.hasSelectionMeta() === true;
}

function intersects(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
	return leftStart <= rightEnd && rightStart <= leftEnd;
}

function glyphWidth(glyph: string): number {
	return Math.max(1, visibleWidth(glyph));
}

function isCopyKey(event: KeyEvent): boolean {
	const key = event.key.toLowerCase();
	if (key === "copy" || key === "cmd+c" || key === "command+c" || key === "meta+c") return true;
	return (event.meta === true || event.cmd === true) && key === "c";
}

export function createOsc52Sequence(text: string): string {
	return `${OSC52_PREFIX}${Buffer.from(text, "utf8").toString("base64")}${OSC52_SUFFIX}`;
}

export class SelectionController {
	private anchor: SelectionPoint | undefined;
	private focus: SelectionPoint | undefined;
	private dragging = false;
	private revision = 0;

	public constructor(private readonly options: SelectionControllerOptions = {}) {}

	public getRevision(): number {
		return this.revision;
	}

	public getRange(): SelectionRange | undefined {
		if (!this.anchor || !this.focus) return undefined;
		return { anchor: { ...this.anchor }, focus: { ...this.focus }, dragging: this.dragging };
	}

	public hasSelection(): boolean {
		return this.anchor !== undefined && this.focus !== undefined && !samePoint(this.anchor, this.focus);
	}

	public clear(): boolean {
		if (!this.anchor && !this.focus && !this.dragging) return false;
		this.anchor = undefined;
		this.focus = undefined;
		this.dragging = false;
		this.notifyChanged();
		return true;
	}

	public handleKey(event: KeyEvent, buffer = this.options.readBuffer?.()): boolean {
		const key = event.key.toLowerCase();
		if (key === "escape" || key === "esc") return this.clear();
		if (!isCopyKey(event)) return false;
		return this.copyCurrentSelection(buffer);
	}

	public handleMouseEvent(event: MouseEvent, buffer = this.options.readBuffer?.()): boolean {
		logDiagnostic("selection_mouse_event", { type: event.type, button: event.button, row: event.row, col: event.col, dragging: this.dragging });
		if (event.type === "scroll") return false;
		if (event.type === "move") {
			if (!this.dragging || !this.anchor) return false;
			return this.handleMouseEvent({ ...event, type: "drag", button: PRIMARY_BUTTON }, buffer);
		}
		if (event.button !== undefined && event.button !== PRIMARY_BUTTON) return false;

		const point = normalizePoint({ row: event.row, col: event.col }, buffer);
		if (event.type === "down") {
			if (this.hasSelection() && !this.pointIsSelected(point, buffer)) this.clear();
			if (hasSemanticSelection(buffer) && !buffer?.getSelectionMeta(point.row, point.col)) return false;
			this.anchor = point;
			this.focus = point;
			this.dragging = true;
			this.notifyChanged();
			return true;
		}

		if (!this.dragging || !this.anchor) return false;

		if (event.type === "drag") {
			this.focus = point;
			this.notifyChanged();
			return true;
		}

		this.focus = point;
		this.dragging = false;
		const selected = this.hasSelection();
		if (!selected) {
			this.clear();
			return true;
		}
		this.notifyChanged();
		this.copyCurrentSelection(buffer);
		return true;
	}

	public copyCurrentSelection(buffer = this.options.readBuffer?.()): boolean {
		const text = this.extractSelectedText(buffer);
		logDiagnostic("selection_copy_attempt", { chars: text.length, hasBuffer: buffer !== undefined, preview: text.slice(0, 80) });
		if (text.length === 0) return false;
		this.options.emitClipboard?.(createOsc52Sequence(text), text);
		this.options.onCopied?.(text);
		logDiagnostic("selection_copy_success", { chars: text.length, preview: text.slice(0, 80) });
		return true;
	}

	public extractSelectedText(buffer = this.options.readBuffer?.()): string {
		if (!buffer || !this.anchor || !this.focus || samePoint(this.anchor, this.focus)) return "";
		const dimensions = buffer.getDimensions();
		const range = orderedRange(
			normalizePoint(this.anchor, buffer),
			normalizePoint(this.focus, buffer),
		);
		const lines: string[] = [];
		for (let row = range.start.row; row <= range.end.row && row < dimensions.rows; row += 1) {
			if (hasSemanticSelection(buffer)) {
				const rawColumns = columnsForRow(range, row, dimensions.cols);
				if (!rawColumns) continue;
				const semanticText = this.extractSemanticRowText(buffer, row, rawColumns.startCol, rawColumns.endCol);
				if (semanticText.length > 0) lines.push(semanticText);
				continue;
			}
			const columns = this.selectableColumnsForRow(buffer, range, row);
			if (!columns) continue;
			lines.push(this.extractRowText(buffer, row, columns.startCol, columns.endCol).trimEnd());
		}
		return lines.join("\n");
	}

	public applySelectionHighlight(buffer: CellBuffer): void {
		if (!this.anchor || !this.focus || samePoint(this.anchor, this.focus)) return;
		const dimensions = buffer.getDimensions();
		const range = orderedRange(
			normalizePoint(this.anchor, buffer),
			normalizePoint(this.focus, buffer),
		);
		for (let row = range.start.row; row <= range.end.row && row < dimensions.rows; row += 1) {
			if (hasSemanticSelection(buffer)) {
				const rawColumns = columnsForRow(range, row, dimensions.cols);
				if (rawColumns) this.applySemanticRowHighlight(buffer, row, rawColumns.startCol, rawColumns.endCol);
				continue;
			}
			const columns = this.selectableColumnsForRow(buffer, range, row);
			if (!columns) continue;
			this.applyRowHighlight(buffer, row, columns.startCol, columns.endCol);
		}
	}

	private selectableColumnsForRow(buffer: CellBuffer, range: OrderedRange, row: number): { startCol: number; endCol: number } | undefined {
		const { cols } = buffer.getDimensions();
		const rawColumns = columnsForRow(range, row, cols);
		if (!rawColumns) return undefined;
		const contentBounds = this.selectableContentBounds(buffer, row);
		if (!contentBounds) return undefined;
		const startCol = Math.max(rawColumns.startCol, contentBounds.startCol);
		const endCol = Math.min(rawColumns.endCol, contentBounds.endCol);
		return startCol <= endCol ? { startCol, endCol } : undefined;
	}

	private selectableContentBounds(buffer: CellBuffer, row: number): { startCol: number; endCol: number } | undefined {
		const { cols } = buffer.getDimensions();
		let startCol: number | undefined;
		let endCol: number | undefined;
		for (let col = 0; col < cols;) {
			const cell = buffer.getCell(row, col);
			const width = glyphWidth(cell.char);
			if (isSelectableEdgeGlyph(cell.char)) {
				startCol ??= col;
				endCol = col + width - 1;
			}
			col += width;
		}
		return startCol === undefined || endCol === undefined ? undefined : { startCol, endCol };
	}

	private extractRowText(buffer: CellBuffer, row: number, startCol: number, endCol: number): string {
		const { cols } = buffer.getDimensions();
		let output = "";
		for (let col = 0; col < cols;) {
			const cell = buffer.getCell(row, col);
			if (cell.char.length === 0) {
				col += 1;
				continue;
			}
			const width = glyphWidth(cell.char);
			const glyphEnd = col + width - 1;
			if (intersects(col, glyphEnd, startCol, endCol)) output += cell.char;
			col += width;
		}
		return output;
	}

	private extractSemanticRowText(buffer: CellBuffer, row: number, startCol: number, endCol: number): string {
		const { cols } = buffer.getDimensions();
		let output = "";
		for (let col = 0; col < cols;) {
			const cell = buffer.getCell(row, col);
			const width = glyphWidth(cell.char);
			const glyphEnd = col + width - 1;
			if (cell.char.length > 0 && intersects(col, glyphEnd, startCol, endCol) && this.glyphHasSelectionMeta(buffer, row, col, width)) output += cell.char;
			col += width;
		}
		return output;
	}

	private applyRowHighlight(buffer: CellBuffer, row: number, startCol: number, endCol: number): void {
		const { cols } = buffer.getDimensions();
		for (let col = 0; col < cols;) {
			const cell = buffer.getCell(row, col);
			if (cell.char.length === 0) {
				col += 1;
				continue;
			}
			const width = glyphWidth(cell.char);
			const glyphEnd = col + width - 1;
			if (intersects(col, glyphEnd, startCol, endCol)) {
				for (let offset = 0; offset < width && col + offset < cols; offset += 1) {
					buffer.updateCellAttrs(row, col + offset, (attrs) => ({ ...attrs, inverse: true }));
				}
			}
			col += width;
		}
	}

	private applySemanticRowHighlight(buffer: CellBuffer, row: number, startCol: number, endCol: number): void {
		const { cols } = buffer.getDimensions();
		for (let col = 0; col < cols;) {
			const cell = buffer.getCell(row, col);
			const width = glyphWidth(cell.char);
			const glyphEnd = col + width - 1;
			if (cell.char.length > 0 && intersects(col, glyphEnd, startCol, endCol) && this.glyphHasSelectionMeta(buffer, row, col, width)) {
				for (let offset = 0; offset < width && col + offset < cols; offset += 1) {
					if (buffer.getSelectionMeta(row, col + offset)) buffer.updateCellAttrs(row, col + offset, (attrs) => ({ ...attrs, inverse: true }));
				}
			}
			col += width;
		}
	}

	private glyphHasSelectionMeta(buffer: CellBuffer, row: number, col: number, width: number): boolean {
		for (let offset = 0; offset < width; offset += 1) {
			if (buffer.getSelectionMeta(row, col + offset)) return true;
		}
		return false;
	}

	private pointIsSelected(point: SelectionPoint, buffer: CellBuffer | undefined): boolean {
		if (!this.anchor || !this.focus || samePoint(this.anchor, this.focus)) return false;
		if (hasSemanticSelection(buffer) && !buffer?.getSelectionMeta(point.row, point.col)) return false;
		const dimensions = buffer?.getDimensions();
		const cols = dimensions?.cols ?? Math.max(this.anchor.col, this.focus.col, point.col) + 1;
		const range = orderedRange(this.anchor, this.focus);
		const columns = columnsForRow(range, point.row, cols);
		return columns !== undefined && point.col >= columns.startCol && point.col <= columns.endCol;
	}

	private notifyChanged(): void {
		this.revision += 1;
		this.options.onSelectionChanged?.();
	}
}
