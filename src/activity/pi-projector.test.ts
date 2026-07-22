import { describe, expect, it } from "vitest";
import { projectPiToolActivity } from "./pi-projector.js";

const scope = { messageId: "message-7", blockIndex: 2 } as const;

describe("Pi Activity projector", () => {
	it.each([
		["pending", "queued"],
		["running", "running"],
		["success", "succeeded"],
		["done", "succeeded"],
		["error", "failed"],
		["failed", "failed"],
		["cancelled", "cancelled"],
	] as const)("normalizes %s to %s", (input, expected) => {
		expect(projectPiToolActivity({ id: "call-1", name: "custom", status: input }, scope)?.status).toBe(expected);
	});

	it("projects read/write, edit, and bash records into specialized bodies", () => {
		expect(projectPiToolActivity({ id: "read-1", name: "read", arguments: { path: "a.ts" }, details: { excerpt: ["one", "two"], startLine: 4, totalLines: 9 } }, scope)).toMatchObject({
			id: "read-1",
			subject: "a.ts",
			body: { kind: "source", text: "one\ntwo", startLine: 4, totalLines: 9 },
		});
		expect(projectPiToolActivity({ id: "write-1", name: "write", output: "created", arguments: { path: "b.ts" } }, scope)?.body).toEqual({ kind: "source", text: "created" });
		expect(projectPiToolActivity({ id: "edit-1", name: "edit", details: { diff: "- old\n+ new" } }, scope)?.body).toEqual({ kind: "diff", text: "- old\n+ new" });
		expect(projectPiToolActivity({ id: "bash-1", name: "bash", arguments: { command: "pnpm test" }, output: "passed" }, scope)?.body).toEqual({ kind: "terminal", command: "pnpm test", text: "passed" });
	});

	it("gives unknown tools useful output, error, safe invocation, and empty bodies", () => {
		expect(projectPiToolActivity({ id: "u-output", name: "mcp.search", arguments: { query: "sumo" }, output: "three matches" }, scope)).toMatchObject({
			body: { kind: "text", text: "three matches" },
		});
		expect(projectPiToolActivity({ id: "u-error", name: "custom", arguments: { query: "sumo" }, error: "failed visibly" }, scope)).toMatchObject({
			status: "failed",
			body: { kind: "text", text: "failed visibly" },
			result: { error: "failed visibly" },
		});
		const invocationOnly = projectPiToolActivity({ id: "u-input", name: "custom", arguments: { query: "sumo", apiKey: "hide-me" } }, scope);
		expect(invocationOnly?.body).toMatchObject({ kind: "text" });
		expect(invocationOnly?.body?.text).toContain("sumo");
		expect(invocationOnly?.body?.text).not.toContain("hide-me");
		expect(projectPiToolActivity({ id: "u-empty-running", name: "custom", status: "running" }, scope)?.body).toEqual({ kind: "text", text: "" });
		expect(projectPiToolActivity({ id: "u-empty-done", name: "custom", status: "done" }, scope)?.body).toEqual({ kind: "text", text: "" });
	});

	it("sanitizes producer output and accepts cyclic invocation values", () => {
		const invocation: Record<string, unknown> = { command: "run\t界", password: "hidden" };
		invocation.self = invocation;
		const activity = projectPiToolActivity({ id: "custom-1", name: "custom", arguments: invocation, output: "\u001b[31mred\u001b[0m\rnext" }, scope);

		expect(activity?.body).toEqual({ kind: "text", text: "red\nnext" });
		expect(() => projectPiToolActivity({ id: "custom-2", name: "custom", arguments: invocation }, scope)).not.toThrow();
	});

	it("requires a tool call ID for live correlation and scopes historical fallback IDs", () => {
		expect(projectPiToolActivity({ name: "read" }, { ...scope, requireToolCallId: true })).toBeUndefined();
		expect(projectPiToolActivity({ name: "read" }, scope)?.id).toBe("pi-tool:message-7:2");
		expect(projectPiToolActivity({ name: "read" }, { messageId: "message-7", blockIndex: 3 })?.id).toBe("pi-tool:message-7:3");
	});
});
