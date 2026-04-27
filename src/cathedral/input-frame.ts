/**
 * Cathedral input frame (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Ported directly from the Stitch HTML mockup
 * (`docs/ui/stitch/cathedral/v1-html/splash.html`):
 *
 *   div.bg-recess.border-divider.p-4 + absolute -top-3 left-2 floating label
 *
 * Active state (Element 4) — label `INPUT`:
 *   ┌─ INPUT ──────────────────────────────────────┐
 *   │ > █                                          │
 *   └──────────────────────────────────────────────┘
 *                                       TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Splash state (Element 3) — label `SCRIPTOR INPUT`:
 *   ┌─ SCRIPTOR INPUT ──────────────────────────────────────────┐
 *   │ > Ask anything... "Refactor the auth flow."  █            │
 *   └───────────────────────────────────────────────────────────┘
 *   ┌─ INPUT PROTOCOL AWAITING COMMAND          TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Token map (from Stitch CSS variables):
 *   border       → divider  (#3A2F25)  — dim, not accent
 *   inner bg     → recess   (#120D0A)  — painted on every row
 *   `>` prompt   → oxidized (#8B7A63)  — splash | accent (#D97706) — active
 *   cursor `█`   → accent   (#D97706)
 *   placeholder  → oxidized (#8B7A63) + DIM
 *   label        → oxidized → accent on focus (we always render accent)
 *
 * Pure render only. Pi-glue (mounting via setEditorComponent) lives in
 * `src/cathedral/cathedral-editor.ts`.
 */

import { CATHEDRAL_TOKENS } from "../tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DIM = "\u001b[2m";

export const INPUT_FRAME_LABEL_SPLASH = "SCRIPTOR INPUT";
export const INPUT_FRAME_LABEL_ACTIVE = "INPUT";
export const INPUT_FRAME_PLACEHOLDER = 'Ask anything... "Refactor the auth flow."';
export const INPUT_FRAME_HINT_KEYBINDS = "TAB · AGENTS  CTRL+/ · COMMANDS";
export const INPUT_FRAME_HINT_AWAITING = "┌─ INPUT PROTOCOL AWAITING COMMAND";

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

function bg(hex: string): string {
	const n = hex.replace("#", "");
	const r = Number.parseInt(n.slice(0, 2), 16);
	const g = Number.parseInt(n.slice(2, 4), 16);
	const b = Number.parseInt(n.slice(4, 6), 16);
	return `\u001b[48;2;${r};${g};${b}m`;
}

function color(text: string, hex: string): string {
	return `${fg(hex)}${text}${RESET}`;
}

function onRecess(text: string): string {
	// Paint a span with the recess background; reset only the bg at the end
	// so any inner foreground colors stay intact within the span.
	return `${bg(CATHEDRAL_TOKENS.colors.surfaceRecess)}${text}\u001b[49m`;
}

function padToWidth(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

export type InputFrameOptions = {
	/** Top-border label, e.g. "SCRIPTOR INPUT" (splash) or "INPUT" (active). */
	label?: string;
	/** Placeholder text shown when input is empty. Splash state only. */
	placeholder?: string;
	/**
	 * Color for the `>` prompt arrow. Stitch mockup uses oxidized (dim) on
	 * splash to keep focus on the cursor, accent on active to mark the
	 * working prompt. Defaults to oxidized.
	 */
	promptColor?: "oxidized" | "accent";
};

/**
 * Pure render of the carved 5-row input frame.
 *
 * Returns 5 lines (top + padding + content + padding + bottom), each padded
 * exactly to `width` cells. The two padding rows mirror the Stitch HTML's
 * `p-4` vertical padding around the content.
 *
 * If `width < 4`, returns a single-line minimal cursor (degraded mode).
 */
export function renderInputFrame(input: string, width: number, options: InputFrameOptions = {}): string[] {
	if (width < 4) {
		return [padToWidth(color("█", CATHEDRAL_TOKENS.colors.accent), width)];
	}

	const inner = width - 2;
	const dividerCh = (ch: string): string => color(ch, CATHEDRAL_TOKENS.colors.divider);

	// Top border with optional label. Label punches through the border with
	// accent foreground over recess background so it reads as a notch.
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

	// Content row: `> <text>█` or `> <placeholder>█`. Inner span gets the
	// recess (#120D0A) background to read as a recessed well per Stitch CSS
	// `bg-recess` on the input container. Cursor is accent █.
	const showPlaceholder = input.length === 0 && options.placeholder !== undefined;
	const promptHex =
		options.promptColor === "accent"
			? CATHEDRAL_TOKENS.colors.accent
			: CATHEDRAL_TOKENS.colors.foregroundDim;
	const promptArrow = color(">", promptHex);
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
	const content = `${dividerCh("│")}${onRecess(contentInner)}${dividerCh("│")}`;

	// Top + bottom padding rows (recess background only, no content) to mirror
	// the Stitch `p-4` vertical breathing room.
	const padInner = onRecess(" ".repeat(inner));
	const padRow = `${dividerCh("│")}${padInner}${dividerCh("│")}`;

	// Bottom border
	const bottom = `${dividerCh("└")}${dividerCh("─".repeat(inner))}${dividerCh("┘")}`;

	return [
		padToWidth(top, width),
		padToWidth(padRow, width),
		padToWidth(content, width),
		padToWidth(padRow, width),
		padToWidth(bottom, width),
	];
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
 * Right-side keybind hint always appears (right-aligned). The modifier keys
 * `TAB` and `CTRL+/` are tinted accent (per Stitch HTML), the labels stay
 * dim oxidized.
 *
 * Optional left-side flavour hint (used on splash) renders dim oxidized.
 */
export function renderInputHints(width: number, options: InputHintsOptions = {}): string {
	if (width <= 0) return "";

	const rightPlain = INPUT_FRAME_HINT_KEYBINDS;
	const rightLen = rightPlain.length;
	const left = options.leftHint;

	const dimFg = `${DIM}${fg(CATHEDRAL_TOKENS.colors.foregroundDim)}`;
	const accent = fg(CATHEDRAL_TOKENS.colors.accent);

	// Build the colored right-hand string: TAB and CTRL+/ in accent, labels in dim.
	const rightColored = `${accent}TAB${RESET} ${dimFg}· AGENTS  ${RESET}${accent}CTRL+/${RESET} ${dimFg}· COMMANDS${RESET}`;

	// At narrow widths, drop the left hint first.
	const leftFitsAlongside = left !== undefined && rightLen + 4 + left.length <= width;

	if (leftFitsAlongside) {
		const gap = width - rightLen - left!.length;
		return `${dimFg}${left!}${RESET}${" ".repeat(gap)}${rightColored}`;
	}

	// Right-only path. Right-align if there's room.
	if (rightLen > width) {
		const truncated = rightPlain.slice(0, width);
		return `${dimFg}${truncated}${RESET}`;
	}
	const padding = " ".repeat(width - rightLen);
	return `${padding}${rightColored}`;
}
