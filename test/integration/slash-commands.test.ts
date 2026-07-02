import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installCommandPalette } from "../../src/command-palette.js";
import { registerMemoryCommand } from "../../src/memory-editor.js";
import { registerPersonaCommand } from "../../src/commands/persona.js";
import { registerSpinnerCommand } from "../../src/commands/spinner.js";
import { registerTabsCommand } from "../../src/commands/tabs.js";
import { registerThemeCommand } from "../../src/commands/theme.js";
import { registerThemeCheckCommand } from "../../src/commands/theme-check.js";

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

describe("Phase 4 slash command pipe", () => {
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
});
