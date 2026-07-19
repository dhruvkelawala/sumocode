import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SpawnSubagentTask } from "./manager.js";
import type { SubagentEvent } from "./domain.js";

const makeTask = (title: string): SpawnSubagentTask => ({ title, prompt: `prompt ${title}`, cwd: "/tmp" });

const deferredBackend = () => {
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const interrupts = new Map<string, ReturnType<typeof vi.fn>>();
	const manager = new SubagentManager((task) => {
		const interrupt = vi.fn(() => emitters.get(task.id)?.({ kind: "run-settled", outcome: { kind: "interrupted" } }));
		interrupts.set(task.id, interrupt);
		return {
			events: (emit) => emitters.set(task.id, emit),
			interrupt,
		};
	}, { captureGitContext: async () => ({ repoRoot: "/repo", baseRef: "base-ref" }) });
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
		expect(manager.get("sa-1")?.status).toBe("done");
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
		await expect(manager.cancel(["sa-1", "sa-2"])).resolves.toEqual(["Cancelled sa-1", "sa-2 was already done"]);
		expect(interrupts.get("sa-1")).toHaveBeenCalled();
		expect(manager.consumedIds.has("sa-1")).toBe(true);
	});

	it("prunes oldest settled snapshots above max tracked", async () => {
		const { manager, emitters } = deferredBackend();
		for (let index = 0; index < 65; index += 1) {
			const result = await manager.spawn(makeTask(`${index}`));
			expect(result).toHaveProperty("id");
			emitters.get(`sa-${index + 1}`)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
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
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }) });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		const id = (spawned as { id: string }).id;
		emitFn?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		expect(manager.get(id)?.status).toBe("error");
		const settledAt = manager.get(id)?.settledAt;
		emitFn?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "late success" } });
		expect(manager.get(id)?.status).toBe("error");
		expect(manager.get(id)?.settledAt).toBe(settledAt);
		expect(manager.get(id)?.finalText).not.toBe("late success");
	});

	it("returns the post-fold snapshot when the backend settles synchronously", async () => {
		const manager = new SubagentManager(() => ({
			events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "bad model" } }),
			interrupt: () => undefined,
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }) });
		const spawned = await manager.spawn({ prompt: "p", title: "t", cwd: "/tmp" });
		expect((spawned as { status: string }).status).toBe("error");
		expect((spawned as { errorText?: string }).errorText).toBe("bad model");
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
		}), { captureGitContext: async () => ({ baseRef: "base-ref" }) });
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
