/**
 * Cathedral working indicator — animation that replaces Pi's default thinking
 * spinner while the agent is generating or running tools.
 *
 * Design intent (from Cathedral DESIGN.md): a slow, warm pulse that fits the
 * scriptorium aesthetic. Frames are simple braille spinners; v0.3+ will move
 * frame definitions into theme bundles so each theme owns its own animation
 * vocabulary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CATHEDRAL_TOKENS } from "./tokens.js";

/**
 * Cathedral spinner frames — a slow inhale/exhale rhythm in braille that pairs
 * with the warm walnut surface. Tick cadence is decided by the caller; the
 * default in Pi is ~80–100ms per frame which yields a calm 6-frame breath.
 */
export const CATHEDRAL_INDICATOR_FRAMES = ["⠂", "⠦", "⠮", "⠶", "⠮", "⠦"] as const;

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
 * Default frame interval in ms. ~110ms over 6 frames ≈ 660ms per inhale→exhale
 * cycle, which reads as a calm, deliberate pulse rather than a frantic spinner.
 */
export const CATHEDRAL_INDICATOR_INTERVAL_MS = 110;

/**
 * Pre-colorize each Cathedral frame with the accent token so Pi can render the
 * array verbatim. Pi handles cycling itself.
 */
export function buildCathedralIndicatorFrames(hex: string = CATHEDRAL_TOKENS.colors.accent): string[] {
	return CATHEDRAL_INDICATOR_FRAMES.map((_, i) => renderIndicator(i, CATHEDRAL_INDICATOR_FRAMES, hex));
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
