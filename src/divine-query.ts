/**
 * Cathedral Divine Query modal (Element 11 from CATHEDRAL_UX_SPEC_V2.md).
 *
 * Replaces Pi's default `ctx.ui.select` rendering with a Scriptorium-themed
 * overlay when SumoCode is active. Painting helpers (lifted bg, floral title,
 * focus marker, split rule) come from `./cathedral/scriptorium-chrome.js` so
 * Memory Scriptorium and Approval Modal share the exact same look without
 * duplicate copies of `persistentBg` etc.
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
 *
 * See `docs/cathedral/SCRIPTORIUM_CHROME.md` for the shared modal contract.
 */

import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeThemeColors } from "./themes/index.js";
import {
	center,
	fg,
	focusMarker,
	splitRule,
	titleRow,
	visibleLength,
	wrapPanelRow,
} from "./cathedral/scriptorium-chrome.js";

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

function optionLabel(index: number): string {
	return `${String.fromCharCode(65 + index)}) `;
}

/**
 * Build the inner content rows of a Divine Query modal at the given content
 * width (i.e. excluding the side borders). Returned rows are not yet padded
 * to width — `wrapPanelRow` handles padding + bg paint at the framing layer.
 */
function buildInnerRows(snapshot: DivineQuerySnapshot, contentWidth: number, extras: readonly string[]): string[] {
	const inner: string[] = [];
	const indent = "     ";
	const colors = activeThemeColors();

	// Blank
	inner.push("");

	// Title: ✾  DIVINE QUERY  ✾
	inner.push(titleRow("DIVINE QUERY", contentWidth));

	// Blank
	inner.push("");

	// Split rule
	inner.push(splitRule(contentWidth));

	// Blank
	inner.push("");

	// Question body. Bible Element 11 keeps a generous right margin: text wraps
	// at `cols - 12`, then gets a 5-col left indent.
	for (const questionLine of wrapIndentedText(snapshot.title, Math.max(1, contentWidth - 7), indent)) {
		inner.push(fg(questionLine, colors.foreground));
	}

	// Blank
	inner.push("");

	// Options
	for (let i = 0; i < snapshot.options.length; i += 1) {
		const focused = i === snapshot.focusedIndex;
		const mark = focusMarker(focused);
		const optionIndent = `${indent}${mark}   `;
		const continuationIndent = `${indent}    `;
		const label = `${optionLabel(i)}${snapshot.options[i]}`;
		const wrappedOption = wrapIndentedText(label, contentWidth, continuationIndent);
		for (let optionRow = 0; optionRow < wrappedOption.length; optionRow += 1) {
			const raw = (wrappedOption[optionRow] ?? "").slice(continuationIndent.length);
			const prefix = optionRow === 0 ? optionIndent : continuationIndent;
			const text = focused
				? fg(raw, colors.foreground)
				: fg(raw, colors.foregroundDim);
			inner.push(`${prefix}${text}`);
		}
	}

	// Blank
	inner.push("");

	// Split rule
	inner.push(splitRule(contentWidth));

	// Footer
	inner.push(center(fg("↑↓ wander    ⏎ answer    ⎋ retreat", colors.foregroundDim), contentWidth));

	// Extras (e.g. edit-mode editor rows from question-tool)
	for (const extra of extras) inner.push(extra);

	// Blank
	inner.push("");

	return inner;
}

export function renderDivineQuery(
	snapshot: DivineQuerySnapshot,
	width: number,
	options: DivineQueryRenderOptions = {},
): string[] {
	if (width < 1) return [];
	const inner = buildInnerRows(snapshot, width, options.extras ?? []);
	return inner.map((innerLine) => wrapPanelRow(innerLine, width));
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
