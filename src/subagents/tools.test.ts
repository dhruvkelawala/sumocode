import { describe, expect, it, vi } from "vitest";
import { registerSubagentTools } from "./tools.js";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import { SUBAGENT_MAX_RUNNING, type SubagentEvent, type SubagentSnapshot } from "./domain.js";
import type { TerminalHost, TerminalHostKind } from "../terminal-host/types.js";
import { loadRoles, type SubagentRole } from "./roles.js";

/** Tool result shape returned by every subagent tool. */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

const createHarness = (hostKind: TerminalHostKind = "herdr", roles?: readonly SubagentRole[], roleWarnings: readonly string[] = []) => {
	const registered: Array<{ name: string; parameters?: unknown; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
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
	// SAFETY: the manager only calls pi.exec on this object.
	const piExec = { exec: vi.fn() } as never;
	const createWorktree = vi.fn(async (options) => ({ ok: true as const, path: "/tmp/isolated", branch: options.branch ?? "sumo/task", baseRef: options.baseRef ?? "HEAD" }));
	const spawnedTasks: Array<SpawnSubagentTask & { id: string }> = [];
	const manager = new SubagentManager((task: SpawnSubagentTask & { id: string }) => {
		spawnedTasks.push(task);
		return {
			events: (emit) => {
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				if (task.visible) emit({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
			},
			interrupt: vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
		};
	}, {
		captureGitContext: async () => ({ repoRoot: "/tmp/project", baseRef: "base-ref" }),
		createWorktree,
		resolveWorktreeBaseRef: async () => "base-ref-sha",
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
	const roleLoader: typeof loadRoles = roles ? (() => ({ roles, warnings: roleWarnings })) : loadRoles;
	// SAFETY: the double implements registerTool/on/getThinkingLevel/getActiveTools, all registerSubagentTools uses.
	registerSubagentTools(pi as never, manager, undefined, host, roleLoader);
	const tool = (name: string) => registered.find((entry) => entry.name === name)!;
	const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5", thinkingLevel: "low" } };
	return { registered, manager, emitters, tool, ctx, host, sendPaneText, createWorktree, spawnedTasks };
};

const textOf = <T extends { content: Array<{ text: string }> }>(result: T): string => result.content[0]!.text;

describe("subagent tools", () => {
	it("registers the six subagent tools and exposes visible spawning with baseRef", () => {
		const { registered, tool } = createHarness();
		expect(registered.map((entry) => entry.name)).toEqual(["subagent_spawn", "subagent_send", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_list"]);
		const spawnSchema = JSON.stringify(tool("subagent_spawn").parameters);
		expect(spawnSchema).toContain("visible");
		expect(spawnSchema).toContain("baseRef");
	});

	it("enumerates loaded roles in the spawn schema", () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const { tool } = createHarness("herdr", [role]);
		const spawnSchema = JSON.stringify(tool("subagent_spawn").parameters);
		expect(spawnSchema).toContain("audit — use for audits");
		expect(spawnSchema).toContain("Explicit spawn parameters override role defaults");
	});

	it("applies role defaults, preserves explicit precedence, and only narrows parent tools", async () => {
		const role: SubagentRole = {
			id: "audit",
			label: "Audit",
			description: "use for audits",
			systemPrompt: "audit carefully",
			model: "anthropic/role-model",
			thinking: "high",
			tools: ["read", "edit"],
			defaultVisible: false,
		};
		const { tool, ctx, manager, spawnedTasks } = createHarness("herdr", [role]);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", {
			prompt: "audit it",
			name: "auditor",
			role: "audit",
			model: "openai/explicit",
			thinking: "minimal",
		}, undefined, undefined, ctx as never);

		expect(spawnedTasks[0]).toMatchObject({
			roleId: "audit",
			appendSystemPrompt: "audit carefully",
			model: "openai/explicit",
			thinking: "minimal",
			builtInTools: ["read"],
		});
		expect(manager.get("sa-1")).toMatchObject({ roleId: "audit", modelLabel: "openai/explicit", thinkingLabel: "minimal" });
	});

	it("fails closed before spawning a role when roles.json has loader warnings", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const { tool, ctx, manager } = createHarness("herdr", [role], ["role audit has an invalid thinking level; entry skipped"]);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "audit" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("roles.json has invalid configuration");
		expect(textOf(result)).toContain("invalid thinking level");
		expect(result).toMatchObject({ details: { action: "spawn", status: "invalid_role_config", role: "audit" } });
		expect(manager.list()).toEqual([]);
	});

	it("keeps role-loader warnings out of role-free spawns", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const { tool, ctx, manager } = createHarness("herdr", [role], ["invalid optional role overlay"]);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Started sa-1");
		expect(manager.get("sa-1")?.roleId).toBeUndefined();
	});

	it("returns an inline error for an unknown role", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const { tool, ctx, manager } = createHarness("herdr", [role]);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "missing" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toBe("Unknown subagent role: missing. Known roles: audit.");
		expect(result).toMatchObject({ details: { action: "spawn", status: "unknown_role", knownRoles: ["audit"] } });
		expect(manager.list()).toEqual([]);
	});

	it("spawn returns an id and automatic-delivery guidance", async () => {
		const { tool, ctx } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toBe("Started sa-1 (worker). No polling needed — continue other work or END YOUR TURN; the result will be delivered to you and wake you automatically when it settles. Only call subagent_wait if you cannot take a single further step without this result.");
		expect(textOf(result)).not.toMatch(/block for\s+it/);
		expect(result).toMatchObject({
			details: {
				action: "spawn",
				activity: { id: "subagent:sa-1", sourceId: "tc", kind: "subagent", status: "running", model: "openai/gpt-5", thinking: "medium" },
			},
		});
	});

	it("opens visible spawns and exposes their pane in list output", async () => {
		const { tool, ctx, manager } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);
		expect(manager.get("sa-1")).toMatchObject({ visible: true, pane: { agentName: "worker-abc", paneId: "w1:p2" } });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const listed = await tool("subagent_list").execute("tc", {}, undefined, undefined, ctx as never);
		expect(textOf(listed)).toContain("pane w1:p2 · agent worker-abc");
	});

	it("rejects visible spawning without a terminal host", async () => {
		const { tool, ctx } = createHarness("none");
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await expect(tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never)).rejects.toThrow("require a running terminal host");
	});

	it("passes worktree isolation, branch, and baseRef overrides to the manager", async () => {
		const { tool, ctx, manager, createWorktree } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom", baseRef: "origin/main" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Started sa-1");
		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "origin/main" }));
		expect(manager.get("sa-1")).toMatchObject({
			cwd: "/tmp/isolated",
			worktree: { path: "/tmp/isolated", branch: "sumo/custom", baseRef: "base-ref-sha", repoRoot: "/tmp/project" },
		});
	});

	it("lists the branch for isolated children", async () => {
		const { tool, ctx } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom" }, undefined, undefined, ctx as never);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_list").execute("tc", {}, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("· sumo/custom");
	});

	it("reports an automatic queue position when running capacity is occupied", async () => {
		const { tool, ctx } = createHarness();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) {
			// SAFETY: the ctx double carries only the fields the tool handlers read.
			await tool("subagent_spawn").execute("tc", { prompt: "do", name: `w${index}` }, undefined, undefined, ctx as never);
		}
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do", name: "queued worker" }, undefined, undefined, ctx as never);
		const queuedId = `sa-${SUBAGENT_MAX_RUNNING + 1}`;
		expect(textOf(result)).toBe(`Queued ${queuedId} (queued worker) at position 1 — starts automatically when a slot frees. Do not retry or wait.`);
		expect(result).toMatchObject({ details: { subagent: { id: queuedId, status: "queued" }, activity: { status: "queued" } } });
	});

	it("sends text to a running visible child pane", async () => {
		const { tool, ctx, sendPaneText } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_send").execute("tc", { id: "sa-1", text: "continue with tests" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toBe("Sent input to sa-1 (worker).");
		expect(sendPaneText).toHaveBeenCalledWith(expect.anything(), { host: "herdr", paneId: "w1:p2", workspaceId: "w1" }, "continue with tests");
	});

	it("reports subagent_send error taxonomy", async () => {
		const headless = createHarness();
		await expect(headless.tool("subagent_send").execute("tc", { id: "sa-404", text: "hi" })).rejects.toThrow("Unknown subagent id");
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await headless.tool("subagent_spawn").execute("tc", { prompt: "quiet", name: "headless" }, undefined, undefined, headless.ctx as never);
		await expect(headless.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("headless children cannot receive input");

		const settled = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await settled.tool("subagent_spawn").execute("tc", { prompt: "watch", name: "visible", visible: true }, undefined, undefined, settled.ctx as never);
		settled.emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(settled.manager.get("sa-1")?.status).toBe("done"));
		await expect(settled.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("already settled");

		const cmux = createHarness("cmux");
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await cmux.tool("subagent_spawn").execute("tc", { prompt: "watch", name: "visible", visible: true }, undefined, undefined, cmux.ctx as never);
		await expect(cmux.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("not supported on cmux");
	});

	it("check does not consume", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "assistant-delta", delta: "hello" });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_check").execute("tc", { id: "sa-1" }, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("hello");
		expect(result).toMatchObject({ details: { activity: { id: "subagent:sa-1", status: "running", outputTail: "hello" } } });
		expect(manager.consumedIds.has("sa-1")).toBe(false);
	});

	it("check renders the host-derived manifest summary after settlement", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "write", name: "worker", worktree: true, branch: "sumo/custom" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_check").execute("tc", { id: "sa-1" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("branch: sumo/custom · base base-re · +1 commits · 1 file changed · clean");
	});

	it("wait errors on unknown id and lists known ids", async () => {
		const { tool, ctx } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await expect(tool("subagent_wait").execute("tc", { ids: ["sa-2"] }, undefined, undefined, ctx as never)).rejects.toThrow("Known ids: sa-1");
	});

	it("emits all 64 wait and cancel Activity envelopes", async () => {
		const snapshots: SubagentSnapshot[] = Array.from({ length: 64 }, (_, index) => ({
			id: `sa-${index + 1}`,
			title: `worker ${index + 1}`,
			prompt: `work ${index + 1}`,
			cwd: "/tmp/project",
			baseRef: "base-ref",
			status: "done",
			createdAt: 1_000,
			settledAt: 2_000,
			usage: { turns: 1 },
			transcript: [],
			liveText: "",
			liveTools: [],
			finalText: "done",
		}));
		const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
		const manager = {
			waitFor: vi.fn(async () => snapshots),
			cancel: vi.fn(async (ids: readonly string[]) => ids.map((id) => `Cancelled ${id}`)),
			get: vi.fn((id: string) => snapshots.find((snapshot) => snapshot.id === id)),
		};
		const delivery = { consume: vi.fn() };
		// SAFETY: doubles cover exactly the members registerSubagentTools touches on each object.
		registerSubagentTools({
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => registered.push(tool),
			getThinkingLevel: () => "medium",
			getActiveTools: () => ["read"],
		} as never, manager as never, delivery, { kind: "none" } as never);
		const tool = (name: string) => registered.find((entry) => entry.name === name)!;
		const ids = snapshots.map((snapshot) => snapshot.id);

		const waited = await tool("subagent_wait").execute("wait-64", { ids }, undefined, undefined);
		const cancelled = await tool("subagent_cancel").execute("cancel-64", { ids });

		// SAFETY: wait/cancel results always carry a details.activity envelope array.
		expect((waited as { details: { activity: unknown[] } }).details.activity).toHaveLength(64);
		// SAFETY: wait/cancel results always carry a details.activity envelope array.
		expect((cancelled as { details: { activity: unknown[] } }).details.activity).toHaveLength(64);
		expect(delivery.consume).toHaveBeenCalledTimes(128);
	});

	it("includes the failure reason in wait results even when partial text exists", async () => {
		const { tool, emitters, ctx } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const spawnResult = await tool("subagent_spawn").execute("t1", { prompt: "p", name: "n" }, undefined, undefined, ctx as never);
		// SAFETY: spawn results always expose details.subagent.id.
		const id = ((spawnResult as { details: { subagent: { id: string } } }).details.subagent).id;
		emitters.get(id)?.({ kind: "message-end", role: "assistant", text: "partial progress" });
		emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "provider exploded", partialText: "partial progress" } });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const waited = await tool("subagent_wait").execute("t2", { ids: [id] }, undefined, undefined, ctx as never);
		const text = textOf(waited);
		expect(text).toContain("error: provider exploded");
		expect(text).toContain("partial progress");
		expect(text).toContain("shared checkout · base base-re · +0 checkout commits · changed paths suppressed · checkout clean");
		expect(waited).toMatchObject({ details: { activity: [{ id: `subagent:${id}`, status: "failed", result: { error: "provider exploded" } }] } });
	});

	it("cancel returns bounded metadata and Activity updates without raw snapshots", async () => {
		const { tool, ctx, emitters } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("spawn-1", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "message-end", role: "assistant", text: "RAW_TRANSCRIPT_MUST_NOT_ESCAPE" });

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_cancel").execute("cancel-1", { ids: ["sa-1", "sa-404"] }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Cancelled sa-1");
		expect(result).toMatchObject({
			details: {
				subagents: [{ id: "sa-1", title: "w", status: "error", createdAt: expect.any(Number), settledAt: expect.any(Number) }],
				activity: [{ id: "subagent:sa-1", status: "cancelled", result: { summary: "RAW_TRANSCRIPT_MUST_NOT_ESCAPE", error: "interrupted" } }],
			},
		});
		/** Bounded cancellation metadata entry shape. */
		type MetadataEntry = { id?: string; title?: string; status?: string };
		// SAFETY: cancel results always carry details.subagents metadata entries.
		const metadata = (result as { details: { subagents: MetadataEntry[] } }).details.subagents[0];
		expect(metadata).not.toHaveProperty("transcript");
		expect(metadata).not.toHaveProperty("liveText");
		expect(metadata).not.toHaveProperty("finalText");
		// SAFETY: details exists on every tool result envelope.
		expect(JSON.stringify((result as { details: unknown }).details)).not.toContain('"transcript"');
	});
});
