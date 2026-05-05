import { CATHEDRAL_THEME } from "./cathedral.js";
import type { Theme, ThemeColors, ThemeTokens } from "./types.js";

export type ThemeChangedListener = (theme: Theme) => void;
export type SetThemeResult = { success: true; theme: Theme } | { success: false; error: string };

function normalizeThemeName(name: string): string {
	return name.trim().toLowerCase();
}

const registry = new Map<string, Theme>([[CATHEDRAL_THEME.name, CATHEDRAL_THEME]]);
const listeners = new Set<ThemeChangedListener>();

let activeThemeName = CATHEDRAL_THEME.name;
let themeVersion = 0;

export function listThemes(): Theme[] {
	return [...registry.values()];
}

export function getTheme(name: string): Theme | undefined {
	return registry.get(normalizeThemeName(name));
}

export function getActiveTheme(): Theme {
	return registry.get(activeThemeName) ?? CATHEDRAL_THEME;
}

export function activeThemeTokens(): ThemeTokens {
	return getActiveTheme().tokens;
}

export function activeThemeColors(): ThemeColors {
	return getActiveTheme().tokens.colors;
}

export function getThemeVersion(): number {
	return themeVersion;
}

export function setActiveTheme(name: string): SetThemeResult {
	const theme = getTheme(name);
	if (!theme) return { success: false, error: `Unknown SumoCode theme: ${name}` };
	activeThemeName = theme.name;
	themeVersion += 1;
	for (const listener of listeners) listener(theme);
	return { success: true, theme };
}

export function onThemeChanged(listener: ThemeChangedListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function resetThemeRegistryForTests(): void {
	activeThemeName = CATHEDRAL_THEME.name;
	themeVersion = 0;
	listeners.clear();
}
