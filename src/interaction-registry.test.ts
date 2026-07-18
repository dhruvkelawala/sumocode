import { describe, expect, it, vi } from "vitest";
import { createInteractionRegistry, installSumoInteractions, type InteractionConflictDiagnostic } from "./interaction-registry.js";

function buildPiStub() {
	return {
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
	};
}

describe("InteractionRegistry", () => {
	it("registers commands once and reports duplicate ownership diagnostics", () => {
		const pi = buildPiStub();
		const reported: InteractionConflictDiagnostic[][] = [];
		const registry = createInteractionRegistry(pi as never, (diagnostics) => reported.push([...diagnostics]));

		registry.install("first", (api) => {
			api.registerCommand("sumo:memory", { description: "first", handler: async () => undefined });
		});
		registry.install("second", (api) => {
			api.registerCommand("sumo:memory", { description: "second", handler: async () => undefined });
		});
		registry.flushDiagnostics();

		expect(pi.registerCommand).toHaveBeenCalledTimes(1);
		expect(pi.registerCommand).toHaveBeenCalledWith("sumo:memory", expect.objectContaining({ description: "first" }));
		expect(reported).toEqual([
			[
				{
					kind: "command",
					id: "sumo:memory",
					owner: "second",
					conflictsWith: "first",
					action: "skipped",
				},
			],
		]);
	});

	it("registers shortcuts once and reports duplicate ownership diagnostics", () => {
		const pi = buildPiStub();
		const diagnostics: InteractionConflictDiagnostic[] = [];
		const registry = createInteractionRegistry(pi as never, (next) => diagnostics.push(...next));

		registry.install("palette", (api) => {
			api.registerShortcut("ctrl+/", { description: "palette", handler: () => undefined });
		});
		registry.install("other", (api) => {
			api.registerShortcut("ctrl+/", { description: "other", handler: () => undefined });
		});
		registry.flushDiagnostics();

		expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
		expect(diagnostics).toEqual([
			{
				kind: "shortcut",
				id: "ctrl+/",
				owner: "other",
				conflictsWith: "palette",
				action: "skipped",
			},
		]);
	});

	it("installs SumoCode commands and keybindings through one registry", () => {
		const pi = buildPiStub();
		const diagnostics: InteractionConflictDiagnostic[] = [];
		const snapshot = installSumoInteractions(pi as never, { reporter: (next) => diagnostics.push(...next) });

		expect(diagnostics).toEqual([]);
		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.commands.map(([id]) => id).sort()).toEqual([
			"exit",
			"slate",
			"sumo:bootstrap",
			"sumo:cursor",
			"sumo:diff",
			"sumo:memory",
			"sumo:persona",
			"sumo:query",
			"sumo:review",
			"sumo:ship",
			"sumo:spinner",
			"sumo:sync",
			"sumo:tabs",
			"sumo:theme",
			"sumo:theme-check",
			"sumo:worktree",
		]);
		expect(snapshot.shortcuts.map(([id]) => id).sort()).toEqual(["alt+t", "ctrl+/", "ctrl+1", "ctrl+2", "ctrl+shift+t"]);
		expect(pi.registerCommand).toHaveBeenCalledTimes(16);
		expect(pi.registerShortcut).toHaveBeenCalledTimes(5);
	});
});
