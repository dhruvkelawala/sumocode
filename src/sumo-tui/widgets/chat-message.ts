import { visibleWidth } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";

export type ChatMessageRole = "user" | "sumo" | "system" | "tool" | string;

export interface ChatMessageMeasure {
	width: number;
	height: number;
}

export interface ChatMessageSnapshot {
	role: ChatMessageRole;
	text: string;
	timestamp: Date;
}

const RESET = "\x1b[0m";

function hexToRgb(hexColor: string): [number, number, number] {
	const hex = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;
	return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function fg(hexColor: string): string {
	const [red, green, blue] = hexToRgb(hexColor);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

function roleLabel(role: ChatMessageRole): string {
	if (role === "user") return "USER >";
	if (role === "sumo" || role === "assistant") return "SUMO >";
	if (role === "tool") return "TOOL >";
	return `${String(role).toUpperCase()} >`;
}

function roleColor(role: ChatMessageRole): string {
	if (role === "user") return CATHEDRAL_TOKENS.colors.accent;
	if (role === "sumo" || role === "assistant") return CATHEDRAL_TOKENS.colors.states.idle;
	if (role === "tool") return CATHEDRAL_TOKENS.colors.states.tool;
	return CATHEDRAL_TOKENS.colors.foregroundDim;
}

function takeVisible(input: string, maxWidth: number): { head: string; tail: string } {
	if (maxWidth <= 0 || input.length === 0) return { head: "", tail: input };
	let width = 0;
	let index = 0;
	for (const glyph of Array.from(input)) {
		const glyphWidth = visibleWidth(glyph);
		if (width + glyphWidth > maxWidth) break;
		width += glyphWidth;
		index += glyph.length;
	}
	if (index === 0) {
		const [first = ""] = Array.from(input);
		return { head: first, tail: input.slice(first.length) };
	}
	return { head: input.slice(0, index), tail: input.slice(index) };
}

function wrapPlainText(input: string, width: number): string[] {
	if (width <= 0) return [""];
	const rows: string[] = [];
	const paragraphs = input.split("\n");
	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) {
			rows.push("");
			continue;
		}
		let remaining = paragraph;
		while (remaining.length > 0) {
			const part = takeVisible(remaining, width);
			rows.push(part.head);
			remaining = part.tail;
		}
	}
	return rows.length === 0 ? [""] : rows;
}

/** One role-prefixed chat row group. Markdown parsing is deferred to Phase 5. */
export class ChatMessage extends SumoNode {
	public readonly timestamp: Date;
	private measuring = false;
	private lastMeasure: ChatMessageMeasure = { width: 0, height: 1 };

	public constructor(yogaNode: YogaNode, public role: ChatMessageRole, public text: string, parent?: SumoNode, timestamp = new Date()) {
		super(yogaNode, parent);
		this.timestamp = timestamp;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public static create(yoga: Yoga, role: ChatMessageRole, text: string, parent?: SumoNode, timestamp?: Date): ChatMessage {
		return new ChatMessage(yoga.Node.create(), role, text, parent, timestamp);
	}

	public setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.markDirty();
	}

	public appendText(chunk: string): void {
		if (chunk.length === 0) return;
		this.text += chunk;
		this.markDirty();
	}

	public toSnapshot(): ChatMessageSnapshot {
		return { role: this.role, text: this.text, timestamp: this.timestamp };
	}

	public getEstimatedHeight(width = this.getComputedWidth()): number {
		return this.renderRows(width).length;
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		const rows = this.renderRows(rect.width);
		const height = Math.min(rows.length, rect.height);
		for (let row = 0; row < height; row += 1) {
			buffer.paintRow(rect.top + row, rows[row] ?? "", rect.left, rect.width);
		}
	}

	private renderRows(width: number): string[] {
		const renderWidth = normalizeWidth(width);
		if (renderWidth <= 0) return [""];
		const label = roleLabel(this.role);
		const prefix = `${label} `;
		const prefixWidth = visibleWidth(prefix);
		const firstLineWidth = Math.max(1, renderWidth - prefixWidth);
		const continuationWidth = Math.max(1, renderWidth - prefixWidth);
		const contentRows = wrapPlainText(this.text, firstLineWidth);
		const labelStyle = fg(roleColor(this.role));
		const textStyle = fg(CATHEDRAL_TOKENS.colors.foreground);
		return contentRows.map((row, index) => {
			const content = index === 0 ? row : takeVisible(row, continuationWidth).head;
			if (index === 0) return `${labelStyle}${prefix}${RESET}${textStyle}${content}${RESET}`;
			return `${" ".repeat(prefixWidth)}${textStyle}${content}${RESET}`;
		});
	}

	private measure(width: number, widthMode: MeasureMode, _height: number, _heightMode: MeasureMode): ChatMessageMeasure {
		if (this.measuring) return this.lastMeasure;
		this.measuring = true;
		try {
			const renderWidth = normalizeWidth(width);
			const rows = this.renderRows(renderWidth);
			this.lastMeasure = {
				width: widthMode === MEASURE_MODE_EXACTLY ? renderWidth : Math.max(...rows.map((row) => visibleWidth(row)), 0),
				height: Math.max(1, rows.length),
			};
			return this.lastMeasure;
		} finally {
			this.measuring = false;
		}
	}
}
