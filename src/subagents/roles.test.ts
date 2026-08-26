import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS } from "../native-task-config.js";
import { BUILT_IN_ROLES, loadRoles, resolveRolesPath } from "./roles.js";

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

	it("merges built-in overrides field by field", () => {
		const loaded = fromJson({ roles: [{ id: "research", label: "Deep Research", thinking: "high" }] });
		const role = loaded.roles.find((candidate) => candidate.id === "research");
		expect(role).toMatchObject({ label: "Deep Research", thinking: "high", tools: ["read", "grep", "find", "ls", "bash"] });
		expect(role?.systemPrompt).toContain("read-only investigator");
		expect(loaded.warnings).toEqual([]);
	});

	it("accepts complete new roles and rejects incomplete ones", () => {
		const loaded = fromJson({ roles: [
			{ id: "security", label: "Security", systemPrompt: "audit security", description: "use for security audits" },
			{ id: "missing-prompt", label: "Missing" },
		] });
		expect(loaded.roles.find((role) => role.id === "security")).toMatchObject({ label: "Security", systemPrompt: "audit security" });
		expect(loaded.roles.some((role) => role.id === "missing-prompt")).toBe(false);
		expect(loaded.warnings.join("\n")).toContain("requires label and systemPrompt");
	});

	it("skips invalid entries, ignores unknown fields, and drops invalid tools", () => {
		const loaded = fromJson({ roles: [
			{ id: "research", thinking: "enormous" },
			{ id: "review", tools: ["read", "mcp", 42, "read"], futureField: true },
			"invalid",
		] });
		expect(loaded.roles.find((role) => role.id === "research")?.thinking).toBeUndefined();
		expect(loaded.roles.find((role) => role.id === "review")?.tools).toEqual(["read"]);
		expect(loaded.warnings.join("\n")).toContain("invalid thinking");
		expect(loaded.warnings.join("\n")).toContain("unknown field futureField");
		expect(loaded.warnings.join("\n")).toContain("invalid tool mcp");
		expect(loaded.warnings.join("\n")).toContain("must be an object");
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

	it("falls back to built-ins for bad json and oversized files", () => {
		const bad = loadRoles({ readFile: () => "{", env: {} });
		const oversized = loadRoles({ readFile: () => "x".repeat(256 * 1024 + 1), env: {} });
		expect(bad.roles).toEqual(BUILT_IN_ROLES);
		expect(bad.warnings[0]).toContain("invalid roles.json");
		expect(oversized.roles).toEqual(BUILT_IN_ROLES);
		expect(oversized.warnings[0]).toContain("exceeds 256 KB");
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
