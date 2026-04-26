/**
 * Cathedral input frame (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Renders a carved 3-row frame around the input area, plus a single-line
 * hint row for the keybind reminder.
 *
 * Active state (Element 4):
 *   ┌──────────────────────────────────────────────┐
 *   │ > █                                          │
 *   └──────────────────────────────────────────────┘
 *                                                    TAB · AGENTS  CTRL+P · COMMANDS
 *
 * Splash state (Element 3):
 *   ┌─ DIVINE INVOCATION ───────────────────────────────────────┐
 *   │ > Ask anything... "Refactor the auth flow."  █            │
 *   └───────────────────────────────────────────────────────────┘
 *
 *   └─ AWAITING DIVINE INVOCATION              TAB · AGENTS  CTRL+P · COMMANDS
 *
 * Pure render only. Pi-glue (mounting via setEditorComponent) lives in
 * `src/cathedral/cathedral-editor.ts`.
 */

import { CATHEDRAL_TOKENS } from "../tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DIM = "\u001b[2m";

export const INPUT_FRAME_HINT_KEYBINDS = "TAB · AGENTS  CTRL+P · COMMANDS";
export const INPUT_FRAME_HINT_AWAITING = "└─ AWAITING DIVINE INVOCATION";

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function fg(hex: string): string {
	const n = hex.replace("#", "");
	const r = Number.parseInt(n.slice(0, 2), 16);
	const g = Number.parseInt(n.slice(2, 4), 16);
	const b = Number.parseInt(n.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function color(text: string, hex: string): string {
	return `${fg(hex)}${text}${RESET}`;
}

function padToWidth(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

export type InputFrameOptions = {
	/** Top-border label, e.g. "DIVINE INVOCATION" (splash). Active state omits. */
	label?: string;
	/** Placeholder text shown when input is empty. Splash state only. */
	placeholder?: string;
};

/**
 * Pure render of the carved 3-row input frame.
 *
 * Returns 3 lines, each padded exactly to `width` cells. If `width < 4`,
 * returns a single-line minimal cursor (degraded mode).
 */
export function renderInputFrame(input: string, width: number, options: InputFrameOptions = {}): string[] {
	if (width < 4) {
		return [padToWidth(color("█", CATHEDRAL_TOKENS.colors.accent), width)];
	}

	const inner = width - 2;
	const dividerCh = (ch: string): string => color(ch, CATHEDRAL_TOKENS.colors.divider);

	// Top border with optional label
	let top: string;
	if (options.label) {
		const labelInner = ` ${options.label} `;
		const remaining = Math.max(2, inner - labelInner.length - 2); // 2 = leading "─" before label
		const leftDashes = "─".repeat(2);
		const rightDashes = "─".repeat(remaining);
		top = `${dividerCh("┌")}${dividerCh(leftDashes)}${color(labelInner, CATHEDRAL_TOKENS.colors.accent)}${dividerCh(rightDashes)}${dividerCh("┐")}`;
	} else {
		top = `${dividerCh("┌")}${dividerCh("─".repeat(inner))}${dividerCh("┐")}`;
	}

	// Content row: `> <text>█` or `> <placeholder>█` with placeholder dim
	const showPlaceholder = input.length === 0 && options.placeholder !== undefined;
	const promptArrow = color(">", CATHEDRAL_TOKENS.colors.accent);
	const cursor = color("█", CATHEDRAL_TOKENS.colors.accent);
	let textPart: string;
	if (showPlaceholder) {
		textPart = `${DIM}${color(options.placeholder!, CATHEDRAL_TOKENS.colors.foregroundDim)}${RESET}`;
	} else {
		textPart = color(input, CATHEDRAL_TOKENS.colors.foreground);
	}
	const innerContent = ` ${promptArrow} ${textPart}${cursor}`;
	const innerVisible = visibleLength(innerContent);
	const padding = Math.max(0, inner - innerVisible);
	const contentInner = `${innerContent}${" ".repeat(padding)}`;
	const content = `${dividerCh("│")}${contentInner}${dividerCh("│")}`;

	// Bottom border
	const bottom = `${dividerCh("└")}${dividerCh("─".repeat(inner))}${dividerCh("┘")}`;

	return [padToWidth(top, width), padToWidth(content, width), padToWidth(bottom, width)];
}

export type InputHintsOptions = {
	/**
	 * Left-side dim hint, e.g. `└─ AWAITING DIVINE INVOCATION` (splash only).
	 * Element 4 (active state) omits this and shows only the right-side keybinds.
	 */
	leftHint?: string;
};

/**
 * Pure render of the single-line hint row below the input frame.
 *
 * Right-side keybind hint always appears (right-aligned). Optional
 * left-side flavour hint (used on splash). Both rendered in dim
 * foreground-dim color.
 */
export function renderInputHints(width: number, options: InputHintsOptions = {}): string {
	if (width <= 0) return "";

	const right = INPUT_FRAME_HINT_KEYBINDS;
	const rightLen = right.length;
	const left = options.leftHint;

	// At narrow widths, drop the left hint first.
	const leftFitsAlongside = left !== undefined && rightLen + 4 + left.length <= width;

	const dimFg = `${DIM}${fg(CATHEDRAL_TOKENS.colors.foregroundDim)}`;

	if (leftFitsAlongside) {
		const gap = width - rightLen - left!.length;
		const composed = `${dimFg}${left!}${RESET}${" ".repeat(gap)}${dimFg}${right}${RESET}`;
		// Sanity: must not exceed width
		const visible = visibleLength(composed);
		if (visible > width) {
			return padToWidth(`${dimFg}${right}${RESET}`, width);
		}
		return composed;
	}

	// Right-only path. Right-align if there's room.
	if (rightLen > width) {
		// Truncate and return what fits
		const truncated = right.slice(0, width);
		return `${dimFg}${truncated}${RESET}`;
	}
	const padding = " ".repeat(width - rightLen);
	return `${padding}${dimFg}${right}${RESET}`;
}
