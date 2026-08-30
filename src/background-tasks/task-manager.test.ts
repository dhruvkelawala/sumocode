import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProcessTreeIdentity, ProcessTreeOperations } from "./process-tree.js";
import { TerminalTaskManager } from "./task-manager.js";
import { TerminalTaskStore } from "./task-store.js";
import { TerminalDeliveryCoordinator } from "./terminal-tools.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

type MockChild = EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };

function mockChild(pid: number): MockChild {
	// SAFETY: MockChild is a structural subset of EventEmitter's surface the manager touches.
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

function asChildProcess<T>(child: T): ChildProcess {
	// SAFETY: MockChild implements exactly the ChildProcess surface the manager drives in these tests.
	return child as ChildProcess;
}

function processTreeHarness(): ProcessTreeHarness {
	const empty = new Map<number, boolean>();
	const calls: string[] = [];
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn((pid) => `start-${pid}`),
		identityMatches: vi.fn((identity) => empty.get(identity.processGroupId) ? "different" : "same"),
		isTreeEmpty: vi.fn((identity) => empty.get(identity.processGroupId) === true),
		captureTreeVerification: vi.fn((identity) => ({
			members: [{ pid: identity.pid + 1, processStartTime: `child-${identity.pid + 1}` }],
		})),
		verificationMatches: vi.fn((identity) => empty.get(identity.processGroupId) ? "different" : "same"),
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

	function manager(
		overrides: Partial<ConstructorParameters<typeof TerminalTaskManager>[0]> = {},
		create: (options: ConstructorParameters<typeof TerminalTaskManager>[0]) => TerminalTaskManager = (options) => new TerminalTaskManager(options),
	): TerminalTaskManager {
		const next = create({
			store: new TerminalTaskStore({ rootDir }),
			processTree: tree.operations,
			// SAFETY: the mock spawn only implements the call signature this manager exercises.
			spawn: vi.fn(() => {
				const child = mockChild(4000 + children.length);
				children.push(child);
				return asChildProcess(child);
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

function transientFault(code: string): Error {
	return Object.assign(new Error(`injected ${code} metadata read failure`), { code });
}

	function durableTask(id: string): TerminalTaskSnapshot | undefined {
		const store = new TerminalTaskStore({ rootDir });
		store.refreshIndex();
		return store.getIndexed(id);
	}

	function persistSettledTask(
		store: TerminalTaskStore,
		id: string,
		ownerSessionId: string,
		createdAt: number,
		title = id,
	): TerminalTaskSnapshot {
		const directory = join(store.rootDir, `${id}-${createdAt}`);
		mkdirSync(directory, { mode: 0o700 });
		chmodSync(directory, 0o700);
		const logFile = join(directory, "output.log");
		writeFileSync(logFile, "", { mode: 0o600 });
		chmodSync(logFile, 0o600);
		const snapshot: TerminalTaskSnapshot = {
			schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
			revision: 1,
			id,
			ownerSessionId,
			command: "true",
			cwd: "/repo",
			title,
			status: "completed",
			completionPolicy: "passive",
			createdAt,
			updatedAt: createdAt,
			settledAt: createdAt,
			exitCode: 0,
			observedAt: createdAt,
			deliveryState: "suppressed",
			completionId: `completion-${id}`,
			logFile,
		};
		const metaFile = join(directory, "meta.json");
		writeFileSync(metaFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		return snapshot;
	}

	function persistRunningTask(
		store: TerminalTaskStore,
		id: string,
		ownerSessionId: string,
		createdAt: number,
	): TerminalTaskSnapshot {
		const directory = join(store.rootDir, `${id}-${createdAt}`);
		mkdirSync(directory, { mode: 0o700 });
		chmodSync(directory, 0o700);
		const logFile = join(directory, "output.log");
		writeFileSync(logFile, "", { mode: 0o600 });
		chmodSync(logFile, 0o600);
		const snapshot: TerminalTaskSnapshot = {
			schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
			revision: 1,
			id,
			ownerSessionId,
			command: "sleep 1",
			cwd: "/repo",
			title: id,
			status: "running",
			completionPolicy: "passive",
			createdAt,
			updatedAt: createdAt,
			deliveryState: "none",
			pid: 4000,
			processGroupId: 4000,
			processStartTime: "start-4000",
			logFile,
		};
		const metaFile = join(directory, "meta.json");
		writeFileSync(metaFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		return snapshot;
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
		expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots[0]).toEqual(task);
	});

	it("does not cap terminal execution to the feed presentation budget", async () => {
		const target = manager();
		for (let index = 0; index < 257; index += 1) await start(target);
		expect(target.getSnapshots().filter((task) => task.status === "running")).toHaveLength(257);
	}, 20_000);

	it("replays deeply immutable snapshot copies without exposing manager state", async () => {
		const target = manager();
		await start(target);
		let replay: readonly TerminalTaskSnapshot[] = [];
		const unsubscribe = target.subscribeChanges((snapshots) => { replay = snapshots; });
		expect(Object.isFrozen(replay[0])).toBe(true);
		// SAFETY: the frozen snapshot in this fixture always has a string title field.
		const titleHolder = replay[0] as { title: string };
		expect(() => { titleHolder.title = "mutated"; }).toThrow();
		expect(target.getSnapshots()[0]?.title).toBe("tests");
		unsubscribe();
	});

	it("builds one index and joins 1500 retained owner snapshots across owners without further metadata reads", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const owners = ["session-indexed", "session-other"];
		for (let index = 0; index < 1_500; index += 1) {
			persistSettledTask(store, `term-retained-${index}`, owners[index % owners.length]!, 1_000 + index);
		}

		const target = manager({ store });
		expect(reads).toEqual({ scans: 1, metadata: 1_500 });
		reads.scans = 0;
		reads.metadata = 0;

		const owned = target.list("session-indexed");
		expect(owned).toHaveLength(750);
		expect(owned.every((task) => task.ownerSessionId === "session-indexed")).toBe(true);
		expect(owned[0]!.id).toBe("term-retained-1498");
		expect(owned.map((task) => task.createdAt)).toEqual(Array.from({ length: 750 }, (_, position) => 2_498 - position * 2));
		expect(target.list("session-other")).toHaveLength(750);
		expect(target.list("session-unknown")).toEqual([]);
		expect(target.claimPending("session-indexed", true)).toEqual([]);
		expect(target.acknowledge("session-indexed", [])).toEqual([]);
		expect(target.getClaimRetryDelay("session-indexed")).toBeUndefined();
		expect(target.get("term-retained-1498", "session-indexed")?.id).toBe("term-retained-1498");
		expect(target.get("term-retained-1499", "session-indexed")).toBeUndefined();
		expect(target.get("term-missing", "session-indexed")).toBeUndefined();
		expect(reads).toEqual({ scans: 0, metadata: 0 });
	}, 120_000);

	it("binds the real coordinator with one full scan and one selected read per delivery step", async () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const target = manager({ store });
		expect(reads).toEqual({ scans: 1, metadata: 0 });
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		reads.scans = 0;
		reads.metadata = 0;

		const sent: Array<{ details?: { completionId?: string } }> = [];
		// SAFETY: the coordinator reads only this structural ExtensionAPI surface.
		const pi = { sendMessage: (message: { details?: { completionId?: string } }) => { sent.push(message); } } as never;
		const coordinator = new TerminalDeliveryCoordinator(pi, target);
		// SAFETY: the real manager only reads this structural ctx surface.
		const ctx = {
			cwd: "/repo",
			isIdle: () => true,
			sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
		} as never;
		coordinator.bind(ctx);
		await Promise.resolve();
		await Promise.resolve();
		coordinator.dispose();

		// Startup performed exactly one full scan (construction). Bind/flush
		// rescans nothing and reads only the selected record: once for its locked
		// claim mutation and once for the authoritative pre-send token check.
		expect(reads).toEqual({ scans: 0, metadata: 2 });
		expect(sent).toHaveLength(1);
		expect(target.get(task.id, "session-a")).toMatchObject({ deliveryState: "claimed" });
	});

	it("suppresses a duplicate follow-up when another process reclaims the claim before send", async () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		let rival: TerminalTaskManager | undefined;
		class RivalReclaimManager extends TerminalTaskManager {
			private reclaimed = false;
			public override claimPending(ownerSessionId: string, includeWake: boolean, maxWake = 1): TerminalTaskSnapshot[] {
				const claimed = super.claimPending(ownerSessionId, includeWake, maxWake);
				if (claimed.length > 0 && !this.reclaimed) {
					this.reclaimed = true;
					// A different process reclaims the expired lease between this
					// manager's claim and the coordinator's send.
					now += 31;
					rival?.claimPending(ownerSessionId, includeWake, maxWake);
				}
				return claimed;
			}
		}
		const target = manager({ store }, (options) => new RivalReclaimManager(options));
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		// The rival builds its projection only after the record is durable.
		rival = manager({ createClaimToken: () => "claim-rival" });
		reads.scans = 0;
		reads.metadata = 0;

		const sent: Array<{ details?: { completionId?: string } }> = [];
		// SAFETY: the coordinator reads only this structural ExtensionAPI surface.
		const pi = { sendMessage: (message: { details?: { completionId?: string } }) => { sent.push(message); } } as never;
		const coordinator = new TerminalDeliveryCoordinator(pi, target);
		// SAFETY: the real manager only reads this structural ctx surface.
		const ctx = {
			cwd: "/repo",
			isIdle: () => true,
			sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
		} as never;
		coordinator.bind(ctx);
		await Promise.resolve();
		await Promise.resolve();
		coordinator.dispose();

		// The pre-send authoritative read detected the rival token: no follow-up
		// was published, and every post-claim read stayed selected-only (no scans).
		expect(sent).toEqual([]);
		expect(reads.scans).toBe(0);
		// The rival's reclaim token survived; our pre-send claim token never published.
		expect(durableTask(task.id)).toMatchObject({ deliveryState: "claimed", deliveryClaimToken: "claim-rival" });
	});

	it("readIndexed is owner-isolated and never scans the store", async () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const target = manager({ store });
		const task = await start(target);
		reads.scans = 0;
		reads.metadata = 0;

		expect(target.readIndexed(task.id, "session-b")).toBeUndefined();
		expect(reads).toEqual({ scans: 0, metadata: 0 });
		expect(target.readIndexed("term-missing", "session-a")).toBeUndefined();
		expect(reads).toEqual({ scans: 0, metadata: 0 });
		expect(target.readIndexed(task.id, "session-a")).toMatchObject({ id: task.id, ownerSessionId: "session-a" });
		// A foreign or unknown id is resolved from the compact index with zero
		// metadata reads; only the matching owner's id opens its one record.
		expect(reads).toEqual({ scans: 0, metadata: 1 });
	});

	it("readIndexed re-verifies the owner from the fresh read when the compact index went stale", async () => {
		const reads = { scans: 0, metadata: 0 };
		// SAFETY: the fake models one divergence only — disk truth was rewritten
		// outside the CAS protocol so the durable record's owner moved to
		// session-b while this process's compact index (refreshed only at explicit
		// boundaries) still names session-a. The precheck passes; the read happens;
		// the fresh owner must win.
		class StaleCompactOwnerStore extends TerminalTaskStore {
			public override getIndexed(id: string): TerminalTaskSnapshot | undefined {
				const snapshot = super.getIndexed(id);
				return snapshot ? { ...snapshot, ownerSessionId: "session-b" } : undefined;
			}
		}
		const target = manager({
			store: new StaleCompactOwnerStore({
				rootDir,
				onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
			}),
		});
		const task = await start(target);
		reads.scans = 0;
		reads.metadata = 0;

		expect(target.readIndexed(task.id, "session-a")).toBeUndefined();
		// The stale compact entry admitted the precheck, so the mismatch cost
		// exactly the one authoritative read and no scan.
		expect(reads).toEqual({ scans: 0, metadata: 1 });
	});

	it("refreshes the compact candidate after a locked no-op so stale claim state stops rereading", async () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const target = manager({ store, createClaimToken: () => "claim-ours" });
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		const claimed = target.claimPending("session-a", true);
		expect(claimed).toHaveLength(1);
		const receipt = { completionId: claimed[0]!.completionId!, claimToken: "claim-ours" };

		// An external writer delivers the completion at a higher revision; this
		// manager's compact candidate still says "claimed".
		const external = new TerminalTaskStore({ rootDir });
		external.refreshIndex();
		const durable = external.refreshIndex().snapshots.find((entry) => entry.id === task.id)!;
		expect(external.transition(task.id, durable.revision, (current) => ({
			...current,
			deliveryState: "delivered",
			deliveryClaimToken: undefined,
		}))).toMatchObject({ deliveryState: "delivered" });

		// The stale compact candidate enters the mutation: the locked
		// authoritative snapshot is already delivered, so the locked update
		// no-ops and the store refreshes that record's compact entry from it.
		reads.scans = 0;
		reads.metadata = 0;
		expect(target.acknowledge("session-a", [receipt])).toEqual([]);
		expect(store.listOwnedIndexed("session-a")[0]).toMatchObject({ deliveryState: "delivered" });

		// Retry-delay and candidate selection now see delivered from the compact
		// entry: the reread/retry loop stops with zero further metadata reads.
		expect(target.getClaimRetryDelay("session-a")).toBeUndefined();
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(reads).toEqual({ scans: 0, metadata: 3 });
	}, 20_000);

	it("rereads only a selected delivery record for each mutation", async () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const target = manager({ store });
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		reads.scans = 0;
		reads.metadata = 0;

		const claimed = target.claimPending("session-a", true);
		expect(claimed).toHaveLength(1);
		expect(reads).toEqual({ scans: 0, metadata: 1 });
		reads.metadata = 0;
		expect(target.getClaimRetryDelay("session-a")).toBe(30);
		expect(reads.metadata).toBe(0);

		const receipt = [{ completionId: claimed[0]!.completionId!, claimToken: claimed[0]!.deliveryClaimToken! }];
		expect(target.acknowledge("session-a", receipt)).toHaveLength(1);
		expect(reads).toEqual({ scans: 0, metadata: 1 });
	});

	it("adopts an external higher revision only at the explicit refresh boundary", () => {
		const reads = { scans: 0, metadata: 0 };
		const indexedStore = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const initial = persistSettledTask(indexedStore, "term-external", "session-a", 1_000, "before");
		const target = manager({ store: indexedStore });
		expect(reads.scans).toBe(1);

		const external = new TerminalTaskStore({ rootDir });
		external.refreshIndex();
		external.transition(initial.id, 1, (current) => ({ ...current, title: "after", updatedAt: 2_000 }));
		expect(target.get(initial.id, "session-a")).toMatchObject({ revision: 1, title: "before" });

		target.refreshSnapshotsFromStore();
		expect(reads.scans).toBe(2);
		expect(target.get(initial.id, "session-a")).toMatchObject({ revision: 2, title: "after" });
	});

	it("stops serving retained snapshots once a successful refresh quarantines the record", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store });
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.status).toBe("completed"));

		// The durable record becomes corrupt/unreadable; the next successful
		// explicit refresh quarantines it from the compact index without deleting
		// or rewriting it.
		const metaFile = join(dirname(task.logFile), "meta.json");
		writeFileSync(metaFile, "{not json", { mode: 0o600 });
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(store.isIndexedOwner(task.id, "session-a")).toBe(false);

		// The stale retained snapshot must not answer explicit queries: get and
		// the terminal_check seam yield normal unknown semantics instead of
		// throwing on the missing indexed path downstream.
		expect(target.get(task.id, "session-a")).toBeUndefined();
		expect(target.check(task.id, "session-a")).toBeUndefined();
		// Quarantine stays logical: the corrupt record itself is untouched.
		expect(readFileSync(metaFile, "utf8")).toBe("{not json");
	});

	it("keeps retained snapshots queryable when a refresh fails", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.status).toBe("completed"));

		chmodSync(rootDir, 0o000);
		try {
			// A failed refresh preserves the last good index, so the retained
			// settled task remains queryable via the explicit query seam across
			// the transient failure.
			expect(target.refreshSnapshotsFromStore().ok).toBe(false);
			expect(target.get(task.id, "session-a")).toMatchObject({ id: task.id, status: "completed" });
		} finally {
			chmodSync(rootDir, 0o700);
		}
	});

	it("prunes quarantined ids from the retained projection on success and preserves them on failure", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store });
		const keep = await start(target);
		const drop = await start(target);
		for (const task of [keep, drop]) {
			writeFileSync(exitFile(task), "0");
			children[keep.id === task.id ? 0 : 1]?.emit("close", 0);
		}
		await vi.waitFor(() => expect(target.get(keep.id, "session-a")?.status).toBe("completed"));
		await vi.waitFor(() => expect(target.get(drop.id, "session-a")?.status).toBe("completed"));

		// A failed refresh preserves the whole last-good projection.
		chmodSync(rootDir, 0o000);
		try {
			expect(target.refreshSnapshotsFromStore().ok).toBe(false);
			expect(target.getSnapshots().map((task) => task.id).sort()).toEqual([keep.id, drop.id].sort());
			expect(target.list("session-a").map((task) => task.id).sort()).toEqual([keep.id, drop.id].sort());
			expect(target.get(drop.id, "session-a")).toBeDefined();
		} finally {
			chmodSync(rootDir, 0o700);
		}

		// The durable record becomes corrupt/unreadable; the next successful
		// refresh quarantines it and the retained projection is replaced to match
		// exactly the refreshed index generation.
		const metaFile = join(dirname(drop.logFile), "meta.json");
		writeFileSync(metaFile, "{not json", { mode: 0o600 });
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(target.getSnapshots().map((task) => task.id)).toEqual([keep.id]);
		expect(target.list("session-a").map((task) => task.id)).toEqual([keep.id]);
		expect(target.get(drop.id, "session-a")).toBeUndefined();
		expect(target.get(keep.id, "session-a")).toMatchObject({ id: keep.id, status: "completed" });
		// Quarantine stays logical: the corrupt durable record is untouched.
		expect(readFileSync(metaFile, "utf8")).toBe("{not json");
	});

	it("routes ids quarantined after the wait began to the unknown bucket", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store });
		const task = await start(target);
		const waited = target.wait([task.id, "term-missing"], "session-a", 25);
		// Quarantine while the wait is parked: the initial known collection
		// already listed the task, so its post-await read must not assert
		// non-null — the id routes to unknownIds through the normal result shape.
		writeFileSync(join(dirname(task.logFile), "meta.json"), "{not json", { mode: 0o600 });
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		await expect(waited).resolves.toEqual({
			settled: [],
			pendingIds: [],
			unknownIds: [task.id, "term-missing"],
			timedOut: false,
		});
	});

	it("returns the normal unknown outcome when the record is quarantined during the async stop window", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store });
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		// Quarantine the record exactly inside the stop's async process window:
		// the natural-stop tree wait quarantines before settlement mutates.
		tree.operations.waitForTreeEmpty = vi.fn(async (_identity: ProcessTreeIdentity) => {
			writeFileSync(join(dirname(task.logFile), "meta.json"), "{not json", { mode: 0o600 });
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			return true;
		});
		const results = await target.stop([task.id], "session-a");
		expect(results).toEqual([
			{ id: task.id, outcome: "unknown", message: `Unknown terminal ${task.id}.` },
		]);
		// Quarantine stays logical: the corrupt durable record is untouched.
		expect(readFileSync(join(dirname(task.logFile), "meta.json"), "utf8")).toBe("{not json");
	});

	it("returns the normal unknown outcome when the record is quarantined during the TERM tree wait", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store });
		const task = await start(target);
		// No exit.code: the ordinary TERM stop path. Quarantine exactly inside the
		// TERM grace wait so the wait's success path must report the normal
		// unknown outcome instead of settleDisposedStop's failed result.
		tree.operations.waitForTreeEmpty = vi.fn(async (_identity: ProcessTreeIdentity) => {
			writeFileSync(join(dirname(task.logFile), "meta.json"), "{not json", { mode: 0o600 });
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			return true;
		});
		const results = await target.stop([task.id], "session-a");
		expect(results).toEqual([
			{ id: task.id, outcome: "unknown", message: `Unknown terminal ${task.id}.` },
		]);
		// Quarantine stays logical: the corrupt durable record is untouched.
		expect(readFileSync(join(dirname(task.logFile), "meta.json"), "utf8")).toBe("{not json");
	});

	it("preserves a healthy retained task when only its metadata read fails transiently", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const reads = { metadata: 0 };
			const faults = new Map<string, Error>();
			const store = new TerminalTaskStore({
				rootDir,
				metaReadFault: (path) => faults.get(path),
				onRead: (kind) => { if (kind === "metadata") reads.metadata += 1; },
			});
			target = manager({ store, pollIntervalMs: 10 });
			const task = await start(target);
			const metaFile = join(dirname(task.logFile), "meta.json");
			await vi.advanceTimersByTimeAsync(30);
			expect(reads.metadata).toBeGreaterThan(0);

			// Inject exactly one transient per-file read failure on the healthy
			// indexed task's metadata file.
			faults.set(metaFile, transientFault("EIO"));
			const refreshed = target.refreshSnapshotsFromStore();
			expect(refreshed.ok).toBe(true);
			// The transient read yields no fresh snapshot, but the generation must
			// not prune the record: it stays queryable, listed, and its poll timer
			// keeps reconciling it.
			expect(target.get(task.id, "session-a")).toMatchObject({ id: task.id, status: "running" });
			expect(target.list("session-a").map((entry) => entry.id)).toEqual([task.id]);
			const readsWhilePreserved = reads.metadata;
			await vi.advanceTimersByTimeAsync(30);
			expect(reads.metadata).toBeGreaterThan(readsWhilePreserved);
			faults.clear();

			// The next successful refresh recovers the record and adopts an external
			// advance made while the record was only transiently unreadable.
			const external = new TerminalTaskStore({ rootDir });
			external.refreshIndex();
			const durable = external.getIndexed(task.id)!;
			external.transition(task.id, durable.revision, (current) => ({ ...current, title: "after", updatedAt: Date.now() }));
			const recovered = target.refreshSnapshotsFromStore();
			expect(recovered.ok).toBe(true);
			expect(target.get(task.id, "session-a")).toMatchObject({ id: task.id, revision: durable.revision + 1, title: "after" });
			expect(target.list("session-a").map((entry) => entry.id)).toEqual([task.id]);
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("adopts an external same-revision owner divergence across the full projection", () => {
		const store = new TerminalTaskStore({ rootDir });
		const original = persistSettledTask(store, "term-move", "session-a", 1_000);
		const target = manager({ store });
		expect(target.list("session-a").map((task) => task.id)).toEqual(["term-move"]);

		// An external writer rewrites the record for another owner WITHOUT
		// bumping the revision: the refreshed disk truth must win at the
		// freshness boundary instead of the retained same-revision snapshot.
		const divergent = { ...original, ownerSessionId: "session-b" };
		const metaFile = join(dirname(original.logFile), "meta.json");
		writeFileSync(metaFile, `${JSON.stringify(divergent)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);

		const refreshed = target.refreshSnapshotsFromStore();
		expect(refreshed.ok).toBe(true);
		// The full projection and both owner lists follow the refreshed owner.
		expect(target.list("session-a")).toEqual([]);
		expect(target.list("session-b")).toEqual([expect.objectContaining({ id: "term-move", ownerSessionId: "session-b" })]);
		expect(target.get("term-move", "session-b")).toMatchObject({ id: "term-move", ownerSessionId: "session-b" });
		expect(target.get("term-move", "session-a")).toBeUndefined();
		expect(target.getSnapshots().every((task) => task.ownerSessionId === "session-b")).toBe(true);
	});

	it("gates refresh recovery to records that are new or durably changed", () => {
		const store = new TerminalTaskStore({ rootDir });
		// Recovering a running record schedules a reconcile; keep the harness from
		// capturing fresh tree verification so the reconcile cannot mutate the
		// record and the spy matrix below observes pure adopt/recover boundaries.
		tree.operations.captureTreeVerification = vi.fn(() => undefined);
		persistSettledTask(store, "term-recap", "session-a", 1_000, "before");
		const adopted: string[] = [];
		const recovered: string[] = [];
		const target = manager({
			store,
			onRefreshAdopt: (id) => adopted.push(id),
			onRefreshRecover: (id) => recovered.push(id),
		});
		// The constructor adopted term-recap already, so the first explicit refresh
		// finds it unchanged: adopted, but not recovered again.
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toEqual(["term-recap"]);
		expect(recovered).toEqual([]);

		// A record created externally after construction is new to the projection:
		// adopted AND recovered exactly once.
		persistSettledTask(store, "term-fresh", "session-a", 2_000, "fresh");
		adopted.length = 0;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect([...adopted].sort()).toEqual(["term-fresh", "term-recap"]);
		expect(recovered).toEqual(["term-fresh"]);

		// Unchanged record: still adopted every refresh, but never recovered again
		// — no repeated log cap, no reschedule.
		adopted.length = 0;
		recovered.length = 0;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect([...adopted].sort()).toEqual(["term-fresh", "term-recap"]);
		expect(recovered).toEqual([]);

		// Same-revision, same-owner content rewrite: adopted with no recovery side
		// effects — revision plus owner are sufficient durable identity, so no
		// deep content compare runs and nothing is capped or rescheduled.
		const fresh = store.getIndexed("term-fresh")!;
		const metaFile = join(dirname(fresh.logFile), "meta.json");
		writeFileSync(metaFile, `${JSON.stringify({ ...fresh, title: "same-revision", updatedAt: 2_500 })}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		adopted.length = 0;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual([]);
		expect(target.get("term-fresh", "session-a")).toMatchObject({ revision: 1, title: "same-revision" });

		// Revision advance: recovery runs again, exactly once.
		adopted.length = 0;
		recovered.length = 0;
		const external = new TerminalTaskStore({ rootDir });
		external.refreshIndex();
		external.transition("term-fresh", 1, (current) => ({ ...current, title: "bumped", updatedAt: 3_000 }));
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual(["term-fresh"]);

		// Same-revision owner divergence: recovery still triggers for the new owner.
		adopted.length = 0;
		recovered.length = 0;
		writeFileSync(metaFile, `${JSON.stringify({ ...fresh, revision: 2, ownerSessionId: "session-b", title: "bumped", updatedAt: 3_000 })}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual(["term-fresh"]);
		expect(target.list("session-a").map((task) => task.id)).not.toContain("term-fresh");
		expect(target.list("session-b")).toEqual([expect.objectContaining({ id: "term-fresh", ownerSessionId: "session-b" })]);

		// Same-revision, same-owner status flip (settled retained vs running on
		// disk): lifecycle status is recovery-relevant, so recovery must run even
		// though revision and owner are unchanged — the rewrite must not leave an
		// active terminal unarmed behind a stale settled projection.
		adopted.length = 0;
		recovered.length = 0;
		writeFileSync(metaFile, `${JSON.stringify({
			...fresh,
			revision: 2,
			ownerSessionId: "session-b",
			title: "bumped",
			status: "running",
			pid: 5_100,
			processGroupId: 5_100,
			processStartTime: "start-5100",
			deliveryState: "none",
			settledAt: undefined,
			exitCode: undefined,
			observedAt: undefined,
			completionId: undefined,
			updatedAt: 3_500,
		})}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual(["term-fresh"]);
		expect(target.get("term-fresh", "session-b")).toMatchObject({ revision: 2, status: "running", pid: 5_100 });

		// Same-revision, same-owner process-identity rewrite at an unchanged
		// status: process identity is recovery-relevant too, so recovery still runs.
		adopted.length = 0;
		recovered.length = 0;
		writeFileSync(metaFile, `${JSON.stringify({
			...fresh,
			revision: 2,
			ownerSessionId: "session-b",
			title: "bumped",
			status: "running",
			pid: 5_200,
			processGroupId: 5_200,
			processStartTime: "start-5200",
			deliveryState: "none",
			settledAt: undefined,
			exitCode: undefined,
			observedAt: undefined,
			completionId: undefined,
			updatedAt: 4_000,
		})}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual(["term-fresh"]);
		expect(target.get("term-fresh", "session-b")).toMatchObject({ revision: 2, status: "running", pid: 5_200, processStartTime: "start-5200" });

		// A following refresh with no durable change still skips recovery.
		adopted.length = 0;
		recovered.length = 0;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(adopted).toContain("term-fresh");
		expect(recovered).toEqual([]);
	});

	it("stops polling a genuinely quarantined id after a successful refresh prune", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const reads = { metadata: 0 };
			const store = new TerminalTaskStore({ rootDir, onRead: (kind) => { if (kind === "metadata") reads.metadata += 1; } });
			target = manager({ store, pollIntervalMs: 10 });
			const task = await start(target);
			const metaFile = join(dirname(task.logFile), "meta.json");
			await vi.advanceTimersByTimeAsync(30);
			expect(reads.metadata).toBeGreaterThan(0);
			// Exactly one pending timer: the task's poll interval.
			expect(vi.getTimerCount()).toBe(1);

			// The durable record becomes corrupt; the next successful refresh
			// quarantines it, prunes the retained projection, and clears its poll
			// timer so no further reconciles are scheduled for the id.
			writeFileSync(metaFile, "{not json", { mode: 0o600 });
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(target.get(task.id, "session-a")).toBeUndefined();
			// The quarantined id's timer is gone — not merely silent.
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(30);
			const drained = reads.metadata;
			await vi.advanceTimersByTimeAsync(50);
			expect(reads.metadata).toBe(drained);
			// Quarantine stays logical: the corrupt durable record is untouched.
			expect(readFileSync(metaFile, "utf8")).toBe("{not json");
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("reports a failed refresh with retained snapshots once detached", () => {
		const store = new TerminalTaskStore({ rootDir });
		persistSettledTask(store, "term-a", "session-a", 1_000);
		const target = manager({ store });
		target.detach();
		// A detached manager performs no scan, so it cannot prove freshness or
		// authorize consuming writer-death proof: report failure while still
		// handing back the retained snapshots.
		const result = target.refreshSnapshotsFromStore();
		expect(result.ok).toBe(false);
		expect(result.snapshots.map((task) => task.id)).toEqual(["term-a"]);
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
			const current = store.refreshIndex().snapshots.find((entry) => entry.id === task.id)!;
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

	it("resolves a parked wait promptly when a concurrent refresh quarantines a known id", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			target = manager({ pollIntervalMs: 60_000 });
			const task = await start(target);
			const waiting = target.wait([task.id], "session-a", 60_000);
			// Parked: the wait timer plus the poll interval are pending.
			expect(vi.getTimerCount()).toBe(2);

			// A corrupt record quarantined by a successful refresh prunes the id
			// mid-wait; the prune notification must wake the waiter instead of
			// leaving it parked for the full timeout.
			const metaFile = join(dirname(task.logFile), "meta.json");
			writeFileSync(metaFile, "{not json", { mode: 0o600 });
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(target.get(task.id, "session-a")).toBeUndefined();

			// Resolution must come from the prune notification: advancing well short
			// of the 60s wait timeout must not be what resolves it.
			const result = await Promise.race([
				waiting,
				vi.advanceTimersByTimeAsync(1_000).then(() => "timer-elapsed" as const),
			]);
			expect(result).not.toBe("timer-elapsed");
			expect(result).toEqual({ settled: [], pendingIds: [], unknownIds: [task.id], timedOut: false });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("resolves a parked wait when a refresh adopts an external settlement", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			target = manager({ pollIntervalMs: 60_000 });
			const task = await start(target);
			const waiting = target.wait([task.id], "session-a", 60_000);
			// Parked: the wait timer plus the poll interval are pending.
			expect(vi.getTimerCount()).toBe(2);

			// An external writer settles the running record on disk at the same
			// revision: the refresh adopts the flipped lifecycle status (recovery-
			// relevant identity) and must notify change listeners so the parked
			// waiter resolves now instead of waiting out the clock.
			const external = new TerminalTaskStore({ rootDir });
			external.refreshIndex();
			const durable = external.getIndexed(task.id)!;
			const metaFile = join(dirname(task.logFile), "meta.json");
			writeFileSync(metaFile, `${JSON.stringify({
				...durable,
				status: "completed",
				updatedAt: 2_000,
				settledAt: 2_000,
				exitCode: 0,
				deliveryState: "pending",
				completionId: "completion-external",
			})}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);

			// Resolution must come from the refresh adoption notification: advancing
			// well short of the 60s wait timeout must not be what resolves it.
			const result = await Promise.race([
				waiting,
				vi.advanceTimersByTimeAsync(1_000).then(() => "timer-elapsed" as const),
			]);
			expect(result).not.toBe("timer-elapsed");
			expect(result).toEqual({
				settled: [expect.objectContaining({ task: expect.objectContaining({ id: task.id, status: "completed" }) })],
				pendingIds: [],
				unknownIds: [],
				timedOut: false,
			});
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("fans refresh changes out once through the final projection", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			target = manager({ store, pollIntervalMs: 60_000 });
			const first = await start(target);
			const second = await start(target);
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const unsubscribe = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const baseline = publications.length;

			// Two quarantined ids: the post-loop fan-out must be a single
			// publication of the final projection — no intermediate projection that
			// still contains a not-yet-pruned quarantined id.
			writeFileSync(join(dirname(first.logFile), "meta.json"), "{not json", { mode: 0o600 });
			writeFileSync(join(dirname(second.logFile), "meta.json"), "{not json", { mode: 0o600 });
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(publications.length - baseline).toBe(1);
			expect(publications.at(-1)).toEqual([]);
			expect(target.getSnapshots()).toEqual([]);
			unsubscribe();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("keeps the refresh batch closed until adopt and prune complete", async () => {
		const reads = { scans: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { if (kind === "full-scan") reads.scans += 1; },
		});
		const drop = persistSettledTask(store, "term-drop", "session-a", 1_100);
		// A running record adopted at construction: its recovery reconcile runs
		// synchronously and persists a first tree verification.
		persistRunningTask(store, "term-active", "session-a", 1_000);
		const target = manager({ store, pollIntervalMs: 60_000 });
		// Settle the construction reconcile's promise bookkeeping so the refresh's
		// own recover can schedule a fresh synchronous reconcile.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		// Advance past the tree-verification refresh window and make the next
		// capture disagree with the persisted anchors, so the refresh's recover
		// reaches reconcile's verification mutation synchronously mid-batch, and
		// bump the record's revision so the recovery gate fires at all.
		now += 10_000;
		tree.operations.captureTreeVerification = vi.fn((identity: ProcessTreeIdentity) => ({
			members: [{ pid: identity.pid + 7, processStartTime: `mutated-${identity.pid}` }],
		}));
		const external = new TerminalTaskStore({ rootDir });
		external.refreshIndex();
		external.transition("term-active", 2, (current) => ({ ...current, title: "bumped", updatedAt: 3_000 }));
		// The same refresh quarantines term-drop.
		writeFileSync(join(dirname(drop.logFile), "meta.json"), "{not json", { mode: 0o600 });

		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const changes: TerminalTaskSnapshot[] = [];
		let refreshRunning = false;
		const unsubscribeProjection = target.subscribeChanges((snapshots) => {
			publications.push(snapshots);
			// Model the bridge guard: a listener that observes an intermediate
			// generation — a quarantined id not yet pruned — rescans the store.
			if (refreshRunning && snapshots.some((task) => task.id === drop.id)) target.refreshSnapshotsFromStore();
		});
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
		const scansBefore = reads.scans;
		const publicationsBefore = publications.length;

		refreshRunning = true;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		refreshRunning = false;

		// The whole refresh is one notification batch: exactly one scan (no
		// listener-triggered re-entrant refresh), exactly one final projection
		// publication that already excludes the quarantined id, and exactly one
		// final per-task payload per id at the latest revision — the mid-refresh
		// verification mutation never publishes, so a fresh-then-stale v2→v1
		// per-task sequence cannot be observed.
		expect(reads.scans - scansBefore).toBe(1);
		expect(publications.length - publicationsBefore).toBe(1);
		expect(publications.at(-1)!.map((task) => task.id)).toEqual(["term-active"]);
		expect(changes.filter((task) => task.id === "term-active").map((task) => task.revision)).toEqual([4]);
		expect(changes.filter((task) => task.id === drop.id)).toHaveLength(1);
		expect(target.get("term-active", "session-a")).toMatchObject({ id: "term-active", revision: 4, title: "bumped" });
		expect(target.get(drop.id, "session-a")).toBeUndefined();
		unsubscribeProjection();
		unsubscribeTasks();
	});

	it("wakes delivery when a refresh discovers a new settled record", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store, pollIntervalMs: 60_000 });
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const changes: TerminalTaskSnapshot[] = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
		const baseline = publications.length;

		// The delivery coordinator's only wakeup for externally discovered
		// completions is the manager's per-task notification.
		const sendMessage = vi.fn();
		const pi = { sendMessage };
		const ctx = {
			sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
			isIdle: () => true,
		};
		// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
		const coordinator = new TerminalDeliveryCoordinator(pi as never, target);
		// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
		coordinator.bind(ctx as never);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(sendMessage).not.toHaveBeenCalled();

		// A completed terminal with a pending completion appears on disk — written
		// by the previous writer before it died. The refresh must include the new
		// record in its batched notification so the coordinator claims and sends it.
		// A pending delivery carries no observation timestamps (store schema).
		const seeded = persistSettledTask(store, "term-fresh", "session-a", 1_500, "fresh");
		const pending = {
			...seeded,
			deliveryState: "pending" as const,
			completionId: "completion-discovered",
			observedAt: undefined,
			consumedAt: undefined,
		};
		const metaFile = join(dirname(seeded.logFile), "meta.json");
		writeFileSync(metaFile, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);

		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(changes.map((task) => task.id)).toEqual(["term-fresh"]);
		expect(changes[0]).toMatchObject({ id: "term-fresh", status: "completed", deliveryState: "pending" });
		expect(publications.length - baseline).toBe(1);
		expect(publications.at(-1)!.map((task) => task.id)).toEqual(["term-fresh"]);

		// The per-task notification flushes the coordinator: it claims the pending
		// completion and sends the terminal-result message.
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "terminal-result" });
		coordinator.dispose();
		unsubscribeProjection();
		unsubscribeTasks();
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

	it("prefers a concurrent natural exit marker over cancellation after stop disposition", async () => {
		const target = manager();
		const task = await start(target);
		tree.operations.waitForTreeEmpty = vi.fn(async (identity) => {
			writeFileSync(exitFile(task), "0");
			tree.empty.set(identity.processGroupId, true);
			return true;
		});

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({
			outcome: "already-settled",
			task: { status: "completed", exitCode: 0 },
		});
		expect(tree.calls).not.toContain(`signal:${task.processGroupId}:SIGKILL`);
	});

	it("reverifies descendant anchors and forces a Windows-style soft taskkill failure after leader exit", async () => {
		let leaderGone = false;
		tree.operations.identityMatches = vi.fn(() => leaderGone ? "unknown" : "same");
		tree.operations.verificationMatches = vi.fn((): "same" => "same");
		const target = manager();
		const task = await start(target);
		vi.mocked(tree.operations.signalTree).mockImplementation(async (identity, signal) => {
			tree.calls.push(`signal:${identity.processGroupId}:${signal}`);
			if (signal === "SIGTERM") {
				leaderGone = true;
				return { ok: false, gone: false, forceRequired: true, error: "soft taskkill partially failed" };
			}
			tree.empty.set(identity.processGroupId, true);
			return { ok: true, gone: true };
		});

		const result = await target.stop([task.id], "session-a");

		expect(result[0]?.outcome).toBe("cancelled");
		expect(tree.calls).toEqual([
			`signal:${task.processGroupId}:SIGTERM`,
			`signal:${task.processGroupId}:SIGKILL`,
		]);
		expect(tree.operations.verificationMatches).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			expect.objectContaining({ members: expect.any(Array) }),
		);
	});

	it("keeps a partially signalled tree stopping when forced escalation fails", async () => {
		const target = manager();
		const task = await start(target);
		vi.mocked(tree.operations.signalTree).mockImplementation(async (_identity, signal) => signal === "SIGTERM"
			? { ok: true, gone: false }
			: { ok: false, gone: false, error: "forced escalation failed" });

		const result = await target.stop([task.id], "session-a");
		target.detach();

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "stopping" } });
		expect(durableTask(task.id)).toMatchObject({
			status: "stopping",
			processTreeVerification: { members: expect.any(Array) },
		});
	});

	it("reconciles a retained-wrapper natural exit before stop can misreport cancellation", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "7");

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({ outcome: "already-settled", task: { status: "failed", exitCode: 7 } });
		expect(tree.operations.signalTree).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			"SIGKILL",
			expect.objectContaining({ members: expect.any(Array) }),
		);
		expect(tree.calls.some((call) => call.endsWith(":SIGTERM"))).toBe(false);
	});

	it("reconciles durable natural exit before an empty-tree stop can misreport cancellation", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "7");
		tree.empty.set(task.processGroupId!, true);

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({ outcome: "already-settled", task: { status: "failed", exitCode: 7 } });
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("records an already-empty running tree without exit evidence as lost, not cancelled", async () => {
		const target = manager();
		const task = await start(target);
		tree.empty.set(task.processGroupId!, true);

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "lost", consumedAt: expect.any(Number) } });
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("marks a mismatched stop target lost and refuses every signal", async () => {
		const target = manager();
		const task = await target.start({ ownerSessionId: "session-a", command: "sleep 1", cwd: "/repo", title: "wake mismatch", completionPolicy: "wake" });
		tree.operations.identityMatches = vi.fn((): "different" => "different");
		// A weak same-second member anchor must never override the definitive
		// random-token leader fingerprint mismatch.
		tree.operations.verificationMatches = vi.fn((): "same" => "same");

		const result = await target.stop([task.id], "session-a");

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "lost", deliveryState: "suppressed", observedAt: expect.any(Number) } });
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("uses and persists retained descendant anchors when the wrapper leader has exited", async () => {
		const target = manager();
		const task = await start(target);
		const retained = vi.mocked(tree.operations.captureTreeVerification!).mock.results.at(-1)?.value;
		tree.operations.identityMatches = vi.fn((): "unknown" => "unknown");
		tree.operations.verificationMatches = vi.fn((): "same" => "same");
		tree.operations.captureTreeVerification = vi.fn(() => undefined);

		const result = await target.stop([task.id], "session-a");

		expect(result[0]?.outcome).toBe("cancelled");
		expect(retained).toEqual(expect.objectContaining({ members: expect.any(Array) }));
		expect(tree.operations.signalTree).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			"SIGKILL",
			retained,
		);
		expect(durableTask(task.id)?.processTreeVerification).toEqual(retained);
	});

	it("stopOwned uses the same identity refusal and never signals an unrelated group", async () => {
		const target = manager();
		await start(target);
		tree.operations.identityMatches = vi.fn((): "unknown" => "unknown");
		tree.operations.verificationMatches = vi.fn((): "unknown" => "unknown");

		const result = await target.stopOwned("session-a");

		expect(result[0]).toMatchObject({ outcome: "failed", task: { status: "running" } });
		expect(tree.operations.signalTree).not.toHaveBeenCalled();
	});

	it("filters every boundary by owner and keeps list side-effect free", async () => {
		const target = manager();
		const own = await start(target, "session-a");
		await start(target, "session-b");
		const before = new TerminalTaskStore({ rootDir }).refreshIndex().snapshots.find((task) => task.id === own.id)!;

		expect(target.list("session-a").map((task) => task.id)).toEqual([own.id]);
		expect(target.check(own.id, "session-b")).toBeUndefined();
		expect((await target.stop([own.id], "session-b"))[0]?.outcome).toBe("unknown");
		const after = new TerminalTaskStore({ rootDir }).refreshIndex().snapshots.find((task) => task.id === own.id)!;
		expect(after).toEqual(before);
	});

	it("does not steal a concurrent starting lease and marks it lost only after expiry", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const directory = join(store.rootDir, "term-starting-1000");
		mkdirSync(directory, { mode: 0o700 });
		chmodSync(directory, 0o700);
		const logFile = join(directory, "output.log");
		writeFileSync(logFile, "", { mode: 0o600 });
		chmodSync(logFile, 0o600);
		const starting: TerminalTaskSnapshot = {
			schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
			revision: 1,
			id: "term-starting",
			ownerSessionId: "session-a",
			command: "sleep 1",
			cwd: "/repo",
			title: "starting",
			status: "starting",
			completionPolicy: "passive",
			createdAt: 1_000,
			updatedAt: 1_000,
			deliveryState: "none",
			logFile,
		};
		store.create(starting, join(directory, "meta.json"));

		const recovered = manager({ startingRecoveryGraceMs: 20 });
		expect(recovered.get(starting.id, "session-a")?.status).toBe("starting");
		now += 21;
		await vi.waitFor(() => expect(recovered.get(starting.id, "session-a")?.status).toBe("lost"));
	});

	it("persists changed running member anchors for replacement-manager recovery", async () => {
		const target = manager();
		const task = await start(target);

		await vi.waitFor(() => expect(durableTask(task.id)?.processTreeVerification).toEqual({
			members: [{ pid: task.pid! + 1, processStartTime: `child-${task.pid! + 1}` }],
		}));
		const captures = vi.mocked(tree.operations.captureTreeVerification!).mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(tree.operations.captureTreeVerification).toHaveBeenCalledTimes(captures);
	});

	it("recovers a running task after manager restart and settles from durable evidence", async () => {
		const firstManager = manager();
		const task = await start(firstManager);
		firstManager.detach();
		writeFileSync(exitFile(task), "0");

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("completed"));
		expect(recovered.get(task.id, "session-a")).toMatchObject({ completionId: expect.any(String), deliveryState: "pending" });
	});

	it("recovers Windows-style natural completion from exit evidence plus absent persisted anchors", async () => {
		const first = manager();
		const task = await start(first);
		const verification = { members: [{ pid: task.pid!, processStartTime: task.processStartTime! }] };
		const store = new TerminalTaskStore({ rootDir });
		store.refreshIndex();
		const current = store.getIndexed(task.id)!;
		store.transition(task.id, current.revision, (entry) => ({
			...entry,
			updatedAt: 2_000,
			processTreeVerification: verification,
		}));
		writeFileSync(exitFile(task), "7");
		first.detach();
		const recoveredOperations: ProcessTreeOperations = {
			...tree.operations,
			identityMatches: vi.fn((): "different" => "different"),
			isTreeEmpty: vi.fn((_identity, anchors) => anchors === verification || anchors?.members[0]?.pid === task.pid),
			signalTree: vi.fn(async () => ({ ok: false, gone: false })),
		};
		const recovered = manager({ processTree: recoveredOperations });

		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("failed"));
		expect(recovered.get(task.id, "session-a")).toMatchObject({ exitCode: 7, completionId: expect.any(String) });
		expect(recoveredOperations.isTreeEmpty).toHaveBeenCalledWith(
			expect.objectContaining({ pid: task.pid }),
			expect.objectContaining({ members: expect.any(Array) }),
		);
		expect(recoveredOperations.signalTree).not.toHaveBeenCalled();
	});

	it("recovers persisted stopping by resuming safe escalation for a live tree", async () => {
		const first = manager();
		const task = await start(first);
		const store = new TerminalTaskStore({ rootDir });
		const current = store.refreshIndex().snapshots.find((entry) => entry.id === task.id)!;
		store.transition(task.id, current.revision, (entry) => ({ ...entry, status: "stopping", updatedAt: 2_000 }));
		first.detach();

		const recovered = manager();
		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("cancelled"));
		expect(tree.operations.signalTree).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			"SIGTERM",
			expect.objectContaining({ members: expect.any(Array) }),
		);
		expect(tree.operations.signalTree).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			"SIGKILL",
			expect.objectContaining({ members: expect.any(Array) }),
		);
	});

	it("persists descendant anchors before TERM and recovers KILL after a manager restart", async () => {
		let firstTermSent = false;
		const verification = { members: [{ pid: 4100, processStartTime: "child-4100" }] };
		const firstOperations: ProcessTreeOperations = {
			...tree.operations,
			captureTreeVerification: vi.fn(() => verification),
			signalTree: vi.fn(async (_identity, signal) => {
				if (signal === "SIGTERM") firstTermSent = true;
				return { ok: true, gone: false };
			}),
			waitForTreeEmpty: vi.fn(() => new Promise<boolean>(() => {})),
		};
		const first = manager({ processTree: firstOperations });
		const task = await start(first);
		void first.stop([task.id], "session-a");
		await vi.waitFor(() => expect(firstTermSent).toBe(true));
		const durableStopping = durableTask(task.id)!;
		expect(durableStopping).toMatchObject({ status: "stopping", processTreeVerification: verification });
		first.detach();

		let empty = false;
		const recoveredOperations: ProcessTreeOperations = {
			...tree.operations,
			identityMatches: vi.fn((): "unknown" => "unknown"),
			verificationMatches: vi.fn((): "same" => "same"),
			captureTreeVerification: vi.fn(() => undefined),
			isTreeEmpty: vi.fn(() => empty),
			signalTree: vi.fn(async (_identity, signal) => {
				if (signal === "SIGKILL") empty = true;
				return { ok: true, gone: signal === "SIGKILL" };
			}),
			waitForTreeEmpty: vi.fn(async () => false),
		};
		const recovered = manager({ processTree: recoveredOperations });

		await vi.waitFor(() => expect(recovered.get(task.id, "session-a")?.status).toBe("cancelled"));
		expect(recoveredOperations.verificationMatches).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			verification,
		);
		expect(recoveredOperations.signalTree).toHaveBeenCalledWith(
			expect.objectContaining({ processGroupId: task.processGroupId }),
			"SIGKILL",
			verification,
		);
	});

	it("recovers persisted stopping as cancelled without signalling when the tree is empty", async () => {
		const first = manager();
		const task = await start(first);
		const store = new TerminalTaskStore({ rootDir });
		const current = store.refreshIndex().snapshots.find((entry) => entry.id === task.id)!;
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
		const current = store.refreshIndex().snapshots.find((entry) => entry.id === task.id)!;
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
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));

		const claimed = target.claimPending("session-a", true);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.deliveryState).toBe("claimed");
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(claimed[0]?.deliveryClaimToken).toEqual(expect.any(String));
		expect(target.acknowledge("session-a", [{ completionId: claimed[0]!.completionId!, claimToken: "wrong" }])).toEqual([]);
		const receipt = [{ completionId: claimed[0]!.completionId!, claimToken: claimed[0]!.deliveryClaimToken! }];
		expect(target.acknowledge("session-a", receipt)[0]?.deliveryState).toBe("delivered");
		expect(target.acknowledge("session-a", receipt)).toEqual([]);
	});

	it("decides claim and acknowledgement eligibility on the locked durable snapshot", async () => {
		const target = manager();
		const task = await start(target);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(target.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		const pending = target.get(task.id, "session-a")!;
		const metaPath = join(dirname(task.logFile), "meta.json");

		const rewriteAtSameRevision = (overrides: Partial<TerminalTaskSnapshot>): void => {
			// SAFETY: meta.json is this store's documented JSON record; the rewrite models a rival writer that
			// committed different content at the SAME revision, which the revision CAS alone would accept.
			const current = JSON.parse(readFileSync(metaPath, "utf8")) as TerminalTaskSnapshot;
			writeFileSync(metaPath, `${JSON.stringify({ ...current, ...overrides })}\n`, { mode: 0o600 });
		};

		// A rival claim committed at the same revision must not be reclaimed by a
		// decision made against the stale retained projection.
		rewriteAtSameRevision({ deliveryState: "claimed", deliveryClaimToken: "claim-rival", updatedAt: pending.updatedAt + 1 });
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(durableTask(task.id)).toMatchObject({ deliveryState: "claimed", deliveryClaimToken: "claim-rival", revision: pending.revision });
		// The no-op decision adopted the authoritative snapshot into retained state.
		expect(target.get(task.id, "session-a")).toMatchObject({ deliveryClaimToken: "claim-rival" });

		// Once the rival lease expires this manager may claim; a rival rewrite at
		// the claimed revision must then also suppress our duplicate acknowledgement.
		now += 31;
		const ours = target.claimPending("session-a", true)[0]!;
		expect(ours.deliveryState).toBe("claimed");
		rewriteAtSameRevision({ deliveryClaimToken: "claim-rival-2", updatedAt: ours.updatedAt });
		expect(target.acknowledge("session-a", [{ completionId: ours.completionId!, claimToken: ours.deliveryClaimToken! }])).toEqual([]);
		expect(durableTask(task.id)).toMatchObject({ deliveryState: "claimed", deliveryClaimToken: "claim-rival-2", revision: ours.revision });
	});

	it("rejects a stalled claimant after a concurrent lease reclaim changes the token", async () => {
		const first = manager();
		const task = await start(first);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(first.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		const stale = first.claimPending("session-a", true)[0]!;
		now += 31;
		const second = manager();
		const reclaimed = second.claimPending("session-a", true)[0]!;

		expect(reclaimed.deliveryClaimToken).not.toBe(stale.deliveryClaimToken);
		expect(first.acknowledge("session-a", [{
			completionId: stale.completionId!,
			claimToken: stale.deliveryClaimToken!,
		}])).toEqual([]);
		expect(second.acknowledge("session-a", [{
			completionId: reclaimed.completionId!,
			claimToken: reclaimed.deliveryClaimToken!,
		}])[0]).toMatchObject({ deliveryState: "delivered" });
	});

	it("allows only one cross-manager notification claim and preserves the winner", async () => {
		const first = manager();
		const task = await start(first);
		writeFileSync(exitFile(task), "0");
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(first.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		const second = manager();

		const claims = [first.claimPending("session-a", true), second.claimPending("session-a", true)];
		expect(claims.map((entries) => entries.length).sort()).toEqual([0, 1]);
		expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots[0]?.deliveryState).toBe("claimed");
	});

	it("settles safely with competing recovery pollers and no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (cause: unknown): void => { unhandled.push(cause); };
		process.on("unhandledRejection", onUnhandled);
		try {
			const first = manager();
			const task = await start(first);
			const second = manager();
			writeFileSync(exitFile(task), "0");
			children[0]?.emit("close", 0);
			await vi.waitFor(() => expect(second.get(task.id, "session-a")?.status).toBe("completed"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
			expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots[0]).toMatchObject({
				status: "completed",
				revision: 4,
				processTreeVerification: { members: expect.any(Array) },
			});
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
			for (const name of ["output.log", "exit.code", "command.sh", "run.sh", "launch.ready", "meta.json"]) {
				expect(lstatSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
			}
			const runScript = readFileSync(join(directory, "run.sh"), "utf8");
			expect(runScript).toContain("launch gate timed out");
			expect(runScript).toContain("bounded-terminal-runner.mjs");
			expect(readFileSync(join(directory, "command.sh"), "utf8")).toContain("set -o pipefail");
			const outside = join(rootDir, "outside.log");
			writeFileSync(outside, "outside", { mode: 0o600 });
			chmodSync(outside, 0o600);
			expect(target.getOutput({ logFile: outside })).toBe("");
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
		children[0]?.emit("close", 0);
		await vi.waitFor(() => expect(first.get(task.id, "session-a")?.deliveryState).toBe("pending"));
		first.claimPending("session-a", true);
		expect(first.getClaimRetryDelay("session-a")).toBe(30);
		first.detach();
		now += 31;

		const recovered = manager();
		const retried = recovered.claimPending("session-a", true)[0]!;
		expect(retried).toMatchObject({ id: task.id, deliveryState: "claimed" });
		expect(recovered.acknowledge("session-a", [{
			completionId: retried.completionId!,
			claimToken: retried.deliveryClaimToken!,
		}])[0]).toMatchObject({ deliveryState: "delivered" });
	});
});
