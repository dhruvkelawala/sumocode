import { createAttrs, type Cell } from "../render/cell.js";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "../../tokens.js";

export type CathedralColorToken = keyof typeof CATHEDRAL_TOKENS.colors;
export type ThemeChangedListener = (themeName: string) => void;

let themeVersion = 0;
const themeListeners = new Set<ThemeChangedListener>();

export function getCathedralThemeVersion(): number {
	return themeVersion;
}

export function onCathedralThemeChanged(listener: ThemeChangedListener): () => void {
	themeListeners.add(listener);
	return () => themeListeners.delete(listener);
}

export function emitCathedralThemeChanged(themeName: string): void {
	themeVersion += 1;
	for (const listener of themeListeners) listener(themeName);
}

export function cathedralCell(options: { char?: string; fg?: string; bg?: string; dim?: boolean } = {}): Cell {
	return {
		char: options.char ?? " ",
		fg: options.fg,
		bg: options.bg,
		attrs: createAttrs({ dim: options.dim ?? false }),
	};
}

export function cathedralStateColor(state: SumoCodeState): string {
	return CATHEDRAL_TOKENS.colors.states[state];
}

export function cathedralBackdropCell(): Cell {
	return cathedralCell({ bg: CATHEDRAL_TOKENS.colors.surfaceRecess, dim: true });
}

export function cathedralSurfaceCell(): Cell {
	return cathedralCell({ bg: CATHEDRAL_TOKENS.colors.surface });
}

export function cathedralRecessCell(): Cell {
	return cathedralCell({ bg: CATHEDRAL_TOKENS.colors.surfaceRecess });
}
