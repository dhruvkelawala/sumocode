import type { Theme } from "./types.js";

/**
 * Obsidian spinner — sacred-geometry progression.
 * Six single-cell glyphs tell a ritual ignition arc:
 *
 *   ▫ — empty void
 *   ◇ — outlined gem rising
 *   ◈ — layered sacred lattice
 *   ◉ — solid bullseye / ignited core
 *   ⊛ — radiating orbit
 *   ⊚ — settled circumscribed orbit
 *
 * Zero glyph overlap with Cathedral's `◌ ✦ ❖ ✺ ❋ ❉` flower-pulse.
 */
export const OBSIDIAN_INDICATOR_FRAMES = ["▫", "◇", "◈", "◉", "⊛", "⊚"] as const;

/**
 * 180ms per frame — slower than Cathedral's 150ms cadence so the temple
 * indicator reads as a slow ceremonial pulse rather than scriptorium brushwork.
 */
export const OBSIDIAN_INDICATOR_INTERVAL_MS = 180;

/**
 * Obsidian — the sacred-tech SumoCode theme.
 *
 * Source of truth: docs/ui/stitch/obsidian-temple/DESIGN.md (the Stitch project
 * shipped under the "obsidian-temple" working name; the user-facing theme name
 * is `obsidian`). Mood: polished obsidian altar, electrum gold + lapis cyan +
 * sacred magenta neon glows on focal elements. Bronze body text on near-black
 * obsidian-violet ground.
 *
 * Palette is deliberately tuned to read as visibly different from Cathedral
 * even on darker terminal calibrations: `surfaceLifted` is a saturated violet
 * stone so the sidebar dock pops away from the obsidian ground, and `accent`
 * is bright sacred gold instead of Cathedral's burnt orange.
 *
 * The 13 token slots map the documented palette to the SumoCode `Theme`
 * interface. Glow effects (text-shadow, chromatic aberration, CRT scanlines)
 * are HTML-only and intentionally absent in the terminal port.
 */
export const OBSIDIAN_THEME: Theme = {
	name: "obsidian",
	displayName: "Obsidian",
	description: "Sacred-tech: deep obsidian altar, bronze body, electrum gold, lapis cyan, sacred magenta accents.",
	tokens: {
		colors: {
			background: "#050308",       // deep obsidian, near-black with violet undertone
			surface: "#15082A",          // polished granite — more violet than the ground for visible chrome layering
			surfaceRecess: "#020104",    // input prompt void
			surfaceLifted: "#1F0F2E",    // sidebar / lifted panels — clearly violet stone, distinct from `background`
			foreground: "#D4B896",       // aged papyrus / warm bronze
			foregroundDim: "#8B7355",    // oxidized bronze
			divider: "#3A2750",          // deep violet-purple, brighter so dividers register on the obsidian ground
			accent: "#FFD700",           // sacred gold (cartouche, accents)
			states: {
				idle: "#00C896",       // malachite life / sacred green
				thinking: "#00E5FF",   // neon cyan — thinking ignition
				tool: "#F0B400",       // electrum gold — tool action
				approval: "#B91C1C",   // carnelian / burial red
				learning: "#FF00AA",   // neon magenta — sacred memory writes
			},
		},
	},
	workingIndicator: {
		frames: OBSIDIAN_INDICATOR_FRAMES,
		intervalMs: OBSIDIAN_INDICATOR_INTERVAL_MS,
	},
};
