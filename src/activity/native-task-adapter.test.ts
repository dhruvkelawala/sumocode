import { describe, expect, it } from "vitest";
import { activityFromNativeTaskRecord } from "./native-task-adapter.js";

const usage = (input = 0, output = 0, cost = 0, turns = 0) => ({
	input,
	output,
	cost,
	turns,
});

describe("native task Activity adapter", () => {
	it("maps a running single task with streaming output and model context", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-1",
			name: "task",
			arguments: { type: "single", tasks: [{ prompt: "## Audit auth\n\nFind risky files.", model: "openai/gpt-5", thinking: "high" }] },
			details: {
				mode: "single",
				results: [{
					prompt: "## Audit auth\n\nFind risky files.",
					exitCode: -1,
					streamingText: "Reading auth.ts",
					messages: [],
					toolEvents: [],
					usage: usage(),
					model: "openai/gpt-5",
					thinking: "high",
				}],
			},
		}, { fallbackStatus: "running" });

		expect(activity).toMatchObject({
			id: "task-1",
			kind: "task",
			title: "Audit auth",
			status: "running",
			invocation: { type: "single", tasks: [{ prompt: "## Audit auth\n\nFind risky files." }] },
			currentStep: "Audit auth",
			outputTail: "Reading auth.ts",
			model: "openai/gpt-5",
			thinking: "high",
		});
	});

	it("maps successful and failed single task results truthfully", () => {
		const succeeded = activityFromNativeTaskRecord({
			toolCallId: "task-success",
			name: "task",
			details: { mode: "single", results: [{ prompt: "Fix bug", exitCode: 0, finalOutput: "Committed abc123", messages: [], usage: usage(100, 20, 0.01, 2) }] },
		}, { fallbackStatus: "succeeded" });
		const failed = activityFromNativeTaskRecord({
			toolCallId: "task-failure",
			name: "task",
			details: { mode: "single", results: [{ prompt: "Run tests", exitCode: 1, errorMessage: "tests failed", messages: [], usage: usage() }] },
		}, { fallbackStatus: "succeeded" });

		expect(succeeded).toMatchObject({
			status: "succeeded",
			result: { summary: "Committed abc123" },
			metrics: { tokensIn: 100, tokensOut: 20, costUsd: 0.01, turns: 2 },
		});
		expect(failed).toMatchObject({ status: "failed", result: { error: "tests failed" } });
	});

	it.each(["single", "chain", "parallel"] as const)("marks %s preparation failures with no results as failed", (mode) => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: `task-${mode}-prepare-failure`,
			name: "task",
			isError: true,
			content: [{ type: "text", text: "Unknown skill: missing-skill" }],
			details: { mode, results: [] },
		}, { fallbackStatus: "succeeded" });

		expect(activity).toMatchObject({
			id: `task-${mode}-prepare-failure`,
			status: "failed",
			result: { error: "Unknown skill: missing-skill" },
		});
	});

	it("preserves cancelled native task status while retaining cancellation evidence", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-cancelled",
			name: "task",
			details: {
				mode: "single",
				results: [{ prompt: "Long task", exitCode: 143, stopReason: "aborted", messages: [], usage: usage() }],
			},
		}, { fallbackStatus: "failed" });

		expect(activity).toMatchObject({ status: "cancelled", result: { error: "cancelled" } });
	});

	it("aggregates mixed parallel progress with stable child identities", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-parallel",
			name: "task",
			details: {
				mode: "parallel",
				results: [
					{ index: 1, prompt: "Inspect auth", exitCode: 0, finalOutput: "found auth.ts", messages: [], usage: usage(100, 10) },
					{ index: 2, prompt: "Inspect tests", exitCode: -1, streamingText: "reading tests", messages: [], usage: usage() },
					{ index: 3, prompt: "Inspect docs", exitCode: -2, messages: [], usage: usage() },
				],
			},
		}, { fallbackStatus: "running" });

		expect(activity).toMatchObject({ status: "running", currentStep: "1/3 · Inspect tests" });
		expect(activity.activeTools?.map((child) => child.id)).toEqual([
			"task-parallel:result:0",
			"task-parallel:result:1",
			"task-parallel:result:2",
		]);
		expect(activity.activeTools?.map((child) => child.status)).toEqual(["succeeded", "running", "queued"]);
	});

	it("gives failure precedence for a chain and retains completed progress", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-chain",
			name: "task",
			details: {
				mode: "chain",
				results: [
					{ index: 1, prompt: "Inspect auth", exitCode: 0, finalOutput: "done", messages: [], usage: usage() },
					{ index: 2, prompt: "Verify auth", exitCode: 1, errorMessage: "verification failed", messages: [], usage: usage() },
					{ index: 3, prompt: "Document auth", exitCode: -2, messages: [], usage: usage() },
				],
			},
		}, { fallbackStatus: "succeeded" });

		expect(activity).toMatchObject({ status: "failed", currentStep: "2/3 · Verify auth", result: { error: "Task 2: verification failed" } });
	});

	it("maps nested tool updates with actual and scoped fallback IDs", () => {
		const record = {
			toolCallId: "task-tools",
			name: "task",
			details: {
				mode: "single",
				results: [{
					prompt: "Inspect files",
					exitCode: -1,
					messages: [],
					usage: usage(),
					toolEvents: [
						{ id: "read-real", name: "read", args: { path: "src/a.ts" }, status: "success", output: "a" },
						{ name: "read", args: { path: "src/b.ts" }, status: "running" },
					],
				}],
			},
		};
		const first = activityFromNativeTaskRecord(record, { fallbackStatus: "running" });
		const second = activityFromNativeTaskRecord(record, { fallbackStatus: "running" });

		expect(first.activeTools?.map((tool) => tool.id)).toEqual([
			"read-real",
			"task-tools:result:0:tool:read:1",
		]);
		expect(first.activeTools?.map((tool) => tool.status)).toEqual(["succeeded", "running"]);
		expect(second.activeTools?.map((tool) => tool.id)).toEqual(first.activeTools?.map((tool) => tool.id));
	});

	it("prioritizes running nested tools then newest settled tools with stable source indices", () => {
		const record = {
			toolCallId: "task-bounded-tools",
			name: "task",
			details: {
				mode: "single",
				results: [{
					prompt: "Inspect many tools",
					exitCode: -1,
					messages: [],
					usage: usage(),
					toolEvents: Array.from({ length: 20 }, (_, index) => ({
						name: "custom",
						args: { index },
						status: index === 18 ? "running" : "success",
						output: `output ${index}`,
					})),
				}],
			},
		};
		const first = activityFromNativeTaskRecord(record, { fallbackStatus: "running" });
		const second = activityFromNativeTaskRecord(record, { fallbackStatus: "running" });

		expect(first.activeTools).toHaveLength(16);
		expect(first.activeTools?.[0]).toMatchObject({ id: "task-bounded-tools:result:0:tool:custom:18", status: "running" });
		expect(first.activeTools?.[1]?.id).toBe("task-bounded-tools:result:0:tool:custom:19");
		expect(first.activeTools?.at(-1)?.id).toBe("task-bounded-tools:result:0:tool:custom:4");
		expect(second.activeTools?.map((tool) => tool.id)).toEqual(first.activeTools?.map((tool) => tool.id));
	});

	it("correlates missing-id nested results to the earliest unresolved same-name call", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-missing-tool-ids",
			name: "task",
			details: {
				mode: "single",
				results: [{
					prompt: "Inspect files",
					exitCode: 0,
					messages: [
						{ role: "assistant", content: [
							{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
							{ type: "toolCall", name: "read", arguments: { path: "src/b.ts" } },
						] },
						{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "alpha" }] },
						{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "beta" }] },
					],
					usage: usage(),
				}],
			},
		}, { fallbackStatus: "succeeded" });

		expect(activity.activeTools).toHaveLength(2);
		expect(activity.activeTools?.map((tool) => tool.id)).toEqual([
			"task-missing-tool-ids:result:0:tool:read:0",
			"task-missing-tool-ids:result:0:tool:read:1",
		]);
		expect(activity.activeTools?.map((tool) => tool.status)).toEqual(["succeeded", "succeeded"]);
		expect(activity.activeTools?.map((tool) => tool.invocation)).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
		expect(activity.activeTools?.map((tool) => tool.outputTail)).toEqual(["alpha", "beta"]);
	});

	it("uses the recent message window for nested-tool fallback state", () => {
		const messages = [
			...Array.from({ length: 130 }, (_, index) => ({ role: "user", content: [{ type: "text", text: `context ${index}` }] })),
			{ role: "assistant", content: [{ type: "toolCall", id: "recent-read", name: "read", arguments: { path: "src/recent.ts" } }] },
			{ role: "toolResult", toolCallId: "recent-read", toolName: "read", content: [{ type: "text", text: "recent contents" }] },
		];
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-recent-messages",
			name: "task",
			details: { mode: "single", results: [{ prompt: "Inspect recent work", exitCode: 0, messages, usage: usage() }] },
		}, { fallbackStatus: "succeeded" });

		expect(activity.activeTools).toEqual([
			expect.objectContaining({ id: "recent-read", status: "succeeded", outputTail: "recent contents" }),
		]);
	});

	it("falls back to assistant messages and aggregates usage and elapsed time", () => {
		const activity = activityFromNativeTaskRecord({
			toolCallId: "task-messages",
			name: "task",
			details: {
				mode: "parallel",
				results: [
					{ prompt: "One", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "first result" }] }], usage: usage(10, 2, 0.01, 1), elapsedMs: 120 },
					{ prompt: "Two", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "second result" }] }], usage: usage(20, 3, 0.02, 2), elapsedMs: 200 },
				],
			},
		}, { fallbackStatus: "succeeded" });

		expect(activity.result?.summary).toContain("Task 1: first result");
		expect(activity.result?.summary).toContain("Task 2: second result");
		expect(activity.metrics).toMatchObject({ tokensIn: 30, tokensOut: 5, costUsd: 0.03, turns: 3, elapsedMs: 320 });
	});

	it("bounds huge arrays and deeply nested unknown values before traversal", () => {
		let deep: unknown = { leaf: "visible" };
		for (let index = 0; index < 10_000; index += 1) deep = { next: deep };
		const activity = activityFromNativeTaskRecord({
			name: "task",
			arguments: {
				type: "parallel",
				tasks: Array.from({ length: 100_000 }, (_, index) => ({ prompt: `Task ${index}` })),
			},
			details: {
				mode: "parallel",
				results: Array.from({ length: 100_000 }, (_, index) => ({
					prompt: `Task ${index}`,
					exitCode: index === 0 ? -1 : -2,
					messages: index === 0 ? Array.from({ length: 100_000 }, () => ({ role: "user", content: [] })) : [],
					toolEvents: index === 0 ? [{ name: "custom", args: deep, status: "running" }] : [],
					usage: usage(),
				})),
			},
		}, { toolCallId: "bounded-deep-task", fallbackStatus: "running" });

		expect(activity.activeTools).toHaveLength(16);
		expect(activity.activeTools?.[0]?.activeTools).toHaveLength(1);
		expect(JSON.stringify(activity).length).toBeLessThan(200_000);
	});

	it("bounds producer text and omits absent optional fields", () => {
		const activity = activityFromNativeTaskRecord({
			name: "task",
			arguments: { prompt: "x".repeat(100_000) },
			content: [{ type: "text", text: "y".repeat(100_000) }],
		}, { toolCallId: "bounded-task", fallbackStatus: "succeeded" });

		expect(JSON.stringify(activity).length).toBeLessThan(40_000);
		expect(activity.id).toBe("bounded-task");
		expect(activity.metrics).toBeUndefined();
		expect(activity.activeTools).toBeUndefined();
	});
});
