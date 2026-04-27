/**
 * Cathedral top chrome (Element 2 from CATHEDRAL_DECISIONS.md).
 *
 * Layout:
 *   SUMOCODE   ║ ● refactor-auth-flow ║   │ debug-balance-tx   │ index-issues   │ ARCHIVE        [terminal]  [⚙]
 *
 *   - SUMOCODE: brand label, always visible (in accent), top-left
 *   - ║ ● label ║: active session marker; ● uses current state color, ║ in accent
 *   - │ label: recent sessions (LLM-summarized names), in dim
 *   - │ ARCHIVE: opens session-list overlay
 *   - [terminal]: bash sub-shell overlay (Ctrl+\), in dim
 *   - [⚙]: settings overlay (Ctrl+,), in dim
 *
 * When `hidden` is true (set via /sumo:tabs hide), only SUMOCODE renders.
 *
 * At narrow widths, regions are dropped right-to-left: icons → ARCHIVE → recents.
 * SUMOCODE + active session always survive.
 *
 * Pure render only. Pi-glue is in `installTopChrome` below.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isTopChromeHidden } from "./commands/tabs.js";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const TOP_CHROME_BRAND = "SUMOCODE";

export type TopChromeSnapshot = {
	activeSession: { id: string; label: string; state: SumoCodeState };
	recentSessions: readonly { id: string; label: string }[];
	hidden: boolean;
};

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

function ellipsize(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max === 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

const ICON_TERMINAL = "[terminal]";
const ICON_SETTINGS = "[⚙]";
const ICON_GAP = "  ";
const ARCHIVE_LABEL = "ARCHIVE";

/**
 * Compose the active-session segment: `║ ● label ║`.
 * Visible width = 6 + label.length (║ space ● space label space ║).
 */
function activeSegment(active: TopChromeSnapshot["activeSession"], maxLabel: number): string {
	const label = ellipsize(active.label, maxLabel);
	const dot = color("●", CATHEDRAL_TOKENS.colors.states[active.state]);
	const wrap = (ch: string): string => color(ch, CATHEDRAL_TOKENS.colors.accent);
	return `${wrap("║")} ${dot} ${label} ${wrap("║")}`;
}

const ACTIVE_OVERHEAD = 6; // chars consumed by `║ ● ` + ` ║`

function recentSegment(label: string): string {
	const sep = color("│", CATHEDRAL_TOKENS.colors.foregroundDim);
	const text = color(label, CATHEDRAL_TOKENS.colors.foregroundDim);
	return `   ${sep} ${text}`;
}

function archiveSegment(): string {
	const sep = color("│", CATHEDRAL_TOKENS.colors.foregroundDim);
	const text = color(ARCHIVE_LABEL, CATHEDRAL_TOKENS.colors.foregroundDim);
	return `   ${sep} ${text}`;
}

function iconsSegment(): string {
	const term = color(ICON_TERMINAL, CATHEDRAL_TOKENS.colors.foregroundDim);
	const gear = color(ICON_SETTINGS, CATHEDRAL_TOKENS.colors.foregroundDim);
	return `${term}${ICON_GAP}${gear}`;
}

function brandSegment(): string {
	return color(TOP_CHROME_BRAND, CATHEDRAL_TOKENS.colors.accent);
}

function padToWidth(text: string, width: number): string {
	const len = visibleLength(text);
	if (len >= width) return text;
	return `${text}${" ".repeat(width - len)}`;
}

/**
 * Pure render of the top chrome row at a given terminal width.
 *
 * Always returns a single line. Priority order (highest first):
 *   1. SUMOCODE brand label (always)
 *   2. Active session marker (label truncated only if absolutely required)
 *   3. Recent sessions (one at a time, in order)
 *   4. ARCHIVE link
 *   5. Icons block (right-aligned)
 *
 * At narrow widths, regions drop right-to-left in reverse priority order
 * (icons first, then ARCHIVE, then recents).
 */
export function renderTopChrome(snapshot: TopChromeSnapshot, width: number): string {
	if (width <= 0) return "";

	const brand = brandSegment();
	if (snapshot.hidden) {
		return padToWidth(brand, width);
	}

	const brandLen = visibleLength(brand);

	// Compute the active session at its full label first; truncate only if it
	// won't fit in width with brand + gap.
	const fullActive = activeSegment(snapshot.activeSession, snapshot.activeSession.label.length);
	const fullActiveLen = visibleLength(fullActive);

	let active: string;
	if (brandLen + 3 + fullActiveLen <= width) {
		active = fullActive;
	} else {
		const maxActiveLabel = Math.max(1, width - brandLen - 3 - ACTIVE_OVERHEAD);
		active = activeSegment(snapshot.activeSession, maxActiveLabel);
	}
	let consumed = brandLen + 3 + visibleLength(active);
	let line = `${brand}   ${active}`;

	// Try to fit recent sessions one at a time.
	for (const recent of snapshot.recentSessions) {
		const seg = recentSegment(recent.label);
		const segLen = visibleLength(seg);
		if (consumed + segLen > width) break;
		line += seg;
		consumed += segLen;
	}

	// Try to fit ARCHIVE link.
	{
		const seg = archiveSegment();
		const segLen = visibleLength(seg);
		if (consumed + segLen <= width) {
			line += seg;
			consumed += segLen;
		}
	}

	// Try to fit icons block, right-aligned with at least 2 spaces of gap.
	{
		const iconBlock = iconsSegment();
		const iconLen = visibleLength(iconBlock);
		if (consumed + 2 + iconLen <= width) {
			const gap = width - consumed - iconLen;
			line += `${" ".repeat(gap)}${iconBlock}`;
			consumed = width;
		}
	}

	return padToWidth(line, width);
}

// ============================================================================
// Pi-glue
// ============================================================================

/**
 * Mounts the top chrome via `ctx.ui.setHeader`. Listens to lifecycle events
 * to update the active session's state dot color in real time.
 *
 * The actual recents + active-session-name resolution is delegated to the
 * caller-supplied `loadSnapshot` so this module stays unit-testable. In
 * production, `installTopChrome` provides a default loader that reads from
 * the session manager + LLM-summarized name cache.
 */
export type TopChromeLoader = () => TopChromeSnapshot;

export function installTopChrome(pi: ExtensionAPI, loader?: TopChromeLoader): void {
	let state: SumoCodeState = "idle";
	let render: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((tui) => {
			render = () => tui.requestRender();

			return {
				dispose(): void {
					render = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					const snap = loader ? loader() : defaultSnapshot(ctx, state);
					return [renderTopChrome(snap, width)];
				},
			};
		});
	});

	pi.on("before_agent_start", () => {
		state = "thinking";
		render?.();
	});
	pi.on("agent_start", () => {
		state = "thinking";
		render?.();
	});
	pi.on("tool_call", () => {
		state = "tool";
		render?.();
	});
	pi.on("tool_result", () => {
		state = "thinking";
		render?.();
	});
	pi.on("agent_end", () => {
		state = "idle";
		render?.();
	});

	// Session-name / state affordances can change when messages commit.
	pi.on("message_start", () => render?.());
	pi.on("message_end", () => render?.());
}

/**
 * Default snapshot loader: reads session id + recent sessions from
 * the Pi context. Recent sessions are not yet exposed by Pi 0.70.x —
 * we leave them empty until session-name.ts adds the cache + Pi adds
 * an enumeration API. Active label falls back to UUID first segment.
 *
 * Reads the per-machine `topChromeHidden` flag set by /sumo:tabs hide.
 */
function defaultSnapshot(
	ctx: { sessionManager: { getSessionId(): string; getSessionName(): string | undefined } },
	state: SumoCodeState,
): TopChromeSnapshot {
	const id = ctx.sessionManager.getSessionId();
	const named = ctx.sessionManager.getSessionName();
	const fallback = id.split("-")[0] ?? "session";
	const label = named ?? fallback;

	return {
		activeSession: { id, label, state },
		recentSessions: [],
		hidden: isTopChromeHidden(),
	};
}
