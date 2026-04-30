/**
 * Cathedral input frame (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Ported directly from the Stitch HTML mockup
 * (`docs/ui/stitch/cathedral/v1-html/splash.html`):
 *
 *   div.bg-recess.border-divider.p-4 + absolute -top-3 left-2 floating label
 *
 * Active state (Element 4) — no label:
 *   ┌──────────────────────────────────────────────┐
 *   │ > █                                          │
 *   └──────────────────────────────────────────────┘
 *                                       CTRL+/ · COMMANDS
 *
 * Splash state (Element 3) — label `DIVINE INVOCATION`:
 *   ┌─ DIVINE INVOCATION ───────────────────────────────────────┐
 *   │ > Ask anything... "Refactor the auth flow."  █            │
 *   └───────────────────────────────────────────────────────────┘
 *   ╰─ AWAITING PROMPT                         CTRL+/ · COMMANDS
 *
 * Token map (from Stitch CSS variables):
 *   border       → divider  (#3A2F25)  — dim, not accent
 *   inner bg     → recess   (#120D0A)  — painted on every row
 *   `>` prompt   → oxidized (#8B7A63)  — splash | accent (#D97706) — active
 *   cursor `█`   → accent   (#D97706)
 *   placeholder  → oxidized (#8B7A63)
 *   label        → oxidized → accent on focus (we always render accent)
 *
 * Pure render only. Pi-glue (mounting via setEditorComponent) lives in
 * `src/cathedral/cathedral-editor.ts`.
 */

import { CATHEDRAL_TOKENS } from "../tokens.js";

const RESET = "\u001b[0m";
const RESET_BG = "\u001b[49m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const INPUT_FRAME_LABEL_SPLASH = "DIVINE INVOCATION";
export const INPUT_FRAME_LABEL_ACTIVE = "";
export const INPUT_FRAME_PLACEHOLDER = 'Ask anything... "Refactor the auth flow."';
export const INPUT_FRAME_HINT_KEYBINDS = "CTRL+/ · COMMANDS";
export const INPUT_FRAME_HINT_AWAITING = "╰─ AWAITING PROMPT";

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

function withBackground(line: string, hex: string): string {
	const bgCode = bg(hex);
	// Inner color() calls use RESET, which clears background too. Re-apply the
	// row background after each RESET so the whole terminal row stays recessed.
	return `${bgCode}${line.replaceAll(RESET, `${RESET}${bgCode}`)}${RESET_BG}`;
}

function padToWidth(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

function ellipsize(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max === 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

export type InputFrameOptions = {
	/** Optional top-border label. V2 active input passes an empty label; splash uses "DIVINE INVOCATION". */
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
 * Pure render of the carved 3-row input frame.
 *
 * Returns 3 lines (top + content + bottom), each padded exactly to `width`
 * cells. The active V2 contract keeps the frame compact so chat retains
 * vertical space.
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

	// Content row: `> <text>█` or `> <placeholder>█`. The full row gets the
	// recess (#120D0A) background to match the Bible `bg-recess` frame block.
	// Cursor is accent █.
	const showPlaceholder = input.length === 0 && options.placeholder !== undefined;
	const promptHex =
		options.promptColor === "accent"
			? CATHEDRAL_TOKENS.colors.accent
			: CATHEDRAL_TOKENS.colors.foregroundDim;
	const promptArrow = color(">", promptHex);
	const cursor = color("█", CATHEDRAL_TOKENS.colors.accent);
	let textPart: string;
	if (showPlaceholder) {
		textPart = color(options.placeholder!, CATHEDRAL_TOKENS.colors.foregroundDim);
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
	const frameBg = CATHEDRAL_TOKENS.colors.surfaceRecess;

	return [
		withBackground(padToWidth(top, width), frameBg),
		withBackground(padToWidth(content, width), frameBg),
		withBackground(padToWidth(bottom, width), frameBg),
	];
}

export type InputHintsOptions = {
	/**
	 * Left-side hint. Splash uses `╰─ AWAITING PROMPT`; portrait active state
	 * uses project/branch context when the sidebar is hidden.
	 */
	leftHint?: string;
	/** When set, truncate the left hint instead of dropping it at narrow widths. */
	leftHintOverflow?: "drop" | "truncate";
	/** Project context renders project in foreground and branch in dim. */
	leftHintStyle?: "dim" | "project-branch";
};

/**
 * Pure render of the single-line hint row below the input frame.
 *
 * Right-side command hint always appears (right-aligned). The functional
 * modifier key `CTRL+/` is tinted accent; inactive future affordances such as
 * `TAB · AGENTS` are intentionally omitted until implemented.
 *
 * Optional left-side flavour hint (used on splash) renders dim oxidized.
 */
export function renderInputHints(width: number, options: InputHintsOptions = {}): string {
	if (width <= 0) return "";

	const rightPlain = INPUT_FRAME_HINT_KEYBINDS;
	const rightLen = rightPlain.length;
	const left = options.leftHint;

	const dimFg = fg(CATHEDRAL_TOKENS.colors.foregroundDim);
	const accent = fg(CATHEDRAL_TOKENS.colors.accent);

	// Build the colored right-hand string: CTRL+/ in accent, label in dim.
	const rightColored = `${accent}CTRL+/${RESET} ${dimFg}· COMMANDS${RESET}`;
	const colorLeftHint = (text: string): string => {
		if (options.leftHintStyle !== "project-branch") return `${dimFg}${text}${RESET}`;
		const branchStart = text.indexOf(" (");
		if (branchStart === -1) return color(text, CATHEDRAL_TOKENS.colors.foreground);
		const project = text.slice(0, branchStart);
		const branch = text.slice(branchStart);
		return `${color(project, CATHEDRAL_TOKENS.colors.foreground)}${dimFg}${branch}${RESET}`;
	};

	// At narrow widths, drop the left hint first unless the caller explicitly
	// asks for truncation (portrait active context path).
	const minGap = 4;
	const leftFitsAlongside = left !== undefined && rightLen + minGap + left.length <= width;

	if (leftFitsAlongside) {
		const gap = width - rightLen - left!.length;
		return `${colorLeftHint(left!)}${" ".repeat(gap)}${rightColored}`;
	}

	if (left !== undefined && options.leftHintOverflow === "truncate" && width > rightLen + minGap) {
		const maxLeft = width - rightLen - minGap;
		const truncatedLeft = ellipsize(left, maxLeft);
		if (truncatedLeft.length > 0) {
			const gap = width - rightLen - truncatedLeft.length;
			return `${colorLeftHint(truncatedLeft)}${" ".repeat(gap)}${rightColored}`;
		}
	}

	// Right-only path. Right-align if there's room.
	if (rightLen > width) {
		const truncated = rightPlain.slice(0, width);
		return `${dimFg}${truncated}${RESET}`;
	}
	const padding = " ".repeat(width - rightLen);
	return `${padding}${rightColored}`;
}
