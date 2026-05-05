/**
 * SumoCode working indicator — sacred animation that shows agent activity
 * above the editor, theme-aware via the registry.
 *
 * Rendering strategies (per Pi mode):
 * - **Classic Pi:** `setWorkingIndicator(...)` — Pi renders inline frames in
 *   the chat area while streaming. Works out of the box.
 * - **Retained SumoTUI (`SUMO_TUI=1`):** Pi's `setWorkingIndicator` is a no-op
 *   because SumoTUI owns the chrome. We mount our own widget above the editor
 *   via `setWidget(... aboveEditor)` and drive it from `agent_start` /
 *   `agent_end` events. Frames cycle on a per-theme `intervalMs` timer and
 *   pull both glyphs and accent color from `getActiveTheme()`, so cycling via
 *   `Ctrl+Shift+T` swaps the indicator immediately.
 *
 * Inspiration: Kyle Martinez's reverse-engineering of Claude Code's `· ✻ ✽ ✶ ✳ ✢`
 * spinner. The lesson is that AI-agent indicators feel alive when the frames
 * transform into different shapes, not when a single rotor cycles.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import {
	CATHEDRAL_INDICATOR_FRAMES as THEME_CATHEDRAL_INDICATOR_FRAMES,
	CATHEDRAL_INDICATOR_INTERVAL_MS as THEME_CATHEDRAL_INDICATOR_INTERVAL_MS,
	getActiveTheme,
	onThemeChanged,
} from "./themes/index.js";

export const CATHEDRAL_INDICATOR_FRAMES = THEME_CATHEDRAL_INDICATOR_FRAMES;
export const CATHEDRAL_INDICATOR_INTERVAL_MS = THEME_CATHEDRAL_INDICATOR_INTERVAL_MS;

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

export const WORKING_INDICATOR_INTERVAL_MS = THEME_CATHEDRAL_INDICATOR_INTERVAL_MS;
export const WORKING_INDICATOR_MIN_WIDTH = 80;
export const WORKING_INDICATOR_WIDGET_KEY = "sumocode-working-indicator";

/**
 * Pre-colorize each Cathedral frame with the accent token so Pi can render the
 * array verbatim. Pi handles cycling itself.
 */
export function buildCathedralIndicatorFrames(hex: string = getActiveTheme().tokens.colors.accent): string[] {
	return CATHEDRAL_INDICATOR_FRAMES.map((_, i) => renderIndicator(i, CATHEDRAL_INDICATOR_FRAMES, hex));
}

export function buildActiveThemeIndicatorFrames(): string[] {
	const theme = getActiveTheme();
	return theme.workingIndicator.frames.map((_, i) => renderIndicator(i, theme.workingIndicator.frames, theme.tokens.colors.accent));
}

/**
 * Portrait Bible scenes reserve the pre-input breathing row; the working
 * indicator is a landscape affordance for V1 so it does not consume that row at
 * 60 columns.
 */
function currentTerminalWidth(): number {
	const envColumns = Number.parseInt(process.env.COLUMNS ?? "", 10);
	if (Number.isFinite(envColumns) && envColumns > 0) return envColumns;
	const stdoutColumns = process.stdout.columns;
	if (Number.isFinite(stdoutColumns) && stdoutColumns > 0) return stdoutColumns;
	return 80;
}

export function shouldInstallWorkingIndicator(width = currentTerminalWidth()): boolean {
	return width >= WORKING_INDICATOR_MIN_WIDTH;
}

/**
 * Static, multi-line preview of every spinner frame for debugging without
 * having to read animation. Returned as a single string ready to drop into a
 * notification or stdout.
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

function dimAnsi(hex: string): string {
	const normalized = hex.replace("#", "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[38;2;${red};${green};${blue}m`;
}

/**
 * Retained-mode widget rendered in the `aboveEditor` slot. Returns one row
 * (always) so layout stays stable between busy and idle states. Empty content
 * when idle, animated frame + label when busy.
 */
export class WorkingIndicatorComponent implements Component {
	private busy = false;
	private tick = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private themeUnsubscribe: (() => void) | undefined;

	public constructor(private readonly tui: Pick<TUI, "requestRender">) {
		this.themeUnsubscribe = onThemeChanged(() => {
			// Cycle keeps timing/animation continuous; just nudge a re-render.
			this.tui.requestRender();
			if (this.busy) this.restartTimer();
		});
	}

	public invalidate(): void {}

	public render(_width: number): string[] {
		if (!this.busy) return [""];
		const theme = getActiveTheme();
		const frame = renderIndicator(this.tick, theme.workingIndicator.frames, theme.tokens.colors.accent);
		const label = `${dimAnsi(theme.tokens.colors.foregroundDim)}Working…${RESET}`;
		return [` ${frame} ${label}`];
	}

	public start(): void {
		if (this.busy) return;
		this.busy = true;
		this.tick = 0;
		this.startTimer();
		this.tui.requestRender();
	}

	public stop(): void {
		if (!this.busy) return;
		this.busy = false;
		this.clearTimer();
		this.tick = 0;
		this.tui.requestRender();
	}

	public dispose(): void {
		this.clearTimer();
		this.themeUnsubscribe?.();
		this.themeUnsubscribe = undefined;
	}

	public isBusy(): boolean {
		return this.busy;
	}

	private startTimer(): void {
		this.clearTimer();
		const intervalMs = getActiveTheme().workingIndicator.intervalMs;
		this.interval = setInterval(() => {
			this.tick += 1;
			this.tui.requestRender();
		}, intervalMs);
	}

	private restartTimer(): void {
		this.startTimer();
	}

	private clearTimer(): void {
		if (this.interval !== undefined) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}
}

export function isRetainedMode(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = env.SUMO_TUI;
	return flag === "1" || flag === "true" || flag === "TRUE" || flag === "yes" || flag === "YES" || flag === "on" || flag === "ON";
}

/**
 * Pi-wiring glue. Registers the working indicator on session_start.
 * - Classic Pi: forwards to `setWorkingIndicator` so Pi can render inline.
 * - Retained SumoTUI: mounts a widget above the editor and drives it from
 *   `agent_start`/`agent_end` so the indicator survives all turn boundaries
 *   inside one agent loop.
 */
export function installWorkingIndicator(pi: ExtensionAPI): void {
	let component: WorkingIndicatorComponent | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!shouldInstallWorkingIndicator()) return;

		if (isRetainedMode()) {
			// Retained SumoTUI owns the chrome. Hide Pi's inline loader row and
			// drive a theme-aware widget above the editor instead.
			if (typeof ctx.ui.setWorkingVisible === "function") ctx.ui.setWorkingVisible(false);
			else ctx.ui.setWorkingIndicator({ frames: [] });
			ctx.ui.setWidget(
				WORKING_INDICATOR_WIDGET_KEY,
				(tui) => {
					component?.dispose();
					component = new WorkingIndicatorComponent(tui);
					return component;
				},
				{ placement: "aboveEditor" },
			);
			return;
		}

		// Classic Pi: forward our frames to Pi's inline indicator.
		const theme = getActiveTheme();
		ctx.ui.setWorkingIndicator({
			frames: buildActiveThemeIndicatorFrames(),
			intervalMs: theme.workingIndicator.intervalMs,
		});
	});

	pi.on("agent_start", () => component?.start());
	pi.on("agent_end", () => component?.stop());
	pi.on("session_shutdown", () => {
		component?.dispose();
		component = undefined;
	});
}
