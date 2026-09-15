import { expect, it } from "vitest";
import { BUILT_IN_TOOLS, resolveChildToolSurface, resolveTaskConfig } from "./task-config.js";

it("inherits the parent's built-ins plus the MCP gateway, and nothing else", () => {
	// The gateway is ambient like a built-in: a child of a session that has it
	// gets it. Other extension tools are still never inherited implicitly.
	const surface = resolveChildToolSurface({
		roleTools: undefined,
		parentActiveTools: ["read", "bash", "mcp", "mcpScript", "terminal_start"],
	});
	expect(surface).toEqual(["read", "bash", "mcp"]);
	expect(resolveChildToolSurface({ roleTools: undefined, parentActiveTools: ["read", "bash"] })).toEqual(["read", "bash"]);
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

it("cannot narrow the gateway away with a role's tool list", () => {
	// A role scopes file/shell primitives, not the session's integrations; a
	// parent that has MCP delegates MCP. Narrowing is `mcpServers`'s job.
	expect(resolveChildToolSurface({ roleTools: ["read"], parentActiveTools: ["read", "bash", "mcp"] })).toEqual(["read", "mcp"]);
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
