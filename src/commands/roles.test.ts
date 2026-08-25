import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLES } from "../subagents/roles.js";
import { registerRolesCommand, runRolesCommand, writeRolesFile, type RolesCommandDeps, type RolesFileMutation } from "./roles.js";
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
	it("lists exactly one summary row per role on surface 1", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			loadRoles: () => ({ roles: BUILT_IN_ROLES, warnings: [] }),
			showPalette: queuedPalette([undefined], calls),
		}));

		const rows = calls[0]?.rows ?? [];
		expect(rows.slice(0, BUILT_IN_ROLES.length).map((row) => row.id)).toEqual(BUILT_IN_ROLES.map((role) => `role:${role.id}`));
		expect(rows.find((row) => row.id === "role:implement-cheap")?.value).toContain("low");
		expect(rows).toHaveLength(BUILT_IN_ROLES.length);
		expect(rows.some((row) => row.label.includes("$EDITOR"))).toBe(false);
		expect(rows.some((row) => row.label.includes("reset"))).toBe(false);
	});

	it("drills into the role's fields with current values on surface 2", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", undefined, undefined], calls),
		}));

		expect(calls[0]?.title).toBe("SUBAGENT ROLES");
		expect(calls[1]?.title).toBe("ROLE — RESEARCH");
		const rows = calls[1]?.rows ?? [];
		expect(rows).toContainEqual({ id: "field:research:model", label: "model", value: "inherit" });
		expect(rows).toContainEqual({ id: "field:research:tools", label: "tools", value: "read-only" });
		expect(rows).toContainEqual({ id: "field:research:systemPrompt", label: "system prompt", value: "(built-in)" });
	});

	it("esc from surface 2 walks back up to surface 1", async () => {
		const calls: SearchPaletteOptions[] = [];
		const result = await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", undefined, undefined], calls),
		}));

		expect(calls.map((call) => call.title)).toEqual(["SUBAGENT ROLES", "ROLE — RESEARCH", "SUBAGENT ROLES"]);
		expect(result).toBeUndefined();
	});

	it("lists inherit first, registry models with providers, and other last", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:model", undefined, undefined], calls),
			getAvailableModels: () => [
				{ id: "claude-opus-4-7", provider: "anthropic" },
				{ id: "gpt-5", provider: "openai" },
			],
		}));

		expect(calls[2]?.rows).toEqual([
			{ id: "inherit", label: "inherit", value: "use parent session's model" },
			{ id: "registry:0", label: "claude-opus-4-7", value: "anthropic" },
			{ id: "registry:1", label: "gpt-5", value: "openai" },
			{ id: "other", label: "other", value: "type provider/modelId…" },
		]);
	});

	it("writes exactly one sparse mutation for a registry model", async () => {
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:model", "registry:0", undefined, undefined]),
			getAvailableModels: () => [{ id: "claude-opus-4-7", provider: "anthropic" }],
			writeRolesFile: write,
		}));

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith({ kind: "set", roleId: "research", field: "model", value: "anthropic/claude-opus-4-7" });
		expect(result).toMatchObject({ kind: "success", message: "role updated — applies to the next spawn" });
	});

	it("preserves the provider when a registry model id contains a slash", async () => {
		const write = vi.fn();
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:model", "registry:0", undefined, undefined]),
			getAvailableModels: () => [{ id: "z-ai/glm-5.3", provider: "openrouter" }],
			writeRolesFile: write,
		}));

		expect(write).toHaveBeenCalledWith({
			kind: "set",
			roleId: "research",
			field: "model",
			value: "openrouter/z-ai/glm-5.3",
		});
	});

	it("routes the explicit other model path through input", async () => {
		const write = vi.fn();
		const input = vi.fn(async () => " openai/gpt-5 ");
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:model", "other", undefined, undefined]),
			input,
			writeRolesFile: write,
		}));

		expect(input).toHaveBeenCalledWith("model (provider/modelId)", "");
		expect(write).toHaveBeenCalledWith({ kind: "set", roleId: "research", field: "model", value: "openai/gpt-5" });
	});

	it("stays on surface 2 after a write, then walks up on esc", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:thinking", "high", undefined, undefined], calls),
		}));

		expect(calls.map((call) => call.title)).toEqual([
			"SUBAGENT ROLES",
			"ROLE — RESEARCH",
			"RESEARCH THINKING",
			"ROLE — RESEARCH",
			"SUBAGENT ROLES",
		]);
	});

	it("reflects a written value on the reopened surface 2", async () => {
		const calls: SearchPaletteOptions[] = [];
		let thinking: "high" | undefined;
		const write = vi.fn((mutation: RolesFileMutation) => {
			if (mutation.kind === "set" && mutation.field === "thinking") thinking = mutation.value as "high";
		});
		await runRolesCommand(commandDeps({
			loadRoles: () => ({
				roles: [{ ...research, ...(thinking ? { thinking } : {}) }],
				warnings: [],
			}),
			showPalette: queuedPalette(["role:research", "field:research:thinking", "high", undefined, undefined], calls),
			writeRolesFile: write,
		}));

		const rowsAfterWrite = calls[3]?.rows ?? [];
		expect(rowsAfterWrite.find((row) => row.id === "field:research:thinking")?.value).toBe("high");
	});

	it("degrades an empty model registry to inherit and other", async () => {
		const calls: SearchPaletteOptions[] = [];
		await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:model", undefined, undefined], calls),
			getAvailableModels: () => [],
		}));

		expect(calls[2]?.rows.map((row) => row.id)).toEqual(["inherit", "other"]);
	});

	it("writes explicit model inheritance for every role", async () => {
		for (const role of BUILT_IN_ROLES) {
			const write = vi.fn();
			await runRolesCommand(commandDeps({
				loadRoles: () => ({ roles: BUILT_IN_ROLES, warnings: [] }),
			showPalette: queuedPalette([`role:${role.id}`, `field:${role.id}:model`, "inherit", undefined, undefined]),
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
			showPalette: queuedPalette(["role:research", "field:research:model", undefined, undefined]),
			writeRolesFile: write,
		}));
		expect(write).not.toHaveBeenCalled();
	});

	it("selecting system prompt shows file instructions without writing or spawning", async () => {
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({
			showPalette: queuedPalette(["role:research", "field:research:systemPrompt", undefined, undefined]),
			writeRolesFile: write,
		}));
		expect(result).toMatchObject({ kind: "instructions", opened: false, message: expect.stringContaining("roles.json") });
		expect(write).not.toHaveBeenCalled();
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

	it("routes the RPC palette path through ctx.ui.select (custom() is a documented rpc no-op)", async () => {
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

		expect(select).toHaveBeenCalledTimes(1);
		expect(custom).not.toHaveBeenCalled();
	});
});
