import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLES } from "../subagents/roles.js";
import { registerRolesCommand, runRolesCommand, writeRolesFile, type RolesCommandDeps } from "./roles.js";

const research = BUILT_IN_ROLES.find((role) => role.id === "research")!;

function commandDeps(overrides: Partial<RolesCommandDeps> = {}): RolesCommandDeps {
	return {
		rolesPath: "/agent/sumocode/roles.json",
		isTTY: true,
		loadRoles: () => ({ roles: [research], warnings: [] }),
		writeRolesFile: vi.fn(),
		select: vi.fn(async () => undefined),
		input: vi.fn(async () => undefined),
		openEditor: vi.fn(() => ({ status: 0 })),
		...overrides,
	};
}

describe("runRolesCommand", () => {
	it("writes only the selected field as a sparse role overlay mutation", async () => {
		const selections = [
			"research · Research · inherit · inherit",
			"model",
			"set a specific model…",
		];
		const write = vi.fn();
		const deps = commandDeps({
			select: vi.fn(async () => selections.shift()),
			input: vi.fn(async () => "openai/gpt-5"),
			writeRolesFile: write,
		});

		const result = await runRolesCommand(deps);

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith({ kind: "set", roleId: "research", field: "model", value: "openai/gpt-5" });
		expect(result).toMatchObject({ kind: "success", message: "role updated — applies to the next spawn" });
	});

	it("writes explicit model inheritance for every role through the same flow", async () => {
		const roles = BUILT_IN_ROLES;
		for (const role of roles) {
			const selections = [
				`${role.id} · ${role.label} · inherit · ${role.thinking ?? "inherit"}`,
				"model",
				"inherit (use parent session's model)",
			];
			const write = vi.fn();
			await runRolesCommand(commandDeps({
				loadRoles: () => ({ roles, warnings: [] }),
				select: vi.fn(async () => selections.shift()),
				writeRolesFile: write,
			}));
			expect(write).toHaveBeenCalledWith({ kind: "set", roleId: role.id, field: "model", value: "inherit" });
		}
	});

	it("returns path instructions without selecting or writing in a non-TTY context", async () => {
		const select = vi.fn();
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({ isTTY: false, select, writeRolesFile: write }));
		expect(result).toMatchObject({ kind: "instructions", opened: false, message: expect.stringContaining("/agent/sumocode/roles.json") });
		expect(select).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("exits silently when a selector is cancelled", async () => {
		const write = vi.fn();
		const result = await runRolesCommand(commandDeps({ select: vi.fn(async () => undefined), writeRolesFile: write }));
		expect(result).toBeUndefined();
		expect(write).not.toHaveBeenCalled();
	});

	it("writes the effective system prompt before opening the editor", async () => {
		const selections = ["research · Research · inherit · inherit", "system prompt"];
		const write = vi.fn();
		const openEditor = vi.fn(() => ({ status: 0 }));
		const result = await runRolesCommand(commandDeps({
			select: vi.fn(async () => selections.shift()),
			writeRolesFile: write,
			openEditor,
		}));
		expect(write.mock.calls[0]?.[0]).toEqual({ kind: "set-if-absent", roleId: "research", field: "systemPrompt", value: research.systemPrompt });
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
});
