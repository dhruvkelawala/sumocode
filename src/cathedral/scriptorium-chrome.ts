/**
 * Shared chrome helpers for Cathedral / Scriptorium overlay modals.
 *
 * Both `divine-query.ts` and `approval-modal.ts` open the same way: a centered
 * lifted-bg panel painted by `wrapPanelRow`, a floral title `\u2728  TITLE  \u2728`,
 * a `splitRule` divider, focused / unfocused marker glyphs, and a centered
 * footer hint. This module is the single source of truth for those primitives
 * so any new Cathedral modal (Memory Scriptorium etc.) reuses the same look
 * without each module re-implementing background painting.
 *
 * The painting is intentionally simple:
 *
 *   - `fg(text, hex)`            \u2192 truecolor foreground
 *   - `persistentBg(text, fg, bg)` \u2192 paints `bg` through every cell so a
 *                                  nested ANSI reset within `text` doesn't
 *                                  drop back to the underlying scene
 *   - `wrapPanelRow(line, width)`  \u2192 pad-right + persistentBg with the active
 *                                  theme's `foreground` + `surfaceLifted`
 *
 * Pi's overlay host already provides the surrounding chrome, so panels are
 * intentionally unframed at the outer edge \u2014 the lifted bg + Pi's overlay
 * box is the visual frame.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { activeThemeColors } from "../themes/index.js";

export const RESET = "\u001b[0m";
export const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const TITLE_FLOWER = "\u273E";
export const FOCUSED_MARK = "\u2748";
export const UNFOCUSED_MARK = "\u00b7";

export function visibleLength(text: string): number {
	return visibleWidth(text.replace(ANSI_PATTERN, ""));
}

/**
 * Build a 24-bit truecolor SGR opener for `mode === 38` (foreground) or
 * `mode === 48` (background). Exported so modal-specific composites (e.g. the
 * approval modal's inverse-label buttons) can stack fg+bg directly without
 * piping every cell through `persistentBg`.
 */
export function sgr(hex: string, mode: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${mode};2;${red};${green};${blue}m`;
}

export function fg(text: string, hex: string): string {
	return `${sgr(hex, 38)}${text}${RESET}`;
}

/**
 * Re-apply `fg`+`bg` after every embedded reset so the lifted background
 * keeps painting through nested ANSI sequences instead of snapping to the
 * underlying scene's background between styled spans.
 */
export function persistentBg(text: string, fgHex: string, bgHex: string): string {
	const style = `${sgr(fgHex, 38)}${sgr(bgHex, 48)}`;
	return `${style}${text.replace(/\u001b\[0m/g, `${RESET}${style}`)}${RESET}`;
}

export function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleLength(line) > width ? truncateToWidth(line, width, "\u2026") : line;
}

export function padRight(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const length = visibleLength(fitted);
	if (length >= width) return fitted;
	return `${fitted}${" ".repeat(width - length)}`;
}

export function center(line: string, width: number): string {
	const fitted = fitLine(line, width);
	const length = visibleLength(fitted);
	if (length >= width) return fitted;
	const left = Math.floor((width - length) / 2);
	return `${" ".repeat(left)}${fitted}${" ".repeat(width - length - left)}`;
}

/** Bible-style split rule: two box-drawing runs separated by a centered `\u00b7`. */
export function splitRule(width: number): string {
	const ruleLen = Math.max(1, Math.min(30, Math.floor((width - 5) / 2)));
	const div = activeThemeColors().divider;
	const piece = `${fg("\u2500".repeat(ruleLen), div)}  ${fg("\u00b7", div)}  ${fg("\u2500".repeat(ruleLen), div)}`;
	return center(piece, width);
}

/** A `\u2728  TITLE  \u2728` row centered in the panel. */
export function titleRow(text: string, width: number): string {
	const accent = activeThemeColors().accent;
	return center(`${fg(TITLE_FLOWER, accent)}  ${fg(text, accent)}  ${fg(TITLE_FLOWER, accent)}`, width);
}

/** Focused or unfocused list-marker glyph. */
export function focusMarker(focused: boolean): string {
	const colors = activeThemeColors();
	return focused ? fg(FOCUSED_MARK, colors.accent) : fg(UNFOCUSED_MARK, colors.divider);
}

/**
 * Pad `inner` to `width` and paint the active theme's `foreground` over
 * `surfaceLifted` background through every cell.
 */
export function wrapPanelRow(inner: string, width: number): string {
	return persistentBg(
		padRight(inner, width),
		activeThemeColors().foreground,
		activeThemeColors().surfaceLifted,
	);
}
