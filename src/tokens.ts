export const CATHEDRAL_TOKENS = {
	colors: {
		background: "#1A1511",
		surface: "#241D17",
		surfaceRecess: "#120D0A",
		surfaceLifted: "#3D3024",
		foreground: "#F5E6C8",
		foregroundDim: "#8B7A63",
		divider: "#3A2F25",
		accent: "#D97706",
		states: {
			idle: "#7FB069",
			thinking: "#E8B339",
			tool: "#5B9BD5",
			approval: "#C1443E",
			learning: "#8E7AB5",
		},
	},
} as const;

export type SumoCodeState = keyof typeof CATHEDRAL_TOKENS.colors.states;

export const SUMOCODE_STATES = Object.keys(CATHEDRAL_TOKENS.colors.states) as SumoCodeState[];
