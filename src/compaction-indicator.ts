/**
 * SumoCode compaction indicator — surface compaction status in the retained
 * SumoTUI chrome as an animated neon-trace bar above the editor.
 *
 * ## Problem
 * In vanilla Pi, compaction status is rendered into `statusContainer` — a
 * dedicated `Container` node Pi adds directly to its TUI layout. SumoTUI
 * replaces Pi's render loop so that container is never composited.
 *
 * ## Solution
 * A dedicated widget key in the `aboveEditor` slot. Hooks:
 *   - `session_before_compact` → start neon-trace animation
 *   - `session_compact`        → snap to 100 %, hold briefly, then clear
 *   - `session_shutdown`       → immediate clear (abort / reload)
 *
 * Classic Pi (no `SUMO_TUI`) is a no-op — Pi's own `statusContainer` Loader
 * already handles it there.
 *
 * ## Visual design — neon trace
 *
 *   ━━━━━━━━━━━━◈─────────────────  Compacting…
 *
 * - `━` (accent)  — traced (filled) cells, growing left-to-right
 * - current theme working-indicator glyph (accent, cycling) — the "spark"
 *   sitting right at the leading edge; pulses as the trace advances
 * - `─` (dim)     — untraced track ahead of the spark
 *
 * Progress is deliberately slow (≈ 45 s to 90 %) so the bar feels proportional
 * to real compaction time. On `session_compact`, the bar instantly fills to
 * 100 % (all `━`, no spark), holds for ~700 ms so the user sees completion,
 * then the slot is cleared.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { onThemeChanged } from "./themes/index.js";
import { getCompactionReason, setCompactionReason } from "./compaction-state.js";
import { compactionStatusLabelForReason, renderCompactionStatusRow, type CompactionStatusLabel } from "./compaction-status-row.js";
import { isRetainedMode } from "./working-indicator.js";

export const COMPACTION_INDICATOR_WIDGET_KEY = "sumocode-compaction-status";

/** Tick interval in ms. */
const TICK_MS = 100;
/** How long (ms) to hold the 100 % trace after completion before clearing. */
const COMPLETE_HOLD_MS = 700;

/**
 * Neon-trace component.
 *
 * Returns exactly **one row** — the `aboveProxy` breathing wrapper
 * (`["", content]` + `belowIndicatorSpacer`) provides the spacing.
 */
export class CompactionStatusComponent implements Component {
	private tick = 0;
	private completed = false;
	private interval: ReturnType<typeof setInterval> | undefined;
	private themeUnsubscribe: (() => void) | undefined;

	public constructor(
		private readonly label: CompactionStatusLabel,
		private readonly tui: Pick<TUI, "requestRender">,
	) {
		this.interval = setInterval(() => {
			this.tick += 1;
			this.tui.requestRender();
		}, TICK_MS);

		this.themeUnsubscribe = onThemeChanged(() => {
			this.tui.requestRender();
		});
	}

	public invalidate(): void {}

	/**
	 * Snap the trace to 100 %, request a final render, then resolve after
	 * `COMPLETE_HOLD_MS` so the caller can clear the widget.
	 */
	public markComplete(): Promise<void> {
		this.completed = true;
		this.tui.requestRender();
		return new Promise((resolve) => {
			const t = setTimeout(resolve, COMPLETE_HOLD_MS);
			(t as NodeJS.Timeout).unref?.();
		});
	}

	public render(width: number): string[] {
		return renderCompactionStatusRow({
			width,
			label: this.label,
			tick: this.tick,
			completed: this.completed,
		});
	}

	public dispose(): void {
		if (this.interval !== undefined) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.themeUnsubscribe?.();
		this.themeUnsubscribe = undefined;
	}
}

/**
 * Registers the compaction indicator for retained SumoTUI mode.
 * No-op in classic Pi (Pi's `statusContainer` Loader handles it there).
 */
export function installCompactionIndicator(pi: ExtensionAPI): void {
	if (!isRetainedMode()) return;

	let active = false;
	let currentComponent: CompactionStatusComponent | undefined;

	const clearWidget = (ctx: { hasUI: boolean; ui: { setWidget(...args: unknown[]): void } }): void => {
		currentComponent?.dispose();
		currentComponent = undefined;
		active = false;
		if (ctx.hasUI) ctx.ui.setWidget(COMPACTION_INDICATOR_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	};

	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.hasUI) return undefined;
		// `compaction_start` fires before this event and sets the reason.
		// Fall back to `customInstructions` heuristic for headless / test paths.
		const reason = getCompactionReason();
		const label = compactionStatusLabelForReason(reason, { fallbackManual: event.customInstructions !== undefined });
		const factory = (tui: TUI): Component & { dispose?(): void } => {
			currentComponent?.dispose();
			currentComponent = new CompactionStatusComponent(label, tui);
			return currentComponent;
		};
		ctx.ui.setWidget(COMPACTION_INDICATOR_WIDGET_KEY, factory, { placement: "aboveEditor" });
		active = true;
		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!active) return;
		// Snap to 100 % and hold briefly so the user sees completion.
		if (currentComponent) await currentComponent.markComplete();
		// Belt-and-suspenders: clear the reason even if compaction_end already
		// cleared it, so no stale value survives into the next compaction.
		setCompactionReason(null);
		clearWidget(ctx as Parameters<typeof clearWidget>[0]);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!active) return;
		// Abort/reload — clear immediately, no hold.
		// Also clear the reason: compaction_end may never fire on abort paths,
		// leaving a stale value that would mislabel the next compaction.
		setCompactionReason(null);
		clearWidget(ctx as Parameters<typeof clearWidget>[0]);
	});
}
