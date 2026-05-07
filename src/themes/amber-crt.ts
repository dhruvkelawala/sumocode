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
 * Sources of truth:
 *   - `docs/prd.md` § Themes (user story 22)
 *   - Mission Control v3's locked palette
 *   - Stitch design ref: `https://stitch.withgoogle.com/projects/5385606235875789209`
 *     ("SumoCode v0.1 — Amber CRT")
 *
 * Mood: warm dark brown-black CRT chassis with classic amber P3 phosphor
 * text, sharp 90-degree corners, double-line ASCII chrome, fleur-de-lis
 * memory bullets carried over from Cathedral. The five preattentive states
 * map to canonical CRT phosphor colours (green / white / cyan / red /
 * magenta) so they stay semantically distinct from Cathedral's earth tones
 * and Obsidian's sacred-tech neons.
 */
export const AMBER_CRT_THEME: Theme = {
	name: "amber-crt",
	displayName: "Amber CRT",
	description: "Mission Control mirror: warm-brown CRT chassis, amber P3 phosphor text, scanline indicator.",
	tokens: {
		colors: {
			background: "#0A0806",       // warm dark brown-black CRT chassis
			surface: "#14100A",          // top bar / status footer chassis trim
			surfaceRecess: "#070504",    // input prompt void / depressed surface
			surfaceLifted: "#1F180F",    // sidebar / lifted panels — caramel chassis
			foreground: "#FFB000",       // P3 amber phosphor — classic CRT body text
			foregroundDim: "#CC8C00",    // softer phosphor for muted text
			divider: "#4D3500",          // burnt-amber line work, carved chassis edge
			accent: "#FFD700",            // bright amber-gold — focus / titles
			states: {
				idle: "#00FF66",       // P1 green phosphor — ready
				thinking: "#F0F0F0",   // white phosphor — electric cogitation
				tool: "#00E5FF",       // cyan phosphor — tooling
				approval: "#FF5500",   // CRT-orange-red phosphor — danger
				learning: "#FF66FF",   // magenta phosphor — sacred memory writes
			},
		},
	},
	workingIndicator: {
		frames: AMBER_CRT_INDICATOR_FRAMES,
		intervalMs: AMBER_CRT_INDICATOR_INTERVAL_MS,
	},
	chrome: {
		// CRT chassis aesthetic. The chat-message frame, modal frame, and sidebar
		// dividers all read from `chrome.*`, so changing these glyphs gives Amber
		// CRT a visibly different identity from Cathedral (rounded `╭╮╰╯`) and
		// Obsidian (square `┌┐└┘` + Egyptian section glyphs).
		...DEFAULT_CHROME,
		// Double-line box drawing reads straight from DOS / VGA serial terminal
		// chrome and pairs naturally with the `═` rule char that the Stitch ref
		// uses for its `════ TITLE ════` banner headers.
		frame: { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║" },
		// Stitch ref renders banner-style section titles without prefix glyphs;
		// the double-line rule above each section is the visual marker.
		sectionGlyphs: {},
		sectionTracked: false,        // compact "CONTEXT" reads denser like htop
		ruleChar: "═",                // double-line horizontal rule for chassis dividers
		// Filled / hollow status circles match the Stitch `║ ● work-... ║` tab
		// affordance and read as live LED indicators.
		tabActive: "●",
		tabInactive: "○",
		// Stitch ref keeps the fleur-de-lis memory bullet from Cathedral; the
		// shared glyph reinforces "SumoCode" identity across themes while the
		// override colour pulls it into the CRT palette.
		bullet: "❧",
		bulletColor: "#FFD700",        // amber-gold bullets stand out against the chassis
	},
};
