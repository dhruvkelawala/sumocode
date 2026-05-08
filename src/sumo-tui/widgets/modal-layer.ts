import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { SumoNode } from "../layout/node.js";
import type { YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { activeThemeChrome, activeThemeColors } from "../../themes/index.js";
import { ModalManager, type ModalManagerOptions } from "./modal.js";
import { cathedralBackdropCell } from "../cathedral/theme-bridge.js";

export interface TerminalSizeProvider {
	columns: number;
	rows: number;
}

export interface ModalLayerOptions extends ModalManagerOptions {
	readonly getTerminalSize?: () => TerminalSizeProvider;
}

const RESET = "\u001b[0m";

function rgb(hex: string): { r: number; g: number; b: number } {
	const normalized = hex.replace("#", "");
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

function fg(hex: string): string {
	const { r, g, b } = rgb(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function bg(hex: string): string {
	const { r, g, b } = rgb(hex);
	return `\u001b[48;2;${r};${g};${b}m`;
}

function padVisible(text: string, width: number): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const pad = Math.max(0, width - visibleWidth(clipped));
	return `${clipped}${" ".repeat(pad)}`;
}

function centerRows(rows: readonly string[], width: number, height: number): string[] {
	const blank = `${bg(activeThemeColors().surfaceRecess)}${" ".repeat(width)}${RESET}`;
	const out = Array.from({ length: height }, () => blank);
	if (rows.length === 0) return [];
	const top = Math.max(0, Math.floor((height - rows.length) / 2));
	for (let index = 0; index < rows.length && top + index < out.length; index += 1) {
		const row = rows[index] ?? "";
		const left = Math.max(0, Math.floor((width - visibleWidth(row)) / 2));
		const right = Math.max(0, width - left - visibleWidth(row));
		out[top + index] = `${bg(activeThemeColors().surfaceRecess)}${" ".repeat(left)}${row}${" ".repeat(right)}${RESET}`;
	}
	return out;
}

export class ModalSurfaceComponent implements Component {
	public constructor(private readonly inner: Component & { dispose?(): void }) {}
	public invalidate(): void {
		this.inner.invalidate?.();
	}
	public handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}
	public dispose(): void {
		this.inner.dispose?.();
	}
	public isVisible(width: number): boolean {
		return this.inner.render(Math.max(1, width - 2)).length > 0;
	}
	public render(width: number): string[] {
		const outerWidth = Math.max(12, width);
		const innerWidth = Math.max(1, outerWidth - 2);
		const border = fg(activeThemeColors().divider);
		const surface = bg(activeThemeColors().surfaceLifted);
		const childRows = this.inner.render(innerWidth);
		if (childRows.length === 0) return [];
		const lines: string[] = [];
		const chrome = activeThemeChrome();
		lines.push(`${surface}${border}${chrome.frame.topLeft}${chrome.frame.horizontal.repeat(innerWidth)}${chrome.frame.topRight}${RESET}`);
		for (const row of childRows) {
			lines.push(`${surface}${border}${chrome.frame.vertical}${RESET}${surface}${padVisible(row, innerWidth)}${border}${chrome.frame.vertical}${RESET}`);
		}
		lines.push(`${surface}${border}${chrome.frame.bottomLeft}${chrome.frame.horizontal.repeat(innerWidth)}${chrome.frame.bottomRight}${RESET}`);
		return lines;
	}
}

export class ModalBackdropNode extends SumoNode {
	public constructor(yogaNode: YogaNode, parent: SumoNode | undefined, private readonly isVisible: () => boolean = () => true) {
		super(yogaNode, parent);
	}
	public render(buffer: CellBuffer, rect: Rect): void {
		if (!this.isVisible()) return;
		buffer.paint(rect, cathedralBackdropCell());
	}
}

/** Full-screen modal manager component with backdrop, centered card, Esc close. */
export class ModalLayer extends ModalManager {
	private readonly getTerminalSize: () => TerminalSizeProvider;

	public constructor(options: ModalLayerOptions = {}) {
		super(options);
		this.getTerminalSize = options.getTerminalSize ?? (() => ({ columns: 80, rows: 24 }));
	}

	public override render(width: number): string[] {
		if (!this.getActiveKind()) return [];
		const size = this.getTerminalSize();
		const frameWidth = Math.max(1, width || size.columns);
		const frameHeight = Math.max(1, size.rows);
		const modalWidth = Math.min(80, Math.max(32, Math.floor(frameWidth * 0.6)));
		const surface = new ModalSurfaceComponent({
			invalidate: () => undefined,
			handleInput: (data: string) => this.handleInput(data),
			render: () => super.render(modalWidth - 2),
		});
		return centerRows(surface.render(modalWidth), frameWidth, frameHeight);
	}
}
