import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { SubagentEvent } from "./domain.js";
import type { CompletionManifest, CompletionManifestEvidence } from "./manifest.js";
import type { TerminalHost } from "../terminal-host/types.js";

const makeTask = (title: string): SpawnSubagentTask => ({ title, prompt: `prompt ${title}`, cwd: "/tmp" });

const fakeManifestBuilder = async (options: Parameters<NonNullable<import("./manager.js").SubagentManagerDependencies["buildCompletionManifest"]>>[0]) => ({
	baseRef: options.baseRef,
	headRef: options.baseRef,
	branch: options.worktree?.branch,
	worktreePath: options.worktree?.path,
	changedPaths: [] as readonly string[],
	dirty: false,
	commits: 0,
	exit: options.outcome.kind,
	durationMs: 1,
});

const deferredBackend = () => {
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const interrupts = new Map<string, ReturnType<typeof vi.fn>>();
	const manager = new SubagentManager((task) => {
		const interrupt = vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } }));
		interrupts.set(task.id, interrupt);
		return {
			events: (emit) => {
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
			},
			interrupt,
		};
	}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
	return { manager, emitters, interrupts };
};

describe("SubagentManager", () => {
	it("enforces capacity", async () => {
		const { manager } = deferredBackend();
		for (let index = 0; index < 4; index += 1) await expect(manager.spawn(makeTask(`${index}`))).resolves.toMatchObject({ id: `sa-${index + 1}` });
		const over = await manager.spawn(makeTask("over"));
		expect(over).toMatchObject({ status: "at_capacity", capacity: 4, runningCount: 4 });
		expect(manager.list()).toHaveLength(4);
	});

	it("includes setup-pending spawns in capacity summaries", async () => {
		let releaseCapture: () => void = () => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const manager = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), {
			captureGitContext: async () => {
				await captureGate;
				return { baseRef: "base-ref" };
			},
		});
		const pending = Array.from({ length: 4 }, (_, index) => manager.spawn(makeTask(`pending-${index}`)));

		const over = await manager.spawn(makeTask("over"));

		expect(over).toMatchObject({ status: "at_capacity", runningCount: 4 });
		expect("running" in over ? over.running.map((task) => task.id) : []).toEqual(["sa-1", "sa-2", "sa-3", "sa-4"]);
		releaseCapture();
		await Promise.all(pending);
	});

	it("frees capacity while a settled child manifest is still collecting", async () => {
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const manifestPromise = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const manager = new SubagentManager((task) => ({
			events: (emit) => emitters.set(task.id, emit),
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			buildCompletionManifest: async () => manifestPromise,
		});
		for (let index = 0; index < 4; index += 1) await manager.spawn(makeTask(`${index}`));
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		const replacement = await manager.spawn(makeTask("replacement"));

		expect(replacement).toMatchObject({ id: "sa-5", status: "running" });
		resolveManifest({ baseRef: "base-ref", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));
	});

	it("folds events into immutable snapshots", async () => {
		const { manager, emitters } = deferredBackend();
		const spawned = await manager.spawn(makeTask("fold"));
		expect(spawned).toMatchObject({ id: "sa-1" });
		emitters.get("sa-1")?.({ kind: "assistant-delta", delta: "hi" });
		expect(manager.get("sa-1")?.liveText).toBe("hi");
		emitters.get("sa-1")?.({ kind: "message-end", role: "assistant", text: "hi done" });
		expect(manager.get("sa-1")?.liveText).toBe("");
		expect(manager.get("sa-1")?.finalText).toBe("hi done");
		expect(manager.get("sa-1")?.usage.turns).toBe(1);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "hi done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));
	});

	it("waitFor resolves settled snapshots and marks them consumed", async () => {
		const { manager, emitters } = deferredBackend();
		await manager.spawn(makeTask("wait"));
		const pending: string[][] = [];
		const wait = manager.waitFor(["sa-1"], undefined, (snapshots) => pending.push(snapshots.map((snapshot) => snapshot.id)));
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await expect(wait).resolves.toMatchObject([{ id: "sa-1", status: "done" }]);
		expect(pending).toEqual([["sa-1"]]);
		expect(manager.consumedIds.has("sa-1")).toBe(true);
	});

	it("stores the manifest before completion listeners are notified", async () => {
		let emitFn: ((event: SubagentEvent) => void) | undefined;
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const manifestPromise = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; },
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			buildCompletionManifest: async () => manifestPromise,
		});
		await manager.spawn(makeTask("ordering"));
		const observedManifests: Array<CompletionManifestEvidence | undefined> = [];
		manager.addChangeListener(() => observedManifests.push(manager.get("sa-1")?.manifest));

		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		expect(observedManifests).toEqual([]);
		resolveManifest({ baseRef: "base-ref", headRef: "head-ref", changedPaths: ["src/a.ts"], dirty: false, commits: 1, exit: "completed", durationMs: 10 });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		expect(observedManifests).toEqual([expect.objectContaining({ changedPaths: ["src/a.ts"] })]);
	});

	it("settles with a partial manifest when collection exceeds five seconds", async () => {
		vi.useFakeTimers();
		try {
			let emitFn: ((event: SubagentEvent) => void) | undefined;
			const manager = new SubagentManager(() => ({
				events: (emit) => { emitFn = emit; },
				interrupt: () => undefined,
			}), {
				captureGitContext: async () => ({ baseRef: "base-ref" }),
				buildCompletionManifest: async () => new Promise(() => undefined),
			});
			await manager.spawn(makeTask("timeout"));

			emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.advanceTimersByTimeAsync(5_000);

			expect(manager.get("sa-1")).toMatchObject({
				status: "done",
				manifest: { exit: "completed", durationMs: 0 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("waitFor rejects unknown ids with known id list", async () => {
		const { manager } = deferredBackend();
		await manager.spawn(makeTask("known"));
		await expect(manager.waitFor(["sa-2"])).rejects.toThrow("Known ids: sa-1");
	});

	it("cancels running children and reports already-settled ids", async () => {
		const { manager, emitters, interrupts } = deferredBackend();
		await manager.spawn(makeTask("run"));
		await manager.spawn(makeTask("done"));
		emitters.get("sa-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-2")?.status).toBe("done"));
		await expect(manager.cancel(["sa-1", "sa-2"])).resolves.toEqual(["Cancelled sa-1", "sa-2 was already done"]);
		expect(interrupts.get("sa-1")).toHaveBeenCalled();
		expect(manager.consumedIds.has("sa-1")).toBe(true);
	});

	it("does not consume a completed result while its manifest is collecting", async () => {
		let emitFn: ((event: SubagentEvent) => void) | undefined;
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const manifestPromise = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; },
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			buildCompletionManifest: async () => manifestPromise,
		});
		await manager.spawn(makeTask("completed"));
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		await expect(manager.cancel(["sa-1"])).resolves.toEqual(["sa-1 was already done"]);
		expect(manager.consumedIds.has("sa-1")).toBe(false);
		resolveManifest({ baseRef: "base-ref", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));
	});

	it("prunes oldest settled snapshots above max tracked", async () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < 65; index += 1) {
			const result = await manager.spawn(makeTask(`${index}`));
			expect(result).toHaveProperty("id");
			emitters.get(`sa-${index + 1}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get(`sa-${index + 1}`)?.status).toBe("done"));
		}
		expect(manager.list()).toHaveLength(64);
		expect(manager.get("sa-1")).toBeUndefined();
		expect(manager.get("sa-65")).toBeDefined();
	});

	it("creates an isolated worktree before spawning and stores its ref", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const createWorktree = vi.fn(async () => ({
			ok: true as const,
			path: "/isolated/worktree",
			branch: "sumo/custom",
			baseRef: "abc123",
		}));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "write feature", cwd: "/repo", worktree: true, branch: "sumo/custom" });

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", branch: "sumo/custom", baseRef: "abc123" }));
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree" }));
		expect(spawned).toMatchObject({
			cwd: "/isolated/worktree",
			baseRef: "abc123",
			worktree: { path: "/isolated/worktree", branch: "sumo/custom", baseRef: "abc123", repoRoot: "/repo" },
		});
	});

	it("preserves the caller's subdirectory inside the worktree", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const createWorktree = vi.fn(async () => ({ ok: true as const, path: "/isolated/worktree", branch: "sumo/x", baseRef: "abc123" }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
		});
		await manager.spawn({ prompt: "p", title: "api work", cwd: "/repo/packages/api", worktree: true });
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree/packages/api" }));
	});

	it("stores the first visible tab id and reuses it for later placement", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			backendTasks.push(task);
			return {
				events: (emit) => {
					emit({ kind: "run-started" });
					emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
				},
				interrupt: () => undefined,
			};
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, pi: { exec: vi.fn() } as never });

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });

		expect(backendTasks[0]?.placement).toEqual({ kind: "new-tab", label: "subagents" });
		expect(backendTasks[1]?.placement).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
		expect(manager.get("sa-1")?.pane?.tabId).toBe("w1:t5");
	});

	it("counts settled visible panes toward tab capacity (open panes occupy real estate)", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			backendTasks.push(task);
			return {
				events: (emit) => {
					emit({ kind: "run-started" });
					emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
					// Settle immediately: the pane stays OPEN for inspection but the
					// child no longer counts as running.
					emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
				},
				interrupt: () => undefined,
			};
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, pi: { exec: vi.fn() } as never });

		for (let index = 0; index < 5; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `task ${index}`, cwd: "/repo", visible: true });
		}

		// Panes 1-4 fill the first tab even though they settled; the fifth must
		// overflow to a fresh tab instead of over-tiling the full one.
		expect(backendTasks[4]?.placement).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("invalidates the cached subagents tab when a visible child fails before any pane attaches", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		let mode: "attach" | "fail-preattach" = "attach";
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			backendTasks.push(task);
			const current = mode;
			return {
				events: (emit) => {
					emit({ kind: "run-started" });
					if (current === "attach") {
						emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
					} else {
						// Mirrors `herdr agent start --tab <dead>` failing: no pane ever attached.
						emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr agent start exited 1" } });
					}
				},
				interrupt: () => undefined,
			};
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, pi: { exec: vi.fn() } as never });

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		expect(backendTasks[0]?.placement).toEqual({ kind: "new-tab", label: "subagents" });

		// Human closes the tab; the next spawn targets the dead cached tab and fails pre-attach.
		mode = "fail-preattach";
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		expect(backendTasks[1]?.placement).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });

		// Recovery: the cache was invalidated, so the third spawn plans a fresh tab.
		mode = "attach";
		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true });
		expect(backendTasks[2]?.placement).toEqual({ kind: "new-tab", label: "subagents" });
	});

	it("serializes concurrent visible placement until the first tab id is durable", async () => {
		let releaseFirstReady = (): void => undefined;
		const firstReady = new Promise<void>((resolve) => { releaseFirstReady = resolve; });
		let firstEmit: ((event: SubagentEvent) => void) | undefined;
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			backendTasks.push(task);
			if (task.id === "sa-1") {
				return { events: (emit) => { firstEmit = emit; emit({ kind: "run-started" }); }, ready: firstReady, interrupt: () => undefined };
			}
			return {
				events: (emit) => {
					emit({ kind: "run-started" });
					emit({ kind: "pane-attached", pane: { agentName: "second", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p2" } });
				},
				ready: Promise.resolve(),
				interrupt: () => undefined,
			};
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, pi: { exec: vi.fn() } as never });

		const first = manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		await vi.waitFor(() => expect(backendTasks).toHaveLength(1));
		const second = manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		await Promise.resolve();
		expect(backendTasks).toHaveLength(1);

		firstEmit?.({ kind: "pane-attached", pane: { agentName: "first", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" } });
		releaseFirstReady();
		await Promise.all([first, second]);

		expect(backendTasks[0]?.placement).toEqual({ kind: "new-tab", label: "subagents" });
		expect(backendTasks[1]?.placement).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("opens the worktree root as a workspace while preserving the caller subdirectory cwd", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const openExistingWorktreeWorkspace = vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "w9:p1", workspaceId: "w9" } }));
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace,
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/worktree", branch: "sumo/api", baseRef: "abc123" }),
			terminalHost: host,
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p", title: "api work", cwd: "/repo/packages/api", visible: true, worktree: true });

		expect(openExistingWorktreeWorkspace).toHaveBeenCalledWith(expect.anything(), { path: "/isolated/worktree", label: "api", focus: false });
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree/packages/api", placement: { kind: "workspace", workspaceId: "w9" } }));
	});

	it("fails closed when a created worktree cannot be opened as a host workspace", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace: vi.fn(async () => ({ ok: false as const, error: "daemon unavailable" })),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/preserved", branch: "sumo/preserved", baseRef: "abc123" }),
			terminalHost: host,
			pi: { exec: vi.fn() } as never,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "preserved", cwd: "/repo", visible: true, worktree: true });

		expect(spawned).toMatchObject({ status: "error", errorText: expect.stringContaining("daemon unavailable"), worktree: { path: "/isolated/preserved" } });
		expect((spawned as { errorText?: string }).errorText).toContain("is preserved");
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it("rejects a branch override without worktree isolation", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
		});

		const spawned = await manager.spawn({ prompt: "p", title: "unsafe", cwd: "/repo", branch: "sumo/must-isolate" });

		expect(spawned).toMatchObject({ status: "error", errorText: expect.stringContaining("branch requires worktree: true") });
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it("fails a worktree spawn without falling back to the parent checkout", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async () => ({ ok: false, error: "branch_already_exists", message: "branch already exists: sumo/collision" }),
		});

		const spawned = await manager.spawn({ prompt: "p", title: "collision", cwd: "/repo", worktree: true, branch: "sumo/collision" });

		expect(spawned).toMatchObject({ status: "error", errorText: expect.stringContaining("branch already exists") });
		expect(backendFactory).not.toHaveBeenCalled();
		expect(manager.list()).toHaveLength(1);
	});

	it("preserves and reports a created worktree when backend spawn throws", async () => {
		const manager = new SubagentManager(() => { throw new Error("backend unavailable"); }, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/preserved", branch: "sumo/preserved", baseRef: "abc123" }),
		});

		const spawned = await manager.spawn({ prompt: "p", title: "preserved", cwd: "/repo", worktree: true });

		expect(spawned).toMatchObject({
			status: "error",
			errorText: expect.stringContaining("Worktree created at /isolated/preserved is preserved"),
			worktree: { path: "/isolated/preserved", branch: "sumo/preserved" },
		});
	});

	it("captures the shared-checkout base ref at spawn", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "captured-head" }),
		});

		const spawned = await manager.spawn({ prompt: "p", title: "shared", cwd: "/repo" });

		expect(spawned).toMatchObject({ cwd: "/repo", baseRef: "captured-head", worktree: undefined });
	});

	it("keeps terminal state sticky when a late real settle arrives after cancel timeout", async () => {
		let emitFn: ((event: import("./domain.js").SubagentEvent) => void) | undefined;
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; },
			interrupt: vi.fn(),
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		const id = (spawned as { id: string }).id;
		emitFn?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		await vi.waitFor(() => expect(manager.get(id)?.status).toBe("error"));
		const settledAt = manager.get(id)?.settledAt;
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "late success" } });
		expect(manager.get(id)?.status).toBe("error");
		expect(manager.get(id)?.settledAt).toBe(settledAt);
		expect(manager.get(id)?.finalText).not.toBe("late success");
	});

	it("returns synchronous pre-start failures without waiting for git evidence", async () => {
		const manifestBuilder = vi.fn(fakeManifestBuilder);
		const manager = new SubagentManager(() => ({
			events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "bad model" } }),
			interrupt: () => undefined,
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: manifestBuilder });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		expect((spawned as { status: string }).status).toBe("error");
		expect((spawned as { errorText?: string }).errorText).toBe("bad model");
		expect((spawned as { manifest?: unknown }).manifest).toMatchObject({ exit: "failed" });
		expect(manifestBuilder).not.toHaveBeenCalled();
	});

	it("preserves usage values when a later usage event omits fields", async () => {
		let emitFn: ((event: import("./domain.js").SubagentEvent) => void) | undefined;
		const manager = new SubagentManager(() => ({ events: (emit) => { emitFn = emit; }, interrupt: () => undefined }), { captureGitContext: async () => ({ baseRef: "base-ref" }) });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		const id = (spawned as { id: string }).id;
		emitFn?.({ kind: "usage", tokens: 120, costUsd: 0.05 });
		emitFn?.({ kind: "usage" });
		expect(manager.get(id)?.usage.tokens).toBe(120);
		expect(manager.get(id)?.usage.costUsd).toBe(0.05);
	});

	it("interrupts every batch-cancel target before awaiting any settle", async () => {
		const interrupts: string[] = [];
		const emitters = new Map<string, (event: import("./domain.js").SubagentEvent) => void>();
		let nextTitle = "";
		const manager = new SubagentManager((task) => ({
			events: (emit) => { emitters.set(nextTitle, emit); },
			interrupt: () => { interrupts.push(nextTitle = nextTitle); interrupts[interrupts.length - 1] = task.id; },
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
		nextTitle = "a";
		const a = await manager.spawn({ prompt: "p", title: "a", cwd: "/tmp" }) as { id: string };
		nextTitle = "b";
		const b = await manager.spawn({ prompt: "p", title: "b", cwd: "/tmp" }) as { id: string };
		const cancelPromise = manager.cancel([a.id, b.id]);
		// Both interrupts must have fired synchronously, before either settles.
		expect(interrupts).toEqual([a.id, b.id]);
		emitters.get("a")?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		emitters.get("b")?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		const lines = await cancelPromise;
		expect(lines).toEqual([`Cancelled ${a.id}`, `Cancelled ${b.id}`]);
	});
});
