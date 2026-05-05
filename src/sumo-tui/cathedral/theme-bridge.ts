import { createAttrs, type Cell } from "../render/cell.js";
import { activeThemeColors, setActiveTheme, type SumoCodeState, type ThemeColors } from "../../themes/index.js";

export type CathedralColorToken = keyof ThemeColors;
export type ThemeChangedListener = (themeName: string) => void;

let bridgeThemeVersion = 0;
const bridgeThemeListeners = new Set<ThemeChangedListener>();

export function getCathedralThemeVersion(): number {
	return bridgeThemeVersion;
}

export function onCathedralThemeChanged(listener: ThemeChangedListener): () => void {
	bridgeThemeListeners.add(listener);
	return () => bridgeThemeListeners.delete(listener);
}

export function emitCathedralThemeChanged(themeName: string): void {
	setActiveTheme(themeName);
	bridgeThemeVersion += 1;
	for (const listener of bridgeThemeListeners) listener(themeName);
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
	return activeThemeColors().states[state];
}

export function cathedralBackdropCell(): Cell {
	return cathedralCell({ bg: activeThemeColors().surfaceRecess, dim: true });
}

export function cathedralSurfaceCell(): Cell {
	return cathedralCell({ bg: activeThemeColors().surface });
}

export function cathedralRecessCell(): Cell {
	return cathedralCell({ bg: activeThemeColors().surfaceRecess });
}
