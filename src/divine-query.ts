/**
 * Cathedral Divine Query modal (Element 11 from CATHEDRAL_UX_SPEC_V2.md).
 *
 * Replaces Pi's default `ctx.ui.select` rendering with a Scriptorium-themed
 * overlay when SumoCode is active.
 *
 * Visual:
 *
 *   ╭──────────────────────────────────────────╮
 *   │            ✾  DIVINE QUERY  ✾            │
 *   │                                          │
 *   │     ──────────────  ·  ──────────────    │
 *   │                                          │
 *   │     Should I rename `getUser` to         │
 *   │     `fetchUser`?                         │
 *   │                                          │
 *   │     ❈   A) Yes, rename it everywhere     │
 *   │     ·   B) No, leave it as-is            │
 *   │     ·   C) Use a different name          │
 *   │                                          │
 *   │     ──────────────  ·  ──────────────    │
 *   │      ↑↓ wander    ⏎ answer    ⎋ retreat  │
 *   ╰──────────────────────────────────────────╯
 *
 * Bible source:
 *   docs/ui/bible/11-divine-query-rename.html
 *   docs/ui/bible/11-divine-query-yesno.html
 */

import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "[0m";
const ANSI_PATTERN = /\[[0-9;]*m/g;

function visibleLength(text: string): number {
	return visibleWidth(text.replace(ANSI_PATTERN, ""));
}

function fg(text: string, hex: string): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `[38;2;${r};${g};${b}m${text}${RESET}`;
}

function persistentBg(text: string, fgHex: string, bgHex: string): string {
	const fh = fgHex.replace("#", "");
	const bh = bgHex.replace("#", "");
	const fr = parseInt(fh.slice(0, 2), 16);
	const fgCode = parseInt(fh.slice(2, 4), 16);
	const fb = parseInt(fh.slice(4, 6), 16);
	const br = parseInt(bh.slice(0, 2), 16);
	const bg = parseInt(bh.slice(2, 4), 16);
	const bb = parseInt(bh.slice(4, 6), 16);
	const styleCode = `[38;2;${fr};${fgCode};${fb}m[48;2;${br};${bg};${bb}m`;
	// Restore both fg+bg after every reset so lifted bg persists through inner ANSI
	return `${styleCode}${text.replace(/\[0m/g, `${RESET}${styleCode}`)}${RESET}`;
}

function center(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const len = visibleLength(fitted);
	if (len >= width) return fitted;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${fitted}${" ".repeat(width - len - pad)}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleLength(line) > width ? truncateToWidth(line, width, "…") : line;
}

function padRight(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const len = visibleLength(fitted);
	if (len >= width) return fitted;
	return `${fitted}${" ".repeat(width - len)}`;
}

function wrapIndentedText(text: string, width: number, indent: string): string[] {
	const contentWidth = Math.max(1, width - visibleLength(indent));
	const rows: string[] = [];
	for (const paragraph of text.split("\n")) {
		const wrapped = wrapTextWithAnsi(paragraph, contentWidth);
		rows.push(...(wrapped.length > 0 ? wrapped : [""]).map((line) => `${indent}${line}`));
	}
	return rows;
}

// ── Snapshot ──────────────────────────────────────────────────

export interface DivineQuerySnapshot {
	readonly title: string;
	readonly options: readonly string[];
	readonly focusedIndex: number;
}

export interface DivineQueryRenderOptions {
	/**
	 * Extra inner rows to render between the footer and the bottom border —
	 * used by `question-tool.ts` for the edit-mode `Your answer:` editor when
	 * the user picks the free-text option.
	 *
	 * Each entry is rendered inside the frame as `│ <padded content> │` with
	 * surfaceLifted bg + foreground fg.
	 */
	readonly extras?: readonly string[];
}

// ── Pure render ──────────────────────────────────────────────

const TITLE_MARK = "✾";
const FOCUSED_MARK = "❈";
const UNFOCUSED_MARK = "·";

function splitRule(width: number): string {
	const ruleLen = Math.max(1, Math.min(22, Math.floor((width - 5) / 2)));
	const left = fg("─".repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	const dot = fg("·", CATHEDRAL_TOKENS.colors.divider);
	const right = fg("─".repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	return center(`${left}  ${dot}  ${right}`, width);
}

function optionLabel(index: number): string {
	return `${String.fromCharCode(65 + index)}) `;
}

/**
 * Build the inner content rows of a Divine Query modal at the given content
 * width (i.e. excluding the side borders). Returned rows are not yet padded
 * to width — `wrapInnerRow` handles padding + bg paint at the framing layer.
 */
function buildInnerRows(snapshot: DivineQuerySnapshot, contentWidth: number, extras: readonly string[]): string[] {
	const inner: string[] = [];
	const indent = "     ";

	// Blank
	inner.push("");

	// Title: ✾  DIVINE QUERY  ✾
	const titleText = `${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}  ${fg("DIVINE QUERY", CATHEDRAL_TOKENS.colors.accent)}  ${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}`;
	inner.push(center(titleText, contentWidth));

	// Blank
	inner.push("");

	// Split rule
	inner.push(splitRule(contentWidth));

	// Blank
	inner.push("");

	// Question body. Bible Element 11 keeps a generous right margin: text wraps
	// at `cols - 12`, then gets a 5-col left indent.
	for (const questionLine of wrapIndentedText(snapshot.title, Math.max(1, contentWidth - 7), indent)) {
		inner.push(fg(questionLine, CATHEDRAL_TOKENS.colors.foreground));
	}

	// Blank
	inner.push("");

	// Options
	for (let i = 0; i < snapshot.options.length; i += 1) {
		const focused = i === snapshot.focusedIndex;
		const mark = focused
			? fg(FOCUSED_MARK, CATHEDRAL_TOKENS.colors.accent)
			: fg(UNFOCUSED_MARK, CATHEDRAL_TOKENS.colors.divider);
		const optionIndent = `${indent}${mark}   `;
		const continuationIndent = `${indent}    `;
		const label = `${optionLabel(i)}${snapshot.options[i]}`;
		const wrappedOption = wrapIndentedText(label, contentWidth, continuationIndent);
		for (let optionRow = 0; optionRow < wrappedOption.length; optionRow += 1) {
			const raw = (wrappedOption[optionRow] ?? "").slice(continuationIndent.length);
			const prefix = optionRow === 0 ? optionIndent : continuationIndent;
			const text = focused
				? fg(raw, CATHEDRAL_TOKENS.colors.foreground)
				: fg(raw, CATHEDRAL_TOKENS.colors.foregroundDim);
			inner.push(`${prefix}${text}`);
		}
	}

	// Blank
	inner.push("");

	// Split rule
	inner.push(splitRule(contentWidth));

	// Footer
	const footer = fg("↑↓ wander    ⏎ answer    ⎋ retreat", CATHEDRAL_TOKENS.colors.foregroundDim);
	inner.push(center(footer, contentWidth));

	// Extras (e.g. edit-mode editor rows from question-tool)
	for (const extra of extras) inner.push(extra);

	// Blank
	inner.push("");

	return inner;
}

/** Paint a full-width lifted panel row. Element 11 is intentionally
 * unframed in the Bible; Pi's overlay host may already provide surrounding
 * chrome, so adding a second box here makes the modal read too heavy.
 */
function wrapPanelRow(innerLine: string, contentWidth: number): string {
	return persistentBg(
		padRight(innerLine, contentWidth),
		CATHEDRAL_TOKENS.colors.foreground,
		CATHEDRAL_TOKENS.colors.surfaceLifted,
	);
}

export function renderDivineQuery(
	snapshot: DivineQuerySnapshot,
	width: number,
	options: DivineQueryRenderOptions = {},
): string[] {
	if (width < 1) return [];
	const contentWidth = width;
	const inner = buildInnerRows(snapshot, contentWidth, options.extras ?? []);
	return inner.map((innerLine) => wrapPanelRow(innerLine, contentWidth));
}

// ── State machine ────────────────────────────────────────────

export interface DivineQueryInputResult {
	readonly snapshot: DivineQuerySnapshot;
	readonly done?: number; // selected index, or -1 for escape
}

export function updateDivineQuery(snapshot: DivineQuerySnapshot, data: string): DivineQueryInputResult {
	const count = snapshot.options.length;
	if (count === 0) return { snapshot };

	// Direct letter selection: a/b/c/...
	const lower = data.toLowerCase();
	const letterIndex = lower.charCodeAt(0) - 97;
	if (lower.length === 1 && letterIndex >= 0 && letterIndex < count) {
		return { snapshot: { ...snapshot, focusedIndex: letterIndex }, done: letterIndex };
	}

	// Arrow / tab navigation
	if (data === "down" || matchesKey(data, "down") || data === "tab" || matchesKey(data, "tab") || data === "j") {
		return { snapshot: { ...snapshot, focusedIndex: (snapshot.focusedIndex + 1) % count } };
	}
	if (data === "up" || matchesKey(data, "up") || data === "shift+tab" || matchesKey(data, "shift+tab") || data === "k") {
		return { snapshot: { ...snapshot, focusedIndex: (snapshot.focusedIndex - 1 + count) % count } };
	}

	// Enter selects focused
	if (data === "enter" || matchesKey(data, "enter") || data === "return" || matchesKey(data, "return")) {
		return { snapshot, done: snapshot.focusedIndex };
	}

	// Escape retreats
	if (data === "escape" || matchesKey(data, "escape")) {
		return { snapshot, done: -1 };
	}

	return { snapshot };
}

// ── Pi component + overlay ───────────────────────────────────

class DivineQueryComponent implements Component {
	constructor(
		private snapshot: DivineQuerySnapshot,
		private readonly done: (result: number) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const result = updateDivineQuery(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done !== undefined) this.done(result.done);
	}

	render(width: number): string[] {
		return renderDivineQuery(this.snapshot, width);
	}
}

export const DIVINE_QUERY_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: 80,
	minWidth: 56,
	maxHeight: "65%",
};

/**
 * Show a Divine Query modal. Returns the selected option string, or
 * undefined if the user escapes.
 */
export async function showDivineQuery(
	ctx: ExtensionContext,
	title: string,
	options: readonly string[],
): Promise<string | undefined> {
	const initialSnapshot: DivineQuerySnapshot = {
		title,
		options,
		focusedIndex: 0,
	};

	const selectedIndex = await ctx.ui.custom<number>(
		(_tui, _theme, _kb, done: (result: number) => void) =>
			new DivineQueryComponent(initialSnapshot, done),
		{ overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS },
	);

	if (selectedIndex < 0 || selectedIndex >= options.length) return undefined;
	return options[selectedIndex];
}
