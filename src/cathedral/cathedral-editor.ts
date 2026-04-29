/**
 * Cathedral editor (Element 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Wraps Pi's `CustomEditor` with cathedral chrome **without replacing it**.
 * Pi's editor stays in charge of:
 *   - text layout + cursor positioning (CURSOR_MARKER preserved)
 *   - autocomplete dropdown (slash commands, agents, file mentions)
 *   - multi-line wrap + scroll indicators
 *   - bracketed paste, IME, kill-ring, history
 *
 * We just decorate around it: replace Pi's flat top/bottom horizontal lines
 * with our `┌─ LABEL ──┐` splash or unlabeled active `┌──┐` / `└─┘` corners, wrap each interior row in side
 * pipes, paint the inner span with the recess background, and let any
 * autocomplete rows tail through unwrapped (they sit under the bottom
 * border like a dropdown).
 *
 * Splash state (no messages):
 *   ┌─ DIVINE INVOCATION ──────────────────────────────────┐
 *   │ > Ask anything... "Refactor the auth flow."  █       │
 *   └──────────────────────────────────────────────────────┘
 *
 * Active state (after first message):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ > /ag<cursor>                                        │
 *   └──────────────────────────────────────────────────────┘
 *      ▸ /agent  switch agent
 *      ▸ /agents list available agents
 *
 * Earlier versions of this file *replaced* `super.render` entirely on
 * splash. That broke slash-command autocomplete (typing `/res` showed no
 * suggestions) because Pi's autocomplete machinery is part of `super.render`.
 * The wrap approach below keeps autocomplete alive.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../tokens.js";
import {
	INPUT_FRAME_LABEL_ACTIVE,
	INPUT_FRAME_LABEL_SPLASH,
	INPUT_FRAME_PLACEHOLDER,
} from "./input-frame.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function visibleLength(text: string): number {
	return visibleWidth(text);
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

const DIVIDER_FG = fg(CATHEDRAL_TOKENS.colors.divider);
const RECESS_BG = bg(CATHEDRAL_TOKENS.colors.surfaceRecess);
const RESET_BG = "\u001b[49m";

function withFrameBackground(line: string): string {
	// Any nested RESET clears the background. Re-apply the frame background so
	// the whole input frame row remains the recessed #120D0A Bible well.
	return `${RECESS_BG}${line.replaceAll(RESET, `${RESET}${RECESS_BG}`)}${RESET_BG}`;
}

/**
 * Build the cathedral top border with an embedded label, e.g.:
 *   ┌─ SCRIPTOR INPUT ────...─────┐
 */
function renderTopBorder(width: number, label?: string): string {
	if (width < 6) return withFrameBackground(color("─".repeat(width), CATHEDRAL_TOKENS.colors.divider));
	const inner = width - 2;
	if (!label) return withFrameBackground(color(`┌${"─".repeat(inner)}┐`, CATHEDRAL_TOKENS.colors.divider));
	const labelInner = ` ${label} `;
	const remaining = Math.max(2, inner - labelInner.length - 2);
	const left = `${DIVIDER_FG}┌──`;
	const labelText = color(labelInner, CATHEDRAL_TOKENS.colors.accent);
	const right = `${DIVIDER_FG}${"─".repeat(remaining)}┐${RESET}`;
	return withFrameBackground(`${left}${labelText}${right}`);
}

function renderBottomBorder(width: number): string {
	if (width < 6) return withFrameBackground(color("─".repeat(width), CATHEDRAL_TOKENS.colors.divider));
	return withFrameBackground(color(`└${"─".repeat(width - 2)}┘`, CATHEDRAL_TOKENS.colors.divider));
}

/**
 * Wrap a single Pi editor row in `│ <inner> │` with the recess background
 * painted across the whole row. The inner span is `width - 2` cells wide;
 * we pad with spaces to that exact width so the bg block is uniform.
 *
 * IMPORTANT: We must not strip ANSI from `inner` — it carries cursor markers
 * and color codes that Pi's TUI engine relies on (CURSOR_MARKER for hardware
 * cursor placement, syntax/highlight colors, etc.). We just measure visible
 * length to compute padding.
 */
function wrapRow(inner: string, width: number): string {
	const innerWidth = Math.max(0, width - 2);
	const visible = visibleLength(inner);
	const pad = Math.max(0, innerWidth - visible);
	const padded = `${inner}${" ".repeat(pad)}`;
	return withFrameBackground(`${DIVIDER_FG}│${RESET}${padded}${DIVIDER_FG}│${RESET}`);
}

/**
 * Test whether a row is one of Pi's flat horizontal borders, i.e. a row
 * consisting of nothing but `─` chars (after stripping ANSI), or one of
 * Pi's scroll indicators like `─── ↑ N more ───────`.
 */
function isPiBorderRow(row: string): boolean {
	const stripped = row.replace(ANSI_PATTERN, "").trimEnd();
	if (stripped.length === 0) return false;
	if (/^─+$/.test(stripped)) return true;
	// Scroll indicators: `─── ↑ 3 more ───────────`
	if (/^─+\s*[↑↓]\s*\d+\s*more\s*─+$/.test(stripped)) return true;
	return false;
}

class CathedralEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly isSplash: () => boolean,
	) {
		super(tui, theme, keybindings);
	}

	override render(width: number): string[] {
		// Too narrow for our chrome — fall back to Pi's bare render.
		if (width < 8) return super.render(width);

		// Always defer to Pi's editor for layout. Pi gets `width - 2` so its
		// content fits inside our `│ ... │` side borders. Pi's CURSOR_MARKER
		// stays in the row, so when we prepend `│` (one visible cell) the
		// cursor's visual column is correctly offset by 1.
		const innerRows = super.render(width - 2);
		if (innerRows.length === 0) return innerRows;

		const splash = this.isSplash();
		const label = splash ? INPUT_FRAME_LABEL_SPLASH : INPUT_FRAME_LABEL_ACTIVE;

		// Find Pi's bottom border row. Pi's render is structured:
		//   row 0           : top border (─...─)
		//   rows 1..k-1     : content rows
		//   row k           : bottom border
		//   rows k+1..end   : autocomplete dropdown (if any)
		let bottomIdx = -1;
		for (let i = 1; i < innerRows.length; i++) {
			if (isPiBorderRow(innerRows[i]!)) {
				bottomIdx = i;
				break;
			}
		}

		// Splash placeholder injection: when the editor is empty AND we're on
		// splash, replace the (otherwise blank) content row with the placeholder
		// text so the user sees what the input wants. Pi's editor
		// has no concept of placeholders; we shim it from the outside.
		const text = this.getText();
		const showPlaceholder = splash && text.length === 0;
		const renderContent = (row: string, isFirstContent: boolean): string => {
			if (showPlaceholder && isFirstContent) {
				// Preserve Pi's zero-width cursor marker while painting our ghost text.
				// Without this, TUI.positionHardwareCursor() sees no marker on the
				// splash empty state and emits \x1b[?25l after every render.
				const ghost = color(`> ${CURSOR_MARKER}${INPUT_FRAME_PLACEHOLDER}`, CATHEDRAL_TOKENS.colors.foregroundDim);
				return wrapRow(ghost, width);
			}
			return wrapRow(row, width);
		};

		const result: string[] = [renderTopBorder(width, label)];
		const paddingRow = wrapRow("", width);
		if (splash) result.push(paddingRow);

		const lastContentIdx = bottomIdx === -1 ? innerRows.length : bottomIdx;
		let contentSeen = false;
		for (let i = 1; i < lastContentIdx; i++) {
			result.push(renderContent(innerRows[i]!, !contentSeen));
			contentSeen = true;
		}
		// Keep the roomy mockup padding for the splash empty state, but avoid
		// adding active-state bottom padding. In active chat, every extra editor
		// row steals vertical space from chat and makes the shell feel bouncy.
		if (splash) result.push(paddingRow);
		result.push(renderBottomBorder(width));

		// Autocomplete rows after Pi's bottom border — passed through as-is
		// at the narrower inner width. They appear as a dropdown directly
		// below the cathedral frame's bottom border, matching how Pi already
		// renders autocomplete (and how the Stitch mockup for the active
		// state implies suggestions float below the input).
		if (bottomIdx !== -1) {
			for (let i = bottomIdx + 1; i < innerRows.length; i++) {
				// Pad to full width so we don't leave artifacts from previous
				// autocomplete frames at the right edge.
				const row = innerRows[i]!;
				const visible = visibleLength(row);
				const pad = Math.max(0, width - visible);
				result.push(`${row}${" ".repeat(pad)}`);
			}
		}

		return result;
	}
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	} catch {
		return false;
	}
}

/**
 * Mount the cathedral editor via setEditorComponent. Replaces Pi's default
 * editor with our wrapper that decorates `super.render` output without
 * intercepting any of its behaviour (autocomplete, multi-line, IME etc.
 * all keep working).
 */
export function installCathedralEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new CathedralEditor(tui, theme, keybindings, () => !sessionHasMessages(ctx));
		});
	});
}
