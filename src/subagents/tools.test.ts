import { describe, expect, it, vi } from "vitest";
import { registerSubagentTools } from "./tools.js";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { SubagentEvent } from "./domain.js";

const createHarness = () => {
	const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const manager = new SubagentManager((task: SpawnSubagentTask & { id: string }) => ({
		events: (emit) => emitters.set(task.id, emit),
		interrupt: vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
	}), {
		captureGitContext: async () => ({ repoRoot: "/tmp/project", baseRef: "base-ref" }),
		createWorktree: async (options) => ({ ok: true, path: "/tmp/isolated", branch: options.branch ?? "sumo/task", baseRef: options.baseRef ?? "base-ref" }),
	});
	const pi = { registerTool: vi.fn((tool) => registered.push(tool)), on: vi.fn(), getThinkingLevel: vi.fn(() => "medium"), getActiveTools: vi.fn(() => ["read", "bash"]) };
	registerSubagentTools(pi as never, manager);
	const tool = (name: string) => registered.find((entry) => entry.name === name)!;
	const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5", thinkingLevel: "low" } };
	return { registered, manager, emitters, tool, ctx };
};

const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0].text);

describe("subagent tools", () => {
	it("registers exactly five tools", () => {
		const { registered } = createHarness();
		expect(registered.map((tool) => tool.name)).toEqual(["subagent_spawn", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_list"]);
	});

	it("spawn returns an id and automatic-delivery guidance", async () => {
		const { tool, ctx } = createHarness();
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toBe("Started sa-1 (worker). Its result will be delivered to you automatically when it settles, or use subagent_wait to block for it.");
	});

	it("passes worktree isolation and branch overrides to the manager", async () => {
		const { tool, ctx, manager } = createHarness();
		const result = await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Started sa-1");
		expect(manager.get("sa-1")).toMatchObject({
			cwd: "/tmp/isolated",
			worktree: { path: "/tmp/isolated", branch: "sumo/custom", baseRef: "base-ref", repoRoot: "/tmp/project" },
		});
	});

	it("at capacity returns cooperative status details", async () => {
		const { tool, ctx } = createHarness();
		for (let index = 0; index < 4; index += 1) await tool("subagent_spawn").execute("tc", { prompt: "do", name: `w${index}` }, undefined, undefined, ctx as never);
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do", name: "over" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("status=at_capacity");
		expect(result).toMatchObject({ details: { status: "at_capacity", runningCount: 4 } });
	});

	it("check does not consume", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "assistant-delta", delta: "hello" });
		const result = await tool("subagent_check").execute("tc", { id: "sa-1" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("hello");
		expect(manager.consumedIds.has("sa-1")).toBe(false);
	});

	it("wait errors on unknown id and lists known ids", async () => {
		const { tool, ctx } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		await expect(tool("subagent_wait").execute("tc", { ids: ["sa-2"] }, undefined, undefined, ctx as never)).rejects.toThrow("Known ids: sa-1");
	});

	it("includes the failure reason in wait results even when partial text exists", async () => {
		const { tool, emitters, ctx } = createHarness();
		const spawnResult = await tool("subagent_spawn").execute("t1", { prompt: "p", name: "n" }, undefined, undefined, ctx as never);
		const id = ((spawnResult as { details: { subagent: { id: string } } }).details.subagent).id;
		emitters.get(id)?.({ kind: "message-end", role: "assistant", text: "partial progress" });
		emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "provider exploded", partialText: "partial progress" } });
		const waited = await tool("subagent_wait").execute("t2", { ids: [id] }, undefined, undefined, ctx as never);
		const text = textOf(waited);
		expect(text).toContain("error: provider exploded");
		expect(text).toContain("partial progress");
	});
});
