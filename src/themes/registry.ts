import { AMBER_CRT_THEME } from "./amber-crt.js";
import { CATHEDRAL_THEME } from "./cathedral.js";
import { HERDR_THEME } from "./herdr.js";
import { OBSIDIAN_THEME } from "./obsidian.js";
import { ULTRAVIOLET_CORE_THEME } from "./ultraviolet-core.js";
import type { Theme, ThemeApplicationRoles, ThemeChrome, ThemeColors, ThemeTokens } from "./types.js";

export type ThemeChangedListener = (theme: Theme) => void;
export type SetThemeResult = { success: true; theme: Theme } | { success: false; error: string };

/**
 * Pin the theme registry on `globalThis` so extension reloads and RPC child
 * re-imports keep a shared theme registry. Without this, separate module
 * copies can each get a private `listeners`, `activeThemeName`, and registry
 * Map, so `setActiveTheme()` would fire listeners in one copy while
 * subscribers live on another.
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
		// Registry insertion order is the user-visible cycle order for both
		// `Ctrl+Shift+T` and `/sumo:theme list`. PRD § Themes pins cathedral
		// first, amber-crt second, obsidian third, herdr fourth, and ultraviolet-core
		// fifth — do not reorder without an explicit PRD change.
		state = {
			registry: new Map<string, Theme>([
				[CATHEDRAL_THEME.name, CATHEDRAL_THEME],
				[AMBER_CRT_THEME.name, AMBER_CRT_THEME],
				[OBSIDIAN_THEME.name, OBSIDIAN_THEME],
				[HERDR_THEME.name, HERDR_THEME],
				[ULTRAVIOLET_CORE_THEME.name, ULTRAVIOLET_CORE_THEME],
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
	// Defensive merges for re-imported module copies. Insertion order on a
	// pre-existing state is whatever the original copy seeded; once that copy
	// is gone the next `ensureState` call falls back to the canonical order
	// above.
	if (!state.registry.has(CATHEDRAL_THEME.name)) state.registry.set(CATHEDRAL_THEME.name, CATHEDRAL_THEME);
	if (!state.registry.has(AMBER_CRT_THEME.name)) state.registry.set(AMBER_CRT_THEME.name, AMBER_CRT_THEME);
	if (!state.registry.has(OBSIDIAN_THEME.name)) state.registry.set(OBSIDIAN_THEME.name, OBSIDIAN_THEME);
	if (!state.registry.has(HERDR_THEME.name)) state.registry.set(HERDR_THEME.name, HERDR_THEME);
	if (!state.registry.has(ULTRAVIOLET_CORE_THEME.name)) state.registry.set(ULTRAVIOLET_CORE_THEME.name, ULTRAVIOLET_CORE_THEME);
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

export function activeThemeApplicationRoles(): ThemeApplicationRoles {
	const theme = getActiveTheme();
	if (theme.applicationRoles) return theme.applicationRoles;
	const colors = theme.tokens.colors;
	return {
		toolLedger: {
			surface: colors.surfaceRecess,
			border: colors.divider,
			label: colors.accent,
			target: colors.foreground,
			body: colors.foreground,
			bodyMuted: colors.foregroundDim,
		},
		code: {
			surface: colors.surfaceRecess,
			border: colors.divider,
			foreground: colors.foreground,
			gutter: colors.foregroundDim,
			// Compatibility fallback: preserves the pre-Plan-075 Cathedral code
			// renderer's comment color for existing first-party themes. New themes
			// that need syntax ownership should provide a complete code role set.
			comment: "#6F5D46",
			keyword: colors.accent,
			string: colors.states.idle,
			number: colors.states.thinking,
			function: colors.states.thinking,
		},
	};
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
