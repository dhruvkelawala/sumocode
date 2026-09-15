import { expect, it, vi } from "vitest";
/* oxlint-disable anti-slop/no-chained-type-assertions -- the harness casts a minimal stub to the Pi ExtensionAPI the guard reads. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installMcpChildBootstrap from "./mcp-child-bootstrap.js";

interface Harness {
	readonly fire: () => void;
	readonly terminate: ReturnType<typeof vi.fn>;
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
	// SAFETY: the double supplies the on() and getActiveTools() surfaces the guard reads.
	installMcpChildBootstrap(api as unknown as ExtensionAPI, terminate);
	return {
		fire: () => { try { handlers.get("before_agent_start")!(); } catch { /* the guard exited the child */ } },
		terminate,
	};
}

it("lets a child with the registered gateway run", () => {
	const h = harness(["read", "bash", "mcp"]);
	h.fire();
	expect(h.terminate).not.toHaveBeenCalled();
});

it("fails closed when the gateway was granted but never registered", () => {
	// Pi's --tools allowlist silently drops unknown names, so without this guard
	// a missing adapter would launch a child whose metadata claims MCP.
	const h = harness(["read", "bash"]);
	h.fire();
	expect(h.terminate).toHaveBeenCalledWith(expect.stringContaining("mcp tool was not registered"));
});
