import { visibleWidth } from "@mariozechner/pi-tui";
import { DEFAULT_SUMOCODE_CONFIG } from "../../config/sumocode-config.js";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { lineToAnsi, span, textLine, withPersistentStyle, type Span } from "../render/primitives.js";
import { renderCathedralCodeBlock } from "../transcript/code-renderer.js";
import { renderScrollBlock } from "../transcript/scroll-renderer.js";
import { renderToolBlockRows } from "../transcript/tool-renderer.js";
import type { ChatBlock } from "../transcript/view-model.js";

export type ChatMessageRole = "user" | "sumo" | "system" | "tool" | string;

export interface ChatMessageMeasure {
	width: number;
	height: number;
}

export interface ChatMessageSnapshot {
	role: ChatMessageRole;
	text: string;
	timestamp: Date;
	blocks?: readonly ChatBlock[];
}

export interface ChatMessageOptions {
	readonly primaryAgentName?: string;
}

const MIN_BOX_WIDTH = 8;

interface TextSegmenter {
	segment(input: string): Iterable<{ segment: string }>;
}

const SEGMENTER_CTOR = (Intl as unknown as {
	Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => TextSegmenter;
}).Segmenter;

const GRAPHEME_SEGMENTER = SEGMENTER_CTOR ? new SEGMENTER_CTOR(undefined, { granularity: "grapheme" }) : undefined;
const TRAILING_WHITESPACE_PATTERN = /\s+$/u;

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

function agentRoleLabel(primaryAgentName: string | undefined): string {
	const label = primaryAgentName?.trim() || DEFAULT_SUMOCODE_CONFIG.primaryAgentName;
	return label.toUpperCase();
}

function roleLabel(role: ChatMessageRole, primaryAgentName?: string): string {
	if (role === "user") return "USER";
	if (role === "sumo" || role === "assistant") return agentRoleLabel(primaryAgentName);
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
	for (const glyph of splitGraphemes(input)) {
		const glyphWidth = visibleWidth(glyph);
		if (width + glyphWidth > maxWidth) break;
		width += glyphWidth;
		index += glyph.length;
	}
	if (index === 0) {
		const [first = ""] = splitGraphemes(input);
		return { head: first, tail: input.slice(first.length) };
	}
	return { head: input.slice(0, index), tail: input.slice(index) };
}

function splitGraphemes(text: string): string[] {
	if (!text) return [];
	if (!GRAPHEME_SEGMENTER) return Array.from(text);
	return [...GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment);
}

function isWhitespace(glyph: string): boolean {
	return /^\s$/u.test(glyph);
}

function joinLine(glyphs: readonly string[]): string {
	return glyphs.join("").replace(TRAILING_WHITESPACE_PATTERN, "");
}

function skipLeadingWhitespace(glyphs: readonly string[]): string[] {
	let index = 0;
	while (index < glyphs.length && isWhitespace(glyphs[index] ?? "")) index += 1;
	return glyphs.slice(index);
}

function wrapParagraph(paragraph: string, width: number): string[] {
	let remaining = splitGraphemes(paragraph.replace(TRAILING_WHITESPACE_PATTERN, ""));
	if (remaining.length === 0) return [""];

	const rows: string[] = [];
	while (remaining.length > 0) {
		let visible = 0;
		let fitEnd = 0;
		let lastWhitespace = -1;
		for (let index = 0; index < remaining.length; index += 1) {
			const glyph = remaining[index] ?? "";
			const glyphWidth = visibleWidth(glyph);
			if (fitEnd > 0 && visible + glyphWidth > width) break;
			visible += glyphWidth;
			fitEnd = index + 1;
			if (index > 0 && isWhitespace(glyph)) lastWhitespace = index;
			if (visible >= width) break;
		}

		if (fitEnd >= remaining.length) {
			rows.push(joinLine(remaining));
			break;
		}

		if (lastWhitespace > 0) {
			rows.push(joinLine(remaining.slice(0, lastWhitespace)));
			remaining = skipLeadingWhitespace(remaining.slice(lastWhitespace));
			continue;
		}

		const hardEnd = Math.max(1, fitEnd);
		rows.push(joinLine(remaining.slice(0, hardEnd)));
		remaining = skipLeadingWhitespace(remaining.slice(hardEnd));
	}

	return rows;
}

function wrapPlainText(input: string, width: number): string[] {
	if (width <= 0) return [""];
	const rows: string[] = [];
	const paragraphs = input.split("\n");
	for (const paragraph of paragraphs) {
		rows.push(...wrapParagraph(paragraph, width));
	}
	return rows.length === 0 ? [""] : rows;
}

function textWidth(parts: readonly (Span | string)[]): number {
	return parts.reduce((sum, part) => sum + visibleWidth(typeof part === "string" ? part : part.text), 0);
}

function fitCellText(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible > width ? takeVisible(text, width).head : `${text}${" ".repeat(width - visible)}`;
}

function formatTime(timestamp: Date): string {
	const hours = String(timestamp.getHours()).padStart(2, "0");
	const minutes = String(timestamp.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function frameTop(role: ChatMessageRole, timestamp: Date | undefined, width: number, primaryAgentName?: string): string {
	const label = roleLabel(role, primaryAgentName);
	const leftParts: (Span | string)[] = [
		span("╭ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(label, { fg: roleColor(role) }),
		span(" ", { fg: CATHEDRAL_TOKENS.colors.foreground }),
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
	const body = withPersistentStyle(` ${text} `, CATHEDRAL_TOKENS.colors.foreground, CATHEDRAL_TOKENS.colors.surfaceRecess);
	return lineToAnsi(textLine([
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(body),
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

function renderSkillRow(block: Extract<ChatBlock, { type: "skill" }>): string {
	const hint = block.expanded ? "(expanded)" : "(⌘O to expand)";
	return lineToAnsi(textLine([
		span("[skill]", { fg: CATHEDRAL_TOKENS.colors.accent }),
		span(` ${block.name} `, { fg: CATHEDRAL_TOKENS.colors.foreground }),
		span(hint, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	]));
}

function renderQuestionRows(block: Extract<ChatBlock, { type: "question" }>): string[] {
	return [`[question] ${block.question.prompt}`, ...block.question.choices.map((choice) => `- ${choice}`)];
}

function renderDelegationRows(block: Extract<ChatBlock, { type: "delegation" }>, width: number): string[] {
	return renderScrollBlock(block.delegation, width);
}

function renderCodeRows(block: Extract<ChatBlock, { type: "code" }>, width: number): string[] {
	return renderCathedralCodeBlock(block.lang, block.source, width);
}

function renderBlockRows(blocks: readonly ChatBlock[], width: number): string[] {
	const rows: string[] = [];
	for (const block of blocks) {
		if (rows.length > 0) rows.push("");
		switch (block.type) {
			case "markdown":
				rows.push(...wrapPlainText(block.text, width));
				break;
			case "code":
				rows.push(...renderCodeRows(block, width));
				break;
			case "tool":
				rows.push(...renderToolBlockRows(block.tool, width));
				break;
			case "skill":
				rows.push(renderSkillRow(block));
				break;
			case "question":
				rows.push(...renderQuestionRows(block));
				break;
			case "delegation":
				rows.push(...renderDelegationRows(block, width));
				break;
		}
	}
	return rows.length === 0 ? [""] : rows;
}

/** One V2 framed chat message. Markdown block parsing lands in #89/#90. */
export class ChatMessage extends SumoNode {
	public readonly timestamp: Date;
	private measuring = false;
	private lastMeasure: ChatMessageMeasure = { width: 0, height: 1 };

	public constructor(
		yogaNode: YogaNode,
		public role: ChatMessageRole,
		public text: string,
		parent?: SumoNode,
		timestamp = new Date(),
		private blocks?: readonly ChatBlock[],
		private readonly options: ChatMessageOptions = {},
	) {
		super(yogaNode, parent);
		this.timestamp = timestamp;
		this.marginBottom = 1;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public static create(yoga: Yoga, role: ChatMessageRole, text: string, parent?: SumoNode, timestamp?: Date, blocks?: readonly ChatBlock[], options?: ChatMessageOptions): ChatMessage {
		return new ChatMessage(yoga.Node.create(), role, text, parent, timestamp, blocks, options);
	}

	public setText(text: string): void {
		if (this.text === text && this.blocks === undefined) return;
		this.text = text;
		this.blocks = undefined;
		this.markDirty();
	}

	public setBlocks(blocks: readonly ChatBlock[], text: string): void {
		this.blocks = blocks;
		this.text = text;
		this.markDirty();
	}

	public setToolExpansion(expanded: boolean): boolean {
		if (!this.blocks?.some((block) => block.type === "tool" && Boolean(block.tool.expanded) !== expanded)) return false;
		this.blocks = this.blocks.map((block) => block.type === "tool" ? { ...block, tool: { ...block.tool, expanded } } : block);
		this.markDirty();
		return true;
	}

	public appendText(chunk: string): void {
		if (chunk.length === 0) return;
		this.blocks = undefined;
		this.text += chunk;
		this.markDirty();
	}

	public toSnapshot(): ChatMessageSnapshot {
		return { role: this.role, text: this.text, timestamp: this.timestamp, blocks: this.blocks };
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
		const bodyRows = this.blocks ? renderBlockRows(this.blocks, bodyWidth) : wrapPlainText(this.text, bodyWidth);
		return [
			frameTop(this.role, this.timestamp, renderWidth, this.options.primaryAgentName),
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
