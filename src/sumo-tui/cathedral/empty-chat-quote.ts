import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { colorHex, italic, padAnsiToWidth } from "./ansi.js";

export interface EmptyChatQuoteSnapshot {
	readonly sidebarVisible: boolean;
	readonly isSplash: boolean;
	readonly userMessageCount: number;
}

export const EMPTY_CHAT_QUOTE_TEXT = [
	"\"perfection is achieved when there is",
	"nothing left to take away.\"",
] as const;
export const EMPTY_CHAT_QUOTE_ATTRIBUTION = "— saint-exupéry";

export function shouldRenderEmptyChatQuote(snapshot: EmptyChatQuoteSnapshot): boolean {
	return snapshot.sidebarVisible && !snapshot.isSplash && snapshot.userMessageCount === 0;
}

function centerPlain(text: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const left = Math.max(0, Math.floor((safeWidth - text.length) / 2));
	return `${" ".repeat(left)}${text}`;
}

export function renderEmptyChatQuoteLines(width: number): string[] {
	const quoteColor = CATHEDRAL_TOKENS.colors.foregroundDim;
	return [
		padAnsiToWidth(italic(colorHex(centerPlain(EMPTY_CHAT_QUOTE_TEXT[0], width), quoteColor)), width),
		padAnsiToWidth(italic(colorHex(centerPlain(EMPTY_CHAT_QUOTE_TEXT[1], width), quoteColor)), width),
		padAnsiToWidth(colorHex(centerPlain(EMPTY_CHAT_QUOTE_ATTRIBUTION, width), quoteColor), width),
	];
}

/**
 * CATHEDRAL_UX_SPEC.md §4.4 active empty-chat quote. This is deliberately
 * separate from the splash: it only renders when the sidebar is already visible
 * and the active branch still has zero user messages.
 */
export class EmptyChatQuoteNode extends SumoNode {
	public constructor(
		yogaNode: YogaNode,
		private readonly getSnapshot: () => EmptyChatQuoteSnapshot,
		parent?: SumoNode,
	) {
		super(yogaNode, parent);
		this.flexGrow = 1;
		this.flexShrink = 1;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		if (!shouldRenderEmptyChatQuote(this.getSnapshot())) return;
		const lines = renderEmptyChatQuoteLines(rect.width);
		const startRow = rect.top + Math.max(0, Math.floor((rect.height - lines.length) / 2));
		for (let index = 0; index < lines.length && index < rect.height; index += 1) {
			buffer.paintRow(startRow + index, lines[index] ?? "", rect.left, rect.width);
		}
	}

	private measure(width: number, widthMode: MeasureMode, height: number, heightMode: MeasureMode): { width: number; height: number } {
		const resolvedWidth = widthMode === MEASURE_MODE_EXACTLY ? Math.max(1, Math.floor(width)) : 42;
		const resolvedHeight = heightMode === MEASURE_MODE_EXACTLY ? Math.max(1, Math.floor(height)) : 3;
		return { width: resolvedWidth, height: resolvedHeight };
	}
}
