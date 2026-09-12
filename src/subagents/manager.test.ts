import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { CreateWorktreeOptions } from "../git/worktree.js";
import { SUBAGENT_MAX_QUEUED, SUBAGENT_MAX_RUNNING, type SubagentEvent } from "./domain.js";
import type { CompletionManifest, CompletionManifestEvidence } from "./manifest.js";
import { CHILD_RETAINED_RESULT_MAX_BYTES, TRUNCATED_HEAD_MARKER } from "../child-protocol.js";
import type { TerminalHost } from "../terminal-host/types.js";

/** Spawned-child double: only visible children get send/requestClose. */
type FakeSpawnedChild = {
	events: (emit: (event: SubagentEvent) => void) => void;
	interrupt: () => void;
	send?: (text: string) => Promise<void>;
	requestClose?: () => void;
};

const makeTask = (title: string): SpawnSubagentTask => ({ title, prompt: `prompt ${title}`, cwd: "/tmp" });
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
	it("allocates readable slug ids with an optional 4-char retention namespace suffix", async () => {
		const plain = deferredBackend();
		try {
			const one = await plain.manager.spawn(makeTask("issue-to-pr-426"));
			const two = await plain.manager.spawn(makeTask("issue-to-pr-426"));
			expect(one).toMatchObject({ id: "sa-issue-to-pr-426-1" });
			expect(two).toMatchObject({ id: "sa-issue-to-pr-426-2" });
		} finally { plain.manager.disposeAll(); }

		const retained = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), {
			idNamespace: "a1b2", captureGitContext: async () => ({ baseRef: "base-ref" }),
		});
		try {
			await expect(retained.spawn(makeTask("issue-to-pr-426"))).resolves.toMatchObject({ id: "sa-issue-to-pr-426-1-a1b2" });
			await expect(retained.spawn(makeTask("Fix: the Widget!"))).resolves.toMatchObject({ id: "sa-fix-the-widget-2-a1b2" });
		} finally { retained.disposeAll(); }
	});

	it("launches an asynchronous backend with the captured worktree identity", async () => {
		const launch = vi.fn(async () => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(launch, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "parent-head" }),
			createWorktree: async () => ({ ok: true, path: "/isolated/child", branch: "sumo/child", baseRef: "topic" }),
			resolveWorktreeBaseRef: async () => "child-base-sha",
			buildCompletionManifest: fakeManifestBuilder,
		});
		try {
			await expect(manager.spawn({ ...makeTask("retained"), worktree: true, baseRef: "topic" })).resolves.toMatchObject({
				status: "running", baseRef: "child-base-sha",
			});
			expect(launch).toHaveBeenCalledWith(expect.objectContaining({
				baseRef: "child-base-sha", cwd: "/isolated/child",
				worktreeRef: { path: "/isolated/child", branch: "sumo/child", baseRef: "child-base-sha", repoRoot: "/repo" },
			}));
		} finally { manager.disposeAll(); }
	});
	it("stops a backend admitted while shutdown waits for its launch", async () => {
		let release!: () => void;
		const ready = new Promise<void>((resolve) => { release = resolve; });
		let emit!: (event: SubagentEvent) => void;
		const interrupt = vi.fn(() => emit({ kind: "run-settled", outcome: { kind: "interrupted" } }));
		const launch = vi.fn(async () => {
			await ready;
			return { events: (listener: typeof emit) => { emit = listener; }, interrupt };
		});
		const manager = new SubagentManager(launch, { captureGitContext: async () => ({}), buildCompletionManifest: fakeManifestBuilder });
		const spawning = manager.spawn(makeTask("late launch"));
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
		manager.disposeAll();
		release();
		await expect(spawning).resolves.toMatchObject({ status: "error", errorText: "interrupted" });
		expect(interrupt).toHaveBeenCalledOnce();
	});
	it("keeps a completed visible turn running and returns to working when steered", async () => {
		vi.useFakeTimers();
		let emit: (event: SubagentEvent) => void = () => undefined;
		const send = vi.fn(async () => undefined);
		const manager = new SubagentManager(() => ({ events: (listener) => { emit = listener; listener({ kind: "run-started" }); }, interrupt: vi.fn(), send, requestClose: vi.fn() }), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			terminalHost: { kind: "herdr", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn() },
			pi: { exec: vi.fn() },
		});
		try {
			await manager.spawn({ ...makeTask("visible turn"), visible: true });
			emit({ kind: "turn-finished", finalText: "report", at: 1_234 });
			expect(manager.get("sa-visible-turn-1")).toMatchObject({ status: "running", turnState: "idle", turnSequence: 1, finalText: "report", lastProgressAt: 1_234 });

			await manager.sendTo("sa-visible-turn-1", "follow up");

			expect(send).toHaveBeenCalledWith("follow up");
			expect(manager.get("sa-visible-turn-1")).toMatchObject({ status: "running", turnState: "working", lastProgressAt: Date.now() });
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("distinguishes visible heartbeat from progress and warns only after observed heartbeat silence", async () => {
		vi.useFakeTimers();
		let emit: (event: SubagentEvent) => void = () => undefined;
		const interrupt = vi.fn();
		const requestClose = vi.fn();
		const manager = new SubagentManager(() => ({ events: (listener) => { emit = listener; }, interrupt, requestClose }), {
			captureGitContext: async () => ({}),
			terminalHost: { kind: "herdr", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn() },
			pi: { exec: vi.fn() },
		});
		try {
			await manager.spawn({ ...makeTask("visible"), visible: true });
			const startedProgress = manager.get("sa-visible-1")?.lastProgressAt;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(manager.get("sa-visible-1")).toMatchObject({ health: "quiet", liveness: "unknown", lastProgressAt: startedProgress });
			emit({ kind: "heartbeat", at: Date.now() });
			expect(manager.get("sa-visible-1")).toMatchObject({ health: "active", lastHeartbeatAt: Date.now(), lastProgressAt: startedProgress, liveness: "unknown" });
			await vi.advanceTimersByTimeAsync(120_000);
			expect(manager.get("sa-visible-1")?.health).toBe("stalled-warning");
			emit({ kind: "heartbeat", at: Date.now() });
			expect(manager.get("sa-visible-1")?.health).toBe("active");
			expect(interrupt).not.toHaveBeenCalled();
			expect(requestClose).not.toHaveBeenCalled();
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});
	it("warns once at a budget crossing without interrupting or freeing the running slot", async () => {
		vi.useFakeTimers();
		const { manager, emitters, interrupts } = deferredBackend();
		try {
			await manager.spawn({ ...makeTask("budget"), budget: { wallTimeMs: 1000 } });
			const listener = vi.fn();
			manager.addChangeListener(listener);
			await vi.advanceTimersByTimeAsync(1000);
			expect(manager.get("sa-budget-1")).toMatchObject({ status: "running", health: "over-budget-warning", elapsedMs: 1000, warnings: ["wall-time"] });
			expect(listener).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1000);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(interrupts.get("sa-budget-1")).not.toHaveBeenCalled();
			emitters.get("sa-budget-1")!({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("keeps one health scheduler with 10 running and 16 queued", async () => {
		vi.useFakeTimers();
		const { manager, interrupts } = deferredBackend();
		try {
			for (let i = 0; i < 26; i++) await manager.spawn(makeTask(String(i)));
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(manager.list().filter((snapshot) => snapshot.health === "stalled-warning")).toHaveLength(10);
			expect(manager.list().filter((snapshot) => snapshot.status === "queued")).toHaveLength(16);
			for (const interrupt of interrupts.values()) expect(interrupt).not.toHaveBeenCalled();
			manager.disposeAll();
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("recovers a stall warning on parsed progress and gives long tools bounded grace", async () => {
		vi.useFakeTimers();
		const { manager, emitters } = deferredBackend();
		try {
			await manager.spawn(makeTask("progress"));
			const emit = emitters.get("sa-progress-1")!;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(manager.get("sa-progress-1")?.health).toBe("stalled-warning");
			emit({ kind: "tool-start", toolId: "tool", name: "read" });
			expect(manager.get("sa-progress-1")?.health).toBe("active");
			await vi.advanceTimersByTimeAsync(299_000);
			expect(manager.get("sa-progress-1")?.health).toBe("quiet");
			await vi.advanceTimersByTimeAsync(1000);
			expect(manager.get("sa-progress-1")?.health).toBe("stalled-warning");
			emit({ kind: "tool-end", toolId: "tool", name: "read", isError: false });
			expect(manager.get("sa-progress-1")).toMatchObject({ health: "active", lastProgressAt: Date.now(), liveness: "unknown" });
		} finally { manager.disposeAll(); vi.useRealTimers(); }
	});

	it("sums reported turn usage for budgets without changing context occupancy", async () => {
		const { manager, emitters } = deferredBackend();
		try {
			await manager.spawn({ ...makeTask("usage"), budget: { tokens: 100, costUsd: 1 } });
			const emit = emitters.get("sa-usage-1")!;
			emit({ kind: "usage", tokens: 60, costUsd: 0.6 });
			emit({ kind: "usage" });
			emit({ kind: "usage", tokens: 40, costUsd: 0.4 });
			expect(manager.get("sa-usage-1")).toMatchObject({ health: "over-budget-warning", warnings: ["tokens", "cost"], usage: { tokens: 40, costUsd: 0.4, reportedTokens: 100, reportedCostUsd: 1 } });
		} finally { manager.disposeAll(); }
	});

	it("rejects invalid budgets before setup or queue admission", async () => {
		const { manager } = deferredBackend();
		await expect(manager.spawn({ ...makeTask("invalid"), budget: { tokens: -1 } })).rejects.toThrow(/budget/);
		expect(manager.list()).toEqual([]);
	});

	it(`queues spawn ${SUBAGENT_MAX_RUNNING + 1} instead of refusing it`, async () => {
		const { manager } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await expect(manager.spawn(makeTask(`${index}`))).resolves.toMatchObject({ id: `sa-${index}-${index + 1}` });
		const queued = await manager.spawn(makeTask("queued"));
		expect(queued).toMatchObject({ id: "sa-queued-11", status: "queued", baseRef: "HEAD" });
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

		expect(queued).toMatchObject({ id: "sa-queued-11", status: "queued" });
		expect(captureGitContext).toHaveBeenCalledTimes(SUBAGENT_MAX_RUNNING);
		releaseCapture();
		await Promise.all(pending);
	});

	it("starts queued work when a direct spawn frees capacity by failing setup", async () => {
		let releaseCapture = (): void => undefined;
		const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
		const starts = vi.fn((task: SpawnSubagentTask & { id: string }) => {
			if (task.id === "sa-pending-0-1") throw new Error("setup failed");
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
		expect(queued).toMatchObject({ id: "sa-queued-11", status: "queued" });

		releaseCapture();
		await Promise.all(pending);
		await vi.waitFor(() => expect(manager.get("sa-queued-11")?.status).toBe("running"));
		expect(starts.mock.calls.filter(([task]) => task.id === "sa-queued-11")).toHaveLength(1);
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

		emitters.get("sa-running-0-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(captureGitContext).toHaveBeenCalledTimes(SUBAGENT_MAX_RUNNING + 1));
		await expect(manager.cancel(["sa-queued-11"])).resolves.toEqual([`Cancelled ${"sa-queued-11"}`]);
		releaseCapture();

		await vi.waitFor(() => expect(manager.get("sa-queued-11")?.status).toBe("error"));
		expect(manager.get("sa-queued-11")).toMatchObject({ errorText: "interrupted", manifest: { exit: "interrupted" } });
		expect(backendFactory.mock.calls.some(([task]) => task.id === "sa-queued-11")).toBe(false);
	});

	it("starts queued tasks in fifo order as running slots free", async () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		await manager.spawn(makeTask("first queued"));
		await manager.spawn(makeTask("second queued"));

		emitters.get("sa-running-0-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-first-queued-11")?.status).toBe("running"));
		expect(manager.get("sa-second-queued-12")?.status).toBe("queued");

		emitters.get("sa-running-1-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-second-queued-12")?.status).toBe("running"));
	});

	it("cancels a queued task without starting a child", async () => {
		const { manager, emitters, interrupts } = deferredBackend();
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
		await manager.spawn(makeTask("queued"));

		await expect(manager.cancel(["sa-queued-11"])).resolves.toEqual([`Cancelled ${"sa-queued-11"}`]);
		expect(manager.get("sa-queued-11")).toMatchObject({ status: "error", errorText: "interrupted", manifest: { exit: "interrupted" } });
		expect(interrupts.has("sa-queued-11")).toBe(false);
		emitters.get("sa-running-0-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-running-0-1")?.status).toBe("done"));
		expect(interrupts.has("sa-queued-11")).toBe(false);
	});

	it("returns at_capacity only after every queue slot is filled", async () => {
		const { manager } = deferredBackend();
		const acceptedCount = SUBAGENT_MAX_RUNNING + SUBAGENT_MAX_QUEUED;
		for (let index = 0; index < acceptedCount; index += 1) {
			const spawned = await manager.spawn(makeTask(`${index}`));
			expect(spawned).toMatchObject({ id: `sa-${index}-${index + 1}`, status: index < SUBAGENT_MAX_RUNNING ? "running" : "queued" });
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

		emitters.get("sa-running-0-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		emitters.get("sa-running-1-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		await vi.waitFor(() => expect(manager.get("sa-queued-11")?.status).toBe("running"));
		expect(starts.mock.calls.filter(([task]) => task.id === "sa-queued-11")).toHaveLength(1);
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
		emitters.get("sa-0-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		const replacement = await manager.spawn(makeTask("replacement"));

		expect(replacement).toMatchObject({ id: "sa-replacement-11", status: "running" });
		resolveManifest({ baseRef: "base-ref", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-0-1")?.status).toBe("done"));
	});

	it("contains async iterator rejection", async () => {
		const unhandled: unknown[] = [];
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node's unhandledRejection event exposes arbitrary rejection values.
		const onUnhandled = (error: unknown): void => { unhandled.push(error); };
		process.on("unhandledRejection", onUnhandled);
		try {
			const interrupts = new Map<string, ReturnType<typeof vi.fn>>();
			const manager = new SubagentManager((task) => ({
				events: (async function* (): AsyncGenerator<SubagentEvent> {
					yield { kind: "assistant-delta", delta: "partial" };
					if (task.id === "sa-worker-0-1") throw new Error("event stream failed");
					if (task.id === "sa-worker-1-2") {
						yield { kind: "run-settled", outcome: { kind: "completed", finalText: "complete" } };
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						throw new Error("late event stream failure");
					}
					await new Promise(() => undefined);
				})(),
				interrupt: (() => {
					const interrupt = vi.fn();
					interrupts.set(task.id, interrupt);
					return interrupt;
				})(),
			}), { captureGitContext: async () => ({ baseRef: "base-ref" }), buildCompletionManifest: fakeManifestBuilder });

			for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`worker-${index}`));
			await vi.waitFor(() => expect(manager.get("sa-worker-0-1")).toMatchObject({
				status: "error",
				errorText: "subagent event stream failed: event stream failed",
				finalText: "partial",
			}));
			await vi.waitFor(() => expect(manager.get("sa-worker-1-2")).toMatchObject({ status: "done", finalText: "complete" }));
			expect(interrupts.get("sa-worker-0-1")).toHaveBeenCalledOnce();
			expect(interrupts.get("sa-worker-1-2")).not.toHaveBeenCalled();

			await expect(manager.spawn(makeTask("replacement"))).resolves.toMatchObject({ id: "sa-replacement-11", status: "running" });
			await expect(manager.cancel(["sa-worker-0-1"])).resolves.toEqual(["sa-worker-0-1 was already settled"]);
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("folds events into immutable snapshots", async () => {
		const { manager, emitters } = deferredBackend();
		const spawned = await manager.spawn(makeTask("fold"));
		expect(spawned).toMatchObject({ id: "sa-fold-1" });
		emitters.get("sa-fold-1")?.({ kind: "assistant-delta", delta: "hi" });
		expect(manager.get("sa-fold-1")?.liveText).toBe("hi");
		emitters.get("sa-fold-1")?.({ kind: "message-end", role: "assistant", text: "hi done" });
		expect(manager.get("sa-fold-1")?.liveText).toBe("");
		expect(manager.get("sa-fold-1")?.finalText).toBe("hi done");
		expect(manager.get("sa-fold-1")?.usage.turns).toBe(1);
		emitters.get("sa-fold-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "hi done" } });
		await vi.waitFor(() => expect(manager.get("sa-fold-1")?.status).toBe("done"));
	});

	it("waitFor resolves settled snapshots and marks them consumed", async () => {
		const { manager, emitters } = deferredBackend();
		await manager.spawn(makeTask("wait"));
		const pending: string[][] = [];
		const wait = manager.waitFor(["sa-wait-1"], undefined, (snapshots) => pending.push(snapshots.map((snapshot) => snapshot.id)));
		emitters.get("sa-wait-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await expect(wait).resolves.toMatchObject([{ id: "sa-wait-1", status: "done" }]);
		expect(pending).toEqual([["sa-wait-1"]]);
		expect(manager.consumedIds.has("sa-wait-1")).toBe(true);
	});

	it("delivers a replacement final result without retaining or charging the replaced transcript", async () => {
		const { manager, emitters } = deferredBackend();
		await manager.spawn(makeTask("bounded delivery"));
		const prior = `${"u".repeat(CHILD_RETAINED_RESULT_MAX_BYTES - Buffer.byteLength(TRUNCATED_HEAD_MARKER))}${TRUNCATED_HEAD_MARKER}`;
		emitters.get("sa-bounded-delivery-1")?.({ kind: "message-end", role: "user", text: prior });
		const finalText = `useful final answer${TRUNCATED_HEAD_MARKER}`;
		emitters.get("sa-bounded-delivery-1")?.({ kind: "message-end", role: "assistant", text: finalText, replacesRetainedText: true });
		emitters.get("sa-bounded-delivery-1")?.({ kind: "assistant-delta", delta: "later live text" });
		emitters.get("sa-bounded-delivery-1")?.({ kind: "message-end", role: "toolResult", text: "later tool output" });
		expect(manager.get("sa-bounded-delivery-1")).toMatchObject({ liveText: "later live text", finalText });
		const wait = manager.waitFor(["sa-bounded-delivery-1"]);
		emitters.get("sa-bounded-delivery-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText } });

		const [delivered] = await wait;
		if (!delivered) throw new Error("missing delivered result");
		expect(delivered.finalText).toBe(finalText);
		expect(delivered.transcript).toMatchObject([
			{ role: "assistant", text: finalText },
			{ role: "toolResult", text: "later tool output" },
		]);
		const retained = delivered.transcript.map((item) => item.text).join("");
		expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(retained.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
	});

	it("moves a prior omission marker to the latest finalText", async () => {
		const { manager, emitters } = deferredBackend();
		await manager.spawn(makeTask("latest delivery"));
		emitters.get("sa-latest-delivery-1")?.({ kind: "message-end", role: "assistant", text: `first${TRUNCATED_HEAD_MARKER}`, replacesRetainedText: true });
		emitters.get("sa-latest-delivery-1")?.({ kind: "message-end", role: "user", text: "later context" });
		const latest = `latest useful answer${TRUNCATED_HEAD_MARKER}`;
		emitters.get("sa-latest-delivery-1")?.({ kind: "message-end", role: "assistant", text: latest, replacesRetainedText: true });
		emitters.get("sa-latest-delivery-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: latest } });

		await vi.waitFor(() => expect(manager.get("sa-latest-delivery-1")?.status).toBe("done"));
		const snapshot = manager.get("sa-latest-delivery-1");
		expect(snapshot?.finalText).toBe(latest);
		expect(snapshot?.transcript).toMatchObject([{ role: "assistant", text: latest }]);
		expect(snapshot?.transcript.map((item) => item.text).join("").split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
	});

	it("isolates listener failure", async () => {
		const diagnostics: Array<{ kind: string; message: string }> = [];
		const manager = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			onDiagnostic: (diagnostic: { kind: string; message: string }) => diagnostics.push(diagnostic),
		});
		const laterListener = vi.fn();
		manager.addChangeListener(() => { throw new Error("listener exploded"); });
		manager.addChangeListener(laterListener);

		await expect(manager.spawn(makeTask("notify"))).resolves.toMatchObject({ status: "running" });

		expect(laterListener).toHaveBeenCalledOnce();
		expect(diagnostics).toEqual([{ kind: "listener", message: "listener exploded" }]);
	});

	it("isolates listener failure after an earlier listener succeeds", async () => {
		const diagnostics: Array<{ kind: string; message: string }> = [];
		const manager = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), {
			captureGitContext: async () => ({ baseRef: "base-ref" }),
			onDiagnostic: (diagnostic: { kind: string; message: string }) => diagnostics.push(diagnostic),
		});
		const firstListener = vi.fn();
		const lastListener = vi.fn();
		manager.addChangeListener(firstListener);
		manager.addChangeListener(() => { throw new Error("second listener exploded"); });
		manager.addChangeListener(lastListener);

		await expect(manager.spawn(makeTask("notify middle"))).resolves.toMatchObject({ status: "running" });

		expect(firstListener).toHaveBeenCalledOnce();
		expect(lastListener).toHaveBeenCalledOnce();
		expect(diagnostics).toEqual([{ kind: "listener", message: "second listener exploded" }]);
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
		manager.addChangeListener(() => observedManifests.push(manager.get("sa-ordering-1")?.manifest));

		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		expect(observedManifests).toEqual([]);
		resolveManifest({ baseRef: "base-ref", headRef: "head-ref", changedPaths: ["src/a.ts"], dirty: false, commits: 1, exit: "completed", durationMs: 10 });
		await vi.waitFor(() => expect(manager.get("sa-ordering-1")?.status).toBe("done"));

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

			expect(manager.get("sa-timeout-1")).toMatchObject({
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
		await expect(manager.waitFor(["sa-2"])).rejects.toThrow("Known ids: sa-known-1");
	});

	it("cancels running children and reports already-settled ids", async () => {
		const { manager, emitters, interrupts } = deferredBackend();
		await manager.spawn(makeTask("run"));
		await manager.spawn(makeTask("done"));
		emitters.get("sa-done-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-done-2")?.status).toBe("done"));
		await expect(manager.cancel(["sa-run-1", "sa-done-2"])).resolves.toEqual(["Cancelled sa-run-1", "sa-done-2 was already done"]);
		expect(interrupts.get("sa-run-1")).toHaveBeenCalled();
		expect(manager.consumedIds.has("sa-run-1")).toBe(true);
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

		await expect(manager.cancel(["sa-completed-1"])).resolves.toEqual(["sa-completed-1 was already done"]);
		expect(manager.consumedIds.has("sa-completed-1")).toBe(false);
		resolveManifest({ baseRef: "base-ref", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-completed-1")?.status).toBe("done"));
	});

	it("prunes oldest settled snapshots above max tracked", async () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < 65; index += 1) {
			const result = await manager.spawn(makeTask(`${index}`));
			expect(result).toHaveProperty("id");
			emitters.get(`sa-${index}-${index + 1}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get(`sa-${index}-${index + 1}`)?.status).toBe("done"));
		}
		expect(manager.list()).toHaveLength(64);
		expect(manager.get("sa-0-1")).toBeUndefined();
		expect(manager.get("sa-64-65")).toBeDefined();
	});

	it("keeps failed-close occupancy through history pruning", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// A visible child whose pane close failed still occupies its slot.
		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		emitters.get("sa-first-1")?.({ kind: "pane-attached", pane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" } });
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));

		// Fill history past MAX_TRACKED with settled background tasks.
		for (let index = 0; index < 64; index += 1) {
			await manager.spawn(makeTask(`${index + 1}`));
			emitters.get(`sa-${index + 1}-${index + 2}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}
		await vi.waitFor(() => expect(manager.list().every((snapshot) => snapshot.id === "sa-first-1" || snapshot.status === "done")).toBe(true));

		// The still-open pane's record must survive pruning: placement reads
		// occupancy only from this.list(), so losing it after MAX_TRACKED newer
		// tasks would undercount the tab and allow a fifth split.
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);
		expect(manager.get("sa-first-1")?.pane).toEqual({ agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" });

		await manager.spawn({ prompt: "p66", title: "next", cwd: "/repo", visible: true });
		// The failed-close pane still counts toward w1:t5's capacity.
		expect(placements[placements.length - 1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
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
		await vi.waitFor(() => expect(manager.get("sa-write-feature-1")?.status).toBe("done"));

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", baseRef: "origin/main" }));
		expect(buildCompletionManifest).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "resolved-origin-main" }));
		expect(spawned).toMatchObject({
			baseRef: "resolved-origin-main",
			worktree: { baseRef: "resolved-origin-main" },
		});
		expect(manager.get("sa-write-feature-1")?.manifest).toMatchObject({ baseRef: "resolved-origin-main" });
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
		await vi.waitFor(() => expect(manager.get("sa-write-feature-1")?.status).toBe("done"));

		expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "HEAD" }));
		expect(buildCompletionManifest).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "captured-head" }));
		expect(manager.get("sa-write-feature-1")?.manifest).toMatchObject({ baseRef: "captured-head" });
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

	it("serializes concurrent worktree creation so both isolated spawns succeed", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const createWorktree = vi.fn(async (options: CreateWorktreeOptions) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				// Two overlapping `git worktree add` calls contend on the shared repo
				// config lock, which failed two of six parallel isolated spawns.
				if (inFlight > 1) return { ok: false as const, error: "git_failed" as const, message: "could not lock config file .git/config: File exists" };
				// A macrotask gives the second spawn's (all-microtask) path time to reach
				// createWorktree; without the gate it enters here and overlaps.
				await new Promise((resolve) => setTimeout(resolve, 0));
				return { ok: true as const, path: options.path ?? "/isolated/worktree", branch: options.branch ?? "sumo/task", baseRef: "abc123" };
			} finally {
				inFlight -= 1;
			}
		});
		const manager = new SubagentManager(() => ({ events: () => undefined, interrupt: () => undefined }), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "abc123",
			buildCompletionManifest: fakeManifestBuilder,
		});

		const [first, second] = await Promise.all([
			manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", worktree: true }),
			manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", worktree: true }),
		]);

		expect(maxInFlight).toBe(1);
		expect(createWorktree).toHaveBeenCalledTimes(2);
		expect(first).toMatchObject({ status: "running" });
		expect(second).toMatchObject({ status: "running" });
	});

	it("does not create a worktree for a spawn interrupted while waiting on the creation gate", async () => {
		let releaseFirst = (): void => undefined;
		const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let calls = 0;
		const createWorktree = vi.fn(async (options: CreateWorktreeOptions) => {
			calls += 1;
			if (calls === 1) await firstHeld;
			return { ok: true as const, path: options.path ?? "/isolated/worktree", branch: options.branch ?? "sumo/task", baseRef: "abc123" };
		});
		const backendFactory = vi.fn(() => ({ events: () => undefined, interrupt: () => undefined }));
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree,
			resolveWorktreeBaseRef: async () => "abc123",
			buildCompletionManifest: fakeManifestBuilder,
		});

		const first = manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", worktree: true });
		const second = manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", worktree: true });
		// The first creation holds the gate, so the second spawn can only wait.
		await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

		manager.disposeAll();
		releaseFirst();

		await expect(first).resolves.toMatchObject({ status: "error", errorText: expect.stringContaining("interrupted during setup") });
		await expect(second).resolves.toMatchObject({ status: "error", errorText: "interrupted during setup" });
		expect(backendFactory).not.toHaveBeenCalled();
		// The interrupted waiter must not create (and preserve) a worktree.
		expect(createWorktree).toHaveBeenCalledTimes(1);
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
		expect(manager.get("sa-first-1")?.pane?.tabId).toBe("w1:t5");
	});

	it("reclaims a closed visible tab before the next spawn", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
			requestClose: () => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "closed" } }),
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		const first = await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		// SAFETY: this first spawn is below capacity, so it is a snapshot with an id.
		await manager.close([(first as { id: string }).id]);
		const second = await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });

		expect(second).toMatchObject({ status: "running", pane: { paneId: "w1:psa-second-2" } });
		expect(placements).toEqual([
			{ kind: "new-tab", label: "subagents" },
			{ kind: "new-tab", label: "subagents" },
		]);
	});

	it("drops the generated tab cache when the last of two siblings settles while the other manifest is still collecting", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const deferredManifest = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: async () => deferredManifest,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		expect(placements).toEqual([
			{ kind: "new-tab", label: "subagents" },
			{ kind: "tab", tabId: "w1:t5", direction: "down" },
		]);

		// Settle both siblings close together: the first child's manifest is
		// deferred, so its snapshot stays "running" while the second child's
		// run-settled folds. The second fold must still drop the generated-tab
		// cache because the first child is no longer a live `children` entry.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "first done" } });
		emitters.get("sa-second-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "second done" } });

		resolveManifest({ baseRef: "abc123", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => {
			expect(manager.get("sa-first-1")?.status).toBe("done");
			expect(manager.get("sa-second-2")?.status).toBe("done");
		});

		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true });
		expect(placements[2]).toEqual({ kind: "new-tab", label: "subagents" });
	});

	it("excludes settling children from caller-tab capacity during placement planning", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const deferredManifest = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t1", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: async () => deferredManifest,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t1",
		});

		for (const title of ["first", "second", "third", "fourth"]) {
			await manager.spawn({ prompt: `p-${title}`, title, cwd: "/repo", visible: true });
		}
		expect(placements).toEqual([
			{ kind: "tab", tabId: "w1:t1", direction: "right" },
			{ kind: "tab", tabId: "w1:t1", direction: "down" },
			{ kind: "tab", tabId: "w1:t1", direction: "right" },
			{ kind: "tab", tabId: "w1:t1", direction: "down" },
		]);

		// Settle all four together: each leaves `children` synchronously while
		// its snapshot still reports "running" during deferred manifest
		// collection. Placement planning must not count those freed panes.
		for (const id of ["sa-first-1", "sa-second-2", "sa-third-3", "sa-fourth-4"]) {
			emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}

		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		expect(placements[4]).toEqual({ kind: "tab", tabId: "w1:t1", direction: "right" });

		resolveManifest({ baseRef: "abc123", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => {
			expect(manager.get("sa-first-1")?.status).toBe("done");
			expect(manager.get("sa-fourth-4")?.status).toBe("done");
		});
	});

	it("retains a surviving generated tab when the cached overflow tab empties", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				// The first two children land in one generated tab, the next two in
				// a second; the second becomes the cached (most recent) tab.
				const tabId = task.id === "sa-first-1" || task.id === "sa-second-2" ? "w1:t5" : "w1:t6";
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId, paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true });
		await manager.spawn({ prompt: "p4", title: "fourth", cwd: "/repo", visible: true });

		// Settle the cached overflow tab (w1:t6) entirely. The older generated
		// tab (w1:t5) still holds live panes and must be reclaimed next.
		emitters.get("sa-third-3")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-third-3")?.status).toBe("done"));
		emitters.get("sa-fourth-4")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-fourth-4")?.status).toBe("done"));

		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		expect(placements[4]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
	});

	it("does not promote an isolated worktree workspace tab when the cached tab empties", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				const tabId = task.id === "sa-first-1" ? "w9:t1" : "w1:t5";
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: tabId.split(":")[0], tabId, paneId: `${tabId}:p` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			createWorktree: async (options) => ({ ok: true, path: `/isolated/${options.task}`, branch: options.branch ?? `sumo/${options.task}`, baseRef: options.baseRef ?? "HEAD" }),
			resolveWorktreeBaseRef: async () => "abc123",
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true, worktree: true });
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		expect(placements).toEqual([
			{ kind: "worktree-workspace", path: "/isolated/first", label: "first", sourceCwd: "/repo" },
			{ kind: "new-tab", label: "subagents" },
		]);

		// Settle the shared generated tab's only child.
		emitters.get("sa-second-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-second-2")?.status).toBe("done"));

		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true });
		// The isolated worktree workspace (w9:t1) must not be promoted to the
		// shared cache; with no surviving shared tab, the next spawn plans fresh.
		expect(placements[2]).toEqual({ kind: "new-tab", label: "subagents" });
	});

	it("keeps a failed-close pane in capacity until its slot is confirmed free", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		for (const title of ["first", "second", "third", "fourth"]) {
			await manager.spawn({ prompt: `p-${title}`, title, cwd: "/repo", visible: true });
		}

		// sa-fourth-4's close fails: it leaves `children` but its pane is still open.
		emitters.get("sa-fourth-4")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-fourth-4")?.status).toBe("error"));

		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		// The still-open pane keeps w1:t5 at capacity, so the fifth child overflows.
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("records failed-close occupancy before the manifest settles", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const deferredManifest = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: async () => deferredManifest,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		for (const title of ["first", "second", "third", "fourth"]) {
			await manager.spawn({ prompt: `p-${title}`, title, cwd: "/repo", visible: true });
		}

		// sa-fourth-4's close fails while its manifest collection stays in flight.
		emitters.get("sa-fourth-4")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });

		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		// The still-open pane must already count during the in-flight settle.
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });

		resolveManifest({ baseRef: "abc123", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-fourth-4")?.status).toBe("error"));
	});

	it("retains a generated tab anchored by a failed-close pane", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		for (const title of ["first", "second"]) {
			await manager.spawn({ prompt: `p-${title}`, title, cwd: "/repo", visible: true });
		}

		// sa-first-1's close fails: its pane keeps w1:t5 alive after it settles.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));
		emitters.get("sa-second-2")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-second-2")?.status).toBe("done"));

		await manager.spawn({ prompt: "p3", title: "third", cwd: "/repo", visible: true });
		// The failed-close pane keeps w1:t5 alive, so the cache must stay and the
		// next child reclaims its remaining capacity instead of a fresh tab.
		expect(placements[2]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("records provisioning orphan occupancy and retains its tab", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		expect(placements[0]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
		// Provisioning failed after a split whose cleanup also failed: the pane is
		// still open even though no pane-attached event ever fired.
		emitters.get("sa-first-1")?.({
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: "herdr pane run exited 1",
				errorCode: "pane_unavailable",
				paneStillOpen: true,
				orphanPane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p9" },
			},
		});
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));

		expect(manager.get("sa-first-1")?.pane).toEqual({ agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p9" });
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		// The orphan occupies w1:t5, so the cache stays and the slot counts.
		expect(placements[1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("promotes a generated orphan tab into the reclaim cache", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// Fill the caller tab so the fifth spawn plans a generated tab.
		for (const [index, title] of ["first", "second", "third", "fourth"].entries()) {
			await manager.spawn({ prompt: `p${index + 1}`, title, cwd: "/repo", visible: true });
			emitters.get(`sa-${title}-${index + 1}`)?.({ kind: "run-started" });
			emitters.get(`sa-${title}-${index + 1}`)?.({ kind: "pane-attached", pane: { agentName: `sa-${title}-${index + 1}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${index + 1}` } });
		}
		expect(placements).toEqual([
			{ kind: "tab", tabId: "w1:t5", direction: "right" },
			{ kind: "tab", tabId: "w1:t5", direction: "down" },
			{ kind: "tab", tabId: "w1:t5", direction: "right" },
			{ kind: "tab", tabId: "w1:t5", direction: "down" },
		]);

		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
		// Provisioning failed after the generated tab was created: the pane run
		// and its cleanup both failed, so the host reports the orphan pane and
		// the tab that keeps it alive.
		emitters.get("sa-fifth-5")?.({
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: "herdr pane run exited 1",
				errorCode: "pane_unavailable",
				paneStillOpen: true,
				orphanPane: { agentName: "fifth-worker", workspaceId: "w1", tabId: "w1:t8", paneId: "w1:p8" },
			},
		});
		await vi.waitFor(() => expect(manager.get("sa-fifth-5")?.status).toBe("error"));

		await manager.spawn({ prompt: "p6", title: "sixth", cwd: "/repo", visible: true });
		// The surviving generated tab has three free slots, so the cache must
		// point at it and the next spawn reclaims capacity there.
		expect(placements[5]).toEqual({ kind: "tab", tabId: "w1:t8", direction: "down" });
	});

	it("reclaims a vacancy in an older shared tab when the cached tab is full", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// Four children fill the caller tab, four more fill a generated overflow
		// tab that becomes the cache. The child ids are 1-indexed so the pane
		// placement asserts read naturally.
		for (let index = 1; index <= 8; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: index <= 4 ? "w1:t5" : "w1:t6", paneId: `w1:p${index}` } });
		}
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
		// The cached overflow tab is full, but the caller tab lost a child.
		emitters.get("sa-child-1-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-child-1-1")?.status).toBe("done"));

		await manager.spawn({ prompt: "p9", title: "ninth", cwd: "/repo", visible: true });
		// The caller tab's free slot must be reclaimed instead of provisioning
		// a duplicate overflow tab.
		expect(placements[8]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("returns to the emptied caller tab when the cached overflow tab is full", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// Four children fill the caller tab, four fill the generated overflow
		// tab that becomes the cache.
		for (let index = 1; index <= 8; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: index <= 4 ? "w1:t5" : "w1:t6", paneId: `w1:p${index}` } });
		}
		// Every child exits the caller tab, but the tab itself survives: it
		// still holds the parent session pane.
		for (let index = 1; index <= 4; index += 1) {
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}
		await vi.waitFor(() => expect(["sa-child-1-1", "sa-child-2-2", "sa-child-3-3", "sa-child-4-4"].every((id) => manager.get(id)?.status === "done")).toBe(true));

		await manager.spawn({ prompt: "p9", title: "ninth", cwd: "/repo", visible: true });
		// The cached overflow tab is full and no live child pane remains
		// elsewhere, so the emptied caller tab must be reclaimed.
		expect(placements[8]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
	});

	it("returns to the caller tab as soon as it has room, before the overflow tab fills", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// Four children fill the caller tab, two spill into the generated overflow
		// tab that becomes the attach cache and still has two free slots.
		for (let index = 1; index <= 6; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: index <= 4 ? "w1:t5" : "w1:t6", paneId: `w1:p${index}` } });
		}
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
		expect(placements[5]).toEqual({ kind: "tab", tabId: "w1:t6", direction: "down" });

		// Every caller-tab child exits; the tab survives because it holds the
		// parent session pane.
		for (let index = 1; index <= 4; index += 1) {
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}
		await vi.waitFor(() => expect(["sa-child-1-1", "sa-child-2-2", "sa-child-3-3", "sa-child-4-4"].every((id) => manager.get(id)?.status === "done")).toBe(true));

		await manager.spawn({ prompt: "p7", title: "seventh", cwd: "/repo", visible: true });
		// The overflow tab has room, but the freed caller tab is the home for
		// visible children again; overflow is spillover only.
		expect(placements[6]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
	});

	it("promotes a surviving tab anchored only by failed-close panes", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
				emit({ kind: "run-started" });
				emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: task.id === "sa-fifth-5" ? "w1:t9" : "w1:t5", paneId: `w1:p${task.id}` } });
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
		});

		for (const title of ["first", "second", "third", "fourth"]) {
			await manager.spawn({ prompt: `p-${title}`, title, cwd: "/repo", visible: true });
		}
		// sa-fifth-5 overflows into a fresh tab and the cache follows its pane.
		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
		await manager.spawn({ prompt: "p6", title: "sixth", cwd: "/repo", visible: true });
		expect(placements[5]).toEqual({ kind: "tab", tabId: "w1:t9", direction: "down" });

		for (const id of ["sa-second-2", "sa-third-3", "sa-fourth-4"]) {
			emitters.get(id)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		}
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));
		emitters.get("sa-fifth-5")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		emitters.get("sa-sixth-6")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(manager.get("sa-sixth-6")?.status).toBe("done"));

		await manager.spawn({ prompt: "p7", title: "seventh", cwd: "/repo", visible: true });
		// w1:t9 died with its last live child, but w1:t5 still holds sa-first-1's
		// failed-close pane; that surviving tab must become the cache.
		expect(placements[6]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("counts only live visible panes toward tab capacity", async () => {
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

		for (let index = 0; index < 5; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `task ${index}`, cwd: "/repo", visible: true });
		}

		// Four live panes fill the first tab; the fifth must overflow instead of
		// over-tiling it. Settled panes are covered by the reclamation test above.
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

	it("unseeds the cache when a pre-attach failure targets the initial caller tab", async () => {
		const backendTasks: Array<SpawnSubagentTask & { placement?: unknown }> = [];
		let mode: "attach" | "fail-preattach" = "fail-preattach";
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
						emit({ kind: "pane-attached", pane: { agentName: `${task.id}-worker`, workspaceId: "w1", tabId: "w1:t9", paneId: `w1:p${task.id}` } });
					} else {
						emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr agent start exited 1" } });
					}
				},
				interrupt: () => undefined,
			};
		}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }), terminalHost: host, // SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never, initialVisibleTabId: "w1:t5" });

		// The cache starts on the caller tab; the operator moved the parent pane
		// elsewhere and Herdr closed the original tab, so the split fails.
		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		expect(backendTasks[0]?.placement).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });

		// Re-arming the same stale initial id would fail every subsequent spawn.
		// The cache must unseed so the next spawn plans a fresh tab instead.
		mode = "attach";
		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		expect(backendTasks[1]?.placement).toEqual({ kind: "new-tab", label: "subagents" });
	});

	it("clears placement tracking when backend construction fails", async () => {
		const backendFactory = vi.fn(() => { throw new Error("cannot create task directory"); });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager(backendFactory, {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });

		// The planned placement must not leak in the tracking map for a
		// construction that never emits run-settled.
		expect(manager.placementByTask.size).toBe(0);
	});

	it("retires the initial caller tab once paneTabGone proves it stale", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// The operator moved the parent pane; the caller tab is gone, and the
		// first spawn proves it with paneTabGone.
		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		expect(placements[0]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr returned no pane for tab w1:t5", paneTabGone: true } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));

		// The replacement generated tab fills up; the retired caller tab must
		// not be re-selected by the vacancy fallback.
		for (let index = 2; index <= 5; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: "w1:t9", paneId: `w1:p${index}` } });
		}
		expect(placements[1]).toEqual({ kind: "new-tab", label: "subagents" });

		await manager.spawn({ prompt: "p6", title: "sixth", cwd: "/repo", visible: true });
		// The cached generated tab is full and the caller tab was retired, so a
		// fresh overflow tab is planned instead of the dead caller tab.
		expect(placements[5]).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("retires a stale failed-close record when its tab fails a placement", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		// Four children fill the caller tab; a fifth opens the overflow tab
		// whose close later fails, leaving a still-open pane record there.
		for (let index = 1; index <= 4; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${index}` } });
		}
		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		expect(placements[4]).toEqual({ kind: "new-tab", label: "subagents 2" });
		emitters.get("sa-fifth-5")?.({ kind: "run-started" });
		emitters.get("sa-fifth-5")?.({ kind: "pane-attached", pane: { agentName: "sa-fifth-5-worker", workspaceId: "w1", tabId: "w1:t6", paneId: "w1:p5" } });
		emitters.get("sa-fifth-5")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-fifth-5")?.status).toBe("error"));

		// The caller tab is full, so the vacancy scan selects w1:t6 for the next
		// spawn. The operator has closed that pane in the meantime: the split
		// fails pre-attach, proving the tab is gone.
		await manager.spawn({ prompt: "p6", title: "sixth", cwd: "/repo", visible: true });
		expect(placements[5]).toEqual({ kind: "tab", tabId: "w1:t6", direction: "down" });
		emitters.get("sa-sixth-6")?.({ kind: "run-started" });
		emitters.get("sa-sixth-6")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr returned no pane for tab w1:t6", paneTabGone: true } });
		await vi.waitFor(() => expect(manager.get("sa-sixth-6")?.status).toBe("error"));

		// The stale record must be retired: otherwise the scan keeps selecting
		// the dead tab and every spawn fails forever.
		expect(manager.get("sa-fifth-5")?.paneStillOpen).toBeUndefined();
		await manager.spawn({ prompt: "p7", title: "seventh", cwd: "/repo", visible: true });
		expect(placements[6]).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("keeps still-open records when a tab placement fails without tab-gone evidence", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		for (let index = 1; index <= 4; index += 1) {
			await manager.spawn({ prompt: `p${index}`, title: `child-${index}`, cwd: "/repo", visible: true });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "run-started" });
			emitters.get(`sa-child-${index}-${index}`)?.({ kind: "pane-attached", pane: { agentName: `sa-child-${index}-${index}-worker`, workspaceId: "w1", tabId: "w1:t5", paneId: `w1:p${index}` } });
		}
		await manager.spawn({ prompt: "p5", title: "fifth", cwd: "/repo", visible: true });
		emitters.get("sa-fifth-5")?.({ kind: "run-started" });
		emitters.get("sa-fifth-5")?.({ kind: "pane-attached", pane: { agentName: "sa-fifth-5-worker", workspaceId: "w1", tabId: "w1:t6", paneId: "w1:p5" } });
		emitters.get("sa-fifth-5")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-fifth-5")?.status).toBe("error"));

		// The candidate tab's split fails without proving the tab is gone (e.g.
		// the run failed on a live tab), so the still-open record must survive.
		await manager.spawn({ prompt: "p6", title: "sixth", cwd: "/repo", visible: true });
		expect(placements[5]).toEqual({ kind: "tab", tabId: "w1:t6", direction: "down" });
		emitters.get("sa-sixth-6")?.({ kind: "run-started" });
		emitters.get("sa-sixth-6")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr agent start exited 1" } });
		await vi.waitFor(() => expect(manager.get("sa-sixth-6")?.status).toBe("error"));

		expect(manager.get("sa-fifth-5")?.paneStillOpen).toBe(true);
	});

	it("reuses the caller tab when a failed-close pane keeps the cached tab alive", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		// The child lands in a generated tab that becomes the cache.
		emitters.get("sa-first-1")?.({ kind: "pane-attached", pane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t6", paneId: "w1:p1" } });
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));

		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		// The failed-close pane keeps w1:t6 alive and counted (see "keeps a
		// failed-close pane in capacity until its slot is confirmed free"), but
		// the caller tab with a free slot is the preferred destination.
		expect(placements[1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "right" });
	});

	it("records a close failure that lands during an in-flight settlement", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const deferredManifest = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: () => deferredManifest,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		emitters.get("sa-first-1")?.({ kind: "pane-attached", pane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" } });

		// cancel() starts a synthetic interrupted settlement whose manifest is
		// still collecting; the snapshot is not terminal yet.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("running"));

		// The real close lands late and fails while settlement is in flight.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);

		// Completing the interrupted settlement must not clobber the flag.
		resolveManifest({ baseRef: "abc123", changedPaths: [], dirty: false, commits: 0, exit: "interrupted", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);

		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		// The still-open pane still counts toward w1:t5's capacity.
		expect(placements[1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("keeps a late close-failure flag when a failed settlement completes first", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		let resolveManifest: (manifest: CompletionManifest) => void = () => undefined;
		const deferredManifest = new Promise<CompletionManifest>((resolve) => { resolveManifest = resolve; });
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: () => deferredManifest,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		emitters.get("sa-first-1")?.({ kind: "pane-attached", pane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" } });

		// The cancel force-settle path emits a failed settlement whose manifest
		// is still collecting; the snapshot is not terminal yet.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "cancelled after timeout" } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("running"));

		// The real close lands late and fails while the failed settlement is in
		// flight; the flag is recorded immediately.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);

		// The in-flight settlement completes without its own paneStillOpen
		// evidence; it must not clobber the late flag.
		resolveManifest({ baseRef: "abc123", changedPaths: [], dirty: false, commits: 0, exit: "failed", durationMs: 1 });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);

		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		// The still-open pane still counts toward w1:t5's capacity.
		expect(placements[1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
	});

	it("records paneStillOpen from a close failure that lands after cancel force-settled the snapshot", async () => {
		const placements: unknown[] = [];
		const emitters = new Map<string, (event: SubagentEvent) => void>();
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			closePane: vi.fn(),
			notify: vi.fn(),
		};
		const manager = new SubagentManager((task) => ({
			events: (emit) => {
				placements.push(task.placement);
				emitters.set(task.id, emit);
			},
			interrupt: () => undefined,
		}), {
			captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "abc123" }),
			buildCompletionManifest: fakeManifestBuilder,
			terminalHost: host,
			// SAFETY: the manager only calls pi.exec on this object.
			pi: { exec: vi.fn() } as never,
			initialVisibleTabId: "w1:t5",
		});

		await manager.spawn({ prompt: "p1", title: "first", cwd: "/repo", visible: true });
		emitters.get("sa-first-1")?.({ kind: "run-started" });
		emitters.get("sa-first-1")?.({ kind: "pane-attached", pane: { agentName: "first-worker", workspaceId: "w1", tabId: "w1:t5", paneId: "w1:p1" } });

		// cancel() force-settles the snapshot while the backend close is still
		// in flight; the snapshot is terminal before the real result arrives.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "cancelled after timeout" } });
		await vi.waitFor(() => expect(manager.get("sa-first-1")?.status).toBe("error"));
		expect(manager.get("sa-first-1")?.paneStillOpen).toBeUndefined();

		// The late close fails: the pane is still open, so occupancy must be
		// recorded even though the snapshot is already terminal.
		emitters.get("sa-first-1")?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } });
		expect(manager.get("sa-first-1")?.paneStillOpen).toBe(true);

		await manager.spawn({ prompt: "p2", title: "second", cwd: "/repo", visible: true });
		// The still-open pane still counts toward w1:t5's capacity.
		expect(placements[1]).toEqual({ kind: "tab", tabId: "w1:t5", direction: "down" });
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
		expect(backendTasks[2]?.placement).toEqual({ kind: "worktree-workspace", path: "/isolated/third", label: "third", sourceCwd: "/repo" });
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
			if (task.id === "sa-first-1") {
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

		expect(openExistingWorktreeWorkspace).not.toHaveBeenCalled();
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/isolated/worktree/packages/api",
			placement: { kind: "worktree-workspace", path: "/isolated/worktree", label: "api", sourceCwd: "/repo" },
		}));
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

		expect(openExistingWorktreeWorkspace).not.toHaveBeenCalled();
		expect(backendTasks.map((task) => task.placement)).toEqual([
			{ kind: "worktree-workspace", path: "/isolated/first", label: "first", sourceCwd: "/repo" },
			{ kind: "worktree-workspace", path: "/isolated/second", label: "second", sourceCwd: "/repo" },
		]);
	});

	it("preserves a created worktree when the backend cannot provision its workspace", async () => {
		const backendFactory = vi.fn(() => ({
			events: (emit: (event: SubagentEvent) => void) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "daemon unavailable", errorCode: "pane_unavailable", errorReason: "daemon unavailable" } }),
			interrupt: () => undefined,
		}));
		const host: TerminalHost = {
			kind: "herdr",
			openCommandInSplit: vi.fn(),
			openExistingWorktreeWorkspace: vi.fn(),
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

		expect(spawned).toMatchObject({
			status: "error",
			errorCode: "pane_unavailable",
			errorText: expect.stringContaining("daemon unavailable"),
			worktree: { path: "/isolated/preserved" },
		});
		// SAFETY: failed spawns always carry an errorText field.
		expect((spawned as { errorText?: string }).errorText).toContain("is preserved");
		expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({
			placement: { kind: "worktree-workspace", path: "/isolated/preserved", label: "preserved", sourceCwd: "/repo" },
		}));
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
			await expect(manager.sendTo("sa-9", "hi")).rejects.toThrow("Unknown subagent id: sa-9. Known ids: sa-known-1");
		});

		it("rejects queued children", async () => {
			const { manager } = steerableBackend();
			for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
			await manager.spawn(makeTask("queued"));
			await expect(manager.sendTo("sa-queued-11", "hi")).rejects.toThrow(`Subagent ${"sa-queued-11"} is queued and cannot receive input until it starts`);
		});

		it("rejects settled children", async () => {
			const { manager, emitters } = steerableBackend();
			await manager.spawn(makeTask("done"));
			emitters.get("sa-done-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get("sa-done-1")?.status).toBe("done"));
			await expect(manager.sendTo("sa-done-1", "hi")).rejects.toThrow("already settled (done)");
		});

		it("classifies headless steering as unsupported", async () => {
			const { manager } = deferredBackend();
			await manager.spawn(makeTask("headless"));
			await expect(manager.sendTo("sa-headless-1", "hi")).resolves.toEqual({ capability: "unsupported: headless steering" });
		});

		it("waits for the child's consumption acknowledgement and returns the snapshot", async () => {
			const { manager, sends } = steerableBackend();
			const id = await spawnVisible(manager, "steered");
			await expect(manager.sendTo(id, "focus the tests")).resolves.toMatchObject({ id, status: "running" });
			expect(sends.get(id)).toHaveBeenCalledWith("focus the tests");
		});

		it("propagates a child consumption or settlement failure", async () => {
			const { manager, sends } = steerableBackend();
			const id = await spawnVisible(manager, "settling");
			// SAFETY: visible spawns always register a send double.
			(sends.get(id) as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("visible subagent sa-1 has settled before steering consumption was acknowledged"));

			await expect(manager.sendTo(id, "too late")).rejects.toThrow("has settled before steering consumption was acknowledged");
			expect(sends.get(id)).toHaveBeenCalledWith("too late");
		});
	});

	describe("close", () => {
		it("reports unknown and already-settled ids without action", async () => {
			const { manager, emitters } = steerableBackend();
			await manager.spawn(makeTask("done"));
			emitters.get("sa-done-1")?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
			await vi.waitFor(() => expect(manager.get("sa-done-1")?.status).toBe("done"));

			await expect(manager.close(["sa-9", "sa-done-1"])).resolves.toEqual(["sa-9 is unknown", "sa-done-1 was already done"]);
			expect(manager.consumedIds.has("sa-done-1")).toBe(true);
			expect(manager.consumedIds.has("sa-9")).toBe(false);
		});

		it("cancels a queued child without starting it", async () => {
			const { manager, requestCloses } = steerableBackend();
			for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await manager.spawn(makeTask(`running-${index}`));
			await manager.spawn(makeTask("queued"));

			await expect(manager.close(["sa-queued-11"])).resolves.toEqual([`Cancelled queued ${"sa-queued-11"}`]);
			expect(manager.get("sa-queued-11")).toMatchObject({ status: "error", errorText: "interrupted" });
			expect(requestCloses.has("sa-queued-11")).toBe(false);
		});

		it("reports headless running children without acting", async () => {
			const { manager } = deferredBackend();
			await manager.spawn(makeTask("headless"));
			await expect(manager.close(["sa-headless-1"])).resolves.toEqual(["sa-headless-1 is headless — it settles on its own; use subagent_cancel to stop it"]);
			expect(manager.get("sa-headless-1")?.status).toBe("running");
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
