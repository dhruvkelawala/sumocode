/**
 * Cathedral top chrome (Element 2 from CATHEDRAL_DECISIONS.md).
 *
 * Layout:
 *   SUMOCODE  ║ • auth-flow-refactor ║   │ debug-balance-tx   │ index-issues   │ ARCHIVE          
 *
 *   - SUMOCODE: brand label, always visible (in accent), top-left
 *   - ║ • label ║: active session marker; • is static accent, never state-colored
 *   - │ label: recent sessions (LLM-summarized names), in dim
 *   - │ ARCHIVE: opens session-list overlay
 *   - : bash sub-shell overlay (Ctrl+\), in foreground
 *   - : settings overlay (Ctrl+,), in foreground
 *
 * When `hidden` is true (set via /sumo:tabs hide), only SUMOCODE renders.
 *
 * At compact portrait widths, recents + ARCHIVE collapse first and the right
 * icons survive when space allows. SUMOCODE + active session always survive.
 *
 * Pure render only. Pi-glue is in `installTopChrome` below.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { isTopChromeHidden } from "./commands/tabs.js";
import { sessionHasMessages as cachedSessionHasMessages } from "./session-cache.js";
import { activeThemeColors, type SumoCodeState } from "./themes/index.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const TOP_CHROME_BRAND = "SUMOCODE";

export type TopChromeDotSize = "small" | "medium" | "large";

export type TopChromeSnapshot = {
	activeSession: { id: string; label: string; state: SumoCodeState };
	recentSessions: readonly { id: string; label: string }[];
	hidden: boolean;
	dotSize?: TopChromeDotSize;
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

const ICON_TERMINAL = "\uF489";
const ICON_SETTINGS = "\uF423";
const ICON_GAP = "  ";
const ARCHIVE_LABEL = "ARCHIVE";
const OUTER_PAD = 1;
const BRAND_ACTIVE_GAP = 2;
const COMPACT_TOP_CHROME_WIDTH = 80;
const PORTRAIT_CHROME_BREATHING_WIDTH = 80;
const DOT_GLYPHS: Record<TopChromeDotSize, string> = {
	small: "·",
	medium: "•",
	large: "●",
};

/**
 * Compose the active-session segment: `║ • label ║`.
 * Visible width = 6 + label.length (║ space • space label space ║).
 */
function activeSegment(active: TopChromeSnapshot["activeSession"], maxLabel: number, dotSize: TopChromeDotSize): string {
	const label = ellipsize(active.label, maxLabel);
	const dot = color(DOT_GLYPHS[dotSize], activeThemeColors().accent);
	const dim = (ch: string): string => color(ch, activeThemeColors().foregroundDim);
	return `${dim("║" + " ")}${dot}${dim(" " + label + " " + "║")}`;
}

const ACTIVE_OVERHEAD = 6; // chars consumed by `║ ● ` + ` ║`

function recentSegment(label: string): string {
	const sep = color("│", activeThemeColors().foregroundDim);
	const text = color(label, activeThemeColors().foregroundDim);
	return `   ${sep} ${text}`;
}

function archiveSegment(): string {
	const sep = color("│", activeThemeColors().foregroundDim);
	const text = color(ARCHIVE_LABEL, activeThemeColors().foregroundDim);
	return `   ${sep} ${text}`;
}

function iconsSegment(): string {
	const term = color(ICON_TERMINAL, activeThemeColors().foreground);
	const gear = color(ICON_SETTINGS, activeThemeColors().foreground);
	return `${term}${ICON_GAP}${gear}`;
}

function brandSegment(): string {
	return color(TOP_CHROME_BRAND, activeThemeColors().accent);
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
 * At compact portrait widths, the chrome keeps brand + active session + icons
 * and drops recents/ARCHIVE so 60-column scenes remain readable.
 */
export function renderTopChrome(snapshot: TopChromeSnapshot, width: number): string {
	if (width <= 0) return "";

	const outerPad = width >= OUTER_PAD * 2 ? " ".repeat(OUTER_PAD) : "";
	const innerWidth = Math.max(0, width - visibleLength(outerPad) * 2);
	if (innerWidth <= 0) return " ".repeat(width);

	const brand = brandSegment();
	if (snapshot.hidden) {
		return `${outerPad}${padToWidth(brand, innerWidth)}${outerPad}`;
	}

	const brandLen = visibleLength(brand);
	const dotSize = snapshot.dotSize ?? "medium";

	// Compute the active session at its full label first; truncate only if it
	// won't fit in width with brand + gap.
	const fullActive = activeSegment(snapshot.activeSession, snapshot.activeSession.label.length, dotSize);
	const fullActiveLen = visibleLength(fullActive);

	let active: string;
	if (brandLen + BRAND_ACTIVE_GAP + fullActiveLen <= innerWidth) {
		active = fullActive;
	} else {
		const maxActiveLabel = Math.max(1, innerWidth - brandLen - BRAND_ACTIVE_GAP - ACTIVE_OVERHEAD);
		active = activeSegment(snapshot.activeSession, maxActiveLabel, dotSize);
	}
	const brandGap = color(" ".repeat(BRAND_ACTIVE_GAP), activeThemeColors().foregroundDim);
	let consumed = brandLen + BRAND_ACTIVE_GAP + visibleLength(active);
	let line = `${brand}${brandGap}${active}`;
	const compact = innerWidth < COMPACT_TOP_CHROME_WIDTH;

	if (!compact) {
		// Try to fit recent sessions one at a time.
		for (const recent of snapshot.recentSessions) {
			const seg = recentSegment(recent.label);
			const segLen = visibleLength(seg);
			if (consumed + segLen > width) break;
			line += seg;
			consumed += segLen;
		}
	}

	// Build right-aligned block: ARCHIVE (when not compact) + icons.
	// Bible positions ARCHIVE immediately left of the icons, right-aligned.
	{
		const iconBlock = iconsSegment();
		const iconLen = visibleLength(iconBlock);
		const archiveBlock = compact ? "" : archiveSegment();
		const archiveLen = compact ? 0 : visibleLength(archiveBlock);
		const rightBlock = `${archiveBlock}${" ".repeat(archiveLen > 0 ? 3 : 0)}${iconBlock}`;
		const rightLen = archiveLen + (archiveLen > 0 ? 3 : 0) + iconLen;
		if (consumed + 1 + rightLen <= innerWidth) {
			const gap = innerWidth - consumed - rightLen;
			line += `${" ".repeat(gap)}${rightBlock}`;
			consumed = innerWidth;
		} else if (consumed + 1 + iconLen <= innerWidth) {
			// ARCHIVE doesn't fit; still right-align icons only
			const gap = innerWidth - consumed - iconLen;
			line += `${" ".repeat(gap)}${iconBlock}`;
			consumed = innerWidth;
		}
	}

	return `${outerPad}${padToWidth(line, innerWidth)}${outerPad}`;
}

/**
 * Runtime block wrapper. Portrait Bible scenes reserve one blank breathing row
 * above and below the top chrome, while wider scenes keep the previously
 * approved one-row landscape chrome.
 */
export function renderTopChromeBlock(snapshot: TopChromeSnapshot, width: number): string[] {
	const line = renderTopChrome(snapshot, width);
	if (width > 0 && width < PORTRAIT_CHROME_BREATHING_WIDTH) {
		const blank = " ".repeat(width);
		return [blank, line, blank];
	}
	return [line];
}

// ============================================================================
// Pi / retained shell glue
// ============================================================================

class TopChromeComponent implements Component {
	public constructor(
		private readonly loadSnapshot: () => TopChromeSnapshot,
		private readonly shouldRender: () => boolean,
	) {}

	public invalidate(): void {}

	public render(width: number): string[] {
		if (!this.shouldRender()) return [];
		return renderTopChromeBlock(this.loadSnapshot(), width);
	}
}

/**
 * Registers Pi's `ctx.ui.setHeader` for direct Pi runs. The RPC host owns the
 * interactive foreground and renders its own top chrome from RPC state.
 * Lifecycle events still update the active session state in real time.
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
		state = "idle";

		const component = new TopChromeComponent(
			() => (loader ? loader() : defaultSnapshot(ctx, state)),
			() => sessionHasMessages(ctx),
		);

		ctx.ui.setHeader((tui) => {
			render = () => {
				tui.requestRender();
			};

			return {
				dispose(): void {
					render = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					return component.render(width);
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
	pi.on("session_shutdown", () => {
		render = undefined;
	});
}

function sessionHasMessages(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): boolean {
	try {
		// Route through the shared session cache when ctx looks like a real
		// ExtensionContext so we don't re-walk the branch on every header render.
		// Falls back to the inline traversal for the test mock shape that only
		// supplies `{ sessionManager: { getBranch } }`.
		if (
			typeof (ctx as { cwd?: unknown }).cwd === "string" &&
			ctx.sessionManager &&
			typeof ctx.sessionManager.getBranch === "function"
		) {
			return cachedSessionHasMessages(ctx as ExtensionContext);
		}
		return ctx.sessionManager?.getBranch?.().some((entry) => (entry as { type?: string }).type === "message") ?? false;
	} catch {
		return false;
	}
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
