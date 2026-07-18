import type { CompactionReason } from "./compaction-state.js";
import { getActiveTheme } from "./themes/index.js";
import { lineToAnsi, span, textLine, truncateLine, type Span } from "./sumo-tui/render/primitives.js";

export type CompactionStatusLabel = "Compacting…" | "Auto-compacting…";

/**
 * Ticks to reach the fill plateau (400 × 100 ms = 40 s → 90 %).
 * Slow enough to feel proportional to real compaction time.
 */
const PLATEAU_TICKS = 400;
/** Ratio at which the bar parks while waiting for the LLM to finish. */
const PLATEAU_RATIO = 0.90;

/**
 * Spark glyph frames — restricted to Unicode Geometric Shapes block
 * (U+25A0–U+25FF).  These chars share the same vertical metrics as the
 * box-drawing chars (━ / ─), so the spark sits *on* the line rather than
 * floating above it.  Math-operator glyphs (⊛ ⊚) are intentionally excluded.
 *
 * Sequence: hollow → half-filled → filled → back ("breathing diamond").
 */
const SPARK_FRAMES = ["◇", "◈", "◉", "◈"] as const;

/**
 * Ticks per spark-frame advance.  5 × 100 ms = 500 ms/frame → full loop ≈ 2 s.
 * Feels calm and proportional to the slow progress curve.
 */
const GLYPH_TICK_DIVISOR = 5;

export function compactionStatusLabelForReason(
	reason: CompactionReason | null | undefined,
	options: { readonly fallbackManual?: boolean } = {},
): CompactionStatusLabel {
	if (reason === "manual" || (reason == null && options.fallbackManual === true)) return "Compacting…";
	return "Auto-compacting…";
}

export function renderCompactionStatusRow(options: {
	readonly width: number;
	readonly label: CompactionStatusLabel;
	readonly tick: number;
	readonly completed?: boolean;
}): string[] {
	const theme = getActiveTheme();
	const accent = theme.tokens.colors.accent;
	const dim = theme.tokens.colors.foregroundDim;
	const width = Math.max(0, Math.floor(options.width));

	// ── bar width ────────────────────────────────────────────────────────
	const labelStr = ` ${options.label}`;
	const available = Math.max(0, width - 1 - labelStr.length);
	const barWidth = Math.max(4, Math.min(30, available));

	// ── fill amount ──────────────────────────────────────────────────────
	const fillRatio = options.completed === true
		? 1.0
		: Math.min(options.tick / PLATEAU_TICKS, 1) * PLATEAU_RATIO;
	const filledCells = options.completed === true
		? barWidth
		: Math.max(0, Math.floor(fillRatio * barWidth));

	// ── assemble bar row via typed primitives ───────────────────────────
	const barParts: (Span | string)[] = [];

	if (options.completed === true || filledCells >= barWidth) {
		// All done — solid trace, no spark.
		barParts.push(span("━".repeat(barWidth), { fg: accent }));
	} else {
		// Traced portion.
		if (filledCells > 0) barParts.push(span("━".repeat(filledCells), { fg: accent }));
		// Spark glyph at leading edge — breathes slowly through SPARK_FRAMES.
		// Using geometric-shapes chars only so vertical alignment matches ━/─.
		const sparkIdx = Math.floor(options.tick / GLYPH_TICK_DIVISOR) % SPARK_FRAMES.length;
		const glyph = SPARK_FRAMES[sparkIdx] ?? "◈";
		barParts.push(span(glyph, { fg: accent }));
		// Untraced track.
		const trackWidth = barWidth - filledCells - 1;
		if (trackWidth > 0) barParts.push(span("─".repeat(trackWidth), { fg: dim }));
	}

	const row = textLine(
		[" ", ...barParts, span(labelStr, { fg: dim })],
		{ fg: dim },
	);
	return [lineToAnsi(truncateLine(row, width))];
}
