import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import { SUBAGENT_MAX_QUEUED, SUBAGENT_MAX_RUNNING, type SubagentEvent } from "./domain.js";
import type { CompletionManifest, CompletionManifestEvidence } from "./manifest.js";
import type { TerminalHost } from "../terminal-host/types.js";

/** Spawned-child double: only visible children get send/requestClose. */
type FakeSpawnedChild = {
	events: (emit: (event: SubagentEvent) => void) => void;
	interrupt: () => void;
	send?: (text: string) => Promise<void>;
	requestClose?: () => void;
};

const makeTask = (title: string): SpawnSubagentTask => ({ title, prompt: `prompt ${title}`, cwd: "/tmp" });
const subagentId = (sequence: number): string => `sa-${sequence}`;
const firstQueuedId = subagentId(SUBAGENT_MAX_RUNNING + 1);
const secondQueuedId = subagentId(SUBAGENT_MAX_RUNNING + 2);

const fakeManifestBuilder = async (options: Parameters<NonNullable<import("./manager.js").SubagentManagerDependencies["buildCompletionManifest"]>>[0]) => ({
	baseRef: options.baseRef,
	headRef: options.baseRef,
	branch: options.worktree?.branch,
	worktreePath: options.worktree?.path,
	// SAFETY: the manifest double never reports changed paths.
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
	it(`queues spawn ${SUBAGENT_MAX_RUNNING + 1} instead of refusing it`, async () => {
		const { manager } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await expect(manager.spawn(makeTask(`${index}`))).resolves.toMatchObject({ id: subagentId(index + 1) });
		const queued = await manager.spawn(makeTask("queued"));
		expect(queued).toMatchObject({ id: firstQueuedId, status: "queued", baseRef: "HEAD" });
		expect(manager.list()).toHaveLength(SUBAGENT_MAX_RUNNING + 1);
	});

	it("queues while all running-capacity spawns are still in setup without doing deferred work", async () => {
		let releaseCapture: () => void = () => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const captureGitContext = vi.fn(async () => {
			await captureGate;
			return { baseRef: "base-ref" };
		});
		const manager = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), { captureGitContext });
		const pending = Array.from({ length: SUBAGENT_MAX_RUNNING }, (_, index) => manager.spawn(makeTask(`pending-${index}`)));

		const queued = await manager.spawn(makeTask("queued"));

		expect(queued).toMatchObject({ id: firstQueuedId, status: "queued" });
		expect(captureGitContext).toHaveBeenCalledTimes(SUBAGENT_MAX_RUNNING);
		releaseCapture();
		await Promise.all(pending);
	});

	it("starts queued work when a direct spawn frees capacity by failing setup", async () => {
		let releaseCapture = (): void => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const starts = vi.fn((task: SpawnSubagentTask & { id: string }) => {
			if (task.id === "sa-1") throw new Error("setup failed");
			return { events: () => undefined, interrupt: () => undefined };
		});
		const manager = new SubagentManager(starts, {
			captureGitContext: async () => {
				await captureGate;
				return { baseRef: "base-ref" };
			},
		});
		const pending = Array.from({ length: SUBAGENT_MAX_RUNNING }, (_, index) => manager.spawn(makeTask(`pending-${index}`)));
		await vi.waitFor(() => expect(manager.list()).toHaveLength(0));
		const queued = await manager.spawn(makeTask("queued"));
		expect(queued).toMatchObject({ id: firstQueuedId, status: "queued" });

		releaseCapture();
		await Promise.all(pending);
		await vi.waitFor(() => expect(manager.get(firstQueuedId)?.status).toBe("running"));
		expect(starts.mock.calls.filter(([task]) => task.id === firstQueuedId)).toHaveLength(1);
	});

	it("prevents an in-flight setup from launching a child after shutdown", async () => {
		let releaseCapture = (): void => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => {
				await captureGate;
				return { baseRef: "base-ref" };
			},
		});
		const spawning = manager.spawn(makeTask("pending"));
		await Promise.resolve();

		manager.disposeAll();
		releaseCapture();

		await expect(spawning).resolves.toMatchObject({ status: "error", errorText: "interrupted during setup" });
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it("prevents a dequeued task cancelled during setup from launching", async () => {
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let blockSetup = false;
		let releaseCapture = (): void => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const backendFactory = vi.fn((task: SpawnSubagentTask & { id: string }) => ({
			events: (emit: (event: SubagentEvent) => void) => {
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
			},
			interrupt: () => undefined,
		}));
		const captureGitContext = vi.fn(async () => {
			if (blockSetup) await captureGate;
			return { baseRef: "base-ref" };
		});
		const manager = new SubagentManager(backendFactory, { captureGitContext, buildCompletionManifest: fakeManifestBuilder });
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		blockSetup = true;
		await manager.spawn(makeTask("queued"));

		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(captureGitContext).toHaveBeenCalledTimes(SUBAGENT_MAX_RUNNING + 1));
		await expect(manager.cancel([firstQueuedId])).resolves.toEqual([`Cancelled ${firstQueuedId}`]);
		releaseCapture();

		await vi.waitFor(() => expect(manager.get(firstQueuedId)?.status).toBe("error"));
		expect(manager.get(firstQueuedId)).toMatchObject({ errorText: "interrupted", manifest: { exit: "interrupted" } });
		expect(backendFactory.mock.calls.some(([task]) => task.id === firstQueuedId)).toBe(false);
	});

	it("starts queued tasks in fifo order as running slots free", async () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		await manager.spawn(makeTask("first queued"));
		await manager.spawn(makeTask("second queued"));

		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get(firstQueuedId)?.status).toBe("running"));
		expect(manager.get(secondQueuedId)?.status).toBe("queued");

		emitters.get("sa-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get(secondQueuedId)?.status).toBe("running"));
	});

	it("cancels a queued task without starting a child", async () => {
		const { manager, emitters, interrupts } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		await manager.spawn(makeTask("queued"));

		await expect(manager.cancel([firstQueuedId])).resolves.toEqual([`Cancelled ${firstQueuedId}`]);
		expect(manager.get(firstQueuedId)).toMatchObject({ status: "error", errorText: "interrupted", manifest: { exit: "interrupted" } });
		expect(interrupts.has(firstQueuedId)).toBe(false);
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));
		expect(interrupts.has(firstQueuedId)).toBe(false);
	});

	it("returns at_capacity only after every queue slot is filled", async () => {
		const { manager } = deferredBackend();
		const acceptedCount = SUBAGENT_MAX_RUNNING + SUBAGENT_MAX_QUEUED;
		for (let index = 0; index < acceptedCount; index += 1) {
			const spawned = await manager.spawn(makeTask(`${index}`));
			expect(spawned).toMatchObject({ id: subagentId(index + 1), status: index < SUBAGENT_MAX_RUNNING ? "running" : "queued" });
		}
		const over = await manager.spawn(makeTask("over"));
		expect(over).toMatchObject({ status: "at_capacity", runningCount: SUBAGENT_MAX_RUNNING });
		expect("capacity" in over ? over.capacity : undefined).toBe(SUBAGENT_MAX_RUNNING);
		expect("retryHint" in over ? over.retryHint : "").toContain("do NOT retry in a loop");
	});

	it("serializes concurrent dequeues so one queued task starts once", async () => {
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const starts = vi.fn((task: SpawnSubagentTask & { id: string }) => ({
			events: (emit: (event: SubagentEvent) => void) => {
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
			},
			interrupt: () => undefined,
		}));
		const manager = new SubagentManager(starts, { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		await manager.spawn(makeTask("queued"));

		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		emitters.get("sa-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		await vi.waitFor(() => expect(manager.get(firstQueuedId)?.status).toBe("running"));
		expect(starts.mock.calls.filter(([task]) => task.id === firstQueuedId)).toHaveLength(1);
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
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`${index}`));
		emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		const replacement = await manager.spawn(makeTask("replacement"));

		expect(replacement).toMatchObject({ id: firstQueuedId, status: "running" });
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
			baseRef: "HEAD",
		}));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "abc123",
		});

		const spawned = await manager.spawn({ prompt: "p", title: "write feature", cwd: "/repo", worktree: true, branch: "sumo/custom" });

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", branch: "sumo/custom", baseRef: "HEAD" }));
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree" }));
		expect(spawned).toMatchObject({
			cwd: "/isolated/worktree",
			baseRef: "abc123",
			worktree: { path: "/isolated/worktree", branch: "sumo/custom", baseRef: "abc123", repoRoot: "/repo" },
		});
	});

	it("threads an explicit baseRef through worktree creation and manifest collection", async () => {
		let emitFn: ((event: SubagentEvent) => void) | undefined;
		const backendFactory = vi.fn(() => ({ events: (emit: (event: SubagentEvent) => void) => { emitFn = emit; emit({ kind: "run-started" }); }, interrupt: () => undefined }));
		const createWorktree = vi.fn(async (options) => ({
			ok: true as const,
			path: "/isolated/worktree",
			branch: options.branch ?? "sumo/feature",
			baseRef: options.baseRef ?? "HEAD",
		}));
		const buildCompletionManifest = vi.fn(fakeManifestBuilder);
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "captured-head" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "resolved-origin-main",
			buildCompletionManifest,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "write feature", cwd: "/repo", worktree: true, baseRef: "origin/main" });
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", baseRef: "origin/main" }));
		expect(buildCompletionManifest).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "resolved-origin-main" }));
		expect(spawned).toMatchObject({
			baseRef: "resolved-origin-main",
			worktree: { baseRef: "resolved-origin-main" },
		});
		expect(manager.get("sa-1")?.manifest).toMatchObject({ baseRef: "resolved-origin-main" });
	});

	it("fails closed and preserves the worktree when an explicit base cannot resolve to a commit", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "captured-head" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/preserved", branch: "sumo/preserved", baseRef: "origin/main" }),
			resolveWorktreeBaseRef: async () => undefined,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "write feature", cwd: "/repo", worktree: true, baseRef: "origin/main" });

		expect(spawned).toMatchObject({
			status: "error",
			errorText: expect.stringContaining("unable to resolve worktree base commit"),
			worktree: { path: "/isolated/preserved", baseRef: "origin/main" },
		});
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it("uses the captured HEAD commit as the default worktree manifest base", async () => {
		let emitFn: ((event: SubagentEvent) => void) | undefined;
		const createWorktree = vi.fn(async (options) => ({
			ok: true as const,
			path: "/isolated/worktree",
			branch: options.branch ?? "sumo/feature",
			baseRef: options.baseRef ?? "HEAD",
		}));
		const buildCompletionManifest = vi.fn(fakeManifestBuilder);
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; emit({ kind: "run-started" }); },
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "captured-head" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "captured-head",
			buildCompletionManifest,
		});

		await manager.spawn({ prompt: "p", title: "write feature", cwd: "/repo", worktree: true });
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "HEAD" }));
		expect(buildCompletionManifest).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "captured-head" }));
		expect(manager.get("sa-1")?.manifest).toMatchObject({ baseRef: "captured-head" });
	});

	it("preserves the caller's subdirectory inside the worktree", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const createWorktree = vi.fn(async () => ({ ok: true as const, path: "/isolated/worktree", branch: "sumo/x", baseRef: "abc123" }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "abc123",
		});
		await manager.spawn({ prompt: "p", title: "api work", cwd: "/repo/packages/api", worktree: true });
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree/packages/api" }));
	});

	it("splits the first visible child beside the parent when its Herdr tab is known", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			terminalHost: host,
			// SAFETY: the pi double only needs exec; no other Pi surface is touched in this test.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t1",
		});

		await manager.spawn({ prompt: "p", title: "visible", cwd: "/repo", visible: true });

		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({
			placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
		}));
	});

	it("runs a worktree-backed visible child beside the parent when its Herdr tab is known", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const openExistingWorktreeWorkspace = vi.fn();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace,
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/worktree", branch: "sumo/demo", baseRef: "abc123" }),
			resolveWorktreeBaseRef: async () => "abc123",
			terminalHost: host,
			// SAFETY: the pi double only needs exec; no other Pi surface is touched in this test.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t1",
		});

		await manager.spawn({ prompt: "p", title: "visible", cwd: "/repo", visible: true, worktree: true });

		expect(openExistingWorktreeWorkspace).not.toHaveBeenCalled();
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/isolated/worktree",
			placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
		}));
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
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, // SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never });

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
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, // SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never });

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
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, // SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never });

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

	it("invalidates a stale cached tab after a worktree-backed child fails before attach", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		let mode: "attach" | "fail-preattach" = "attach";
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace: vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "w9:p1", workspaceId: "w9" } })),
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
						emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "stale tab" } });
					}
				},
				interrupt: () => undefined,
			};
		}, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async (options) => ({ ok: true, path: `/isolated/${options.task}`, branch: options.branch ?? `sumo/${options.task}`, baseRef: options.baseRef ?? "HEAD" }),
			resolveWorktreeBaseRef: async () => "abc123",
			terminalHost: host,
			// SAFETY: the pi double only needs exec; no other Pi surface is touched in this test.
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		mode = "fail-preattach";
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true, worktree: true });
		expect(backendTasks[1]?.placement).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });

		mode = "attach";
		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true, worktree: true });
		expect(backendTasks[2]?.placement).toEqual({ kind: "workspace", workspaceId: "w9", paneId: "w9:p1" });
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
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, // SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never });

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
			resolveWorktreeBaseRef: async () => "abc123",
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p", title: "api work", cwd: "/repo/packages/api", visible: true, worktree: true });

		expect(openExistingWorktreeWorkspace).toHaveBeenCalledWith(expect.anything(), { path: "/isolated/worktree", label: "api", sourceCwd: "/repo", focus: false });
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/isolated/worktree/packages/api", placement: { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" } }));
	});

	it("keeps separate workspace fallbacks for isolated children when no caller tab exists", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		let workspace = 8;
		const openExistingWorktreeWorkspace = vi.fn(async () => {
			workspace += 1;
			return { ok: true as const, pane: { host: "herdr" as const, paneId: `w${workspace}:p1`, workspaceId: `w${workspace}` } };
		});
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace,
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			backendTasks.push(task);
			const placement = task.placement?.kind === "workspace" ? task.placement : undefined;
			return {
				events: (emit) => {
					emit({ kind: "run-started" });
					emit({ kind: "pane-attached", pane: {
						agentName: `${task.id}-worker`,
						workspaceId: placement?.workspaceId ?? "unknown",
						tabId: `${placement?.workspaceId ?? "unknown"}:t1`,
						paneId: `${placement?.workspaceId ?? "unknown"}:p2`,
					} });
				},
				interrupt: () => undefined,
			};
		}, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async (options) => ({ ok: true, path: `/isolated/${options.task}`, branch: options.branch ?? `sumo/${options.task}`, baseRef: options.baseRef ?? "HEAD" }),
			resolveWorktreeBaseRef: async () => "abc123",
			terminalHost: host,
			// SAFETY: the pi double only needs exec; no other Pi surface is touched in this test.
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true, worktree: true });
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true, worktree: true });

		expect(openExistingWorktreeWorkspace).toHaveBeenCalledTimes(2);
		expect(backendTasks.map((task) => task.placement)).toEqual([
			{ kind: "workspace", workspaceId: "w9", paneId: "w9:p1" },
			{ kind: "workspace", workspaceId: "w10", paneId: "w10:p1" },
		]);
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
			resolveWorktreeBaseRef: async () => "abc123",
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
pi: { exec: vi.fn() } as never,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "preserved", cwd: "/repo", visible: true, worktree: true });

		expect(spawned).toMatchObject({ status: "error", errorText: expect.stringContaining("daemon unavailable"), worktree: { path: "/isolated/preserved" } });
		// SAFETY: failed spawns always carry an errorText field.
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
			resolveWorktreeBaseRef: async () => "abc123",
		});

		const spawned = await manager.spawn({ prompt: "p", title: "preserved", cwd: "/repo", worktree: true });

		expect(spawned).toMatchObject({
			status: "error",
			errorText: expect.stringContaining("Worktree created at /isolated/preserved is preserved"),
			worktree: { path: "/isolated/preserved", branch: "sumo/preserved" },
		});
	});

	it("captures the shared-checkout base ref and ignores a worktree baseRef without isolation", async () => {
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const createWorktree = vi.fn();
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "captured-head" }),
			createWorktree,
		});

		const spawned = await manager.spawn({ prompt: "p", title: "shared", cwd: "/repo", baseRef: "origin/main" });

		expect(spawned).toMatchObject({ cwd: "/repo", baseRef: "captured-head", worktree: undefined });
		expect(createWorktree).not.toHaveBeenCalled();
	});

	it("keeps terminal state sticky when a late real settle arrives after cancel timeout", async () => {
		let emitFn: ((event: import("./domain.js").SubagentEvent) => void) | undefined;
		const manager = new SubagentManager(() => ({
			events: (emit) => { emitFn = emit; },
			interrupt: vi.fn(),
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		// SAFETY: spawn always resolves to a snapshot carrying the generated id.
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
		// SAFETY: synchronous failures resolve to an error snapshot with these fields.
		expect((spawned as { status: string }).status).toBe("error");
		// SAFETY: synchronous failures resolve to an error snapshot with these fields.
		expect((spawned as { errorText?: string }).errorText).toBe("bad model");
		// SAFETY: synchronous failures resolve to an error snapshot with these fields.
		expect((spawned as { manifest?: unknown }).manifest).toMatchObject({ exit: "failed" });
		expect(manifestBuilder).not.toHaveBeenCalled();
	});

	it("preserves usage values when a later usage event omits fields", async () => {
		let emitFn: ((event: import("./domain.js").SubagentEvent) => void) | undefined;
		const manager = new SubagentManager(() => ({ events: (emit) => { emitFn = emit; }, interrupt: () => undefined }), { captureGitContext: async () => ({ baseRef: "base-ref" }) });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		// SAFETY: spawn always resolves to a snapshot carrying the generated id.
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
			interrupt: () => { interrupts.push(task.id); },
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });
		nextTitle = "a";
		// SAFETY: spawn always resolves to a snapshot carrying the generated id.
		const a = await manager.spawn({ prompt: "p", title: "a", cwd: "/tmp" }) as { id: string };
		nextTitle = "b";
		// SAFETY: spawn always resolves to a snapshot carrying the generated id.
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

describe("SubagentManager steering and close", () => {
	/** Like deferredBackend, but visible children expose send/requestClose. */
	const steerableBackend = () => {
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const sends = new Map<string, ReturnType<typeof vi.fn>>();
		const requestCloses = new Map<string, ReturnType<typeof vi.fn>>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => {
			const child: FakeSpawnedChild = {
				events: (emit) => {
					emitters.set(task.id, emit);
					emit({ kind: "run-started" });
				},
				interrupt: vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
			};
			if (task.visible) {
				const send = vi.fn(async () => undefined);
				const requestClose = vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "closed cleanly" } }));
				child.send = send;
				child.requestClose = requestClose;
				sends.set(task.id, send);
				requestCloses.set(task.id, requestClose);
			}
			// SAFETY: the fake child implements every SpawnedChild member this manager path calls; send/requestClose are present exactly for visible children, mirroring the real backends.
			return child as import("./backend-pi.js").SpawnedChild;
		}, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});
		return { manager, emitters, sends, requestCloses };
	};

	const spawnVisible = async (manager: SubagentManager, title: string): Promise<string> => {
		const spawned = await manager.spawn({ prompt: "p", title, cwd: "/tmp", visible: true });
		// SAFETY: a steerable spawn always resolves to a snapshot with an id.
		return (spawned as { id: string }).id;
	};

	describe("sendTo", () => {
		it("rejects unknown ids with the known id list", async () => {
			const { manager } = steerableBackend();
			await manager.spawn(makeTask("known"));
			await expect(manager.sendTo("sa-9", "hi")).rejects.toThrow("Unknown subagent id: sa-9. Known ids: sa-1");
		});

		it("rejects queued children", async () => {
			const { manager } = steerableBackend();
			for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
			await manager.spawn(makeTask("queued"));
			await expect(manager.sendTo(firstQueuedId, "hi")).rejects.toThrow(`Subagent ${firstQueuedId} is queued and cannot receive input until it starts`);
		});

		it("rejects settled children", async () => {
			const { manager, emitters } = steerableBackend();
			await manager.spawn(makeTask("done"));
			emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));
			await expect(manager.sendTo("sa-1", "hi")).rejects.toThrow("already settled (done)");
		});

		it("rejects children without a send capability as headless", async () => {
			const { manager } = deferredBackend();
			await manager.spawn(makeTask("headless"));
			await expect(manager.sendTo("sa-1", "hi")).rejects.toThrow("headless children cannot receive input — respawn with visible: true");
		});

		it("delivers text through the child's send and returns the snapshot", async () => {
			const { manager, sends } = steerableBackend();
			const id = await spawnVisible(manager, "steered");
			await expect(manager.sendTo(id, "focus the tests")).resolves.toMatchObject({ id, status: "running" });
			expect(sends.get(id)).toHaveBeenCalledWith("focus the tests");
		});
	});

	describe("close", () => {
		it("reports unknown and already-settled ids without action", async () => {
			const { manager, emitters } = steerableBackend();
			await manager.spawn(makeTask("done"));
			emitters.get("sa-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get("sa-1")?.status).toBe("done"));

			await expect(manager.close(["sa-9", "sa-1"])).resolves.toEqual(["sa-9 is unknown", "sa-1 was already done"]);
			expect(manager.consumedIds.has("sa-1")).toBe(false);
		});

		it("cancels a queued child without starting it", async () => {
			const { manager, requestCloses } = steerableBackend();
			for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
			await manager.spawn(makeTask("queued"));

			await expect(manager.close([firstQueuedId])).resolves.toEqual([`Cancelled queued ${firstQueuedId}`]);
			expect(manager.get(firstQueuedId)).toMatchObject({ status: "error", errorText: "interrupted" });
			expect(requestCloses.has(firstQueuedId)).toBe(false);
		});

		it("reports headless running children without acting", async () => {
			const { manager } = deferredBackend();
			await manager.spawn(makeTask("headless"));
			await expect(manager.close(["sa-1"])).resolves.toEqual(["sa-1 is headless — it settles on its own; use subagent_cancel to stop it"]);
			expect(manager.get("sa-1")?.status).toBe("running");
		});

		it("closes a visible child, marks it consumed, and returns its line", async () => {
			const { manager, requestCloses } = steerableBackend();
			const id = await spawnVisible(manager, "closable");

			await expect(manager.close([id])).resolves.toEqual([`Closed ${id}`]);
			expect(requestCloses.get(id)).toHaveBeenCalledTimes(1);
			await vi.waitFor(() => expect(manager.get(id)?.status).toBe("done"));
			expect(manager.consumedIds.has(id)).toBe(true);
		});

		it("isolates a throwing close request so later ids still get theirs", async () => {
			const { manager, requestCloses } = steerableBackend();
			const first = await spawnVisible(manager, "unwritable");
			const second = await spawnVisible(manager, "healthy");
			// The pane backend writes a file here, so a removed/unwritable task dir
			// throws synchronously. That must not abort the rest of the batch.
			// SAFETY: visible spawns always register a requestClose double.
			(requestCloses.get(first) as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("ENOENT: control dir is gone");
			});

			await expect(manager.close([first, second])).resolves.toEqual([
				`unable to request close for ${first}: ENOENT: control dir is gone`,
				`Closed ${second}`,
			]);
			expect(requestCloses.get(second)).toHaveBeenCalledTimes(1);
			expect(manager.get(first)?.status).toBe("running");
			// The failed id keeps its deferred result: nothing was reported inline.
			expect(manager.consumedIds.has(first)).toBe(false);
		});

		it("leaves the child running when the close times out and does not consume", async () => {
			vi.useFakeTimers();
			try {
				const { manager, emitters, requestCloses } = steerableBackend();
				const id = await spawnVisible(manager, "slow");
				// SAFETY: visible spawns always register a requestClose double.
				(requestCloses.get(id) as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);

				const closing = manager.close([id]);
				await vi.advanceTimersByTimeAsync(15_000);
				await expect(closing).resolves.toEqual([`close requested for ${id}; still running — check the pane or use subagent_cancel`]);
				expect(manager.get(id)?.status).toBe("running");
				expect(manager.consumedIds.has(id)).toBe(false);

				// The real settle still lands afterwards and stays truthful.
				emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "eventually" } });
				await vi.waitFor(() => expect(manager.get(id)?.status).toBe("done"));
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
