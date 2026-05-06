import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@mariozechner/pi-tui";
import type { SumoNode } from "../layout/node.js";
import type { Yoga, YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { PiComponentLeaf } from "./pi-component-leaf.js";

const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]/g;
const BORDER_ONLY_PATTERN = /^[\s\u2500-\u257F]*$/;

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function isBorderRow(rendered: string): boolean {
	const plain = stripAnsi(rendered).replace(/[\u200B-\u200F]/g, "");
	if (plain.length === 0) return true;
	return BORDER_ONLY_PATTERN.test(plain);
}

export interface HardwareCursorPosition {
	row: number;
	col: number;
}

/**
 * Pi CustomEditor leaf with Q1:A cursor-marker remapping.
 *
 * Source: Pi's own `TUI.extractCursorPosition()` scans for CURSOR_MARKER,
 * measures `visibleWidth(beforeMarker)`, strips the marker, then positions the
 * hardware cursor (`node_modules/.pnpm/@mariozechner+pi-tui@0.73.0/.../dist/tui.js:651-674`).
 * sumo-tui performs the same scan inside the Yoga leaf and offsets by the
 * leaf's computed frame rect.
 */
export class PiEditorLeaf extends PiComponentLeaf {
	private hardwareCursor: HardwareCursorPosition | null = null;

	public constructor(yogaNode: YogaNode, editor: CustomEditor, parent?: SumoNode) {
		super(yogaNode, editor, parent);
	}

	public static override create(yoga: Yoga, editor: CustomEditor, parent?: SumoNode): PiEditorLeaf {
		return new PiEditorLeaf(yoga.Node.create(), editor, parent);
	}

	public override render(buffer: CellBuffer, rect: Rect): void {
		this.hardwareCursor = null;
		const rows = this.renderRows(rect.width);
		const height = Math.min(rows.length, rect.height);
		let fallbackInverseCursor: HardwareCursorPosition | null = null;
		for (let row = 0; row < height; row += 1) {
			const raw = rows[row] ?? "";
			const markerIndex = raw.indexOf(CURSOR_MARKER);
			const painted = markerIndex === -1 ? raw : raw.slice(0, markerIndex) + raw.slice(markerIndex + CURSOR_MARKER.length);
			if (markerIndex !== -1) {
				const markerCol = visibleWidth(raw.slice(0, markerIndex));
				this.hardwareCursor = { row: rect.top + row, col: rect.left + markerCol };
			}
			buffer.paintRow(rect.top + row, painted, rect.left, rect.width);
			if (markerIndex === -1 && fallbackInverseCursor === null) {
				for (let col = 0; col < rect.width; col += 1) {
					const cell = buffer.getCell(rect.top + row, rect.left + col);
					if (cell.attrs.inverse) {
						fallbackInverseCursor = { row: rect.top + row, col: rect.left + col };
						break;
					}
				}
			}
			if (!isBorderRow(painted) && rect.width >= 3) {
				// Mark inner editor cells as selectable so the user can drag-copy the
				// prompt text. Skip the leftmost / rightmost columns: the Cathedral
				// input frame paints `│ … │` so the outer cells are border glyphs.
				const startCol = rect.left + 1;
				const endCol = rect.left + rect.width - 2;
				for (let col = startCol; col <= endCol; col += 1) {
					buffer.setSelectionMeta(row + rect.top, col, { selectable: true });
				}
			}
		}
		// Pi suppresses CURSOR_MARKER while autocomplete is active and paints a fake
		// inverse cursor instead. Keep the real terminal cursor on top of that cell
		// rather than hiding it globally; hiding (`\x1b[?25l`) also hides the mouse
		// pointer in cmux/Ghostty for Dhruv.
		if (this.hardwareCursor === null) this.hardwareCursor = fallbackInverseCursor;
	}

	public getHardwareCursor(): HardwareCursorPosition | null {
		return this.hardwareCursor;
	}
}
