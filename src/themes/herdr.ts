import { DEFAULT_CHROME, type Theme } from "./types.js";

/**
 * Herdr spinner — eight-frame ASCII packet progression. A payload densifies
 * from a single dot into a full packet glyph and is finally routed (`>`).
 * Pure ASCII: zero glyph overlap with Cathedral's `◌ ✦ ❖ ✺ ❋ ❉` flower
 * pulse, Amber CRT's `▁▂▃▄▅▆▇█` scanline sweep, or Obsidian's `▫ ◇ ◈ ◉ ⊛ ⊚`
 * sacred-geometry arc.
 */
export const HERDR_INDICATOR_FRAMES = [".", ":", "+", "*", "#", "%", "@", ">"] as const;

/**
 * 110ms per frame — quicker than Cathedral's 150ms brushwork but calmer than
 * Amber CRT's 90ms sweep, so the packet pulse reads as steady network traffic.
 */
export const HERDR_INDICATOR_INTERVAL_MS = 110;

/**
 * Herdr Terminal — the operational agent-control SumoCode theme.
 *
 * Source of truth: docs/ui/stitch/herdr-terminal/DESIGN.md. Palette is
 * grounded in the active Herdr/Ghostty setup (`neon-blue-split-contrast`)
 * and Herdr's configured state colours, with `foregroundDim` adjusted above
 * ANSI grey for sustained-readability contrast.
 *
 * Mood: near-black operational terminal. Neon is reserved for routing/focus
 * and state — cyan means active routing, mint means ready/healthy, gold means
 * execution, hot pink means interruption/danger. Body copy stays warm
 * off-white; metadata stays cool dim grey. No glow, no gradients, no green
 * body text — terminal restraint is part of the theme.
 */
export const HERDR_THEME: Theme = {
	name: "herdr",
	displayName: "Herdr Terminal",
	description: "Operational terminal — cyan routing, mint readiness, sharp hacker chrome.",
	tokens: {
		colors: {
			background: "#0B0B0F",       // Ghostty background — terminal chassis
			surface: "#0D0D14",          // Herdr unfocused pane fill
			surfaceRecess: "#07090D",    // editor/input well
			surfaceLifted: "#1A1A2E",    // Ghostty selection background — overlays/selected rows
			foreground: "#F5EFE1",       // Ghostty foreground — warm readable body text
			foregroundDim: "#8F96A8",    // cool operational metadata; adjusted above ANSI grey
			divider: "#3A3A4A",          // Ghostty bright-black — decorative structure only
			accent: "#00E5FF",           // Herdr active border / Ghostty cyan
			states: {
				idle: "#4ECCA3",       // Herdr healthy / ready
				thinking: "#00E5FF",   // active routing / focus
				tool: "#FFD700",       // execution / warning gold
				approval: "#FF3366",   // interruption / danger
				learning: "#F1D77A",   // durable write / learned state
			},
		},
	},
	workingIndicator: {
		frames: HERDR_INDICATOR_FRAMES,
		intervalMs: HERDR_INDICATOR_INTERVAL_MS,
	},
	chrome: {
		...DEFAULT_CHROME,
		// Sharp 90-degree box chrome and single-cell ASCII sigils — terminal
		// identity without changing layout measurements or double-width risk.
		frame: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
		sectionGlyphs: { context: ">", memory: "#", mcp: "@", session: "$", registry: "%" },
		sectionTracked: false,
		ruleChar: "─",
		tabActive: "▸",
		tabInactive: "·",
		bullet: ">",
	},
};
