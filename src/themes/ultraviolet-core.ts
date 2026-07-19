import { DEFAULT_CHROME, type Theme } from "./types.js";

/**
 * Ultraviolet Core spinner — an ASCII orbital pulse that expands to a bright
 * core and contracts again. Every frame is exactly one terminal cell.
 */
export const ULTRAVIOLET_CORE_INDICATOR_FRAMES = [".", ":", "o", "O", "@", "O", "o", ":"] as const;

export const ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS = 120;

export const ULTRAVIOLET_RUNCAT_FRAMES = ["\uE900", "\uE901", "\uE902", "\uE903", "\uE904"] as const;
export const ULTRAVIOLET_RUNCAT_INTERVAL_MS = 167;
export const ULTRAVIOLET_RUNCAT_CAPABILITY_ENV = "SUMOCODE_RUNCAT_FONT";

/**
 * Ultraviolet Core — SumoCode's high-impact violet command layer.
 *
 * Violet owns focus, active routing, frames, keywords, and selected structure.
 * Pale lavender owns sustained body text and idle/healthy state. Ice cyan is a
 * secondary operational/syntax signal, amber is localized to tools and numbers,
 * and pink owns approval/failure/interruption. Tool ledgers use a restrained
 * amber-tinted surface so dense tool output stays semantic without turning the
 * whole UI amber-dominant.
 */
export const ULTRAVIOLET_CORE_THEME: Theme = {
	name: "ultraviolet-core",
	displayName: "Ultraviolet Core",
	description: "Ultraviolet command layer — violet focus, ice signal, deep spatial surfaces.",
	tokens: {
		colors: {
			background: "#06050B",
			surface: "#0D0917",
			surfaceRecess: "#0A0711",
			surfaceLifted: "#1B102E",
			foreground: "#DCC7FF",
			foregroundDim: "#9B7BBE",
			divider: "#56347A",
			accent: "#B974FF",
			states: {
				idle: "#DCC7FF",
				thinking: "#B974FF",
				tool: "#FFC857",
				approval: "#FF668F",
				learning: "#75E8FF",
			},
		},
	},
	workingIndicator: {
		frames: ULTRAVIOLET_CORE_INDICATOR_FRAMES,
		intervalMs: ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS,
		enhanced: {
			name: "runcat",
			frames: ULTRAVIOLET_RUNCAT_FRAMES,
			intervalMs: ULTRAVIOLET_RUNCAT_INTERVAL_MS,
			capabilityEnv: ULTRAVIOLET_RUNCAT_CAPABILITY_ENV,
		},
	},
	chrome: {
		...DEFAULT_CHROME,
		frame: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		sectionGlyphs: { context: ">", memory: "+", mcp: "*", session: "~", registry: "#" },
		sectionTracked: false,
		ruleChar: "─",
		tabActive: ">",
		tabInactive: ".",
		bullet: ">",
	},
	applicationRoles: {
		toolLedger: {
			// In-family with the violet palette (mirrors the `code` roles below
			// and how every other theme colors its tool ledger). The prior
			// gold/brown values were authored out-of-palette and clashed with
			// the theme's violet chat frames.
			surface: "#100A1D",
			border: "#56347A",
			label: "#B974FF",
			target: "#DCC7FF",
			body: "#DCC7FF",
			bodyMuted: "#9B7BBE",
		},
		code: {
			surface: "#100A1D",
			border: "#56347A",
			foreground: "#DCC7FF",
			gutter: "#9B7BBE",
			comment: "#9B7BBE",
			keyword: "#B974FF",
			string: "#75E8FF",
			number: "#FFC857",
			function: "#75E8FF",
		},
	},
};
