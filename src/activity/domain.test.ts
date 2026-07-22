import { describe, expect, it } from "vitest";
import {
	mergeActivitySnapshot,
	parseActivitySnapshot,
	safeValuePreview,
	sameActivity,
	sanitizeActivityText,
	type ActivitySnapshot,
} from "./domain.js";

function activity(id: string, overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return { id, kind: "tool", title: "read", status: "running", ...overrides };
}

describe("Activity domain", () => {
	it("matches stable IDs and explicit source correlations, never titles", () => {
		expect(sameActivity(activity("a"), activity("a"))).toBe(true);
		expect(sameActivity(activity("tool-call-1"), activity("task-1", { kind: "task", sourceId: "tool-call-1" }))).toBe(true);
		expect(sameActivity(activity("temporary", { sourceId: "call-1" }), activity("canonical", { kind: "task", sourceId: "call-1" }))).toBe(true);
		expect(sameActivity(activity("spawn-call-1"), activity("subagent:sa-1", { kind: "subagent", sourceId: "spawn-call-1" }))).toBe(true);
		expect(sameActivity(activity("a", { sourceId: "shared" }), activity("b", { sourceId: "shared" }))).toBe(false);
		expect(sameActivity(activity("a"), activity("b"))).toBe(false);
	});

	it("preserves canonical task identity when correlated tool and task snapshots arrive in either order", () => {
		const tool = activity("tool-call-1", { title: "task", outputTail: "tool output" });
		const task = activity("task-42", { kind: "task", title: "canonical task", sourceId: "tool-call-1", currentStep: "running tests" });

		expect(mergeActivitySnapshot(tool, task)).toMatchObject({
			id: "task-42",
			kind: "task",
			title: "canonical task",
			sourceId: "tool-call-1",
			outputTail: "tool output",
			currentStep: "running tests",
		});
		expect(mergeActivitySnapshot(task, tool)).toMatchObject({
			id: "task-42",
			kind: "task",
			title: "canonical task",
			sourceId: "tool-call-1",
			outputTail: "tool output",
			currentStep: "running tests",
		});
	});

	it("preserves canonical subagent identity when a spawn tool result reveals it", () => {
		const tool = activity("spawn-call-1", { title: "subagent_spawn", invocation: { prompt: "Review auth" } });
		const subagent = activity("subagent:sa-1", { kind: "subagent", title: "review auth", sourceId: "spawn-call-1", subject: "sa-1" });

		expect(mergeActivitySnapshot(tool, subagent)).toMatchObject({
			id: "subagent:sa-1",
			kind: "subagent",
			title: "review auth",
			sourceId: "spawn-call-1",
			invocation: { prompt: "Review auth" },
		});
	});

	it("preserves absent data and prevents terminal-state regression", () => {
		const merged = mergeActivitySnapshot(
			activity("a", {
				status: "failed",
				invocation: { path: "a.ts" },
				body: { kind: "source", text: "known" },
				result: { error: "boom" },
				metrics: { tokensIn: 10 },
			}),
			activity("a", {
				status: "running",
				result: { summary: "late update" },
				metrics: { elapsedMs: 50 },
			}),
		);

		expect(merged).toMatchObject({
			status: "failed",
			invocation: { path: "a.ts" },
			body: { kind: "source", text: "known" },
			result: { error: "boom", summary: "late update" },
			metrics: { tokensIn: 10, elapsedMs: 50 },
		});
	});

	it("merges child activities by stable ID and retains older siblings within the bound", () => {
		const merged = mergeActivitySnapshot(
			activity("parent", {
				kind: "task",
				activeTools: [activity("read-1", { status: "running" }), activity("bash-1", { title: "bash" })],
			}),
			activity("parent", {
				kind: "task",
				activeTools: [activity("read-1", { status: "succeeded", outputTail: "done" }), activity("edit-1", { title: "edit" })],
			}),
		);

		expect(merged.activeTools).toHaveLength(3);
		expect(merged.activeTools?.[0]).toMatchObject({ id: "read-1", status: "succeeded", outputTail: "done" });
		expect(merged.activeTools?.map((child) => child.id)).toEqual(["read-1", "edit-1", "bash-1"]);
	});

	it("keeps incoming child priority authoritative and bounds merged sliding windows", () => {
		const existing = activity("parent", {
			kind: "task",
			activeTools: Array.from({ length: 16 }, (_, index) => activity(`old-${index}`)),
		});
		const incoming = activity("parent", {
			kind: "task",
			activeTools: [activity("running-tail", { status: "running" }), ...Array.from({ length: 15 }, (_, index) => activity(`new-${index}`))],
		});

		const merged = mergeActivitySnapshot(existing, incoming);

		expect(merged.activeTools).toHaveLength(16);
		expect(merged.activeTools?.[0]).toMatchObject({ id: "running-tail", status: "running" });
		expect(merged.activeTools?.map((child) => child.id)).not.toContain("old-0");
	});

	it("treats an explicit empty activeTools list as a clear while undefined preserves children", () => {
		const existing = activity("parent", { kind: "task", activeTools: [activity("read-1")] });

		expect(mergeActivitySnapshot(existing, activity("parent", { kind: "task" })).activeTools).toHaveLength(1);
		expect(mergeActivitySnapshot(existing, activity("parent", { kind: "task", activeTools: [] })).activeTools).toEqual([]);
	});

	it("strictly deserializes persisted snapshots and rejects malformed nested fields", () => {
		const persisted = {
			id: "term-1",
			kind: "terminal",
			title: "tests",
			status: "succeeded",
			body: { kind: "terminal", command: "pnpm test", text: "passed" },
			activeTools: [{ id: "tool-1", kind: "tool", title: "read", status: "succeeded" }],
			result: { summary: "done" },
			metrics: { elapsedMs: 25 },
		};
		expect(parseActivitySnapshot(persisted)).toEqual(persisted);
		expect(parseActivitySnapshot({ ...persisted, body: { kind: "terminal", text: {} } })).toBeUndefined();
		expect(parseActivitySnapshot({ ...persisted, activeTools: [{ ...persisted.activeTools[0], outputTail: [] }] })).toBeUndefined();
		expect(parseActivitySnapshot({ ...persisted, result: { summary: 42 } })).toBeUndefined();
		expect(parseActivitySnapshot({ ...persisted, metrics: { elapsedMs: "fast" } })).toBeUndefined();
	});

	it("renders cyclic and huge values safely while redacting secret-shaped fields", () => {
		const cyclic: Record<string, unknown> = {
			apiKey: "top-secret",
			"x-api-key": "header-api-nope",
			stripeApiKey: "stripe-api-nope",
			apiKeyValue: "value-api-nope",
			Authorization: "Bearer nope",
			password: "nope",
			cookie: "nope",
			access_token: "access-nope",
			refreshToken: "refresh-nope",
			client_secret: "client-nope",
			sessionCookie: "session-nope",
			privateKey: "private-nope",
			nested: { token: "nope", okay: "visible" },
		};
		cyclic.self = cyclic;
		cyclic.huge = "x".repeat(10_000);
		const preview = safeValuePreview(cyclic, { maxChars: 500 });

		expect(preview.length).toBeLessThanOrEqual(500);
		expect(preview).toContain("[REDACTED]");
		expect(preview).toContain("[Circular]");
		expect(preview).toContain("visible");
		expect(preview).not.toContain("top-secret");
		for (const secret of [
			"access-nope",
			"refresh-nope",
			"client-nope",
			"session-nope",
			"private-nope",
			"header-api-nope",
			"stripe-api-nope",
			"value-api-nope",
		]) {
			expect(preview).not.toContain(secret);
		}
		expect(() => safeValuePreview(cyclic)).not.toThrow();
	});

	it("bounds global nodes, value characters, and oversized object keys incrementally", () => {
		let deep: unknown = { value: "visible" };
		for (let index = 0; index < 10_000; index += 1) deep = { next: deep };
		const hugeKey = `${"x".repeat(100_000)}token`;
		const preview = safeValuePreview({ [hugeKey]: "must-not-leak", deep }, {
			maxChars: 200,
			maxDepth: 10_000,
			maxEntries: 20,
			maxStringChars: 40,
			maxNodes: 32,
			maxTotalStringChars: 100,
		});

		expect(preview.length).toBeLessThanOrEqual(200);
		expect(preview).not.toContain("must-not-leak");
		expect(preview).toContain("[REDACTED]");
		expect(preview).toContain("[Truncated]");
	});

	it("strips ANSI and controls while normalizing tabs and carriage returns", () => {
		const sanitized = sanitizeActivityText("\u001b[31mred\u001b[0m\twide 界\rnext\u0000\u009dHIDDEN\u001b\\VISIBLE");
		expect(sanitized).toBe("red    wide 界\nnextVISIBLE");
		expect(sanitized).not.toContain("HIDDEN");
		expect(sanitized).not.toContain("\u001b");
		expect(sanitizeActivityText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
		expect(sanitizeActivityText("\u009d\u0007VISIBLE-BEL")).toBe("VISIBLE-BEL");
		expect(sanitizeActivityText("\u009d\u001b\\VISIBLE-ST")).toBe("VISIBLE-ST");
	});
});
