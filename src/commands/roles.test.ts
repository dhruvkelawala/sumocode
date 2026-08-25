import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLES } from "../subagents/roles.js";
import { registerRolesCommand, runRolesCommand, writeRolesFile, type RolesCommandDeps } from "./roles.js";
import type { SearchPaletteOptions } from "./roles-palette.js";

const research = BUILT_IN_ROLES.find((role) => role.id === "research")!;

function commandDeps(overrides: Partial<RolesCommandDeps> = {}): RolesCommandDeps {
	return {
		rolesPath: "/agent/sumocode/roles.json",
		isTTY: true,
		loadRoles: () => ({ roles: [research], warnings: [] }),
		writeRolesFile: vi.fn(),
		showPalette: vi.fn(async () => undefined),
		getAvailableModels: () => [],
		input: vi.fn(async () => undefined),
		openEditor: vi.fn(() => ({ status: 0 })),
		...overrides,
	};
}

function queuedPalette(selections: Array<string | undefined>, calls: SearchPaletteOptions[] = []): RolesCommandDeps["showPalette"] {
	return vi.fn(async (options) => {
		calls.push(options);
		return selections.shift();
	});
}

describe("runRolesCommand", () => {
	it("shows every role×field row with its current value on surface 1", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			loadRoles: () => ({ roles: BUILT_IN_ROLES, warnings: [] }),
			showPalette: queuedPalette([undefined], calls),
		}));

		const rows = calls[0]?.rows ?? [];
		for (const role of BUILT_IN_ROLES) {
			for (const field of ["model", "thinking", "tools", "worktree", "visible", "system prompt"]) {
				expect(rows.some((row) => row.label === `${role.id} ${field}`)).toBe(true);
			}
		}
		expect(rows).toContainEqual({ id: "field:research:model", label: "research model", value: "inherit" });
		expect(rows).toContainEqual({ id: "field:research:tools", label: "research tools", value: "read-only" });
		expect(rows).toContainEqual({ id: "field:research:systemPrompt", label: "research system prompt", value: "(built-in)" });
		expect(rows.slice(-2).map((row) => row.label)).toEqual(["open roles.json in $EDITOR", "reset a role to built-in…"]);
	});

	it("lists inherit first, registry models with providers, and other last", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:model", undefined, undefined], calls),
			getAvailableModels: () => [
				{ id: "claude-opus-4-7", provider: "anthropic" },
				{ id: "gpt-5", provider: "openai" },
			],
		}));

		expect(calls[1]?.rows).toEqual([
			{ id: "inherit", label: "inherit", value: "use parent session's model" },
			{ id: "registry:0", label: "claude-opus-4-7", value: "anthropic" },
			{ id: "registry:1", label: "gpt-5", value: "openai" },
			{ id: "other", label: "other", value: "type provider/modelId…" },
		]);
	});

	it("writes exactly one sparse mutation for a registry model", async () => {
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:model", "registry:0", undefined]),
			getAvailableModels: () => [{ id: "claude-opus-4-7", provider: "anthropic" }],
			writeRolesFile: write,
		}));

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith({ kind: "set", roleId: "research", field: "model", value: "anthropic/claude-opus-4-7" });
		expect(result).toMatchObject({ kind: "success", message: "role updated — applies to the next spawn" });
	});

	it("routes the explicit other model path through input", async () => {
		const write = vi.fn();
		const input = vi.fn(async () => " openai/gpt-5 ");
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:model", "other", undefined]),
			input,
			writeRolesFile: write,
		}));

		expect(input).toHaveBeenCalledWith("model (provider/modelId)", "");
		expect(write).toHaveBeenCalledWith({ kind: "set", roleId: "research", field: "model", value: "openai/gpt-5" });
	});

	it("reopens surface 1 after a write", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:thinking", "high", undefined], calls),
		}));

		expect(calls.map((call) => call.title)).toEqual(["SUBAGENT ROLES", "RESEARCH THINKING", "SUBAGENT ROLES"]);
	});

	it("degrades an empty model registry to inherit and other", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:model", undefined, undefined], calls),
			getAvailableModels: () => [],
		}));

		expect(calls[1]?.rows.map((row) => row.id)).toEqual(["inherit", "other"]);
	});

	it("writes explicit model inheritance for every role", async () => {
		for (const role of BUILT_IN_ROLES) {
			const write = vi.fn();
			await runRolesCommand(commandDeps({
				loadRoles: () => ({ roles: BUILT_IN_ROLES, warnings: [] }),
				showPalette: queuedPalette([`field:${role.id}:model`, "inherit", undefined]),
				writeRolesFile: write,
			}));
			expect(write).toHaveBeenCalledWith({ kind: "set", roleId: role.id, field: "model", value: "inherit" });
		}
	});

	it("returns path instructions without opening a palette or writing in a non-TTY context", async () => {
		const showPalette = vi.fn();
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({ isTTY: false, showPalette, writeRolesFile: write }));
		expect(result).toMatchObject({ kind: "instructions", opened: false, message: expect.stringContaining("/agent/sumocode/roles.json") });
		expect(showPalette).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("exits silently when surface 1 is cancelled", async () => {
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({ showPalette: queuedPalette([undefined]), writeRolesFile: write }));
		expect(result).toBeUndefined();
		expect(write).not.toHaveBeenCalled();
	});

	it("writes nothing when a value picker is cancelled", async () => {
		const write = vi.fn();
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:model", undefined, undefined]),
			writeRolesFile: write,
		}));
		expect(write).not.toHaveBeenCalled();
	});

	it("writes the effective system prompt before opening the editor", async () => {
		const write = vi.fn();
		const openEditor = vi.fn(() => ({ status: 0 }));
		const result = await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["field:research:systemPrompt", undefined]),
			writeRolesFile: write,
			openEditor,
		}));
		expect(write.mock.calls[0]?.[0]).toEqual({ kind: "set-if-absent", roleId: "research", field: "systemPrompt", value: research.systemPrompt });
		expect(write.mock.calls[1]?.[0]).toEqual({ kind: "ensure" });
		expect(openEditor).toHaveBeenCalledWith("/agent/sumocode/roles.json");
		expect(result).toMatchObject({ kind: "success", opened: true });
	});
});

describe("writeRolesFile", () => {
	it("creates a missing roles.json and keeps the overlay sparse", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-roles-command-"));
		const path = join(dir, "nested", "sumocode", "roles.json");
		try {
			writeRolesFile(path, { kind: "set", roleId: "research", field: "model", value: "inherit" });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ roles: [{ id: "research", model: "inherit" }] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resets one built-in role without disturbing other overlays", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-roles-reset-"));
		const path = join(dir, "roles.json");
		try {
			writeRolesFile(path, { kind: "set", roleId: "research", field: "thinking", value: "high" });
			writeRolesFile(path, { kind: "set", roleId: "review", field: "thinking", value: "low" });
			writeRolesFile(path, { kind: "reset", roleId: "research" });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ roles: [{ id: "review", thinking: "low" }] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("registerRolesCommand", () => {
	it("registers sumo:roles for the command palette", () => {
		const registerCommand = vi.fn();
		registerRolesCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith("sumo:roles", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
	});

	it("uses ctx.ui.custom for the RPC palette path", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		registerRolesCommand({ registerCommand } as never);
		const custom = vi.fn(async () => undefined);
		const select = vi.fn(async () => undefined);

		await handler?.("", {
			hasUI: true,
			mode: "rpc",
			ui: { custom, select, input: vi.fn(), notify: vi.fn() },
			modelRegistry: { getAvailable: () => [] },
		});

		expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
		expect(select).not.toHaveBeenCalled();
	});
});
