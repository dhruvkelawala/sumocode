import { CATHEDRAL_THEME, SUMOCODE_STATE_NAMES, type SumoCodeState } from "./themes/index.js";

export const CATHEDRAL_TOKENS = CATHEDRAL_THEME.tokens;

export type { SumoCodeState };

export const SUMOCODE_STATES = [...SUMOCODE_STATE_NAMES] as SumoCodeState[];
