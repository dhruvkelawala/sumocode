import { visibleWidth, type Component } from "@mariozechner/pi-tui";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";

export interface PiComponentLeafMeasure {
	width: number;
	height: number;
}

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

function renderedWidth(rows: string[]): number {
	let width = 0;
	for (const row of rows) width = Math.max(width, visibleWidth(row));
	return width;
}

/**
 * Yoga leaf adapter for Pi's imperative `Component.render(width): string[]`
 * contract (`docs/research/sumo-tui-spike/04-pi-tui.md`, Component section).
 */
export class PiComponentLeaf extends SumoNode {
	protected readonly component: Component;
	private measuring = false;
	private lastMeasure: PiComponentLeafMeasure = { width: 0, height: 0 };

	public constructor(yogaNode: YogaNode, component: Component, parent?: SumoNode) {
		super(yogaNode, parent);
		this.component = component;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public static create(yoga: Yoga, component: Component, parent?: SumoNode): PiComponentLeaf {
		return new PiComponentLeaf(yoga.Node.create(), component, parent);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		const rows = this.renderRows(rect.width);
		const height = Math.min(rows.length, rect.height);
		for (let row = 0; row < height; row += 1) {
			buffer.paintRow(rect.top + row, rows[row] ?? "", rect.left, rect.width);
		}
	}

	protected renderRows(width: number): string[] {
		return this.component.render(normalizeWidth(width));
	}

	protected measure(width: number, widthMode: MeasureMode, _height: number, _heightMode: MeasureMode): PiComponentLeafMeasure {
		if (this.measuring) return this.lastMeasure;
		this.measuring = true;
		try {
			const renderWidth = normalizeWidth(width);
			const rows = this.renderRows(renderWidth);
			const measuredWidth = widthMode === MEASURE_MODE_EXACTLY ? renderWidth : renderedWidth(rows);
			this.lastMeasure = { width: measuredWidth, height: rows.length };
			return this.lastMeasure;
		} finally {
			this.measuring = false;
		}
	}
}
