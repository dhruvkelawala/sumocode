/**
 * Cathedral Divine Query modal (Element 11 from CATHEDRAL_UX_SPEC_V2.md).
 *
 * Replaces Pi's default `ctx.ui.select` rendering with a Scriptorium-themed
 * overlay when SumoCode is active.
 *
 * Visual:
 *
 *                            ✾  DIVINE QUERY  ✾
 *
 *            ──────────────────────  ·  ──────────────────────
 *
 *     Should I rename `getUser` to `fetchUser`?
 *
 *     ❈   A) Yes, rename it everywhere
 *     ·   B) No, leave it as-is
 *     ·   C) Use a different name
 *
 *            ──────────────────────  ·  ──────────────────────
 *                    ↑↓ wander    ⏎ answer    ⎋ retreat
 *
 * Bible source:
 *   docs/ui/bible/11-divine-query-rename.html
 *   docs/ui/bible/11-divine-query-yesno.html
 */

import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function fg(text: string, hex: string): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m${text}${RESET}`;
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
	const styleCode = `\u001b[38;2;${fr};${fgCode};${fb}m\u001b[48;2;${br};${bg};${bb}m`;
	// Restore both fg+bg after every reset so lifted bg persists through inner ANSI
	return `${styleCode}${text.replace(/\u001b\[0m/g, `${RESET}${styleCode}`)}${RESET}`;
}

function center(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${line}${" ".repeat(width - len - pad)}`;
}

function padRight(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

// ── Snapshot ──────────────────────────────────────────────────

export interface DivineQuerySnapshot {
	readonly title: string;
	readonly options: readonly string[];
	readonly focusedIndex: number;
}

// ── Pure render ──────────────────────────────────────────────

const TITLE_MARK = "✾";
const FOCUSED_MARK = "❈";
const UNFOCUSED_MARK = "·";

function splitRule(width: number): string {
	const ruleLen = Math.max(1, Math.floor((width - 6) / 2 - 15));
	const left = fg("─".repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	const dot = fg("·", CATHEDRAL_TOKENS.colors.divider);
	const right = fg("─".repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	return center(`${left}  ${dot}  ${right}`, width);
}

function optionLabel(index: number): string {
	return `${String.fromCharCode(65 + index)}) `;
}

export function renderDivineQuery(snapshot: DivineQuerySnapshot, width: number): string[] {
	const lines: string[] = [];
	const indent = "     ";

	// Blank
	lines.push("");

	// Title: ✾  DIVINE QUERY  ✾
	const titleText = `${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}  ${fg("DIVINE QUERY", CATHEDRAL_TOKENS.colors.accent)}  ${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}`;
	lines.push(center(titleText, width));

	// Blank
	lines.push("");

	// Split rule
	lines.push(splitRule(width));

	// Blank
	lines.push("");

	// Question body
	lines.push(padRight(`${indent}${fg(snapshot.title, CATHEDRAL_TOKENS.colors.foreground)}`, width));

	// Blank
	lines.push("");

	// Options
	for (let i = 0; i < snapshot.options.length; i += 1) {
		const focused = i === snapshot.focusedIndex;
		const mark = focused
			? fg(FOCUSED_MARK, CATHEDRAL_TOKENS.colors.accent)
			: fg(UNFOCUSED_MARK, CATHEDRAL_TOKENS.colors.divider);
		const label = `${optionLabel(i)}${snapshot.options[i]}`;
		const text = focused
			? fg(label, CATHEDRAL_TOKENS.colors.foreground)
			: fg(label, CATHEDRAL_TOKENS.colors.foregroundDim);
		lines.push(padRight(`${indent}${mark}   ${text}`, width));
	}

	// Blank
	lines.push("");

	// Split rule
	lines.push(splitRule(width));

	// Footer
	const footer = fg("↑↓ wander    ⏎ answer    ⎋ retreat", CATHEDRAL_TOKENS.colors.foregroundDim);
	lines.push(center(footer, width));

	// Blank
	lines.push("");

	// Wrap all lines with persistent surfaceLifted bg + foreground fg
	return lines.map((line) => persistentBg(
		padRight(line, width),
		CATHEDRAL_TOKENS.colors.foreground,
		CATHEDRAL_TOKENS.colors.surfaceLifted,
	));
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
	width: "60%",
	minWidth: 50,

	maxHeight: "80%",
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


