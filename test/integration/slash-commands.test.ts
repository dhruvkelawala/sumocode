import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCommandPalette } from "../../src/command-palette.js";
import { registerMemoryCommand } from "../../src/memory-editor.js";
import { registerPersonaCommand } from "../../src/commands/persona.js";
import { registerSpinnerCommand } from "../../src/commands/spinner.js";
import { registerTabsCommand } from "../../src/commands/tabs.js";
import { registerThemeCommand } from "../../src/commands/theme.js";
import { registerThemeCheckCommand } from "../../src/commands/theme-check.js";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

function commandRegistry(): { pi: ExtensionAPI; commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> } {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = {
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options);
		},
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		sendMessage: () => undefined,
		on: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function retainedModeEnv(): Record<string, string> {
	return {
		SUMO_TUI: "1",
		SUMO_TUI_MODULE: pathToFileURL(resolve(process.cwd(), "sumo-interactive-mode.js")).href,
		CMUX_WORKSPACE_ID: "",
		CMUX_SURFACE_ID: "",
	};
}

describe("Phase 4 slash command pipe", () => {
	let app: SpawnedPiPty | undefined;
	afterEach(() => {
		app?.cleanup();
		app = undefined;
	});
	it("surfaces all /sumo:* commands for autocomplete providers", () => {
		const { pi, commands } = commandRegistry();

		installCommandPalette(pi);
		registerTabsCommand(pi, { configPath: "/tmp/sumocode-tabs-test.json" });
		registerThemeCommand(pi);
		registerPersonaCommand(pi, {
			personaPath: "/tmp/sumocode-persona.md",
			fileExists: () => true,
			runEditor: () => ({ status: 0 }),
		});
		registerSpinnerCommand(pi);
		registerThemeCheckCommand(pi);
		registerMemoryCommand(pi);

		const suggestions = [...commands.keys()].filter((name) => name.startsWith("sumo:")).sort();

		expect(suggestions).toEqual([
			"sumo:memory",
			"sumo:persona",
			"sumo:spinner",
			"sumo:tabs",
			"sumo:theme",
			"sumo:theme-check",
		]);
	});

	it("dispatches /sumo:worktree from the retained editor", async () => {
		app = spawnPiPty({
			args: ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
			env: retainedModeEnv(),
		});
		await app.waitForOutput(/DIVINE INVOCATION/, 20_000);

		app.sendInput("/sumo:worktree build thing");
		// Wait for the editor to render the full command before submitting, then
		// clear the 50ms raw-paste CR window (RAW_PASTE_CR_WINDOW_MS in
		// cathedral-editor.ts) with ample margin. A separate "\r" that lands within
		// that window is treated as pasted text, not Enter — under CI load the old
		// fixed 75ms delay was too tight and the command never submitted.
		await app.waitForOutput(/\/sumo:worktree build thing/, 20_000);
		await new Promise((resolve) => setTimeout(resolve, 200));
		app.sendInput("\r");

		await app.waitForOutput(/\/sumo:worktree requires a cmux surface/, 20_000);
	}, 45_000);
});
