/**
 * Cathedral working indicator — animation that replaces Pi's default thinking
 * spinner while the agent is generating or running tools.
 *
 * Design intent (from Cathedral DESIGN.md): a hand-crafted flower-pulse rather
 * than a generic rotor. The frames are six Unicode dingbats that together tell
 * a Greek + Eastern story — quiet, rises, blooms, bursts, works, settles. v0.3+
 * will move frame definitions into theme bundles so each theme owns its own
 * animation vocabulary.
 *
 * Inspiration: Kyle Martinez's reverse-engineering of Claude Code's `· ✻ ✽ ✶ ✳ ✢`
 * spinner. The lesson is that AI-agent indicators feel alive when the frames
 * transform into different shapes, not when a single rotor cycles.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CATHEDRAL_TOKENS } from "./tokens.js";

/**
 * Cathedral spinner frames — a flower-pulse that doubles as Greek + Eastern
 * iconography. Every glyph is single-cell and lives in the U+2700 Dingbats
 * range, so it renders reliably across IBM Plex Mono, JetBrains Mono, SF Mono.
 *
 * Sequence as story:
 *   · — quiet, before
 *   ✦ — small Greek cross-star, rising
 *   ❖ — lozenge, Eastern bloom
 *   ✺ — 12-pointed sun, Zeus full burst
 *   ❋ — propeller, work-in-progress
 *   ✶ — heavy 6-point, settled
 */
export const CATHEDRAL_INDICATOR_FRAMES = ["·", "✦", "❖", "✺", "❋", "✶"] as const;

const RESET = "\u001b[0m";

/**
 * Returns the frame string at `tick`, cycling forever. `tick` is expected to
 * advance monotonically while the agent is busy; the caller decides cadence.
 */
export function indicatorFrameAt(tick: number, frames: readonly string[]): string {
	const length = frames.length;
	if (length === 0) return "";
	const index = ((tick % length) + length) % length;
	return frames[index];
}

/**
 * Wraps the current frame in a 24-bit ANSI color sequence so the indicator
 * picks up the active theme accent. `hex` is `#rrggbb`.
 */
export function renderIndicator(
	tick: number,
	frames: readonly string[],
	hex: string,
): string {
	const frame = indicatorFrameAt(tick, frames);
	if (!frame) return "";
	const normalized = hex.replace("#", "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[38;2;${red};${green};${blue}m${frame}${RESET}`;
}

/**
 * Default frame interval in ms. 150ms over 6 frames ≈ 900ms per pulse:
 * deliberately slower than ora (80ms) and Claude Code (~100ms) so the bloom
 * reads as scriptorium brushwork rather than a frantic CLI spinner.
 */
export const CATHEDRAL_INDICATOR_INTERVAL_MS = 150;

/**
 * Pre-colorize each Cathedral frame with the accent token so Pi can render the
 * array verbatim. Pi handles cycling itself.
 */
export function buildCathedralIndicatorFrames(hex: string = CATHEDRAL_TOKENS.colors.accent): string[] {
	return CATHEDRAL_INDICATOR_FRAMES.map((_, i) => renderIndicator(i, CATHEDRAL_INDICATOR_FRAMES, hex));
}

/**
 * Static, multi-line preview of every spinner frame for debugging without
 * having to read animation. Returned as a single string ready to drop into a
 * notification or stdout. Closes the observability loop — Dhruv can copy this
 * back to me as text when an animation reads wrong.
 */
export function formatSpinnerInspection(
	frames: readonly string[],
	hex: string,
	intervalMs: number,
): string {
	const lines: string[] = [`${frames.length} frames · ${intervalMs}ms per frame`];
	for (let i = 0; i < frames.length; i++) {
		const num = String(i + 1).padStart(2, " ");
		const colored = renderIndicator(i, frames, hex);
		lines.push(`  ${num}. ${colored}  ${frames[i]}`);
	}
	return lines.join("\n");
}

/**
 * Pi-wiring glue. Registers the working indicator on session_start.
 * TTY-defensive — in non-interactive contexts, this is a no-op because there's
 * no UI surface to render frames into. Untested by design: pure logic lives
 * in `indicatorFrameAt` / `renderIndicator` above.
 */
export function installWorkingIndicator(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setWorkingIndicator({
			frames: buildCathedralIndicatorFrames(),
			intervalMs: CATHEDRAL_INDICATOR_INTERVAL_MS,
		});
	});
}
