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

export interface ThemeWorkingIndicator {
	frames: readonly string[];
	intervalMs: number;
}

export interface Theme {
	name: string;
	displayName: string;
	description: string;
	tokens: ThemeTokens;
	workingIndicator: ThemeWorkingIndicator;
}
