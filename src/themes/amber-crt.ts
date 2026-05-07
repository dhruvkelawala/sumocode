import { DEFAULT_CHROME, type Theme } from "./types.js";

/**
 * Amber CRT spinner — scanline sweep that reads as a CRT phosphor build-up
 * across 8 frames. Zero glyph overlap with Cathedral's `◌ ✦ ❖ ✺ ❋ ❉` flower
 * pulse or Obsidian's `▫ ◇ ◈ ◉ ⊛ ⊚` sacred-geometry arc.
 */
export const AMBER_CRT_INDICATOR_FRAMES = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * 90ms per frame — faster than Cathedral's 150ms or Obsidian's 180ms so the
 * scanline feels like a quick monitor sweep rather than ceremonial pulse.
 */
export const AMBER_CRT_INDICATOR_INTERVAL_MS = 90;

/**
 * Amber CRT — SumoCode's Mission Control v3 mirror.
 *
 * Source of truth: `docs/prd.md` § Themes (user story 22) and Mission Control
 * v3's locked palette. Mood: warm-brown CRT chassis with classic amber P3
 * phosphor text, sharp 90-degree corners, scanline-flavored chrome.
 *
 * Palette is tuned so the five preattentive states (idle / thinking / tool /
 * approval / learning) read as distinct CRT phosphor colours — green, white,
 * cyan, red, magenta — different from Cathedral's earth-toned palette AND
 * Obsidian's sacred-tech neons, while still feeling like a coherent CRT
 * rather than a rainbow.
 */
export const AMBER_CRT_THEME: Theme = {
	name: "amber-crt",
	displayName: "Amber CRT",
	description: "Mission Control mirror: warm-brown CRT chassis, amber P3 phosphor text, scanline indicator.",
	tokens: {
		colors: {
			background: "#1A0F00",       // warm-brown CRT chassis, very dark
			surface: "#241600",          // panel background, slightly lighter brown
			surfaceRecess: "#0E0700",    // input prompt void / depressed surface
			surfaceLifted: "#3A2500",    // sidebar / lifted panels — caramel highlight
			foreground: "#FFB000",       // P3 amber phosphor — classic CRT body text
			foregroundDim: "#9C6A00",    // dimmed amber, oxidized phosphor
			divider: "#5C3D00",          // burnt-amber line work, carved chassis edge
			accent: "#FFD700",            // bright amber-gold — focus / titles
			states: {
				idle: "#33FF33",       // P1 green phosphor — ready
				thinking: "#F0F0F0",   // white phosphor — electric cogitation
				tool: "#33D6FF",       // cyan phosphor — tooling
				approval: "#FF3333",   // red phosphor — danger
				learning: "#FF66FF",   // magenta phosphor — sacred memory writes
			},
		},
	},
	workingIndicator: {
		frames: AMBER_CRT_INDICATOR_FRAMES,
		intervalMs: AMBER_CRT_INDICATOR_INTERVAL_MS,
	},
	chrome: {
		// 0px radius globally — sharp 90-degree corners read as CRT chassis edge.
		...DEFAULT_CHROME,
		frame: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
		sectionGlyphs: {},
		sectionTracked: false,        // tighter letter spacing for retro CRT feel
		ruleChar: "═",                // double-line horizontal rule for chassis dividers
		tabActive: "■",
		tabInactive: "□",
		bullet: "▸",
	},
};
