import { loadSumoCodeConfig, type LoadSumoCodeConfigOptions } from "../config/sumocode-config.js";
import { getTheme, setActiveTheme } from "./registry.js";

/**
 * Resolve the theme name a fresh process should boot with: the user's
 * configured theme if it names a real registry entry, otherwise Obsidian.
 * Registry insertion order keeps Cathedral as the *default* active theme for
 * tests and non-runtime module imports (see registry.ts), so callers that
 * skip this resolution silently render Cathedral instead of honoring
 * `~/.pi/agent/sumocode.json`'s `themeName` (or falling back to Obsidian).
 *
 * Both the in-process extension boot path (`extension.ts`) and the RPC host
 * boot path (`sumo-tui/rpc/host.ts`) must use this — one process resolving
 * differently from the other is exactly the drift this helper exists to
 * prevent.
 */
export function resolveStartupThemeName(options: LoadSumoCodeConfigOptions = {}): string {
	const configuredThemeName = loadSumoCodeConfig(options).config.themeName;
	return configuredThemeName && getTheme(configuredThemeName) ? configuredThemeName : "obsidian";
}

/**
 * Resolve and apply the startup theme. Must run before the first frame
 * renders / before any runtime or shell is constructed, so first paint
 * already uses the chosen palette instead of the registry default.
 */
export function applyStartupTheme(options: LoadSumoCodeConfigOptions = {}): string {
	const themeName = resolveStartupThemeName(options);
	setActiveTheme(themeName);
	return themeName;
}
