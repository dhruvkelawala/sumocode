import { expect, it } from "vitest";
import { BUILT_IN_TOOLS, resolveChildToolSurface, resolveTaskConfig } from "./task-config.js";

it("inherits only built-ins when no role narrowed the surface", () => {
	// The parent's own session routinely has extension tools active (the MCP
	// gateway among them); a role-free delegation never inherits those.
	const surface = resolveChildToolSurface({
		roleTools: undefined,
		parentActiveTools: ["read", "bash", "mcp", "mcpScript", "terminal_start"],
	});
	expect(surface).toEqual(["read", "bash"]);
});

it("grants an approvable extension tool only when the role asks for it and the parent has it", () => {
	expect(resolveChildToolSurface({ roleTools: ["read", "mcp"], parentActiveTools: ["read", "mcp"] })).toEqual(["read", "mcp"]);
	// A narrowed parent cannot widen its child.
	expect(resolveChildToolSurface({ roleTools: ["read", "mcp"], parentActiveTools: ["read"] })).toEqual(["read"]);
});

it("drops tools outside the approvable set and de-duplicates the surface", () => {
	const surface = resolveChildToolSurface({
		roleTools: ["read", "terminal_start", "mcp", "mcp", "bash", "not-a-tool"],
		parentActiveTools: ["read", "bash", "mcp", "terminal_start", "not-a-tool"],
	});
	expect(surface).toEqual(["read", "mcp", "bash"]);
});

it("refuses every tool when the role names tools the parent has nothing active for", () => {
	expect(resolveChildToolSurface({ roleTools: ["read"], parentActiveTools: [] })).toEqual([]);
});

it("serialises the resolved surface into --tools, including extension tool names", () => {
	const config = resolveTaskConfig({
		item: {}, defaultModel: undefined, defaultThinking: "inherit", inheritedThinking: "low", ctxModel: undefined,
		tools: ["read", "bash", "mcp"],
	});
	if (!config.ok) throw new Error(config.error);
	expect(config.subprocessArgs).toContain("--no-extensions");
	expect(config.subprocessArgs[config.subprocessArgs.indexOf("--tools") + 1]).toBe("read,bash,mcp");
});

it("keeps --no-tools when the surface is empty", () => {
	const config = resolveTaskConfig({
		item: {}, defaultModel: undefined, defaultThinking: "inherit", inheritedThinking: "low", ctxModel: undefined, tools: [],
	});
	if (!config.ok) throw new Error(config.error);
	expect(config.subprocessArgs).toContain("--no-tools");
	expect(config.subprocessArgs).not.toContain("--tools");
});

it("exposes the canonical built-in list as the only implicit inheritance", () => {
	expect(resolveChildToolSurface({ roleTools: undefined, parentActiveTools: [...BUILT_IN_TOOLS] })).toEqual([...BUILT_IN_TOOLS]);
});
