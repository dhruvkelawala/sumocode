import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { SumoNode } from "../layout/node.js";
import type { Yoga, YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { PiComponentLeaf } from "./pi-component-leaf.js";

const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]/g;
const HORIZONTAL_BAR_PATTERN = /[\u2500\u2501\u2504\u2505\u2508\u2509\u254C\u254D\u2550]/;
const VERTICAL_BAR_PATTERN = /[\u2502\u2503\u2506\u2507\u250A\u250B\u254E\u254F\u2551]/;
const CORNER_PATTERN = /[\u250C-\u251B\u2552-\u255D\u256D-\u2570]/;
const NON_BORDER_PATTERN = /[^\s\u2500-\u257F]/;

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

/**
 * Classify the editor frame's top/bottom border rows. A border row needs all of:
 *   - at least one horizontal bar (─━═ etc)
 *   - at least one box corner glyph (┌┐└┘ / ╭╮╯╰ / ╔╗╚╝ etc)
 *   - no vertical bars (│┃║ etc)
 *   - no non-box-drawing content characters
 * That keeps content rows like `│ hello │`, `│       │`, `│ ───── │`, and a
 * user-typed bare `─────` separator selectable while still excluding the
 * Cathedral input frame's `╭──╮` and `╰──╯` border rows.
 */
function isBorderRow(rendered: string): boolean {
	const plain = stripAnsi(rendered).replace(/[\u200B-\u200F]/g, "");
	if (!HORIZONTAL_BAR_PATTERN.test(plain)) return false;
	if (!CORNER_PATTERN.test(plain)) return false;
	if (VERTICAL_BAR_PATTERN.test(plain)) return false;
	return !NON_BORDER_PATTERN.test(plain);
}

function isVerticalBarChar(char: string | undefined): boolean {
	if (!char) return false;
	return VERTICAL_BAR_PATTERN.test(char);
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
 * hardware cursor (`node_modules/.pnpm/@earendil-works+pi-tui@0.74.0/.../dist/tui.js:651-674`).
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
			// Cathedral input frame's top/bottom borders only ever appear at the
			// outer edges of the editor render. Restrict the box-drawing border
			// classification to those positions so that user-typed content rows
			// composed only of box-drawing glyphs (e.g. `┌────┐`, `┬────┬`) in the
			// middle of a multiline prompt remain selectable.
			const isOuterRow = row === 0 || row === height - 1;
			if ((!isOuterRow || !isBorderRow(painted)) && rect.width >= 1) {
				// Mark editor content cells as selectable so the user can drag-copy
				// the prompt text. The Cathedral input frame paints `│ … │`, so when
				// the actual edge cells are vertical-bar glyphs we skip them; for
				// non-framed rows (Pi's resume / model selector / confirm dialogs
				// also render through this leaf flush to the rect edges) the edge
				// cells stay selectable so first/last glyphs are not truncated on
				// copy.
				const lastCol = rect.width - 1;
				const leftIsBar = isVerticalBarChar(buffer.getCell(row + rect.top, rect.left).char);
				const rightIsBar = lastCol > 0
					? isVerticalBarChar(buffer.getCell(row + rect.top, rect.left + lastCol).char)
					: false;
				const startCol = leftIsBar ? rect.left + 1 : rect.left;
				const endCol = rightIsBar ? rect.left + lastCol - 1 : rect.left + lastCol;
				for (let col = startCol; col <= endCol; col += 1) {
					buffer.setSelectionMeta(row + rect.top, col, { selectable: true });
				}
			}
		}
		// Pi suppresses CURSOR_MARKER while autocomplete is active and paints a fake
		// inverse cursor instead. Keep the real terminal cursor on top of that cell
		// rather than hiding it globally; hiding (`\x1b[?25l`) also hides the mouse
		// pointer in cmux/Ghostty.
		if (this.hardwareCursor === null) this.hardwareCursor = fallbackInverseCursor;
	}

	public getHardwareCursor(): HardwareCursorPosition | null {
		return this.hardwareCursor;
	}
}
