import { AMBER_CRT_THEME } from "./amber-crt.js";
import { CATHEDRAL_THEME } from "./cathedral.js";
import { OBSIDIAN_THEME } from "./obsidian.js";
import type { Theme, ThemeChrome, ThemeColors, ThemeTokens } from "./types.js";

export type ThemeChangedListener = (theme: Theme) => void;
export type SetThemeResult = { success: true; theme: Theme } | { success: false; error: string };

/**
 * Pin the theme registry on `globalThis` because the retained
 * `sumo-interactive-mode.js` jiti loader uses `moduleCache: false`. Without
 * this, SumoInteractiveMode and the extension code each get a private copy of
 * `listeners`, `activeThemeName`, and the registry Map — `setActiveTheme()`
 * fires listeners in one copy while subscribers live on the other, so the
 * retained chrome never repaints on theme switch.
 *
 * Mirrors the `ACTIVE_SUMO_RUNTIME_KEY` pattern in
 * `sumo-interactive-mode.ts` and the diagnostic singleton in
 * `render-diagnostics.ts`.
 */
const REGISTRY_KEY = Symbol.for("sumocode.themeRegistry");

interface ThemeRegistryState {
	registry: Map<string, Theme>;
	listeners: Set<ThemeChangedListener>;
	activeThemeName: string;
	themeVersion: number;
}

function ensureState(): ThemeRegistryState {
	const host = globalThis as unknown as Record<symbol, ThemeRegistryState | undefined>;
	let state = host[REGISTRY_KEY];
	if (!state) {
		state = {
			registry: new Map<string, Theme>([
				[CATHEDRAL_THEME.name, CATHEDRAL_THEME],
				[OBSIDIAN_THEME.name, OBSIDIAN_THEME],
				[AMBER_CRT_THEME.name, AMBER_CRT_THEME],
			]),
			listeners: new Set<ThemeChangedListener>(),
			activeThemeName: CATHEDRAL_THEME.name,
			themeVersion: 0,
		};
		host[REGISTRY_KEY] = state;
		return state;
	}
	// Re-imported module copies must observe newly-shipped builtin themes added
	// after the first state was created (e.g. Obsidian Temple landed on a later
	// require chain). Defensive merge keeps cross-copy registries aligned.
	if (!state.registry.has(OBSIDIAN_THEME.name)) state.registry.set(OBSIDIAN_THEME.name, OBSIDIAN_THEME);
	if (!state.registry.has(CATHEDRAL_THEME.name)) state.registry.set(CATHEDRAL_THEME.name, CATHEDRAL_THEME);
	if (!state.registry.has(AMBER_CRT_THEME.name)) state.registry.set(AMBER_CRT_THEME.name, AMBER_CRT_THEME);
	return state;
}

function normalizeThemeName(name: string): string {
	return name.trim().toLowerCase();
}

export function listThemes(): Theme[] {
	return [...ensureState().registry.values()];
}

export function getTheme(name: string): Theme | undefined {
	return ensureState().registry.get(normalizeThemeName(name));
}

export function getActiveTheme(): Theme {
	const state = ensureState();
	return state.registry.get(state.activeThemeName) ?? CATHEDRAL_THEME;
}

export function activeThemeTokens(): ThemeTokens {
	return getActiveTheme().tokens;
}

export function activeThemeColors(): ThemeColors {
	return getActiveTheme().tokens.colors;
}

export function activeThemeChrome(): ThemeChrome {
	return getActiveTheme().chrome;
}

export function getThemeVersion(): number {
	return ensureState().themeVersion;
}

export function setActiveTheme(name: string): SetThemeResult {
	const state = ensureState();
	const theme = state.registry.get(normalizeThemeName(name));
	if (!theme) return { success: false, error: `Unknown SumoCode theme: ${name}` };
	state.activeThemeName = theme.name;
	state.themeVersion += 1;
	for (const listener of state.listeners) listener(theme);
	return { success: true, theme };
}

export function nextThemeName(currentName: string = getActiveTheme().name): string {
	const names = listThemes().map((theme) => theme.name);
	if (names.length === 0) return currentName;
	const currentIndex = names.indexOf(currentName);
	const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % names.length;
	return names[nextIndex]!;
}

export function cycleActiveTheme(): Theme {
	const result = setActiveTheme(nextThemeName());
	if (!result.success) return getActiveTheme();
	return result.theme;
}

export function onThemeChanged(listener: ThemeChangedListener): () => void {
	const state = ensureState();
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

export function resetThemeRegistryForTests(): void {
	const state = ensureState();
	state.activeThemeName = CATHEDRAL_THEME.name;
	state.themeVersion = 0;
	state.listeners.clear();
}
