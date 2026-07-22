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

const MAX_SOURCE_LINES = 20;
const MAX_VISIBLE_ROWS = 20;
const GUTTER_WIDTH = 4; // "  1 " — 4 chars (right-aligned 3 + space)
// Explicit plaintext tags intentionally trade column alignment for visible
// continuation rows. Untagged/code fences keep legacy one-row clipping for
// tables, trees, and other structure-sensitive text.
const WRAPPED_TEXT_LANGUAGES = new Set(["txt", "text", "plain", "plaintext"]);

// ── Syntax highlighting ──────────────────────────────────────

const KEYWORD_SETS: Record<string, ReadonlySet<string>> = {
	ts: new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "implements", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "type", "interface", "enum", "as", "is", "keyof", "readonly", "declare", "module", "namespace", "abstract", "private", "protected", "public", "static", "yield", "delete", "super", "this", "debugger", "with"]),
	typescript: new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "implements", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "type", "interface", "enum", "as", "is", "keyof", "readonly", "declare", "module", "namespace", "abstract", "private", "protected", "public", "static", "yield", "delete", "super", "this", "debugger", "with"]),
	js: new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "yield", "delete", "super", "this", "debugger", "with"]),
	javascript: new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "yield", "delete", "super", "this", "debugger", "with"]),
	bash: new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "local", "export", "readonly", "declare", "typeset", "unset", "shift", "exit", "break", "continue", "source", "eval", "exec", "set", "trap"]),
	sh: new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "local", "export", "readonly", "declare", "typeset", "unset", "shift", "exit", "break", "continue", "source", "eval", "exec", "set", "trap"]),
	python: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "yield", "lambda", "and", "or", "not", "in", "is", "True", "False", "None", "global", "nonlocal", "del", "assert", "async", "await"]),
	py: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "yield", "lambda", "and", "or", "not", "in", "is", "True", "False", "None", "global", "nonlocal", "del", "assert", "async", "await"]),
};

interface SyntaxSpan {
	text: string;
	color: string;
}

type CodeRoles = ThemeApplicationRoles["code"];

function isFunctionCall(rest: string): boolean {
	return /^\s*\(/.test(rest);
}

/**
 * Tokenize a source line into colored spans.
 * Handles: comments (#, //), strings ("…", '…'), numbers, keywords, function calls.
 */
function highlightLine(line: string, lang: string, roles: CodeRoles): SyntaxSpan[] {
	const spans: SyntaxSpan[] = [];
	const fg = roles.foreground;
	const kw = roles.keyword;
	const str = roles.string;
	const num = roles.number;
	const fn = roles.function;
	const comment = roles.comment;

	let i = 0;
	let current = "";
	let currentColor = fg;

	function flush(): void {
		if (current.length > 0) {
			spans.push({ text: current, color: currentColor });
			current = "";
		}
	}

	function pushColored(text: string, color: string): void {
		flush();
		spans.push({ text, color });
		currentColor = fg;
	}

	while (i < line.length) {
		const ch = line[i]!;

		// Line comments: // or #
		if ((ch === "/" && line[i + 1] === "/") || (ch === "#" && (lang === "bash" || lang === "sh" || lang === "python" || lang === "py"))) {
			flush();
			spans.push({ text: line.slice(i), color: comment });
			return spans.length > 0 ? spans : [{ text: line, color: fg }];
		}

		// Strings
		if (ch === '"' || ch === "'" || ch === "`") {
			flush();
			let j = i + 1;
			while (j < line.length && line[j] !== ch) {
				if (line[j] === "\\") j += 1;
				j += 1;
			}
			j = Math.min(j + 1, line.length);
			pushColored(line.slice(i, j), str);
			i = j;
			continue;
		}

		// Numbers
		if (/[0-9]/.test(ch) && (i === 0 || /[\s(,=:<>!&|+\-*/[\]{};]/.test(line[i - 1] ?? ""))) {
			flush();
			let j = i;
			while (j < line.length && /[0-9._xXa-fA-FeEn]/.test(line[j]!)) j += 1;
			pushColored(line.slice(i, j), num);
			i = j;
			continue;
		}

		// Words (identifiers / keywords)
		if (/[a-zA-Z_$]/.test(ch)) {
			flush();
			let j = i;
			while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j]!)) j += 1;
			const word = line.slice(i, j);
			const after = line.slice(j);
				if (KEYWORD_SETS[lang]?.has(word)) {
				pushColored(word, kw);
			} else if (isFunctionCall(after)) {
				pushColored(word, fn);
			} else {
				pushColored(word, fg);
			}
			i = j;
			continue;
		}

		// Default: accumulate as foreground
		current += ch;
		currentColor = fg;
		i += 1;
	}

	flush();
	return spans.length > 0 ? spans : [{ text: line, color: fg }];
}

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

function codeBodyRow(lineNumber: number | "continuation", bodySpans: readonly Span[], width: number, roles: CodeRoles): string {
	const gutter = lineNumber === "continuation" ? "  ↳ " : `${String(lineNumber).padStart(3)} `;
	const gutterSpan = span(gutter, { fg: roles.gutter });
	const innerWidth = Math.max(0, width - 4); // 2 for │+space, 1 for space+│
	const contentWidth = GUTTER_WIDTH + bodySpans.reduce((sum, part) => sum + visibleWidth(part.text), 0);
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
): { rows: string[]; truncated: boolean } {
	if (maxRows <= 0) return { rows: [], truncated: true };
	const sourceWidth = Math.max(1, width - 4 - GUTTER_WIDTH);
	const source = textLine(bodySpans);
	if (maxRows === 1) {
		return {
			rows: [codeBodyRow(lineNumber, truncateLine(source, sourceWidth).spans, width, roles)],
			truncated: lineWidth(source) > sourceWidth,
		};
	}
	const cellBudget = sourceWidth * maxRows;
	const sourceTruncated = lineWidth(source) > cellBudget;
	const bounded = sourceTruncated ? truncateLine(source, cellBudget) : source;
	const wrapped = wrapLine(bounded, sourceWidth);
	return {
		rows: wrapped.slice(0, maxRows).map((line, index) =>
			codeBodyRow(index === 0 ? lineNumber : "continuation", line.spans, width, roles)),
		truncated: sourceTruncated || wrapped.length > maxRows,
	};
}

function collapsedRow(label: string, width: number, roles: CodeRoles): string {
	const innerWidth = Math.max(0, width - 4);
	const suffix = ` · ${expandKey()} expand`;
	const availableWidth = Math.max(0, innerWidth - GUTTER_WIDTH);
	const fullText = `… ${label}${suffix}`;
	const text = visibleWidth(fullText) <= availableWidth ? fullText : `… collapsed${suffix}`;
	const pad = Math.max(0, innerWidth - GUTTER_WIDTH - visibleWidth(text));
	const inner = withPersistentStyle(
		lineToAnsi(textLine([span(" "), span(" ".repeat(GUTTER_WIDTH), { fg: roles.gutter }), span(text, { fg: roles.gutter }), span(" ".repeat(pad + 1))]), { width: innerWidth + 2 }),
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

export function renderCathedralCodeBlock(lang: string, source: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 10) return [takeVisible(source, safeWidth)];

	const lines = source.split("\n");
	const visible = lines.slice(0, MAX_SOURCE_LINES);
	const normalizedLang = lang.toLowerCase().replace(/^language-/, "");
	const roles = activeThemeApplicationRoles().code;
	const bodyRows: string[] = [];
	let collapsedSourceLines = Math.max(0, lines.length - visible.length);
	let wrappedContentCollapsed = false;

	for (let i = 0; i < visible.length; i += 1) {
		if (bodyRows.length >= MAX_VISIBLE_ROWS) {
			collapsedSourceLines += visible.length - i;
			break;
		}
		const highlighted = highlightLine(visible[i]!, normalizedLang, roles);
		const bodySpans = highlighted.map((syntax) => span(syntax.text, { fg: syntax.color }));
		if (WRAPPED_TEXT_LANGUAGES.has(normalizedLang)) {
			const availableRows = MAX_VISIBLE_ROWS - bodyRows.length;
			const remainingLines = visible.length - i - 1;
			const reservedRows = Math.min(remainingLines, Math.max(0, availableRows - 1));
			const rowsForLine = Math.max(1, availableRows - reservedRows);
			const rendered = wrappedCodeBodyRows(i + 1, bodySpans, safeWidth, roles, rowsForLine);
			bodyRows.push(...rendered.rows);
			wrappedContentCollapsed ||= rendered.truncated;
		} else {
			bodyRows.push(codeBodyRow(i + 1, bodySpans, safeWidth, roles));
		}
	}

	const rows: string[] = [codeFrameTop(normalizedLang, safeWidth, roles), ...bodyRows];
	const collapsedLabel = collapsedSourceLines > 0
		? (wrappedContentCollapsed ? `${collapsedSourceLines} lines + tail collapsed` : `${collapsedSourceLines} lines collapsed`)
		: (wrappedContentCollapsed ? "wrapped content collapsed" : undefined);
	if (collapsedLabel) rows.push(collapsedRow(collapsedLabel, safeWidth, roles));
	rows.push(codeFrameBottom(safeWidth, roles));
	return rows;
}
