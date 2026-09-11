import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { projectPiToolActivity } from "../activity/pi-projector.js";
import { TRUNCATED_HEAD_MARKER } from "../child-protocol.js";
import { herdrTerminalHost } from "../terminal-host/herdr.js";
import type { TerminalHost, TerminalHostKind } from "../terminal-host/types.js";
import { createPaneChildSpawner } from "./backend-pane.js";
import { SUBAGENT_MAX_RUNNING, type SubagentEvent, type SubagentSnapshot } from "./domain.js";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import { loadRoles, type RoleWarning, type SubagentRole } from "./roles.js";
import { registerSubagentTools } from "./tools.js";

/** Tool result shape returned by every subagent tool. */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

/** Spawned-child double: only visible children get send/requestClose. */
type FakeSpawnedChild = {
	events: (emit: (event: SubagentEvent) => void) => void;
	interrupt: () => void;
	send?: (text: string) => Promise<void>;
	requestClose?: () => void;
};

const createHarness = (hostKind: TerminalHostKind = "herdr", roles?: readonly SubagentRole[], roleWarnings: readonly RoleWarning[] = []) => {
	const registered: Array<{ name: string; parameters?: unknown; promptGuidelines?: readonly string[]; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const childSends = new Map<string, ReturnType<typeof vi.fn>>();
	const childRequestCloses = new Map<string, ReturnType<typeof vi.fn>>();
	const sendPaneText = vi.fn(async () => ({ ok: true as const }));
	const delivery = { consume: vi.fn() };
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
		const child: FakeSpawnedChild = {
			events: (emit) => {
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				if (task.visible) emit({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
			},
			interrupt: vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
		};
		// Model the real capability split: only visible children can steer/close.
		if (task.visible) {
			const send = vi.fn(async () => undefined);
			const requestClose = vi.fn();
			child.send = send;
			child.requestClose = requestClose;
			childSends.set(task.id, send);
			childRequestCloses.set(task.id, requestClose);
		}
		// SAFETY: the fake child implements every SpawnedChild member this manager path calls; send/requestClose are present exactly for visible children, mirroring the real backends.
		return child as import("./backend-pi.js").SpawnedChild;
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
	registerSubagentTools(pi as never, manager, delivery, host, roleLoader);
	const tool = (name: string) => registered.find((entry) => entry.name === name)!;
	const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5", thinkingLevel: "low" } };
	return { registered, manager, emitters, tool, ctx, host, sendPaneText, createWorktree, spawnedTasks, childSends, childRequestCloses, delivery };
};

const textOf = <T extends { content: Array<{ text: string }> }>(result: T): string => result.content[0]!.text;

const publicSpawnTool = (manager: SubagentManager, host: TerminalHost, roles: readonly SubagentRole[] = []) => {
	const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
	// SAFETY: the public-seam double implements every ExtensionAPI member the registration and spawn handler use.
	registerSubagentTools({
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => registered.push(tool),
		getThinkingLevel: () => "medium",
		getActiveTools: () => ["read", "bash"],
	} as never, manager, undefined, host, () => ({ roles, warnings: [] }));
	return registered.find((tool) => tool.name === "subagent_spawn")!;
};

describe("subagent tools", () => {
	it("surfaces warning budgets in list/check without cancelling and refuses invalid limits", async () => {
		vi.useFakeTimers();
		const { manager, tool, ctx, spawnedTasks } = createHarness();
		try {
			await expect(tool("subagent_spawn").execute("invalid", { prompt: "task", name: "task", budget: { tokens: 0 } }, undefined, undefined, ctx)).rejects.toThrow(/budget/);
			expect(spawnedTasks).toEqual([]);
			await tool("subagent_spawn").execute("valid", { prompt: "task", name: "task", budget: { wallTimeMs: 1000 } }, undefined, undefined, ctx);
			await vi.advanceTimersByTimeAsync(1000);
			for (const name of ["subagent_list", "subagent_check"]) {
				const text = textOf(await tool(name).execute("check", { id: "sa-1" }));
				expect(text).toContain("over-budget-warning");
				expect(text).toContain("wall 100%");
				expect(text).toContain("reported tokens unknown");
				expect(text).toContain("inspect or explicitly cancel with subagent_cancel");
			}
			expect(manager.get("sa-1")?.status).toBe("running");
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("keeps visible children quiet with unknown liveness instead of inventing a stall", async () => {
		vi.useFakeTimers();
		const { manager, tool, ctx } = createHarness();
		try {
			await tool("subagent_spawn").execute("visible", { prompt: "task", name: "task", visible: true }, undefined, undefined, ctx);
			await vi.advanceTimersByTimeAsync(600_000);
			expect(manager.get("sa-1")).toMatchObject({ status: "running", health: "quiet", lastProgressAt: null, liveness: "unknown", warnings: [] });
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("registers the seven subagent tools and exposes visible spawning with baseRef", () => {
		const { registered, tool } = createHarness();
		expect(registered.map((entry) => entry.name)).toEqual(["subagent_spawn", "subagent_send", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_close", "subagent_list"]);
		const spawnSchema = JSON.stringify(tool("subagent_spawn").parameters);
		expect(spawnSchema).toContain("visible");
		expect(spawnSchema).toContain("baseRef");
	});

	it("enumerates loaded roles with their resolved model in the spawn schema", () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully", model: "openai-codex/gpt-5.6-sol", defaultWorktree: true };
		const { tool } = createHarness("herdr", [role]);
		const spawnSchema = JSON.stringify(tool("subagent_spawn").parameters);
		expect(spawnSchema).toContain("audit — use for audits (openai-codex/gpt-5.6-sol, worktree)");
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
		const { tool, ctx, manager } = createHarness("herdr", [role], [{ scope: "role", roleId: "audit", blocksRole: true, message: "role audit has an invalid thinking level; entry skipped" }]);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "audit" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("roles.json has invalid configuration");
		expect(textOf(result)).toContain("invalid thinking level");
		expect(result).toMatchObject({ details: { action: "spawn", status: "invalid_role_config", role: "audit" } });
		expect(manager.list()).toEqual([]);
	});

	it("scopes role warnings to the selected role while keeping built-ins available", async () => {
		const research: SubagentRole = { id: "research", label: "Research", description: "read only", systemPrompt: "research" };
		const roleWarnings: RoleWarning[] = [
			{ scope: "role", roleId: "audit", blocksRole: true, message: "role audit has an invalid thinking level; entry skipped" },
		];
		const valid = createHarness("herdr", [research], roleWarnings);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const validResult = await valid.tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "research" }, undefined, undefined, valid.ctx as never);
		expect(textOf(validResult)).toContain("Started sa-1");

		const invalid = createHarness("herdr", [research], roleWarnings);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const invalidResult = await invalid.tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "audit" }, undefined, undefined, invalid.ctx as never);
		expect(textOf(invalidResult)).toContain("invalid thinking level");
		expect(invalidResult).toMatchObject({ details: { status: "invalid_role_config", warnings: roleWarnings } });

		const fileWarnings: RoleWarning[] = [{ scope: "file", blocksOverlays: true, message: "invalid roles.json: unexpected token" }];
		const fallback = createHarness("herdr", [research], fileWarnings);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const fallbackResult = await fallback.tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "research" }, undefined, undefined, fallback.ctx as never);
		expect(textOf(fallbackResult)).toContain("Started sa-1");

		const audit: SubagentRole = { id: "audit", label: "Audit", description: "audit", systemPrompt: "audit" };
		const siblingWarning: RoleWarning[] = [{ scope: "file", blocksOverlays: false, message: "roles[2] must be an object; entry skipped" }];
		const custom = createHarness("herdr", [research, audit], siblingWarning);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const customResult = await custom.tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "audit" }, undefined, undefined, custom.ctx as never);
		expect(textOf(customResult)).toContain("Started sa-1");
	});

	it("allows a role whose warnings are advisory", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const roleWarnings: RoleWarning[] = [{ scope: "role", roleId: "audit", blocksRole: false, message: "role audit ignores unknown field futureField" }];
		const { tool, ctx, manager } = createHarness("herdr", [role], roleWarnings);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "do it", name: "worker", role: "audit" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Started sa-1");
		expect(manager.get("sa-1")?.roleId).toBe("audit");
	});

	it("keeps role-loader warnings out of role-free spawns", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully" };
		const { tool, ctx, manager } = createHarness("herdr", [role], [{ scope: "file", blocksOverlays: true, message: "invalid optional role overlay" }]);

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
		await expect(tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never)).rejects.toThrow("require a running herdr terminal host");
	});

	it("returns a pre-pane host failure without waiting for a stalled manifest", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "sumocode-spawn-fast-failure-"));
		try {
			const host: TerminalHost = {
				kind: "herdr",
				startAgentPane: vi.fn(async () => ({ ok: false as const, code: "pane_unavailable", error: "no pane", reason: "no attach target" })),
				openCommandInSplit: vi.fn(),
				closePane: vi.fn(),
				notify: vi.fn(),
			};
			// SAFETY: the pane backend and manager use only pi.exec on this test double.
			const piExec = { exec: vi.fn() } as never;
			const spawnPane = createPaneChildSpawner({ baseDir: taskDir, env: {} });
			const manager = new SubagentManager((task) => spawnPane({
				...task,
				name: task.title,
				host,
				pi: piExec,
				placement: task.placement!,
			}), {
				captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }),
				buildCompletionManifest: async () => new Promise(() => undefined),
				terminalHost: host,
				pi: piExec,
				initialVisibleTabId: "w1:t1",
			});
			const startedAt = performance.now();

			const result = await publicSpawnTool(manager, host).execute("spawn-1", {
				prompt: "watch",
				name: "worker",
				visible: true,
			}, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } });

			expect(performance.now() - startedAt).toBeLessThan(1_000);
			expect(result).toMatchObject({
				details: {
					status: "pane_unavailable",
					herdrReason: "no attach target",
					subagent: { status: "error", manifest: { exit: "failed" } },
				},
			});
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	}, 10_000);

	it("bounds concurrent no-pane spawns across reservation and Herdr provisioning", async () => {
		vi.useFakeTimers();
		vi.stubEnv("HERDR_ENV", "");
		vi.stubEnv("HERDR_PANE_ID", "");
		const taskDir = await mkdtemp(join(tmpdir(), "sumocode-spawn-reservation-timeout-"));
		try {
			let hostMode: "stall" | "succeed" = "stall";
			let stalledCalls = 0;
			const exec = vi.fn((_command: string, args: string[], options: { timeout: number }) => {
				if (hostMode === "stall") {
					stalledCalls += 1;
					const delayMs = stalledCalls === 1 ? Math.min(2_500, options.timeout) : options.timeout;
					return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
						setTimeout(() => resolve({ stdout: "", stderr: "", code: 1, killed: true }), delayMs);
					});
				}
				if (args[0] === "tab") {
					return Promise.resolve({ stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2" } } }), stderr: "", code: 0, killed: false });
				}
				return Promise.resolve({ stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false });
			});
			// SAFETY: exec implements the Pi exec result contract exercised by the real Herdr adapter.
			const piExec = { exec } as never;
			const spawnPane = createPaneChildSpawner({ baseDir: taskDir, env: {} });
			const manager = new SubagentManager((task) => spawnPane({
				...task,
				name: task.title,
				host: herdrTerminalHost,
				pi: piExec,
				placement: task.placement!,
			}), {
				captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }),
				terminalHost: herdrTerminalHost,
				pi: piExec,
			});
			const spawn = publicSpawnTool(manager, herdrTerminalHost);
			const startedAt = Date.now();
			const first = spawn.execute("spawn-1", { prompt: "watch one", name: "one", visible: true }, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } })
				.then((result) => ({ result, elapsed: Date.now() - startedAt }));
			await vi.advanceTimersByTimeAsync(0);
			expect(exec).toHaveBeenCalledTimes(1);
			const second = spawn.execute("spawn-2", { prompt: "watch two", name: "two", visible: true }, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } })
				.then((result) => ({ result, elapsed: Date.now() - startedAt }));
			const third = spawn.execute("spawn-3", { prompt: "watch three", name: "three", visible: true }, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } })
				.then((result) => ({ result, elapsed: Date.now() - startedAt }));

			await vi.advanceTimersByTimeAsync(10_000);
			const completed = await Promise.all([first, second, third]);

			expect(Math.max(...completed.map(({ elapsed }) => elapsed))).toBeLessThan(5_000);
			expect(completed[0]?.result).toMatchObject({ details: { status: "pane_unavailable" } });
			expect(completed[1]?.result).toMatchObject({ details: { status: "pane_unavailable" } });
			// The cleanup reserve bounds the second spawn's tab create tighter, so
			// the third spawn inherits a slot whose remaining budget is exactly the
			// reserve. It fails at the Herdr deadline check without an exec call.
			expect(completed[2]?.result).toMatchObject({
				details: {
					status: "pane_unavailable",
					herdrReason: "herdr tab create exceeded the Herdr pane provisioning deadline",
					subagent: {
						status: "error",
						errorText: "herdr tab create exceeded the Herdr pane provisioning deadline",
					},
				},
			});
			expect(exec).toHaveBeenCalledTimes(2);
			expect(exec.mock.calls[1]?.[2].timeout).toBeLessThan(2_500);
			expect(await readdir(taskDir)).toHaveLength(3);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(exec).toHaveBeenCalledTimes(2);

			hostMode = "succeed";
			const fourthResult = await spawn.execute("spawn-4", { prompt: "watch four", name: "four", visible: true }, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } });
			expect(textOf(fourthResult)).toContain("Started sa-4");
			expect(manager.get("sa-4")).toMatchObject({ status: "running", pane: { paneId: "w1:p3" } });
		} finally {
			vi.useRealTimers();
			vi.unstubAllEnvs();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("shares one Herdr budget for default-worktree fallback and returns pane_unavailable", async () => {
		vi.useFakeTimers();
		const taskDir = await mkdtemp(join(tmpdir(), "sumocode-spawn-worktree-failure-"));
		try {
			const exec = vi.fn((_command: string, args: string[], options: { timeout: number }) => new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
				const expectedDuration = args[0] === "worktree" || (args[0] === "pane" && args[1] === "list") ? 3_000 : 0;
				const duration = Math.min(expectedDuration, options.timeout);
				setTimeout(() => {
					if (duration < expectedDuration) {
						resolve({ stdout: "", stderr: "", code: 1, killed: true });
						return;
					}
					if (args[0] === "worktree") {
						resolve({ stdout: JSON.stringify({ result: { workspace: { workspace_id: "w9" } } }), stderr: "", code: 0, killed: false });
						return;
					}
					resolve({ stdout: JSON.stringify({ result: { panes: [] } }), stderr: "", code: 0, killed: false });
				}, duration);
			}));
			// SAFETY: exec implements the Pi exec result contract exercised by the real Herdr adapter.
			const piExec = { exec } as never;
			const spawnPane = createPaneChildSpawner({ baseDir: taskDir, env: {} });
			const createWorktree = vi.fn(async () => ({ ok: true as const, path: "/repo.sumo-worktrees/sumo__worker", branch: "sumo/worker", baseRef: "HEAD" }));
			const manager = new SubagentManager((task) => spawnPane({
				...task,
				name: task.title,
				host: herdrTerminalHost,
				pi: piExec,
				placement: task.placement!,
			}), {
				captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }),
				createWorktree,
				resolveWorktreeBaseRef: async () => "base-ref",
				buildCompletionManifest: async () => new Promise(() => undefined),
				terminalHost: herdrTerminalHost,
				pi: piExec,
			});
			const role: SubagentRole = { id: "implement-cheap", label: "Implement Cheap", description: "implement", systemPrompt: "implement", defaultWorktree: true };
			const startedAt = Date.now();
			const pending = publicSpawnTool(manager, herdrTerminalHost, [role]).execute("spawn-1", {
				prompt: "write",
				name: "worker",
				role: "implement-cheap",
				visible: true,
			}, undefined, undefined, { cwd: "/repo", model: { provider: "openai", id: "gpt-5" } }).then((result) => ({ result, elapsed: Date.now() - startedAt }));

			await vi.advanceTimersByTimeAsync(20_000);
			const { result, elapsed } = await pending;

			expect(elapsed).toBeLessThanOrEqual(5_000);
			expect(createWorktree).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				details: {
					status: "pane_unavailable",
					herdrReason: expect.stringContaining("herdr pane list"),
					subagent: {
						status: "error",
						worktree: { path: "/repo.sumo-worktrees/sumo__worker" },
						manifest: { exit: "failed" },
					},
				},
			});
		} finally {
			vi.useRealTimers();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("returns pane_unavailable with Herdr's reason as structured spawn details", async () => {
		const { tool, ctx, manager } = createHarness();
		vi.spyOn(manager, "spawn").mockResolvedValue({
			id: "sa-1",
			title: "worker",
			prompt: "watch",
			cwd: "/tmp/project",
			baseRef: "base-ref",
			visible: true,
			status: "error",
			createdAt: 1,
			settledAt: 2,
			errorText: "herdr returned no pane for tab w5:t8",
			errorCode: "pane_unavailable",
			errorReason: "tab has no available shell pane",
			usage: { turns: 0 },
			transcript: [],
			liveText: "",
			liveTools: [],
			finalText: "",
		});

		// SAFETY: the ctx double carries only the fields the tool handler reads.
		const result = await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);

		expect(result).toMatchObject({
			details: {
				action: "spawn",
				status: "pane_unavailable",
				herdrReason: "tab has no available shell pane",
				subagent: { id: "sa-1", status: "error" },
			},
		});
		expect(textOf(result)).toContain("tab has no available shell pane");
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

	it("builds prompt guidelines from the loaded role table", () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully", model: "openai-codex/gpt-5.6-sol", defaultWorktree: true };
		const { tool } = createHarness("herdr", [role]);
		expect(tool("subagent_spawn").promptGuidelines?.join("\n")).toContain("audit → openai-codex/gpt-5.6-sol (worktree)");
	});

	it("prints the role table when no subagents are tracked", async () => {
		const role: SubagentRole = { id: "audit", label: "Audit", description: "use for audits", systemPrompt: "audit carefully", model: "openai-codex/gpt-5.6-sol", defaultWorktree: true };
		const { tool, ctx } = createHarness("herdr", [role]);
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_list").execute("tc", {}, undefined, undefined, ctx as never);
		expect(textOf(result)).toContain("No subagents tracked.");
		expect(textOf(result)).toContain("audit → openai-codex/gpt-5.6-sol (worktree)");
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

	it("sends steering text through the child's control channel, not the pane PTY", async () => {
		const { tool, ctx, childSends, sendPaneText } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_send").execute("tc", { id: "sa-1", text: "continue with tests" }, undefined, undefined, ctx as never);

		expect(textOf(result)).toBe("Steering submitted to the child runtime for sa-1 (worker); Pi exposes no post-acceptance acknowledgement.");
		expect(textOf(result)).not.toMatch(/(?:was|is) (?:delivered|accepted)|delivery-to-child/);
		expect(childSends.get("sa-1")).toHaveBeenCalledWith("continue with tests");
		expect(sendPaneText).not.toHaveBeenCalled();
		expect(result).toMatchObject({ details: { action: "send", id: "sa-1", pane: { paneId: "w1:p2" } } });
	});

	it("rejects blank and whitespace steering before the manager or child sees it", async () => {
		const { tool, ctx, childSends } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("tc", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, ctx as never);
		// SAFETY: visible harness children always register a send double in childSends.
		const send = childSends.get("sa-1") as ReturnType<typeof vi.fn>;

		for (const blank of ["", "   ", "\n\t "]) {
			// SAFETY: the ctx double carries only the fields the tool handlers read.
			await expect(tool("subagent_send").execute("tc", { id: "sa-1", text: blank }, undefined, undefined, ctx as never))
				.rejects.toThrow("blank or whitespace-only steering is rejected before submission");
		}
		expect(send).not.toHaveBeenCalled();
		// The schema carries minLength so the model-facing contract rejects blanks too.
		expect(JSON.stringify(tool("subagent_send").parameters)).toContain('"minLength":1');
	});

	it("reports subagent_send error taxonomy", async () => {
		const headless = createHarness();
		await expect(headless.tool("subagent_send").execute("tc", { id: "sa-404", text: "hi" })).rejects.toThrow("Unknown subagent id");
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await headless.tool("subagent_spawn").execute("tc", { prompt: "quiet", name: "headless" }, undefined, undefined, headless.ctx as never);
		const unsupported = await headless.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" });
		expect(unsupported).toMatchObject({ details: { action: "send", capability: "unsupported: headless steering" } });
		expect(unsupported).not.toHaveProperty("isError", true);
		expect(textOf(unsupported)).toBe("unsupported: headless steering; respawn with visible: true to steer");
		expect(projectPiToolActivity({ id: "tc", name: "subagent_send", status: "done", output: textOf(unsupported), details: unsupported.details },
			{ messageId: "message", blockIndex: 0 })).toMatchObject({ status: "succeeded", body: { kind: "text", text: textOf(unsupported) } });

		const settled = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await settled.tool("subagent_spawn").execute("tc", { prompt: "watch", name: "visible", visible: true }, undefined, undefined, settled.ctx as never);
		settled.emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(settled.manager.get("sa-1")?.status).toBe("done"));
		await expect(settled.tool("subagent_send").execute("tc", { id: "sa-1", text: "hi" })).rejects.toThrow("already settled");
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

	it("preserves literal truncation-marker text in untruncated wait results", async () => {
		const { tool, emitters, ctx } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const spawned = await tool("subagent_spawn").execute("spawn-literal", { prompt: "do", name: "marker reviewer" }, undefined, undefined, ctx as never);
		// SAFETY: spawn results always expose details.subagent.id.
		const id = (spawned as { details: { subagent: { id: string } } }).details.subagent.id;
		const finalText = `before${TRUNCATED_HEAD_MARKER}after`;
		emitters.get(id)?.({ kind: "message-end", role: "assistant", text: finalText });
		emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText } });

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const waited = await tool("subagent_wait").execute("wait-literal", { ids: [id] }, undefined, undefined, ctx as never);
		expect(textOf(waited)).toContain(finalText);
	});

	it("keeps the omission marker through per-agent and aggregate wait projections", async () => {
		const { tool, ctx, emitters, manager } = createHarness();
		const ids: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			// SAFETY: the ctx double carries only the fields the tool handlers read.
			const spawned = await tool("subagent_spawn").execute(`spawn-${index}`, { prompt: "do", name: `worker-${index}` }, undefined, undefined, ctx as never);
			// SAFETY: spawn results always expose details.subagent.id.
			const id = (spawned as { details: { subagent: { id: string } } }).details.subagent.id;
			ids.push(id);
			const prefix = index === 3 ? "FOURTH-USEFUL:" : `RESULT-${index}:`;
			const finalText = `${prefix}${"x".repeat((index === 3 ? 20 : 15) * 1024)}${index === 3 ? TRUNCATED_HEAD_MARKER : ""}`;
			emitters.get(id)?.({ kind: "message-end", role: "assistant", text: finalText });
			emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText } });
		}
		await vi.waitFor(() => expect(ids.every((id) => manager.get(id)?.status === "done")).toBe(true));

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const one = await tool("subagent_wait").execute("wait-one", { ids: [ids[3]] }, undefined, undefined, ctx as never);
		expect(Buffer.byteLength(textOf(one), "utf8")).toBeLessThanOrEqual(16 * 1024);
		expect(textOf(one)).toContain("FOURTH-USEFUL:");
		expect(textOf(one).split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const all = await tool("subagent_wait").execute("wait-all", { ids }, undefined, undefined, ctx as never);
		expect(Buffer.byteLength(textOf(all), "utf8")).toBeLessThanOrEqual(48 * 1024);
		expect(textOf(all)).toContain("FOURTH-USEFUL:");
		expect(textOf(all).split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
	});

	it.each([
		["when the last retained chunk is shorter than the marker", [16_371, 16_371, 16_313, 1, 1]],
		["when retained chunks exactly fill the aggregate cap", [12_270, 12_270, 12_270, 12_269, 1]],
	] as const)("marks aggregate omission %s", async (_label, lengths) => {
		const snapshots: SubagentSnapshot[] = lengths.map((length, index) => ({
			id: `sa-${index + 1}`,
			title: "",
			prompt: "work",
			cwd: "/tmp/project",
			baseRef: "base-ref",
			status: "done",
			createdAt: 1_000,
			settledAt: 2_000,
			usage: { turns: 1 },
			transcript: [],
			liveText: "",
			liveTools: [],
			finalText: "x".repeat(length),
		}));
		const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
		const manager = {
			waitFor: vi.fn(async () => snapshots),
			get: vi.fn((id: string) => snapshots.find((snapshot) => snapshot.id === id)),
		};
		const delivery = { consume: vi.fn() };
		// SAFETY: doubles cover exactly the members registerSubagentTools touches on each object.
		registerSubagentTools({
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => registered.push(tool),
			getThinkingLevel: () => "medium",
			getActiveTools: () => ["read"],
		} as never, manager as never, delivery, { kind: "none" } as never);
		const wait = registered.find((entry) => entry.name === "subagent_wait")!;

		const result = await wait.execute("wait-short-tail", { ids: snapshots.map((snapshot) => snapshot.id) }, undefined, undefined);
		const text = textOf(result);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(48 * 1024);
		expect(text.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(delivery.consume).toHaveBeenCalledTimes(lengths.length);
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

describe("subagent_close tool", () => {
	it("consumes delivery and appends bounded results for ids that settled", async () => {
		const { tool, ctx, emitters, manager, delivery } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("spawn-1", { prompt: "do", name: "w" }, undefined, undefined, ctx as never);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "final answer" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_close").execute("close-1", { ids: ["sa-1"] }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("sa-1 was already done");
		expect(textOf(result)).toContain("final answer");
		expect(delivery.consume).toHaveBeenCalledWith("sa-1");
		expect(result).toMatchObject({
			details: {
				action: "close",
				ids: ["sa-1"],
				subagents: [{ id: "sa-1", title: "w", status: "done" }],
				activity: [{ id: "subagent:sa-1", status: "succeeded" }],
			},
		});
	});

	it("closes a running visible child inline and consumes its delivered result", async () => {
		const { tool, ctx, emitters, childRequestCloses, manager, delivery } = createHarness();
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		await tool("subagent_spawn").execute("spawn-1", { prompt: "do", name: "worker", visible: true }, undefined, undefined, ctx as never);
		// SAFETY: visible harness children always register a requestClose double.
		(childRequestCloses.get("sa-1") as ReturnType<typeof vi.fn>).mockImplementation(() => {
			emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "wrapped up" } });
		});

		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const result = await tool("subagent_close").execute("close-1", { ids: ["sa-1"] }, undefined, undefined, ctx as never);

		expect(textOf(result)).toContain("Closed sa-1");
		expect(textOf(result)).toContain("wrapped up");
		expect(manager.get("sa-1")?.status).toBe("done");
		expect(delivery.consume).toHaveBeenCalledWith("sa-1");
	});

	it("keeps a still-running child unconsumed with a follow-up line", async () => {
		vi.useFakeTimers();
		try {
			const { tool, ctx, childRequestCloses, manager, delivery } = createHarness();
			// SAFETY: the ctx double carries only the fields the tool handlers read.
			await tool("subagent_spawn").execute("spawn-1", { prompt: "do", name: "worker", visible: true }, undefined, undefined, ctx as never);

			const closing = tool("subagent_close").execute("close-1", { ids: ["sa-1"] });
			await vi.advanceTimersByTimeAsync(15_000);
			const result = await closing;

			expect(textOf(result)).toContain("close requested for sa-1; still running — check the pane or use subagent_cancel");
			expect(manager.get("sa-1")?.status).toBe("running");
			expect(delivery.consume).not.toHaveBeenCalled();
			expect(childRequestCloses.get("sa-1")).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
