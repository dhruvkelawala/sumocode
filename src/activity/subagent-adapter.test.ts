import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../subagents/domain.js";
import {
	activitiesFromSubagentToolRecord,
	activityFromSubagentResultRecord,
	activityFromSubagentSnapshot,
} from "./subagent-adapter.js";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "sa-7",
		title: "review auth",
		prompt: "Review the auth implementation",
		cwd: "/repo",
		baseRef: "abc123",
		status: "running",
		createdAt: 1_000,
		usage: { turns: 1 },
		transcript: [],
		liveText: "",
		liveTools: [],
		finalText: "",
		...overrides,
	};
}

describe("subagent Activity adapter", () => {
	it("maps running live text and nested tools", () => {
		const activity = activityFromSubagentSnapshot(snapshot({
			liveText: "Inspecting src/auth.ts",
			modelLabel: "openai/gpt-5",
			thinkingLabel: "high",
			usage: { tokens: 1200, contextWindow: 128000, costUsd: 0.04, turns: 2 },
			liveTools: [{ id: "read-1", name: "read", argsPreview: "{\"path\":\"src/auth.ts\"}", outputPreview: "file contents", done: false, isError: false }],
		}));

		expect(activity).toMatchObject({
			id: "subagent:sa-7",
			kind: "subagent",
			title: "review auth",
			status: "running",
			subject: "sa-7",
			currentStep: "Inspecting src/auth.ts",
			outputTail: "Inspecting src/auth.ts",
			model: "openai/gpt-5",
			thinking: "high",
			metrics: { tokens: 1200, contextWindow: 128000, costUsd: 0.04, turns: 2 },
			activeTools: [{ id: "read-1", title: "read", status: "running" }],
		});
	});

	it("preserves the producer's redacted bounded nested-tool argument preview", () => {
		const activity = activityFromSubagentSnapshot(snapshot({
			liveTools: [{
				id: "custom-1",
				name: "custom",
				argsPreview: "{\"query\":\"visible\",\"nested\":{\"token\":\"[REDACTED]\"}}",
				done: false,
				isError: false,
			}],
		}));

		expect(activity.activeTools?.[0]?.invocation).toContain("visible");
		expect(activity.activeTools?.[0]?.invocation).toContain("[REDACTED]");
		expect(activity.activeTools?.[0]?.invocation).not.toContain("secret-value");
	});

	it("maps done, failed, and interrupted outcomes without treating every error as cancellation", () => {
		const done = activityFromSubagentSnapshot(snapshot({ status: "done", settledAt: 4_000, finalText: "No findings", manifest: { exit: "completed", durationMs: 3_000 } }));
		const failed = activityFromSubagentSnapshot(snapshot({ status: "error", settledAt: 4_000, errorText: "provider failed", finalText: "partial", manifest: { exit: "failed", durationMs: 3_000 } }));
		const interrupted = activityFromSubagentSnapshot(snapshot({ status: "error", settledAt: 4_000, errorText: "interrupted", finalText: "partial", manifest: { exit: "interrupted", durationMs: 3_000 } }));

		expect(done).toMatchObject({ status: "succeeded", result: { summary: "No findings" }, metrics: { elapsedMs: 3_000 } });
		expect(failed).toMatchObject({ status: "failed", result: { summary: "partial", error: "provider failed" } });
		expect(interrupted).toMatchObject({ status: "cancelled", result: { summary: "partial", error: "interrupted" } });
	});

	it("maps pane-only visible children without scraping terminal content", () => {
		const activity = activityFromSubagentSnapshot(snapshot({
			visible: true,
			pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" },
			worktree: { path: "/tmp/worktree", branch: "sumo/review", baseRef: "abc123", repoRoot: "/repo" },
		}));

		expect(activity).toMatchObject({
			status: "running",
			subject: "sa-7 · pane w1:p2 · sumo/review",
			currentStep: "pane w1:p2 · running",
			invocation: {
				visible: true,
				pane: { agentName: "worker-abc", paneId: "w1:p2" },
				worktree: { path: "/tmp/worktree", branch: "sumo/review" },
			},
		});
		expect(activity.activeTools).toBeUndefined();
		expect(activity.outputTail).toBeUndefined();
	});

	it("adopts canonical identity from a spawn result envelope", () => {
		const canonical = activityFromSubagentSnapshot(snapshot());
		const activities = activitiesFromSubagentToolRecord({
			role: "toolResult",
			toolCallId: "spawn-call-1",
			toolName: "subagent_spawn",
			details: { action: "spawn", activity: { ...canonical, sourceId: "spawn-call-1" } },
		}, { toolCallId: "spawn-call-1" });

		expect(activities).toEqual([expect.objectContaining({ id: "subagent:sa-7", sourceId: "spawn-call-1", kind: "subagent", status: "running" })]);
	});

	it("projects the initial spawn invocation under the tool-call identity", () => {
		const activities = activitiesFromSubagentToolRecord({
			type: "toolCall",
			id: "spawn-call-2",
			name: "subagent_spawn",
			arguments: { prompt: "Review auth", name: "review", worktree: true, baseRef: "origin/main" },
		}, { toolCallId: "spawn-call-2" });

		expect(activities).toEqual([expect.objectContaining({
			id: "spawn-call-2",
			kind: "tool",
			title: "subagent_spawn",
			status: "queued",
			invocation: { prompt: "Review auth", name: "review", worktree: true, baseRef: "origin/main" },
		})]);
	});

	it("returns canonical updates from check, wait, and cancel envelopes", () => {
		const running = activityFromSubagentSnapshot(snapshot());
		const cancelled = activityFromSubagentSnapshot(snapshot({ status: "error", errorText: "interrupted", manifest: { exit: "interrupted", durationMs: 10 } }));

		expect(activitiesFromSubagentToolRecord({ toolName: "subagent_check", details: { activity: running } }, { toolCallId: "check-1" })).toHaveLength(1);
		expect(activitiesFromSubagentToolRecord({ toolName: "subagent_wait", details: { activity: [running, cancelled] } }, { toolCallId: "wait-1" })).toHaveLength(2);
		expect(activitiesFromSubagentToolRecord({ toolName: "subagent_cancel", details: { activity: [cancelled] } }, { toolCallId: "cancel-1" })[0]).toMatchObject({ status: "cancelled" });
	});

	it("keeps all 64 wait/cancel operation envelopes separate from the child-tool bound", () => {
		const activities = Array.from({ length: 64 }, (_, index) => ({
			id: `subagent:sa-${index + 1}`,
			kind: "subagent",
			title: `worker ${index + 1}`,
			status: "running",
			invocation: { prompt: `work ${index + 1}` },
		}));

		for (const toolName of ["subagent_wait", "subagent_cancel"] as const) {
			const projected = activitiesFromSubagentToolRecord({ toolName, details: { activity: activities } }, { toolCallId: `${toolName}-1` });
			expect(projected).toHaveLength(64);
			expect(projected.at(-1)?.id).toBe("subagent:sa-64");
		}
	});

	it("bounds huge operation arrays and deeply nested invocation envelopes", () => {
		let deep: unknown = { leaf: "visible" };
		for (let index = 0; index < 10_000; index += 1) deep = { next: deep };
		const activities = Array.from({ length: 100_000 }, (_, index) => ({
			id: `subagent:sa-${index + 1}`,
			kind: "subagent",
			title: `worker ${index + 1}`,
			status: "running",
			invocation: index === 0 ? deep : { prompt: `work ${index + 1}` },
			activeTools: index === 0 ? Array.from({ length: 100_000 }, (__, childIndex) => ({
				id: `tool-${childIndex}`,
				kind: "tool",
				title: "custom",
				status: "running",
			})) : [],
		}));

		const projected = activitiesFromSubagentToolRecord({ toolName: "subagent_wait", details: { activity: activities } }, { toolCallId: "wait-huge" });
		expect(projected).toHaveLength(64);
		expect(projected[0]?.activeTools).toHaveLength(16);
		expect(JSON.stringify(projected).length).toBeLessThan(500_000);
	});

	it("maps a historical passive result without guessing a spawn correlation", () => {
		const activity = activityFromSubagentResultRecord({
			role: "custom",
			customType: "subagent-result",
			content: 'Subagent sa-3 "review" finished.\n\nNo findings.',
			details: { id: "sa-3", title: "review", status: "done" },
		});

		expect(activity).toMatchObject({
			id: "subagent:sa-3",
			kind: "subagent",
			title: "review",
			status: "succeeded",
			result: { summary: 'Subagent sa-3 "review" finished.\n\nNo findings.' },
		});
		expect(activity.sourceId).toBeUndefined();
	});

	it("bounds output and omits absent optional fields", () => {
		const activity = activityFromSubagentSnapshot(snapshot({
			liveText: "x".repeat(100_000),
			prompt: "y".repeat(100_000),
			liveTools: Array.from({ length: 100 }, (_, index) => ({
				id: `tool-${index}`,
				name: "custom",
				argsPreview: "a".repeat(100_000),
				outputPreview: "o".repeat(100_000),
				done: false,
				isError: false,
			})),
		}));

		expect(JSON.stringify(activity).length).toBeLessThan(65_000);
		expect(activity.activeTools).toHaveLength(16);
		expect(activity.result).toBeUndefined();
		expect(activity.model).toBeUndefined();
		expect(activity.settledAt).toBeUndefined();
	});
});
