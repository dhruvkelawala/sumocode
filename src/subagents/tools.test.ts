import { describe, expect, it, vi } from "vitest";
import { registerSubagentTools } from "./tools.js";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { SubagentEvent } from "./domain.js";
import type { TerminalHost, TerminalHostKind } from "../terminal-host/types.js";

const createHarness = (hostKind: TerminalHostKind = "herdr") => {
	const registered: Array<{ name: string; parameters?: unknown; execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const sendPaneText = vi.fn(async () => hostKind === "cmux"
		? { ok: false as const, error: "not supported on cmux" }
		: { ok: true as const });
	const host: TerminalHost = {
		kind: hostKind,
		startAgentPane: vi.fn(),
		sendPaneText,
		openCommandInSplit: vi.fn(),
		openExistingWorktreeWorkspace: vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "w9:p1", workspaceId: "w9" } })),
		closePane: vi.fn(),
		notify: vi.fn(),
	};
	const piExec = { exec: vi.fn() } as never;
	const manager = new SubagentManager((task: SpawnSubagentTask & { id: string }) => ({
		events: (emit) => {
			emitters.set(task.id, emit);
			emit({ kind: "run-started" });
			if (task.visible) emit({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
		},
		interrupt: vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
	}), {
		captureGitContext: async () => ({ repoRoot: "/tmp/project", baseRef: "base-ref" }),
		createWorktree: async (options) => ({ ok: true, path: "/tmp/isolated", branch: options.branch ?? "sumo/task", baseRef: options.baseRef ?? "base-ref" }),
		terminalHost: host,
		pi: piExec,
		buildCompletionManifest: async (options) => ({
			baseRef: options.baseRef,
			headRef: "head-ref",
			branch: options.worktree?.branch,
			worktreePath: options.worktree?.path,
			changedPaths: options.worktree ? ["src/feature.ts"] : [],
			dirty: false,
			commits: options.worktree ? 1 : 0,
			exit: options.outcome.kind,
			durationMs: 10,
		}),
	});
	const pi = { registerTool: vi.fn((tool) => registered.push(tool)), on: vi.fn(), getThinkingLevel: vi.fn(() => "medium"), getActiveTools: vi.fn(() => ["read", "bash"]) };
	registerSubagentTools(pi as never, manager, undefined, host);
	const tool = (name: string) => registered.find((entry) => entry.name === name)!;
	const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5", thinkingLevel: "low" } };
	return { registered, manager, emitters, tool, ctx, host, sendPaneText };
};

const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0].text);

describe("subagent tools", () => {
	it("registers the six subagent tools and exposes visible spawning", () => {
		const { registered, tool } = createHarness();
		expect(registered.map((entry) => entry.name)).toEqual(["subagent_spawn", "subagent_send", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_list"]);
		expect(JSON.stringify(tool("subagent_spawn").parameters)).toContain("visible");
	});

	it("spawn returns an id and automatic-delivery guidance", async () => {
		const { tool, ctx } = createHarness();
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toBe("Started sa-1 (worker). Its result will be delivered to you automatically when it settles, or use subagent_wait to block for it.");
	});

	it("opens visible spawns and exposes their pane in list output", async () => {
		const { tool, ctx, manager } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);
		expect(manager.get("sa-1")).toMatchObject({ visible: true, pane: { agentName: "worker-abc", paneId: "w1:p2" } });
		const listed = await tool("subagent_list").execute("tc", {}, undefined, undefined, ctx as never);
		expect(textOf(listed)).toContain("pane w1:p2 · agent worker-abc");
	});

	it("rejects visible spawning without a terminal host", async () => {
		const { tool, ctx } = createHarness("none");
		await expect(tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never)).rejects.toThrow("require a running terminal host");
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

	it("lists the branch for isolated children", async () => {
		const { tool, ctx } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom" }, undefined, undefined, ctx as never);

		const result = await tool("subagent_list").execute("tc", {}, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("· sumo/custom");
	});

	it("at capacity returns cooperative status details", async () => {
		const { tool, ctx } = createHarness();
		for (let index = 0; index < 4; index += 1) await tool("subagent_spawn").execute("tc", { prompt: "do", name: `w${index}` }, undefined, undefined, ctx as never);
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do", name: "over" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("status=at_capacity");
		expect(result).toMatchObject({ details: { status: "at_capacity", runningCount: 4 } });
	});

	it("sends text to a running visible child pane", async () => {
		const { tool, ctx, sendPaneText } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);

		const result = await tool("subagent_send").execute("tc", { id: "sa-1", text: "continue with tests" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toBe("Sent input to sa-1 (worker).");
		expect(sendPaneText).toHaveBeenCalledWith(expect.anything(), { host: "herdr", paneId: "w1:p2", workspaceId: "w1" }, "continue with tests");
	});

	it("reports subagent_send error taxonomy", async () => {
		const headless = createHarness();
		await expect(headless.tool("subagent_send").execute("tc", { id: "sa-404", text: "hi" })).rejects.toThrow("Unknown subagent id");
		await headless.tool("subagent_spawn").execute("tc", { prompt: "quiet", name: "headless" }, undefined, undefined, headless.ctx as never);
		await expect(headless.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("headless children cannot receive input");

		const settled = createHarness();
		await settled.tool("subagent_spawn").execute("tc", { prompt: "watch", name: "visible", visible: true }, undefined, undefined, settled.ctx as never);
		settled.emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(settled.manager.get("sa-1")?.status).toBe("done"));
		await expect(settled.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("already settled");

		const cmux = createHarness("cmux");
		await cmux.tool("subagent_spawn").execute("tc", { prompt: "watch", name: "visible", visible: true }, undefined, undefined, cmux.ctx as never);
		await expect(cmux.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("not supported on cmux");
	});

	it("check does not consume", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "assistant-delta", delta: "hello" });
		const result = await tool("subagent_check").execute("tc", { id: "sa-1" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("hello");
		expect(manager.consumedIds.has("sa-1")).toBe(false);
	});

	it("check renders the host-derived manifest summary after settlement", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		const result = await tool("subagent_check").execute("tc", { id: "sa-1" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("branch: sumo/custom · base base-re · +1 commits · 1 file changed · clean");
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
		expect(text).toContain("shared checkout · base base-re · +0 checkout commits · changed paths suppressed · checkout clean");
	});
});
