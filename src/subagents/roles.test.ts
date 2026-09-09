import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS } from "../native-task-config.js";
import { BUILT_IN_ROLES, loadRoles, resolveRolesPath } from "./roles.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper: serializes arbitrary JSON fixtures into the roles.json read boundary.
const fromJson = (value: unknown) => loadRoles({
	readFile: () => JSON.stringify(value),
	env: { PI_CODING_AGENT_DIR: "/agent" },
});

describe("subagent roles", () => {
	it("ships six well-formed model-inheriting built-ins", () => {
		expect(BUILT_IN_ROLES.map((role) => role.id)).toEqual([
			"research",
			"review",
			"documentor",
			"designer",
			"implement-cheap",
			"implement-smart",
		]);
		expect(new Set(BUILT_IN_ROLES.map((role) => role.id)).size).toBe(BUILT_IN_ROLES.length);
		for (const role of BUILT_IN_ROLES) {
			expect(role.label).not.toBe("");
			expect(role.description).not.toBe("");
			expect(role.systemPrompt).not.toBe("");
			expect(role.model).toBeUndefined();
			for (const tool of role.tools ?? []) expect(BUILT_IN_TOOLS).toContain(tool);
		}
	});

	it("splits write-capable roles into isolated worktrees and keeps read-only roles in the shared checkout", () => {
		const byId = new Map(BUILT_IN_ROLES.map((role) => [role.id, role]));
		expect(byId.get("research")?.defaultWorktree).toBeUndefined();
		expect(byId.get("review")?.defaultWorktree).toBeUndefined();
		expect(byId.get("documentor")?.defaultWorktree).toBe(true);
		expect(byId.get("designer")?.defaultWorktree).toBe(true);
		expect(byId.get("implement-cheap")?.defaultWorktree).toBe(true);
		expect(byId.get("implement-smart")?.defaultWorktree).toBe(true);
	});

	it("merges built-in overrides field by field", () => {
		const loaded = fromJson({ roles: [{ id: "research", label: "Deep Research", thinking: "high" }] });
		const role = loaded.roles.find((candidate) => candidate.id === "research");
		expect(role).toMatchObject({ label: "Deep Research", thinking: "high", tools: ["read", "grep", "find", "ls", "bash"] });
		expect(role?.systemPrompt).toContain("read-only investigator");
		expect(loaded.warnings).toEqual([]);
	});

	it("rejects empty built-in instruction overrides instead of erasing the role contract", () => {
		const loaded = fromJson({ roles: [{ id: "research", systemPrompt: "   " }] });
		const role = loaded.roles.find((candidate) => candidate.id === "research");
		expect(role?.systemPrompt).toContain("read-only investigator");
		expect(loaded.warnings).toEqual([{ scope: "role", roleId: "research", blocksRole: true, message: "role research has an invalid systemPrompt; entry skipped" }]);
	});

	it("accepts complete new roles and rejects incomplete ones", () => {
		const loaded = fromJson({ roles: [
			{ id: "security", label: "Security", systemPrompt: "audit security", description: "use for security audits" },
			{ id: "missing-prompt", label: "Missing" },
		] });
		expect(loaded.roles.find((role) => role.id === "security")).toMatchObject({ label: "Security", systemPrompt: "audit security" });
		expect(loaded.roles.some((role) => role.id === "missing-prompt")).toBe(false);
		expect(loaded.warnings.map((warning) => warning.message).join("\n")).toContain("requires label and systemPrompt");
	});

	it("skips invalid entries, ignores unknown fields, and drops invalid tools", () => {
		const loaded = fromJson({ roles: [
			{ id: "research", thinking: "enormous" },
			{ id: "review", tools: ["read", "mcp", 42, "read"], futureField: true },
			"invalid",
		] });
		expect(loaded.roles.find((role) => role.id === "research")?.thinking).toBeUndefined();
		expect(loaded.roles.find((role) => role.id === "review")?.tools).toEqual(["read"]);
		const warningText = loaded.warnings.map((warning) => warning.message).join("\n");
		expect(warningText).toContain("invalid thinking");
		expect(warningText).toContain("unknown field futureField");
		expect(warningText).toContain("invalid tool mcp");
		expect(warningText).toContain("must be an object");
	});

	it("scopes role warnings to an affected role or the whole file", () => {
		const loaded = fromJson({ roles: [
			{ id: "research", thinking: "enormous" },
			{ id: "review", tools: ["read", "mcp"] },
			"invalid",
		] });

		expect(loaded.warnings).toEqual([
			{ scope: "role", roleId: "research", blocksRole: true, message: "role research has an invalid thinking level; entry skipped" },
			{ scope: "role", roleId: "review", blocksRole: false, message: "role review ignores invalid tool mcp" },
			{ scope: "file", blocksOverlays: false, message: "roles[2] must be an object; entry skipped" },
		]);
	});

	it("normalizes explicit inheritance sentinels over built-in defaults", () => {
		const loaded = fromJson({ roles: [
			{ id: "research", model: "inherit", tools: "inherit" },
			{ id: "implement-cheap", thinking: "inherit", defaultWorktree: "inherit" },
		] });
		const research = loaded.roles.find((candidate) => candidate.id === "research");
		const implementCheap = loaded.roles.find((candidate) => candidate.id === "implement-cheap");
		expect(research).toHaveProperty("model", undefined);
		expect(research).toHaveProperty("tools", undefined);
		expect(implementCheap).toHaveProperty("thinking", undefined);
		expect(implementCheap).toHaveProperty("defaultWorktree", undefined);
		expect(loaded.warnings).toEqual([]);
	});

	it("falls back to built-ins for bad json, oversized files, and read failures", () => {
		const bad = loadRoles({ readFile: () => "{", env: {} });
		const oversized = loadRoles({ readFile: () => "x".repeat(256 * 1024 + 1), env: {} });
		const unreadable = loadRoles({ readFile: () => { throw new Error("permission denied"); }, env: {} });
		expect(bad.roles).toEqual(BUILT_IN_ROLES);
		expect(bad.warnings[0]?.message).toContain("invalid roles.json");
		expect(bad.warnings[0]?.scope).toBe("file");
		expect(oversized.roles).toEqual(BUILT_IN_ROLES);
		expect(oversized.warnings[0]?.message).toContain("exceeds 256 KB");
		expect(oversized.warnings[0]?.scope).toBe("file");
		expect(unreadable.roles).toEqual(BUILT_IN_ROLES);
		expect(unreadable.warnings).toEqual([{ scope: "file", blocksOverlays: true, message: "unable to read roles.json: permission denied" }]);
	});

	it("falls back without warning when roles.json does not exist", () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		const loaded = loadRoles({ readFile: () => { throw missing; }, env: {} });
		expect(loaded).toEqual({ roles: BUILT_IN_ROLES, warnings: [] });
	});

	it("honors PI_CODING_AGENT_DIR when resolving roles.json", () => {
		expect(resolveRolesPath({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe("/custom/agent/sumocode/roles.json");
	});
});
