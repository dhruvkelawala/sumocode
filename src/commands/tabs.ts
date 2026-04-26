/**
 * `/sumo:tabs hide|show` slash command — controls the top chrome bar's
 * visibility. Persists a per-machine flag in `~/.sumocode/local-config.json`
 * (intentionally NOT synced through the config repo, per the existing
 * sidebarAnchor pattern from #13).
 *
 * When `topChromeHidden` is true:
 *   - SUMOCODE label still renders
 *   - all other top-bar regions (sessions, ARCHIVE, icons) hide
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TABS_LOCAL_CONFIG_KEY = "topChromeHidden" as const;
export const DEFAULT_TABS_CONFIG_PATH = join(homedir(), ".sumocode", "local-config.json");

/**
 * Read the topChromeHidden flag from a local-config.json file.
 * Returns false if file missing, malformed, or key absent.
 */
export function isTopChromeHidden(configPath: string = DEFAULT_TABS_CONFIG_PATH): boolean {
	try {
		if (!existsSync(configPath)) return false;
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return parsed[TABS_LOCAL_CONFIG_KEY] === true;
	} catch {
		return false;
	}
}

/**
 * Write the topChromeHidden flag into the local-config.json file. Preserves
 * any other keys present in the file. Creates the file (and key) if missing.
 */
export function setTopChromeHidden(hidden: boolean, configPath: string = DEFAULT_TABS_CONFIG_PATH): void {
	let parsed: Record<string, unknown> = {};
	try {
		if (existsSync(configPath)) {
			parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
			if (typeof parsed !== "object" || parsed === null) parsed = {};
		}
	} catch {
		parsed = {};
	}
	parsed[TABS_LOCAL_CONFIG_KEY] = hidden;
	writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Register the `/sumo:tabs hide|show` slash command. Optional `configPath`
 * override is for tests.
 */
export function registerTabsCommand(
	pi: ExtensionAPI,
	options: { configPath?: string } = {},
): void {
	const configPath = options.configPath ?? DEFAULT_TABS_CONFIG_PATH;

	pi.registerCommand("sumo:tabs", {
		description: "show or hide the top chrome bar (SUMOCODE label always stays)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "hide") {
				setTopChromeHidden(true, configPath);
				ctx.ui.notify("top chrome hidden — restart pi to apply", "info");
				return;
			}
			if (arg === "show") {
				setTopChromeHidden(false, configPath);
				ctx.ui.notify("top chrome visible — restart pi to apply", "info");
				return;
			}
			const current = isTopChromeHidden(configPath);
			ctx.ui.notify(`top chrome currently ${current ? "hidden" : "visible"}`, "info");
		},
	});
}
