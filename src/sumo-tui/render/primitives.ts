import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Cell } from "./cell.js";
import { createAttrs } from "./cell.js";

export interface Style {
	readonly fg?: string;
	readonly bg?: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly dim?: boolean;
	readonly inverse?: boolean;
}

export interface Span {
	readonly text: string;
	readonly style?: Style;
}

export interface Line {
	readonly spans: readonly Span[];
	/** Base style for spans that do not override a field, and for padding cells. */
	readonly style?: Style;
}

export interface RenderLineOptions {
	readonly width?: number;
	readonly style?: Style;
}

export interface RuleOptions {
	readonly char?: string;
	readonly indent?: string;
	readonly style?: Style;
	readonly lineStyle?: Style;
}

export interface BoxOptions {
	readonly width: number;
	readonly style?: Style;
	readonly borderStyle?: Style;
	readonly fillStyle?: Style;
	readonly title?: readonly Span[] | string;
}

const RESET = "\u001b[0m";

/**
 * Inject persistent fg + bg into pre-rendered ANSI text.
 * Every SGR reset (\x1b[0m) inside the text is followed by the restore
 * codes so both colors survive through nested ANSI-formatted content.
 */
export function withPersistentStyle(ansiText: string, fgHex: string, bgHex: string): string {
	const fg = parseHex(fgHex);
	const bg = parseHex(bgHex);
	if (!fg || !bg) return ansiText;
	const styleCode = `\u001b[38;2;${fg[0]};${fg[1]};${fg[2]}m\u001b[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
	return `${styleCode}${ansiText.replace(/\u001b\[0m/g, `${RESET}${styleCode}`)}${RESET}`;
}

function parseHex(hex: string): [number, number, number] | undefined {
	const normalized = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;
	return [
		Number.parseInt(normalized.slice(0, 2), 16),
		Number.parseInt(normalized.slice(2, 4), 16),
		Number.parseInt(normalized.slice(4, 6), 16),
	];
}

function sgrForStyle(style: Style): string {
	let output = "";
	const attrs: string[] = [];
	if (style.bold) attrs.push("1");
	if (style.italic) attrs.push("3");
	if (style.underline) attrs.push("4");
	if (style.dim) attrs.push("2");
	if (style.inverse) attrs.push("7");
	if (attrs.length > 0) output += `\u001b[${attrs.join(";")}m`;
	const fg = style.fg ? parseHex(style.fg) : undefined;
	if (fg) output += `\u001b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
	const bg = style.bg ? parseHex(style.bg) : undefined;
	if (bg) output += `\u001b[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
	return output;
}

function mergeStyle(base: Style | undefined, override: Style | undefined): Style {
	if (!base && !override) return {};
	return {
		fg: override?.fg ?? base?.fg,
		bg: override?.bg ?? base?.bg,
		bold: override?.bold ?? base?.bold,
		italic: override?.italic ?? base?.italic,
		underline: override?.underline ?? base?.underline,
		dim: override?.dim ?? base?.dim,
		inverse: override?.inverse ?? base?.inverse,
	};
}

function hasStyle(style: Style): boolean {
	return (
		style.fg !== undefined ||
		style.bg !== undefined ||
		style.bold === true ||
		style.italic === true ||
		style.underline === true ||
		style.dim === true ||
		style.inverse === true
	);
}

function toSpan(part: Span | string): Span {
	return typeof part === "string" ? { text: part } : part;
}

export function span(text: string, style?: Style): Span {
	return { text, style };
}

export function textLine(parts: readonly (Span | string)[] = [], style?: Style): Line {
	return { spans: parts.map(toSpan), style };
}

export function plainLine(text: string, style?: Style): Line {
	return textLine([text], style);
}

export function lineWidth(line: Line): number {
	return line.spans.reduce((width, part) => width + visibleWidth(part.text), 0);
}

export function truncateLine(line: Line, width: number): Line {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return { spans: [], style: line.style };

	let remaining = safeWidth;
	const spans: Span[] = [];
	for (const part of line.spans) {
		if (remaining <= 0) break;
		const partWidth = visibleWidth(part.text);
		if (partWidth <= remaining) {
			spans.push(part);
			remaining -= partWidth;
			continue;
		}
		const truncated = truncateToWidth(part.text, remaining, "");
		if (truncated.length > 0) spans.push({ ...part, text: truncated });
		remaining = 0;
	}
	return { spans, style: line.style };
}

export function padLine(line: Line, width: number, style?: Style): Line {
	const safeWidth = Math.max(0, Math.floor(width));
	const truncated = truncateLine(line, safeWidth);
	const padding = Math.max(0, safeWidth - lineWidth(truncated));
	if (padding === 0) return truncated;
	return {
		spans: [...truncated.spans, { text: " ".repeat(padding), style }],
		style: truncated.style,
	};
}

export function renderRule(width: number, options: RuleOptions = {}): Line {
	const safeWidth = Math.max(0, Math.floor(width));
	const indent = options.indent ?? "";
	const char = options.char ?? "─";
	const count = Math.max(0, safeWidth - visibleWidth(indent));
	return textLine([indent, span(char.repeat(count), options.style)], options.lineStyle);
}

export function renderBox(content: readonly Line[], options: BoxOptions): Line[] {
	const width = Math.max(0, Math.floor(options.width));
	if (width <= 0) return [];
	if (width === 1) return content.map(() => plainLine("│", options.borderStyle));

	const innerWidth = Math.max(0, width - 2);
	const borderStyle = options.borderStyle ?? options.style;
	const fillStyle = options.fillStyle ?? options.style;
	const topParts: (Span | string)[] = [span("┌", borderStyle)];
	if (options.title !== undefined && innerWidth > 0) {
		const titleParts = typeof options.title === "string" ? [span(` ${options.title} `, borderStyle)] : options.title;
		const titleWidth = titleParts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
		const rightRule = Math.max(0, innerWidth - titleWidth);
		topParts.push(...titleParts, span("─".repeat(rightRule), borderStyle));
	} else {
		topParts.push(span("─".repeat(innerWidth), borderStyle));
	}
	topParts.push(span("┐", borderStyle));

	const rows = [padLine(textLine(topParts, options.style), width, fillStyle)];
	for (const row of content) {
		const inner = padLine(row, innerWidth, fillStyle);
		const innerSpans = inner.spans.map((part) => ({ ...part, style: mergeStyle(inner.style, part.style) }));
		rows.push(padLine(textLine([span("│", borderStyle), ...innerSpans, span("│", borderStyle)], options.style), width, fillStyle));
	}
	rows.push(padLine(textLine([span("└", borderStyle), span("─".repeat(innerWidth), borderStyle), span("┘", borderStyle)], options.style), width, fillStyle));
	return rows;
}

export function lineToAnsi(line: Line, options: RenderLineOptions = {}): string {
	const prepared = options.width === undefined ? line : padLine(line, options.width, options.style ?? line.style);
	const baseStyle = mergeStyle(options.style, prepared.style);
	let output = "";
	for (const part of prepared.spans) {
		if (part.text.length === 0) continue;
		const effectiveStyle = mergeStyle(baseStyle, part.style);
		if (hasStyle(effectiveStyle)) output += `${RESET}${sgrForStyle(effectiveStyle)}`;
		else if (output.length > 0) output += RESET;
		output += part.text;
	}
	return output.length === 0 ? "" : `${output}${RESET}`;
}

export function lineToCells(line: Line, options: RenderLineOptions & { readonly width: number }): Cell[] {
	const prepared = padLine(line, options.width, options.style ?? line.style);
	const baseStyle = mergeStyle(options.style, prepared.style);
	const cells: Cell[] = [];

	for (const part of prepared.spans) {
		const style = mergeStyle(baseStyle, part.style);
		for (const char of Array.from(part.text)) {
			if (cells.length >= options.width) return cells;
			cells.push({
				char,
				fg: style.fg,
				bg: style.bg,
				attrs: createAttrs(style),
			});
		}
	}
	return cells;
}
