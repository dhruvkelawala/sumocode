import { expect, it, vi } from "vitest";
/* oxlint-disable anti-slop/no-chained-type-assertions -- the harness casts a minimal stub to the Pi ExtensionAPI the guard reads. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installMcpChildBootstrap from "./mcp-child-bootstrap.js";

interface Harness {
	readonly fire: () => void;
	readonly terminate: ReturnType<typeof vi.fn>;
	readonly report: ReturnType<typeof vi.fn>;
}

function harness(activeTools: readonly string[]): Harness {
	const handlers = new Map<string, () => void>();
	const api = {
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		getActiveTools: () => [...activeTools],
	};
	// The real guard never returns: it exits the child process.
	const terminate = vi.fn((_message: string): never => {
		throw new Error("child terminated");
	});
	const report = vi.fn();
	installMcpChildBootstrap(api as unknown as ExtensionAPI, terminate, report);
	return {
		fire: () => { try { handlers.get("before_agent_start")!(); } catch { /* the guard exited the child */ } },
		terminate,
		report,
	};
}

it("lets a child with the registered gateway run", () => {
	const h = harness(["read", "bash", "mcp"]);
	h.fire();
	expect(h.terminate).not.toHaveBeenCalled();
	expect(h.report).not.toHaveBeenCalled();
});

it("fails a child whose gateway was required by name but never registered", () => {
	// Pi's --tools allowlist silently drops unknown names, so a required grant
	// that did not register must stop the child rather than let it run without.
	process.env.SUMOCODE_MCP_REQUIRED = "1";
	try {
		const h = harness(["read", "bash"]);
		h.fire();
		expect(h.terminate).toHaveBeenCalledWith(expect.stringContaining("mcp tool was not registered"));
	} finally {
		delete process.env.SUMOCODE_MCP_REQUIRED;
	}
});

it("only warns for an inherited gateway, so one bad adapter cannot kill every delegation", () => {
	const h = harness(["read", "bash"]);
	h.fire();
	// The resolver already degrades an inherited grant; the guard must agree.
	expect(h.terminate).not.toHaveBeenCalled();
	expect(h.report).toHaveBeenCalledWith(expect.stringContaining("continuing without it"));
});
