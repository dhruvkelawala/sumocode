import type { Theme } from "./types.js";

/**
 * Cathedral spinner frames — a hand-crafted flower-pulse that shares the
 * design DNA with Claude Code's spinner (transforming dingbats, not a rotor)
 * but has zero glyph overlap with their `· ✻ ✽ ✶ ✳ ✢` set.
 */
export const CATHEDRAL_INDICATOR_FRAMES = ["◌", "✦", "❖", "✺", "❋", "❉"] as const;

export const CATHEDRAL_INDICATOR_INTERVAL_MS = 150;

export const CATHEDRAL_THEME: Theme = {
	name: "cathedral",
	displayName: "Cathedral",
	description: "19th-century scriptorium: warm walnut, parchment foreground, burnt-orange accents.",
	tokens: {
		colors: {
			background: "#1A1511",
			surface: "#241D17",
			surfaceRecess: "#120D0A",
			surfaceLifted: "#3D3024",
			foreground: "#F5E6C8",
			foregroundDim: "#8B7A63",
			divider: "#5A4D3C",
			accent: "#D97706",
			states: {
				idle: "#7FB069",
				thinking: "#E8B339",
				tool: "#5B9BD5",
				approval: "#C1443E",
				learning: "#8E7AB5",
			},
		},
	},
	workingIndicator: {
		frames: CATHEDRAL_INDICATOR_FRAMES,
		intervalMs: CATHEDRAL_INDICATOR_INTERVAL_MS,
	},
};
