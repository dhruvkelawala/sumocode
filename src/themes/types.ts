export const SUMOCODE_STATE_NAMES = ["idle", "thinking", "tool", "approval", "learning"] as const;

export type SumoCodeState = (typeof SUMOCODE_STATE_NAMES)[number];

export type ThemeStateColors = Record<SumoCodeState, string>;

export interface ThemeColors {
	background: string;
	surface: string;
	surfaceRecess: string;
	surfaceLifted: string;
	foreground: string;
	foregroundDim: string;
	divider: string;
	accent: string;
	states: ThemeStateColors;
}

export interface ThemeTokens {
	colors: ThemeColors;
}

export interface ThemeApplicationRoles {
	toolLedger: {
		surface: string;
		border: string;
		label: string;
		target: string;
		body: string;
		bodyMuted: string;
	};
	code: {
		surface: string;
		border: string;
		foreground: string;
		gutter: string;
		comment: string;
		keyword: string;
		string: string;
		number: string;
		function: string;
	};
}

export interface ThemeWorkingIndicatorEnhancedVariant {
	readonly name: string;
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly capabilityEnv: string;
	/**
	 * Cells of gap between the frame and the "Working…" label (default 1).
	 * Glyph fonts may overdraw their declared cell — the RunCat icomoon cat
	 * bleeds into the following cell, visually swallowing a single space —
	 * so enhanced variants can widen the gap without smuggling whitespace
	 * into the frame strings (frames stay one logical cell, no whitespace).
	 */
	readonly labelGapCells?: number;
}

export interface ThemeWorkingIndicator {
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly enhanced?: ThemeWorkingIndicatorEnhancedVariant;
}

export interface ResolvedThemeWorkingIndicator {
	/** "default" is reserved for the base variant; enhanced variants use their declared name. */
	readonly name: string;
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly capabilityEnv?: string;
	readonly capabilityState: "enabled" | "disabled" | "unrecognized";
	/** See ThemeWorkingIndicatorEnhancedVariant.labelGapCells. Always ≥ 1. */
	readonly labelGapCells: number;
}

/**
 * Structural chrome vocabulary — the box-drawing, glyphs, and typographic
 * conventions that give each theme its visual personality beyond color.
 *
 * Every rendering surface that emits structural characters (frame corners,
 * section banners, dividers, bullets) reads from the active theme's chrome
 * via `activeThemeChrome()` instead of hardcoding glyphs.
 *
 * To build a new theme, spread `DEFAULT_CHROME` and override what matters.
 */
export interface ThemeChrome {
	/** Chat message / modal frame box-drawing characters. */
	frame: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};

	/**
	 * Sidebar section header glyph prefixes.
	 * Key = lowercase section id ("context", "memory", "mcp", "session", "registry").
	 * Value = glyph string prepended to the header. Empty string = no glyph.
	 */
	sectionGlyphs: Partial<Record<string, string>>;

	/** Whether section header text uses letter-spacing ("C O N T E X T" vs "CONTEXT"). */
	sectionTracked: boolean;

	/** Character used for horizontal rule dividers in the sidebar. */
	ruleChar: string;

	/** Active tab marker glyph. */
	tabActive: string;

	/** Inactive tab marker glyph. */
	tabInactive: string;

	/** Memory / list item bullet glyph. */
	bullet: string;

	/** Bullet color hex override. Falls back to theme `accent` if omitted. */
	bulletColor?: string;
}

/** Cathedral chrome — the baseline structural vocabulary. Spread this in new themes. */
export const DEFAULT_CHROME: ThemeChrome = {
	frame: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	sectionGlyphs: {},
	sectionTracked: true,
	ruleChar: "━",
	tabActive: "◆",
	tabInactive: "▢",
	bullet: "❧",
};

export interface Theme {
	name: string;
	displayName: string;
	description: string;
	tokens: ThemeTokens;
	workingIndicator: ThemeWorkingIndicator;
	chrome: ThemeChrome;
	applicationRoles?: ThemeApplicationRoles;
}
