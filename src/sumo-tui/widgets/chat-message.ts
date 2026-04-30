import { visibleWidth } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { lineToAnsi, span, textLine, type Span } from "../render/primitives.js";

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

const MIN_BOX_WIDTH = 8;

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

function roleLabel(role: ChatMessageRole): string {
	if (role === "user") return "USER";
	if (role === "sumo" || role === "assistant") return "SUMO";
	if (role === "tool") return "TOOL";
	return String(role).toUpperCase();
}

function roleColor(role: ChatMessageRole): string {
	if (role === "user") return CATHEDRAL_TOKENS.colors.foreground;
	if (role === "sumo" || role === "assistant") return CATHEDRAL_TOKENS.colors.accent;
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

function textWidth(parts: readonly (Span | string)[]): number {
	return parts.reduce((sum, part) => sum + visibleWidth(typeof part === "string" ? part : part.text), 0);
}

function fitCellText(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? takeVisible(text, width).head : `${text}${" ".repeat(width - visible)}`;
}

function formatTime(timestamp: Date): string {
	const hours = String(timestamp.getHours()).padStart(2, "0");
	const minutes = String(timestamp.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function frameTop(role: ChatMessageRole, timestamp: Date | undefined, width: number): string {
	const label = roleLabel(role);
	const leftParts: (Span | string)[] = [
		span("╭ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(label, { fg: roleColor(role) }),
		span(" ", { fg: CATHEDRAL_TOKENS.colors.divider }),
	];

	const showTime = (role === "sumo" || role === "assistant") && timestamp !== undefined;
	const rightParts: (Span | string)[] = showTime
		? [
			span(" ", { fg: CATHEDRAL_TOKENS.colors.divider }),
			span(formatTime(timestamp), { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
			span(" \u2500", { fg: CATHEDRAL_TOKENS.colors.divider }),
		]
		: [];

	const used = textWidth(leftParts) + textWidth(rightParts) + 1; // right corner
	const rule = Math.max(0, width - used);
	return lineToAnsi(textLine([
		...leftParts,
		span("─".repeat(rule), { fg: CATHEDRAL_TOKENS.colors.divider }),
		...rightParts,
		span("╮", { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

function frameBody(row: string, width: number): string {
	const inner = Math.max(0, width - 4);
	const text = fitCellText(row, inner);
	return lineToAnsi(textLine([
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		" ",
		span(text, { fg: CATHEDRAL_TOKENS.colors.foreground }),
		" ",
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

function frameBottom(width: number): string {
	return lineToAnsi(textLine([
		span("╰", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("─".repeat(Math.max(0, width - 2)), { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("╯", { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

/** One V2 framed chat message. Markdown block parsing lands in #89/#90. */
export class ChatMessage extends SumoNode {
	public readonly timestamp: Date;
	private measuring = false;
	private lastMeasure: ChatMessageMeasure = { width: 0, height: 1 };

	public constructor(yogaNode: YogaNode, public role: ChatMessageRole, public text: string, parent?: SumoNode, timestamp = new Date()) {
		super(yogaNode, parent);
		this.timestamp = timestamp;
		this.marginBottom = 1;
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
		return this.renderRows(width).length + 1;
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
		if (renderWidth < MIN_BOX_WIDTH) return [fitCellText(this.text, renderWidth)];

		const bodyWidth = Math.max(1, renderWidth - 4);
		const bodyRows = wrapPlainText(this.text, bodyWidth);
		return [
			frameTop(this.role, this.timestamp, renderWidth),
			...bodyRows.map((row) => frameBody(row, renderWidth)),
			frameBottom(renderWidth),
		];
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
