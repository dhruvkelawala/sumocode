import { Image, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_SUMOCODE_CONFIG } from "../../config/sumocode-config.js";
import { activeThemeChrome, activeThemeColors, getThemeVersion } from "../../themes/index.js";
import { fgHex, RESET } from "../cathedral/ansi.js";
import { SumoNode } from "../layout/node.js";
import { MEASURE_MODE_EXACTLY, type MeasureMode, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { lineToAnsi, span, textLine, type Span } from "../render/primitives.js";
import { renderCathedralCodeBlock } from "../transcript/code-renderer.js";
import { expandKey } from "../transcript/expand-key.js";
import { cathedralMarkdownTheme } from "../transcript/markdown-theme.js";
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
const DIM = "\x1b[2m";

/**
 * Memoized `renderRows` cache entry. `renderRows` is called from
 * `getEstimatedHeight`, `measure`, AND `render` — often several times per
 * frame per message — and its body path runs the `Markdown` parser (plus
 * `Image` construction), which is not cheap. We cache the last computed rows
 * per `(width, contentVersion, themeVersion)` so unchanged messages skip
 * recompute entirely. Rows are read-only string arrays; sharing the cached
 * array reference across calls is safe as nothing mutates it in place.
 */
interface RenderRowsCacheEntry {
	width: number;
	contentVersion: number;
	themeVersion: number;
	rows: string[];
}

/** Keep only the current + previous width entries: resize churns width, not content. */
const RENDER_ROWS_CACHE_LIMIT = 2;

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
	if (role === "bash") return "BASH";
	return String(role).toUpperCase();
}

function roleColor(role: ChatMessageRole): string {
	if (role === "user") return activeThemeColors().foreground;
	if (role === "sumo" || role === "assistant") return activeThemeColors().accent;
	if (role === "tool" || role === "bash") return activeThemeColors().states.tool;
	return activeThemeColors().foregroundDim;
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

function fitAnsiText(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const clipped = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "") : text;
	return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

function formatTime(timestamp: Date): string {
	const hours = String(timestamp.getHours()).padStart(2, "0");
	const minutes = String(timestamp.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function frameTop(role: ChatMessageRole, timestamp: Date | undefined, width: number, primaryAgentName?: string): string {
	const chrome = activeThemeChrome();
	const label = roleLabel(role, primaryAgentName);
	const leftParts: (Span | string)[] = [
		span(`${chrome.frame.topLeft} `, { fg: activeThemeColors().divider }),
		span(label, { fg: roleColor(role) }),
		span(" ", { fg: activeThemeColors().foreground }),
	];

	const showTime = (role === "sumo" || role === "assistant") && timestamp !== undefined;
	const rightParts: (Span | string)[] = showTime
		? [
			span(" ", { fg: activeThemeColors().divider }),
			span(formatTime(timestamp), { fg: activeThemeColors().foregroundDim }),
			span(` ${chrome.frame.horizontal}`, { fg: activeThemeColors().divider }),
		]
		: [];

	const used = textWidth(leftParts) + textWidth(rightParts) + 1; // right corner
	const rule = Math.max(0, width - used);
	return lineToAnsi(textLine([
		...leftParts,
		span(chrome.frame.horizontal.repeat(rule), { fg: activeThemeColors().divider }),
		...rightParts,
		span(chrome.frame.topRight, { fg: activeThemeColors().divider }),
	]), { width });
}

function frameBody(row: string, width: number): string {
	const chrome = activeThemeChrome();
	const inner = Math.max(0, width - 4);
	const text = fitAnsiText(row, inner);
	const divider = fgHex(activeThemeColors().divider);
	const foreground = fgHex(activeThemeColors().foreground);
	return `${divider}${chrome.frame.vertical}${RESET} ${foreground}${text}${RESET} ${divider}${chrome.frame.vertical}${RESET}`;
}

function frameBottom(width: number): string {
	const chrome = activeThemeChrome();
	return lineToAnsi(textLine([
		span(chrome.frame.bottomLeft, { fg: activeThemeColors().divider }),
		span(chrome.frame.horizontal.repeat(Math.max(0, width - 2)), { fg: activeThemeColors().divider }),
		span(chrome.frame.bottomRight, { fg: activeThemeColors().divider }),
	]), { width });
}

function renderSkillRows(block: Extract<ChatBlock, { type: "skill" }>, width: number): string[] {
	const hint = block.expanded ? `(${expandKey()} to collapse)` : `(${expandKey()} to expand)`;
	const header = lineToAnsi(textLine([
		span("[skill]", { fg: activeThemeColors().accent }),
		span(` ${block.name} `, { fg: activeThemeColors().foreground }),
		span(hint, { fg: activeThemeColors().foregroundDim }),
	]));
	if (!block.expanded || !block.content) return [header];
	const body = wrapPlainText(block.content, width).map((row) => lineToAnsi(textLine([
		span(row, { fg: activeThemeColors().foregroundDim }),
	]), { width }));
	return [header, ...body];
}

function renderSummaryRows(block: Extract<ChatBlock, { type: "summary" }>, width: number): string[] {
	const hint = block.expanded ? `(${expandKey()} to collapse)` : `(${expandKey()} to expand)`;
	const header = lineToAnsi(textLine([
		span(block.label, { fg: activeThemeColors().accent }),
		span(" "),
		span(hint, { fg: activeThemeColors().foregroundDim }),
	]));
	if (!block.expanded || !block.content) return [header];
	const body = wrapPlainText(block.content, width).map((row) => lineToAnsi(textLine([
		span(row, { fg: activeThemeColors().foregroundDim }),
	]), { width }));
	return [header, ...body];
}

function renderThinkingRows(block: Extract<ChatBlock, { type: "thinking" }>, width: number): string[] {
	const prefix = block.hidden ? "◌ " : "✦ ";
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const lines = new Markdown(block.text, 0, 0, cathedralMarkdownTheme(), {
		italic: true,
		color: (text) => `${DIM}${fgHex(activeThemeColors().states.thinking)}${text}${RESET}`,
	}).render(contentWidth);
	return (lines.length > 0 ? lines : [""]).map((row) => lineToAnsi(textLine([
		span(prefix, { fg: activeThemeColors().states.thinking, dim: true }),
		span(row),
	]), { width }));
}

function renderQuestionRows(block: Extract<ChatBlock, { type: "question" }>): string[] {
	return [`[question] ${block.question.prompt}`, ...block.question.choices.map((choice) => `- ${choice}`)];
}

function renderImageRows(block: Extract<ChatBlock, { type: "image" }>, width: number): string[] {
	const image = new Image(
		block.data,
		block.mime,
		{ fallbackColor: (value) => `${fgHex(activeThemeColors().foregroundDim)}${value}${RESET}` },
		{ maxWidthCells: Math.max(1, width), maxHeightCells: 24, filename: block.filename },
	);
	return image.render(width).map((row) => visibleWidth(row) > width ? truncateToWidth(row, width, "") : row);
}

function renderDelegationRows(block: Extract<ChatBlock, { type: "delegation" }>, width: number): string[] {
	return renderScrollBlock(block.delegation, width);
}

function renderCodeRows(block: Extract<ChatBlock, { type: "code" }>, width: number): string[] {
	return renderCathedralCodeBlock(block.lang, block.source, width);
}

function renderMarkdownRows(text: string, width: number): string[] {
	const lines = new Markdown(text, 0, 0, cathedralMarkdownTheme()).render(width);
	return lines.length > 0 ? lines : [""];
}

function renderBlockRows(blocks: readonly ChatBlock[], width: number): string[] {
	const rows: string[] = [];
	for (const block of blocks) {
		if (rows.length > 0) rows.push("");
		switch (block.type) {
			case "markdown": {
				rows.push(...renderMarkdownRows(block.text, width));
				break;
			}
			case "thinking":
				rows.push(...renderThinkingRows(block, width));
				break;
			case "code":
				rows.push(...renderCodeRows(block, width));
				break;
			case "image":
				rows.push(...renderImageRows(block, width));
				break;
			case "tool":
				rows.push(...renderToolBlockRows(block.tool, width));
				break;
			case "skill":
				rows.push(...renderSkillRows(block, width));
				break;
			case "summary":
				rows.push(...renderSummaryRows(block, width));
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

/** One V2 framed chat message. */
export class ChatMessage extends SumoNode {
	private timestampValue: Date;
	private measuring = false;
	private lastMeasure: ChatMessageMeasure = { width: 0, height: 1 };

	/**
	 * Bumped by every mutator that changes what `renderRows` produces
	 * (`setRole`/`setText`/`appendText`/`setBlocks`/`setToolExpansion`/
	 * `setTimestamp`). This is the content half of the `renderRows` memo key —
	 * see `renderRowsCache`. A missed bump site means a stale frame, so if you
	 * add a new mutator that changes rendered output, bump this in it too.
	 */
	private contentVersion = 0;
	private renderRowsCache: RenderRowsCacheEntry[] = [];

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
		this.timestampValue = timestamp;
		this.marginBottom = 1;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public static create(yoga: Yoga, role: ChatMessageRole, text: string, parent?: SumoNode, timestamp?: Date, blocks?: readonly ChatBlock[], options?: ChatMessageOptions): ChatMessage {
		return new ChatMessage(yoga.Node.create(), role, text, parent, timestamp, blocks, options);
	}

	public get timestamp(): Date {
		return this.timestampValue;
	}

	public setTimestamp(next: Date): void {
		const renderedMinuteChanged = formatTime(this.timestampValue) !== formatTime(next);
		this.timestampValue = next;
		if (renderedMinuteChanged) this.invalidateRenderCache();
	}

	/**
	 * Chat pagers may reassign the role of an existing message in place (e.g.
	 * `replaceLastWithViewModel` folding a streamed placeholder into its final
	 * role). Route that through a setter rather than direct `.role =` so the
	 * render memo invalidates — `frameTop` reads `role` for the label/color.
	 */
	public setRole(role: ChatMessageRole): void {
		if (this.role === role) return;
		this.role = role;
		this.invalidateRenderCache();
	}

	public setText(text: string): void {
		if (this.text === text && this.blocks === undefined) return;
		this.text = text;
		this.blocks = undefined;
		this.invalidateRenderCache();
	}

	public setBlocks(blocks: readonly ChatBlock[], text: string): void {
		this.blocks = blocks;
		this.text = text;
		this.invalidateRenderCache();
	}

	public setToolExpansion(expanded: boolean): boolean {
		const expandable = (block: ChatBlock): boolean => block.type === "tool" || block.type === "skill" || block.type === "summary";
		if (!this.blocks?.some(expandable)) return false;
		this.blocks = this.blocks.map((block) => {
			if (block.type === "tool") return { ...block, tool: { ...block.tool, expanded } };
			if (block.type === "skill") return { ...block, expanded };
			if (block.type === "summary") return { ...block, expanded };
			return block;
		});
		this.invalidateRenderCache();
		return true;
	}

	public appendText(chunk: string): void {
		if (chunk.length === 0) return;
		this.blocks = undefined;
		this.text += chunk;
		this.invalidateRenderCache();
	}

	public toSnapshot(): ChatMessageSnapshot {
		return { role: this.role, text: this.text, timestamp: this.timestamp, blocks: this.blocks };
	}

	/** Bumps the content version (invalidating the render memo) and marks Yoga layout dirty. */
	private invalidateRenderCache(): void {
		this.contentVersion += 1;
		this.markDirty();
	}

	public getEstimatedHeight(width = this.getComputedWidth()): number {
		return this.renderRows(width).length + 1;
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		const rows = this.renderRows(rect.width);
		const height = Math.min(rows.length, rect.height);
		for (let row = 0; row < height; row += 1) {
			const absoluteRow = rect.top + row;
			buffer.paintRow(absoluteRow, rows[row] ?? "", rect.left, rect.width);
			if (rect.width >= MIN_BOX_WIDTH && row > 0 && row < rows.length - 1) {
				this.markBodyRowSelectable(buffer, absoluteRow, rect.left, rect.width);
			}
		}
	}

	private markBodyRowSelectable(buffer: CellBuffer, row: number, left: number, width: number): void {
		const startCol = left + 2;
		const endCol = left + Math.max(1, width - 3);
		let contentEnd: number | undefined;
		for (let col = startCol; col <= endCol; col += 1) {
			const cell = buffer.getCell(row, col);
			if (cell.char.length > 0 && cell.char.trim().length > 0) contentEnd = col;
		}
		// For non-blank rows we mark startCol..contentEnd so trailing padding
		// stays unselectable. For blank body rows (paragraph breaks, blank lines
		// inside code blocks) we still need to mark the full inner range so the
		// row participates in semantic selection — otherwise multi-row drags drop
		// the blank line from copied text and `snapFocusToSelectableRow` skips
		// past it. Selection text extraction trims trailing whitespace so the
		// row contributes an empty line, not a row of spaces.
		const lastSelectable = contentEnd ?? endCol;
		for (let col = startCol; col <= lastSelectable; col += 1) {
			buffer.setSelectionMeta(row, col, { selectable: true });
		}
	}

	/**
	 * Memoized entry point: called from `getEstimatedHeight`, `measure`, AND
	 * `render` — several times per message per frame. Recomputing from scratch
	 * every call re-runs the `Markdown` parse (and `Image` construction) on
	 * the hot path, so we cache the last few width->rows results keyed by
	 * `(width, contentVersion, themeVersion)`. Cache hit returns the same rows
	 * array reference; this is purely a compute cache and must never change
	 * rendered output.
	 */
	private renderRows(width: number): string[] {
		const renderWidth = normalizeWidth(width);
		const themeVersion = getThemeVersion();
		const cached = this.renderRowsCache.find(
			(entry) => entry.width === renderWidth && entry.contentVersion === this.contentVersion && entry.themeVersion === themeVersion,
		);
		if (cached) return cached.rows;

		const rows = this.computeRenderRows(renderWidth);
		const entry: RenderRowsCacheEntry = { width: renderWidth, contentVersion: this.contentVersion, themeVersion, rows };
		this.renderRowsCache = [entry, ...this.renderRowsCache.filter((existing) => existing.width !== renderWidth)].slice(0, RENDER_ROWS_CACHE_LIMIT);
		return rows;
	}

	private computeRenderRows(renderWidth: number): string[] {
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
