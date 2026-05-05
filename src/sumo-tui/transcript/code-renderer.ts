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
import { visibleWidth } from "@mariozechner/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { lineToAnsi, span, textLine, withPersistentStyle, type Span } from "../render/primitives.js";

const MAX_VISIBLE_LINES = 20;
const GUTTER_WIDTH = 4; // "  1 " — 4 chars (right-aligned 3 + space)

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

function isFunctionCall(rest: string): boolean {
	return /^\s*\(/.test(rest);
}

/**
 * Tokenize a source line into colored spans.
 * Handles: comments (#, //), strings ("…", '…'), numbers, keywords, function calls.
 */
function highlightLine(line: string, lang: string): SyntaxSpan[] {
	const spans: SyntaxSpan[] = [];
	const fg = activeThemeColors().foreground;
	const kw = activeThemeColors().accent;
	const str = activeThemeColors().states.idle;
	const num = activeThemeColors().states.thinking;
	const fn = activeThemeColors().states.thinking;
	const comment = "#6F5D46";

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

function codeFrameTop(lang: string, width: number): string {
	const labelParts: (Span | string)[] = lang.length > 0
		? [span("── ", { fg: activeThemeColors().divider }), span(lang, { fg: activeThemeColors().foregroundDim }), span(" ─", { fg: activeThemeColors().divider })]
		: [span("──", { fg: activeThemeColors().divider })];
	const labelWidth = lang.length > 0 ? 5 + lang.length : 2;
	const ruleLen = Math.max(0, width - 3 - labelWidth);
	return lineToAnsi(textLine([
		span("╭─", { fg: activeThemeColors().divider }),
		...labelParts,
		span("─".repeat(ruleLen), { fg: activeThemeColors().divider }),
		span("╮", { fg: activeThemeColors().divider }),
	]), { width });
}

function codeFrameBottom(width: number): string {
	return lineToAnsi(textLine([
		span("╰", { fg: activeThemeColors().divider }),
		span("─".repeat(Math.max(0, width - 2)), { fg: activeThemeColors().divider }),
		span("╯", { fg: activeThemeColors().divider }),
	]), { width });
}

function codeBodyRow(lineNumber: number, syntaxSpans: SyntaxSpan[], width: number): string {
	const gutter = `${String(lineNumber).padStart(3)} `;
	const gutterSpan = span(gutter, { fg: activeThemeColors().foregroundDim });
	const bodySpans: Span[] = syntaxSpans.map((s) => span(s.text, { fg: s.color }));
	const innerWidth = Math.max(0, width - 4); // 2 for │+space, 1 for space+│
	const contentWidth = GUTTER_WIDTH + syntaxSpans.reduce((w, s) => w + visibleWidth(s.text), 0);
	const pad = Math.max(0, innerWidth - contentWidth);

	const inner = withPersistentStyle(
		lineToAnsi(textLine([span(" "), gutterSpan, ...bodySpans, span(" ".repeat(pad + 1))]), { width: innerWidth + 2 }),
		activeThemeColors().foreground,
		activeThemeColors().surfaceRecess,
	);

	return lineToAnsi(textLine([
		span("│", { fg: activeThemeColors().divider }),
		span(inner),
		span("│", { fg: activeThemeColors().divider }),
	]), { width });
}

function collapsedRow(remaining: number, width: number): string {
	const text = `… ${remaining} lines collapsed · ⌘O expand`;
	const innerWidth = Math.max(0, width - 4);
	const pad = Math.max(0, innerWidth - GUTTER_WIDTH - visibleWidth(text));
	const inner = withPersistentStyle(
		lineToAnsi(textLine([span(" "), span(" ".repeat(GUTTER_WIDTH), { fg: activeThemeColors().foregroundDim }), span(text, { fg: activeThemeColors().foregroundDim }), span(" ".repeat(pad + 1))]), { width: innerWidth + 2 }),
		activeThemeColors().foreground,
		activeThemeColors().surfaceRecess,
	);
	return lineToAnsi(textLine([
		span("│", { fg: activeThemeColors().divider }),
		span(inner),
		span("│", { fg: activeThemeColors().divider }),
	]), { width });
}

// ── Public API ───────────────────────────────────────────────

export function renderCathedralCodeBlock(lang: string, source: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 10) return [takeVisible(source, safeWidth)];

	const lines = source.split("\n");
	const visible = lines.slice(0, MAX_VISIBLE_LINES);
	const collapsed = lines.length - visible.length;
	const normalizedLang = lang.toLowerCase().replace(/^language-/, "");

	const rows: string[] = [codeFrameTop(normalizedLang, safeWidth)];
	for (let i = 0; i < visible.length; i += 1) {
		const highlighted = highlightLine(visible[i]!, normalizedLang);
		rows.push(codeBodyRow(i + 1, highlighted, safeWidth));
	}
	if (collapsed > 0) {
		rows.push(collapsedRow(collapsed, safeWidth));
	}
	rows.push(codeFrameBottom(safeWidth));
	return rows;
}
