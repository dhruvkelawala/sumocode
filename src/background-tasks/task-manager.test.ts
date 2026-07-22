import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProcessTreeIdentity, ProcessTreeOperations } from "./process-tree.js";
import { TerminalTaskManager } from "./task-manager.js";
import { TerminalTaskStore } from "./task-store.js";

type MockChild = EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };

function mockChild(pid: number): MockChild {
	const child = new EventEmitter() as MockChild;
	child.pid = pid;
	child.unref = vi.fn();
	return child;
}

interface ProcessTreeHarness {
	readonly operations: ProcessTreeOperations;
	readonly empty: Map<number, boolean>;
	readonly calls: string[];
}

function processTreeHarness(): ProcessTreeHarness {
	const empty = new Map<number, boolean>();
	const calls: string[] = [];
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn((pid) => `start-${pid}`),
		identityMatches: vi.fn((identity) => empty.get(identity.processGroupId) ? "different" : "same"),
		isTreeEmpty: vi.fn((identity) => empty.get(identity.processGroupId) === true),
		signalTree: vi.fn(async (identity, signal) => {
			calls.push(`signal:${identity.processGroupId}:${signal}`);
			if (signal === "SIGKILL") empty.set(identity.processGroupId, true);
			return { ok: true, gone: false };
		}),
		waitForTreeEmpty: vi.fn(async (identity) => {
			calls.push(`wait:${identity.processGroupId}`);
			return empty.get(identity.processGroupId) === true;
		}),
	};
	return { operations, empty, calls };
}

describe("TerminalTaskManager", () => {
	let rootDir: string;
	let children: MockChild[];
	let managers: TerminalTaskManager[];
	let tree: ProcessTreeHarness;
	let ids: string[];
	let now: number;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-manager-"));
		children = [];
		managers = [];
		tree = processTreeHarness();
		ids = ["term-a", "term-b", "term-c"];
		now = 1_000;
	});

	afterEach(() => {
		for (const manager of managers) manager.detach();
		rmSync(rootDir, { recursive: true, force: true });
	});

	function manager(overrides: Partial<ConstructorParameters<typeof TerminalTaskManager>[0]> = {}): TerminalTaskManager {
		const next = new TerminalTaskManager({
			store: new TerminalTaskStore({ rootDir }),
			processTree: tree.operations,
			spawn: vi.fn(() => {
				const child = mockChild(4000 + children.length);
				children.push(child);
				return child as unknown as ChildProcess;
			}) as never,
			now: () => now,
			createId: () => ids.shift() ?? `term-${children.length}`,
			createCompletionId: () => `completion-${children.length}`,
			pollIntervalMs: 10,
			termGraceMs: 10,
			killGraceMs: 10,
			claimLeaseMs: 30,
			...overrides,
		});
		managers.push(next);
		return next;
	}

	async function start(target = manager(), ownerSessionId = "session-a") {
		return target.start({
			ownerSessionId,
			command: "pnpm test",
			cwd: "/repo",
			title: "tests",
		});
	}

	function exitFile(task: { logFile: string }): string {
		return join(dirname(task.logFile), "exit.code");
	}

	it("persists spawn identity before releasing a detached terminal", async () => {
		const target = manager();
		const task = await start(target);

		expect(task).toMatchObject({
			schemaVersion: 4,
			revision: 2,
			id: "term-a",
			ownerSessionId: "session-a",
			status: "running",
			completionPolicy: "passive",
			pid: 4000,
			processGroupId: 4000,
			processStartTime: "start-4000",
			deliveryState: "none",
		});
		expect(children[0]?.unref).toHaveBeenCalledOnce();
		expect(existsSync(join(dirname(task.logFile), "launch.ready"))).toBe(true);
		expect(new TerminalTaskStore({ rootDir }).loadAll()[0]).toEqual(task);
	});

	it("terminates the new process tree when spawn identity persistence fails", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const transition = vi.spyOn(store, "transition").mockImplementation(() => {
			throw new Error("disk unavailable");
		});
		const target = manager({ store });
		tree.operations.waitForTreeEmpty = vi.fn(async (identity: ProcessTreeIdentity) => {
			tree.empty.set(identity.processGroupId, true);
			return true;
		});

		await expect(start(target)).rejects.toThrow("disk unavailable");
		expect(transition).toHaveBeenCalledOnce();
		expect(tree.operations.signalTree).toHaveBeenCalledWith(expect.objectContaining({ processGroupId: 4000 }), "SIGTERM");
	});

	it("settles once with a durable completion id and pending passive delivery", async () => {
		const target = manager();
		const changes = vi.fn();
		target.addChangeListener(changes);
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		children[0]?.emit("close", 0);

		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.status).toBe("completed"));
		const settled = target.get(task.id, "session-a")!;
		expect(settled).toMatchObject({
			status: "completed",
			exitCode: 0,
			completionId: "completion-1",
			deliveryState: "pending",
		});
		expect(changes.mock.calls.filter(([value]) => value.status === "completed")).toHaveLength(1);
	});

	it("check suppresses an unclaimed wake without making later waits unavailable", async () => {
		const target = manager();
		const task = await target.start({ ownerSessionId: "session-a", command: "echo done", cwd: "/repo", title: "done", completionPolicy: "wake" });
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.status).toBe("completed"));

		const checked = target.check(task.id, "session-a")!;
		expect(checked.task).toMatchObject({ deliveryState: "suppressed", observedAt: expect.any(Number) });
		const waited = await target.wait([task.id], "session-a", 10);
		expect(waited.settled[0]?.task).toMatchObject({ id: task.id, consumedAt: expect.any(Number) });
		expect(waited.pendingIds).toEqual([]);
	});

	it("keeps repeated check and wait observations revision-idempotent", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.status).toBe("completed"));

		const firstCheck = target.check(task.id, "session-a")!.task;
		const secondCheck = target.check(task.id, "session-a")!.task;
		expect(secondCheck.revision).toBe(firstCheck.revision);
		const firstWait = (await target.wait([task.id], "session-a", 10)).settled[0]!.task;
		const secondWait = (await target.wait([task.id], "session-a", 10)).settled[0]!.task;
		expect(secondWait.revision).toBe(firstWait.revision);
		expect(secondWait.updatedAt).toBe(firstWait.updatedAt);
	});

	it("closes the wait inspection/subscription lost-wakeup window", async () => {
		const target = manager();
		const task = await start(target);
		const originalSubscribe = target.addChangeListener.bind(target);
		vi.spyOn(target, "addChangeListener").mockImplementation((listener) => {
			const store = new TerminalTaskStore({ rootDir });
			const current = store.loadAll().find((entry) => entry.id === task.id)!;
			store.transition(task.id, current.revision, (entry) => ({
				...entry,
				status: "completed",
				updatedAt: 2_000,
				settledAt: 2_000,
				exitCode: 0,
				deliveryState: "pending",
				completionId: "completion-race",
			}));
			return originalSubscribe(listener);
		});

		const before = Date.now();
		const result = await target.wait([task.id], "session-a", 1_000);
		expect(Date.now() - before).toBeLessThan(250);
		expect(result).toMatchObject({ pendingIds: [], timedOut: false, settled: [{ task: { id: task.id } }] });
	});

	it("times out normally and aborts only the wait", async () => {
		const target = manager();
		const task = await start(target);

		const timedOut = await target.wait([task.id, "term-foreign"], "session-a", 5);
		expect(timedOut).toEqual({ settled: [], pendingIds: [task.id], unknownIds: ["term-foreign"], timedOut: true });

		const controller = new AbortController();
		const waiting = target.wait([task.id], "session-a", 1_000, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(target.get(task.id, "session-a")?.status).toBe("running");
	});

	it("signals every stop target before waiting, escalates, and confirms cancellation", async () => {
		const target = manager();
		const first = await start(target);
		const second = await start(target);
		const results = await target.stop([first.id, second.id], "session-a");

		const firstWait = tree.calls.findIndex((call) => call.startsWith("wait:"));
		expect(tree.calls.slice(0, firstWait)).toEqual([
			`signal:${first.processGroupId}:SIGTERM`,
			`signal:${second.processGroupId}:SIGTERM`,
		]);
		expect(tree.calls).toContain(`signal:${first.processGroupId}:SIGKILL`);
		expect(tree.calls).toContain(`signal:${second.processGroupId}:SIGKILL`);
		expect(results.map((result) => result.outcome)).toEqual(["cancelled", "cancelled"]);
		expect(results[0]?.task).toMatchObject({ status: "cancelled", deliveryState: "suppressed", observedAt: expect.any(Number), consumedAt: expect.any(Number) });
	});

	it("marks a mismatched stop target lost and refuses every signal", async () => {
		const target = manager();
		const task = await start(target);
		tree.operations.identityMatches = vi.fn((): "different" => "different");

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "lost" } });
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("stopOwned uses the same identity refusal and never signals an unrelated group", async () => {
		const target = manager();
		await start(target);
		tree.operations.identityMatches = vi.fn((): "unknown" => "unknown");

		const result = await target.stopOwned("session-a");

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "running" } });
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("filters every boundary by owner and keeps list side-effect free", async () => {
		const target = manager();
		const own = await start(target, "session-a");
		await start(target, "session-b");
		const before = new TerminalTaskStore({ rootDir }).loadAll().find((task) => task.id === own.id)!;

		expect(target.list("session-a").map((task) => task.id)).toEqual([own.id]);
		expect(target.check(own.id, "session-b")).toBeUndefined();
		expect((await target.stop([own.id], "session-b"))[0]?.outcome).toBe("unknown");
		const after = new TerminalTaskStore({ rootDir }).loadAll().find((task) => task.id === own.id)!;
		expect(after).toEqual(before);
	});

	it("recovers a running task after manager restart and settles from durable evidence", async () => {
		const firstManager = manager();
		const task = await start(firstManager);
		firstManager.detach();
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("completed"));
		expect(recovered.get(task.id, "session-a")).toMatchObject({ completionId: expect.any(String), deliveryState: "pending" });
	});

	it("recovers persisted stopping by resuming safe escalation for a live tree", async () => {
		const first = manager();
		const task = await start(first);
		const store = new TerminalTaskStore({ rootDir });
		const current = store.loadAll().find((entry) => entry.id === task.id)!;
		store.transition(task.id, current.revision, (entry) => ({ ...entry, status: "stopping", updatedAt: 2_000 }));
		first.detach();

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("cancelled"));
		expect(tree.operations.signalTree).toHaveBeenCalledWith(expect.objectContaining({ processGroupId: task.processGroupId }), "SIGTERM");
		expect(tree.operations.signalTree).toHaveBeenCalledWith(expect.objectContaining({ processGroupId: task.processGroupId }), "SIGKILL");
	});

	it("recovers persisted stopping as cancelled without signalling when the tree is empty", async () => {
		const first = manager();
		const task = await start(first);
		const store = new TerminalTaskStore({ rootDir });
		const current = store.loadAll().find((entry) => entry.id === task.id)!;
		store.transition(task.id, current.revision, (entry) => ({ ...entry, status: "stopping", updatedAt: 2_000 }));
		first.detach();
		tree.empty.set(task.processGroupId!, true);
		vi.mocked(tree.operations.signalTree).mockClear();

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("cancelled"));
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("recovers persisted stopping as lost on identity mismatch without signalling", async () => {
		const first = manager();
		const task = await start(first);
		const store = new TerminalTaskStore({ rootDir });
		const current = store.loadAll().find((entry) => entry.id === task.id)!;
		store.transition(task.id, current.revision, (entry) => ({ ...entry, status: "stopping", updatedAt: 2_000 }));
		first.detach();
		tree.operations.identityMatches = vi.fn((): "different" => "different");
		vi.mocked(tree.operations.signalTree).mockClear();

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("lost"));
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("leases pending delivery and acknowledges exactly the observable completion id", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));

		const claimed = target.claimPending("session-a", true);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.deliveryState).toBe("claimed");
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(target.acknowledge("session-a", new Set(["wrong"]))).toEqual([]);
		expect(target.acknowledge("session-a", new Set([claimed[0]!.completionId!]))[0]?.deliveryState).toBe("delivered");
		expect(target.acknowledge("session-a", new Set([claimed[0]!.completionId!]))).toEqual([]);
	});

	it("allows only one cross-manager notification claim and preserves the winner", async () => {
		const first = manager();
		const task = await start(first);
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(first.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		const second = manager();

		const claims = [first.claimPending("session-a", true), second.claimPending("session-a", true)];
		expect(claims.map((entries) => entries.length).sort()).toEqual([0, 1]);
		expect(new TerminalTaskStore({ rootDir }).loadAll()[0]?.deliveryState).toBe("claimed");
	});

	it("settles safely with competing recovery pollers and no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => { unhandled.push(error); };
		process.on("unhandledRejection", onUnhandled);
		try {
			const first = manager();
			const task = await start(first);
			const second = manager();
			writeFileSync(exitFile(task), "0");
			tree.empty.set(task.processGroupId!, true);
			children[0]?.emit("close", 0);
			await vi.waitFor(() => expect(second.get(task.id, "session-a")?.status).toBe("completed"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
			expect(new TerminalTaskStore({ rootDir }).loadAll()[0]).toMatchObject({ status: "completed", revision: 3 });
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.skipIf(process.platform === "win32")("creates every task artifact private under a permissive umask and refuses symlink output", async () => {
		const previousUmask = process.umask(0);
		try {
			const target = manager();
			const task = await start(target);
			const directory = dirname(task.logFile);
			expect(lstatSync(rootDir).mode & 0o777).toBe(0o700);
			expect(lstatSync(directory).mode & 0o777).toBe(0o700);
			for (const name of ["output.log", "exit.code", "run.sh", "launch.ready", "meta.json"]) {
				expect(lstatSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
			}
			const outside = join(rootDir, "outside.log");
			writeFileSync(outside, "outside", { mode: 0o600 });
			chmodSync(outside, 0o600);
			rmSync(task.logFile);
			symlinkSync(outside, task.logFile);
			expect(target.getOutput(task)).toBe("");
			expect(readdirSync(directory)).toContain("output.log");
		} finally {
			process.umask(previousUmask);
		}
	});

	it("retries a crashed claim lease and acknowledges only after retry visibility", async () => {
		const first = manager();
		const task = await start(first);
		writeFileSync(exitFile(task), "0");
		tree.empty.set(task.processGroupId!, true);
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(first.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		first.claimPending("session-a", true);
		expect(first.getClaimRetryDelay("session-a")).toBe(30);
		first.detach();
		now += 31;

		const recovered = manager();
		const retried = recovered.claimPending("session-a", true)[0]!;
		expect(retried).toMatchObject({ id: task.id, deliveryState: "claimed" });
		expect(recovered.acknowledge("session-a", new Set([retried.completionId!]))[0]).toMatchObject({ deliveryState: "delivered" });
	});
});
