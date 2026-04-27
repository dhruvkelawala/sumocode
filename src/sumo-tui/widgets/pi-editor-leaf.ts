import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@mariozechner/pi-tui";
import type { SumoNode } from "../layout/node.js";
import type { Yoga, YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { PiComponentLeaf } from "./pi-component-leaf.js";

export interface HardwareCursorPosition {
	row: number;
	col: number;
}

/**
 * Pi CustomEditor leaf with Q1:A cursor-marker remapping.
 *
 * Source: Pi's own `TUI.extractCursorPosition()` scans for CURSOR_MARKER,
 * measures `visibleWidth(beforeMarker)`, strips the marker, then positions the
 * hardware cursor (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/.../dist/tui.js:651-674`).
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
		for (let row = 0; row < height; row += 1) {
			const raw = rows[row] ?? "";
			const markerIndex = raw.indexOf(CURSOR_MARKER);
			const painted = markerIndex === -1 ? raw : raw.slice(0, markerIndex) + raw.slice(markerIndex + CURSOR_MARKER.length);
			if (markerIndex !== -1) {
				const markerCol = visibleWidth(raw.slice(0, markerIndex));
				this.hardwareCursor = { row: rect.top + row, col: rect.left + markerCol };
			}
			buffer.paintRow(rect.top + row, painted, rect.left, rect.width);
		}
	}

	public getHardwareCursor(): HardwareCursorPosition | null {
		return this.hardwareCursor;
	}
}
