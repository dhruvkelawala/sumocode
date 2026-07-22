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

	it("projects real Pi read/write, edit, and bash records into useful specialized bodies", () => {
		expect(projectPiToolActivity({ id: "read-1", name: "read", arguments: { path: "a.ts" }, details: { excerpt: ["one", "two"], startLine: 4, totalLines: 9 } }, scope)).toMatchObject({
			id: "read-1",
			subject: "a.ts",
			body: { kind: "source", text: "one\ntwo", startLine: 4, totalLines: 9 },
		});
		expect(projectPiToolActivity({
			id: "real-read",
			name: "read",
			status: "success",
			arguments: { path: "offset.ts", offset: 7, limit: 3 },
			content: [{ type: "text", text: "alpha\n\nomega" }],
		}, scope)).toMatchObject({
			body: { kind: "source", text: "alpha\n\nomega", startLine: 7, totalLines: 9 },
		});
		expect(projectPiToolActivity({
			id: "limited-read",
			name: "read",
			status: "success",
			arguments: { path: "limited.ts", offset: 1, limit: 2 },
			content: [{ type: "text", text: "one\n\ntwo\n\n[37 more lines in file. Use offset=4 to continue.]" }],
		}, scope)?.body).toEqual({ kind: "source", text: "one\n\ntwo", startLine: 1, totalLines: 40 });
		expect(projectPiToolActivity({
			id: "truncated-read",
			name: "read",
			status: "success",
			arguments: { path: "truncated.ts", offset: 21 },
			content: [{ type: "text", text: "twenty-one\ntwenty-two\n\n[Showing lines 21-22 of 100 (50KB limit). Use offset=23 to continue.]" }],
		}, scope)?.body).toEqual({ kind: "source", text: "twenty-one\ntwenty-two", startLine: 21, totalLines: 100 });
		expect(projectPiToolActivity({
			id: "write-1",
			name: "write",
			status: "success",
			arguments: { path: "b.ts", content: "const one = 1;\n\nconst two = 2;" },
			content: [{ type: "text", text: "Successfully wrote 31 bytes to b.ts" }],
		}, scope)).toMatchObject({
			outputTail: "Successfully wrote 31 bytes to b.ts",
			body: { kind: "source", text: "const one = 1;\n\nconst two = 2;", totalLines: 3 },
		});
		expect(projectPiToolActivity({
			id: "write-error",
			name: "write",
			arguments: { path: "b.ts", content: "attempted content" },
			content: [{ type: "text", text: "permission denied" }],
			isError: true,
		}, scope)).toMatchObject({
			status: "failed",
			body: { kind: "source", text: "attempted content" },
			result: { error: "permission denied" },
		});
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

	it("requires an actual toolCallId for live correlation and scopes historical fallback IDs", () => {
		expect(projectPiToolActivity({ id: "generic-record-id", name: "read" }, { ...scope, requireToolCallId: true })).toBeUndefined();
		expect(projectPiToolActivity({ toolCallId: "live-call", id: "generic-record-id", name: "read" }, { ...scope, requireToolCallId: true })?.id).toBe("live-call");
		expect(projectPiToolActivity({ name: "read" }, { ...scope, requireToolCallId: true })).toBeUndefined();
		expect(projectPiToolActivity({ name: "read" }, scope)?.id).toBe("pi-tool:message-7:2");
		expect(projectPiToolActivity({ name: "read" }, { messageId: "message-7", blockIndex: 3 })?.id).toBe("pi-tool:message-7:3");
	});
});
