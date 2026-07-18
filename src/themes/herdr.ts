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
 * Herdr Terminal — the electric-green operator-console SumoCode theme.
 *
 * Source of truth: docs/ui/stitch/herdr-terminal/DESIGN.md. Palette is the
 * approved v7 realignment, ported from the live Ghostty + Herdr canary
 * (Mac Mini approval, MacBook parity). Host provenance values:
 *   background #040704 · electric foreground/focus/cursor #39FF14 ·
 *   active surface #0F3D17 · muted host green #1FA82F ·
 *   amber #FFB000 · bright amber #FFD166 · error red #FF625F.
 *
 * SumoCode reproduces that visual language through the semantic theme
 * contract. Two text colours are accessibility-safe derivatives of the host
 * literals (which fail 4.5:1 on the lifted surface): `foregroundDim`/`idle`
 * `#29B938` derives from host-muted `#1FA82F` (3.94:1 → 4.759:1), and
 * `approval` `#FF706D` derives from host error `#FF625F` (4.21:1 → 4.582:1).
 * Host literals remain valid for decorative/non-text use only.
 *
 * Mood: green-black operator terminal. Electric green is dominant across
 * body, focus, frames and cursor; amber owns tools/warnings/learning; red
 * owns approval/failure/interruption. No cyan/teal/blue/purple, no glow, no
 * gradients — hierarchy comes from surface depth, weight, labels and chrome.
 */
export const HERDR_THEME: Theme = {
	name: "herdr",
	displayName: "Herdr Terminal",
	description: "Electric-green operator terminal — phosphor focus, amber execution, sharp hacker chrome.",
	tokens: {
		colors: {
			background: "#040704",       // approved Ghostty chassis / OSC 11 value
			surface: "#070C08",          // calm green-black content/sidebar plane
			surfaceRecess: "#050905",    // input/editor well
			surfaceLifted: "#0F3D17",    // approved active/selected surface
			foreground: "#39FF14",       // approved electric-green body foreground
			foregroundDim: "#29B938",    // text-safe derivative of host-muted #1FA82F
			divider: "#176B22",          // decorative structure; never sole carrier of text/state
			accent: "#39FF14",           // active frame, focus, cursor and routing
			states: {
				idle: "#29B938",       // ready/healthy, quieter than active focus
				thinking: "#39FF14",   // active reasoning/routing
				tool: "#FFB000",       // tool execution and warning
				approval: "#FF706D",   // text-safe derivative of host error #FF625F
				learning: "#FFD166",   // durable write / learned state / bright amber
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
