/**
 * Cathedral code block renderer — Bible Element 10.
 *
 * Renders fenced code blocks as framed cards with line gutter and
 * basic syntax highlighting. Shares frame primitives with the tool
 * ledger renderer but adds a language label and gutter.
 *
 * Bible source of truth:
 *   docs/ui/bible/10-code-typescript.html
 *   docs/ui/bible/10-code-bash.html
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeApplicationRoles, type ThemeApplicationRoles } from "../../themes/index.js";
import { lineToAnsi, lineWidth, span, textLine, truncateLine, withPersistentStyle, wrapLine, type Span } from "../render/primitives.js";
import { expandKey } from "./expand-key.js";
import { highlightLine } from "./syntax-highlight.js";

const MAX_SOURCE_LINES = 20;
const MAX_VISIBLE_ROWS = 20;
const MIN_GUTTER_WIDTH = 4; // "  1 " — 4 chars (right-aligned 3 + space)
// Explicit plaintext tags intentionally trade column alignment for visible
// continuation rows. Untagged/code fences keep legacy one-row clipping for
// tables, trees, and other structure-sensitive text.
const WRAPPED_TEXT_LANGUAGES = new Set(["txt", "text", "plain", "plaintext"]);

// Syntax highlighting (Shiki + synchronous fallback) lives in
// ./syntax-highlight.ts.

type CodeRoles = ThemeApplicationRoles["code"];

// ── Frame rendering ──────────────────────────────────────────

function takeVisible(input: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let width = 0;
	let index = 0;
	for (const glyph of Array.from(input)) {
		const w = visibleWidth(glyph);
		if (width + w > maxWidth) break;
		width += w;
		index += glyph.length;
	}
	return input.slice(0, index);
}

function codeFrameTop(lang: string, width: number, roles: CodeRoles): string {
	const labelParts: (Span | string)[] = lang.length > 0
		? [span("── ", { fg: roles.border }), span(lang, { fg: roles.gutter }), span(" ─", { fg: roles.border })]
		: [span("──", { fg: roles.border })];
	const labelWidth = lang.length > 0 ? 5 + lang.length : 2;
	const ruleLen = Math.max(0, width - 3 - labelWidth);
	return lineToAnsi(textLine([
		span("╭─", { fg: roles.border }),
		...labelParts,
		span("─".repeat(ruleLen), { fg: roles.border }),
		span("╮", { fg: roles.border }),
	], { fg: roles.foreground, bg: roles.surface }), { width });
}

function codeFrameBottom(width: number, roles: CodeRoles): string {
	return lineToAnsi(textLine([
		span("╰", { fg: roles.border }),
		span("─".repeat(Math.max(0, width - 2)), { fg: roles.border }),
		span("╯", { fg: roles.border }),
	], { fg: roles.foreground, bg: roles.surface }), { width });
}

function codeBodyRow(lineNumber: number | "continuation", bodySpans: readonly Span[], width: number, roles: CodeRoles, gutterWidth: number): string {
	const gutter = lineNumber === "continuation"
		? `${" ".repeat(Math.max(0, gutterWidth - 2))}↳ `
		: `${String(lineNumber).padStart(Math.max(1, gutterWidth - 1))} `;
	const gutterSpan = span(gutter, { fg: roles.gutter });
	const innerWidth = Math.max(0, width - 4); // 2 for │+space, 1 for space+│
	const contentWidth = gutterWidth + bodySpans.reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const pad = Math.max(0, innerWidth - contentWidth);

	const inner = withPersistentStyle(
		lineToAnsi(textLine([span(" "), gutterSpan, ...bodySpans, span(" ".repeat(pad + 1))]), { width: innerWidth + 2 }),
		roles.foreground,
		roles.surface,
	);

	return lineToAnsi(textLine([
		span("│", { fg: roles.border }),
		span(inner),
		span("│", { fg: roles.border }),
	], { fg: roles.foreground, bg: roles.surface }), { width });
}

function wrappedCodeBodyRows(
	lineNumber: number,
	bodySpans: readonly Span[],
	width: number,
	roles: CodeRoles,
	maxRows: number,
	gutterWidth: number,
) {
	if (maxRows <= 0) return { rows: [], truncated: true };
	const sourceWidth = Math.max(1, width - 4 - gutterWidth);
	const source = textLine(bodySpans);
	if (maxRows === 1) {
		return {
			rows: [codeBodyRow(lineNumber, truncateLine(source, sourceWidth).spans, width, roles, gutterWidth)],
			truncated: lineWidth(source) > sourceWidth,
		};
	}
	const cellBudget = sourceWidth * maxRows;
	const sourceTruncated = lineWidth(source) > cellBudget;
	const bounded = sourceTruncated ? truncateLine(source, cellBudget) : source;
	const wrapped = wrapLine(bounded, sourceWidth);
	return {
		rows: wrapped.slice(0, maxRows).map((line, index) =>
			codeBodyRow(index === 0 ? lineNumber : "continuation", line.spans, width, roles, gutterWidth)),
		truncated: sourceTruncated || wrapped.length > maxRows,
	};
}

function collapsedRow(label: string, width: number, roles: CodeRoles, gutterWidth: number): string {
	const innerWidth = Math.max(0, width - 4);
	const suffix = ` · ${expandKey()} expand`;
	const availableWidth = Math.max(0, innerWidth - gutterWidth);
	const fullText = `… ${label}${suffix}`;
	const text = visibleWidth(fullText) <= availableWidth ? fullText : `… collapsed${suffix}`;
	const pad = Math.max(0, innerWidth - gutterWidth - visibleWidth(text));
	const inner = withPersistentStyle(
		lineToAnsi(textLine([span(" "), span(" ".repeat(gutterWidth), { fg: roles.gutter }), span(text, { fg: roles.gutter }), span(" ".repeat(pad + 1))]), { width: innerWidth + 2 }),
		roles.foreground,
		roles.surface,
	);
	return lineToAnsi(textLine([
		span("│", { fg: roles.border }),
		span(inner),
		span("│", { fg: roles.border }),
	], { fg: roles.foreground, bg: roles.surface }), { width });
}

// ── Public API ───────────────────────────────────────────────

export interface CodeBlockRenderOptions {
	/** Disable the preview row/source caps after the user invokes the expand affordance. */
	readonly expanded?: boolean;
}

function normalizedCodeLanguage(lang: string): string {
	return lang.toLowerCase().replace(/^language-/, "");
}

function codeGutterWidth(lineCount: number): number {
	return Math.max(MIN_GUTTER_WIDTH, String(Math.max(1, lineCount)).length + 1);
}

function wrappedTextBodyRowCount(line: string, width: number, gutterWidth: number): number {
	const sourceWidth = Math.max(1, width - 4 - gutterWidth);
	return wrapLine(textLine([span(line)]), sourceWidth).length;
}

export function isCathedralCodeBlockCollapsible(lang: string, source: string, width: number): boolean {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 10) return false;
	const lines = source.split("\n");
	if (lines.length > MAX_SOURCE_LINES) return true;
	if (!WRAPPED_TEXT_LANGUAGES.has(normalizedCodeLanguage(lang))) return false;
	const gutterWidth = codeGutterWidth(lines.length);
	const displayRows = lines.reduce((sum, line) => sum + wrappedTextBodyRowCount(line, safeWidth, gutterWidth), 0);
	return displayRows > MAX_VISIBLE_ROWS;
}

function expandedWrappedCodeBodyRows(lineNumber: number, bodySpans: readonly Span[], width: number, roles: CodeRoles, gutterWidth: number): string[] {
	const sourceWidth = Math.max(1, width - 4 - gutterWidth);
	const wrapped = wrapLine(textLine(bodySpans), sourceWidth);
	return wrapped.map((line, index) => codeBodyRow(index === 0 ? lineNumber : "continuation", line.spans, width, roles, gutterWidth));
}

export function renderCathedralCodeBlock(lang: string, source: string, width: number, options: CodeBlockRenderOptions = {}): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 10) return [takeVisible(source, safeWidth)];

	const expanded = options.expanded === true;
	const lines = source.split("\n");
	const visible = expanded ? lines : lines.slice(0, MAX_SOURCE_LINES);
	const normalizedLang = normalizedCodeLanguage(lang);
	const roles = activeThemeApplicationRoles().code;
	const gutterWidth = codeGutterWidth(lines.length);
	const bodyRows: string[] = [];
	let collapsedSourceLines = expanded ? 0 : Math.max(0, lines.length - visible.length);
	let wrappedContentCollapsed = false;

	for (let i = 0; i < visible.length; i += 1) {
		if (!expanded && bodyRows.length >= MAX_VISIBLE_ROWS) {
			collapsedSourceLines += visible.length - i;
			break;
		}
		const highlighted = highlightLine(visible[i]!, normalizedLang, roles);
		const bodySpans = highlighted.map((syntax) => span(syntax.text, { fg: syntax.color }));
		if (WRAPPED_TEXT_LANGUAGES.has(normalizedLang)) {
			if (expanded) {
				bodyRows.push(...expandedWrappedCodeBodyRows(i + 1, bodySpans, safeWidth, roles, gutterWidth));
				continue;
			}
			const availableRows = MAX_VISIBLE_ROWS - bodyRows.length;
			const remainingLines = visible.length - i - 1;
			const reservedRows = Math.min(remainingLines, Math.max(0, availableRows - 1));
			const rowsForLine = Math.max(1, availableRows - reservedRows);
			const rendered = wrappedCodeBodyRows(i + 1, bodySpans, safeWidth, roles, rowsForLine, gutterWidth);
			bodyRows.push(...rendered.rows);
			wrappedContentCollapsed ||= rendered.truncated;
		} else {
			bodyRows.push(codeBodyRow(i + 1, bodySpans, safeWidth, roles, gutterWidth));
		}
	}

	const rows: string[] = [codeFrameTop(normalizedLang, safeWidth, roles), ...bodyRows];
	const collapsedLabel = collapsedSourceLines > 0
		? (wrappedContentCollapsed ? `${collapsedSourceLines} lines + tail collapsed` : `${collapsedSourceLines} lines collapsed`)
		: (wrappedContentCollapsed ? "wrapped content collapsed" : undefined);
	if (collapsedLabel) rows.push(collapsedRow(collapsedLabel, safeWidth, roles, gutterWidth));
	rows.push(codeFrameBottom(safeWidth, roles));
	return rows;
}
