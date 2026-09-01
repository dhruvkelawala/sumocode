import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProcessTreeIdentity, ProcessTreeOperations } from "./process-tree.js";
import { TerminalTaskManager } from "./task-manager.js";
import { TerminalTaskStore, type TerminalTaskIndexRefreshResult, type TerminalTaskStoreDiagnostic } from "./task-store.js";
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

	it("seeds the projection lazily after a failed constructor scan and resumes the zero-scan guarantee", async () => {
		const reads = { scans: 0, metadata: 0 };
		// Only the constructor's startup scan and the first lazy retry fail; every
		// later scan is healthy. A store double keeps the injection deterministic
		// (a chmod-based root fault cannot survive the harness's default-store
		// construction, which re-chmods the root before the manager scans).
		class FlakyConstructorScanStore extends TerminalTaskStore {
			public attempts = 0;
			public remainingFailures = 2;
			public override refreshIndex(): TerminalTaskIndexRefreshResult {
				this.attempts += 1;
				if (this.remainingFailures > 0) {
					this.remainingFailures -= 1;
					return { ok: false, complete: false, snapshots: [] };
				}
				return super.refreshIndex();
			}
		}
		const store = new FlakyConstructorScanStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		persistSettledTask(store, "term-lazy", "session-a", 1_000);
		const diagnostics: Array<{ kind: string }> = [];
		const target = manager({ store, onDiagnostic: (entry) => diagnostics.push(entry) });
		// The constructor's one startup scan fails: the manager must not
		// permanently seed an empty generation, and the failure is diagnosed once.
		expect(store.attempts).toBe(1);
		expect(reads.scans).toBe(0);
		expect(diagnostics).toEqual([expect.objectContaining({ kind: "manager" })]);

		const changes: TerminalTaskSnapshot[] = [];
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

		// Queries answer empty while uninitialized, but every entry point retries
		// the scan lazily — the first entry pays one attempt.
		expect(target.get("term-lazy", "session-a")).toBeUndefined();
		expect(store.attempts).toBe(2);
		expect(reads.scans).toBe(0);
		// The failure stays deduped: no second manager diagnostic.
		expect(diagnostics).toHaveLength(1);

		// Further entries at the same clock reading coalesce into the backoff: one
		// attempt per entry at most, never per id, and no retry storm.
		expect(target.list("session-a")).toEqual([]);
		expect(target.get("term-lazy", "session-a")).toBeUndefined();
		await expect(target.wait(["term-lazy", "term-other"], "session-a", 0)).resolves.toMatchObject({
			settled: [],
			pendingIds: [],
			unknownIds: ["term-lazy", "term-other"],
		});
		expect(store.attempts).toBe(2);

		// Fault cleared: the next entry's single retry seeds the generation exactly
		// like a successful refresh — adoption, recovery, one per-task change, and
		// exactly one projection publication, with no re-diagnosis.
		now += 1_000;
		const changesBefore = changes.length;
		const publicationsBefore = publications.length;
		expect(target.get("term-lazy", "session-a")).toMatchObject({ id: "term-lazy", status: "completed" });
		expect(store.attempts).toBe(3);
		expect(reads.scans).toBe(1);
		expect(diagnostics).toHaveLength(1);
		expect(changes.slice(changesBefore)).toEqual([expect.objectContaining({ id: "term-lazy", status: "completed" })]);
		expect(publications.length - publicationsBefore).toBe(1);
		expect(target.list("session-a").map((task) => task.id)).toEqual(["term-lazy"]);

		// The zero-scan query guarantee resumes: even well past the backoff
		// window, initialized managers never rescan on query/mutation entries.
		now += 60_000;
		expect(target.list("session-a")).toHaveLength(1);
		expect(target.get("term-lazy", "session-a")).toBeDefined();
		expect(target.check("term-lazy", "session-a")?.task).toMatchObject({ id: "term-lazy" });
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(store.attempts).toBe(3);
		expect(reads.scans).toBe(1);

		unsubscribeProjection();
		unsubscribeTasks();
	});

	it("keeps init retries armed after an incomplete seeding scan until a complete scan lands and delivery fires", () => {
		const reads = { scans: 0, metadata: 0 };
		const diagnostics: Array<TerminalTaskStoreDiagnostic | { kind: "manager"; message: string }> = [];
		const faults = new Map<string, Error>();
		const store = new TerminalTaskStore({
			rootDir,
			onDiagnostic: (entry) => diagnostics.push(entry),
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
			metaReadFault: (path) => faults.get(path),
		});
		// Both records are durable before construction and unknown to the empty
		// prior index. term-known reads cleanly and seeds the indexed subset;
		// term-late's transient read skips it unindexed — a settled pending
		// completion that must not stay invisible for the manager lifetime.
		persistSettledTask(store, "term-known", "session-a", 1_000);
		const seeded = persistSettledTask(store, "term-late", "session-a", 2_000, "late");
		const pending = { ...seeded, deliveryState: "pending" as const, observedAt: undefined, consumedAt: undefined };
		const lateMetaPath = join(dirname(seeded.logFile), "meta.json");
		writeFileSync(lateMetaPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
		chmodSync(lateMetaPath, 0o600);
		faults.set(lateMetaPath, transientFault("EIO"));

		const target = manager({ store, onDiagnostic: (entry) => diagnostics.push(entry) });
		// The constructor scan succeeded but incomplete: the indexed subset is
		// seeded and served, and the incomplete episode is diagnosed once.
		expect(reads.scans).toBe(1);
		expect(target.get("term-known", "session-a")).toMatchObject({ id: "term-known", status: "completed" });
		expect(target.get("term-late", "session-a")).toBeUndefined();
		// The first query entry paid exactly one coalesced lazy retry, still faulted.
		expect(reads.scans).toBe(2);
		expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(1);
		// One store io diagnostic per transient read inside a successful scan.
		expect(diagnostics.filter((entry) => entry.kind === "io")).toHaveLength(2);

		// The fault clears: the next entry after the backoff window rescans and
		// the complete scan makes the skipped record visible and queryable.
		faults.clear();
		const changes: TerminalTaskSnapshot[] = [];
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
		now += 1_000;
		const changesBefore = changes.length;
		const publicationsBefore = publications.length;
		expect(target.get("term-late", "session-a")).toMatchObject({ id: "term-late", status: "completed", deliveryState: "pending" });
		expect(reads.scans).toBe(3);
		// A record new to the projection joins the batched fan-out: delivery
		// listeners wake and the projection publishes the completed generation.
		expect(changes.slice(changesBefore).map((task) => task.id)).toEqual(["term-late"]);
		expect(changes[changesBefore]).toMatchObject({ status: "completed", deliveryState: "pending" });
		expect(publications.length - publicationsBefore).toBe(1);

		// Delivery fires: the claim pass claims the recovered durable completion.
		expect(target.claimPending("session-a", true).map((task) => task.id)).toEqual(["term-late"]);
		expect(durableTask("term-late")).toMatchObject({ deliveryState: "claimed" });

		// A complete scan stops the retries: no entry point rescans, even well
		// past the backoff window, and the episode stays deduped.
		now += 60_000;
		expect(target.list("session-a").map((task) => task.id).sort()).toEqual(["term-known", "term-late"]);
		expect(target.get("term-known", "session-a")).toBeDefined();
		expect(target.claimPending("session-b", true)).toEqual([]);
		expect(reads.scans).toBe(3);
		expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(1);

		unsubscribeProjection();
		unsubscribeTasks();
	});

	it("retries an incomplete startup scan from a timer when no later entry point runs and delivers the recovered completion", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		let coordinator: TerminalDeliveryCoordinator | undefined;
		try {
			const faults = new Map<string, Error>();
			const store = new TerminalTaskStore({
				rootDir,
				metaReadFault: (path) => faults.get(path),
			});
			const seeded = persistSettledTask(store, "term-idle-init", "session-a", 1_000, "idle");
			const pending = { ...seeded, deliveryState: "pending" as const, observedAt: undefined, consumedAt: undefined };
			const metaPath = join(dirname(seeded.logFile), "meta.json");
			writeFileSync(metaPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
			chmodSync(metaPath, 0o600);
			faults.set(metaPath, transientFault("EIO"));

			target = manager({ store, pollIntervalMs: 60_000 });
			const branch: Array<{ type: "custom_message"; details: unknown }> = [];
			const sendMessage = vi.fn((message: { details?: unknown }) => {
				branch.push({ type: "custom_message", details: message.details });
			});
			const pi = { sendMessage };
			const ctx = {
				sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
				isIdle: () => true,
			};
			// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
			coordinator = new TerminalDeliveryCoordinator(pi as never, target);
			// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
			coordinator.bind(ctx as never);
			await vi.advanceTimersByTimeAsync(0);

			expect(sendMessage).not.toHaveBeenCalled();
			expect(store.isIndexedOwner("term-idle-init", "session-a")).toBe(false);
			// The startup flush consumed the one direct entry point and left exactly one
			// lazy init retry timer for the backoff boundary.
			expect(vi.getTimerCount()).toBe(1);

			faults.clear();
			now += 999;
			await vi.advanceTimersByTimeAsync(999);
			expect(sendMessage).not.toHaveBeenCalled();
			expect(store.isIndexedOwner("term-idle-init", "session-a")).toBe(false);

			now += 1;
			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(0);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "terminal-result" });
			expect(target.get("term-idle-init", "session-a")).toMatchObject({ id: "term-idle-init", deliveryState: "delivered" });
			expect(durableTask("term-idle-init")).toMatchObject({ deliveryState: "delivered" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			coordinator?.dispose();
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("retries an incomplete startup scan from an active poll and delivers the recovered completion", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		let coordinator: TerminalDeliveryCoordinator | undefined;
		try {
			const reads = { scans: 0, metadata: 0 };
			const faults = new Map<string, Error>();
			const store = new TerminalTaskStore({
				rootDir,
				onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
				metaReadFault: (path) => faults.get(path),
			});
			persistRunningTask(store, "term-active-init", "session-a", 1_000);
			const seeded = persistSettledTask(store, "term-active-skipped", "session-a", 2_000, "skipped");
			const pending = { ...seeded, deliveryState: "pending" as const, observedAt: undefined, consumedAt: undefined };
			const metaPath = join(dirname(seeded.logFile), "meta.json");
			writeFileSync(metaPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
			chmodSync(metaPath, 0o600);
			faults.set(metaPath, transientFault("EIO"));

			target = manager({ store, pollIntervalMs: 1_000 });
			expect(reads.scans).toBe(1);
			expect(target.getSnapshots()).toEqual([expect.objectContaining({ id: "term-active-init", status: "running" })]);
			expect(store.isIndexedOwner("term-active-skipped", "session-a")).toBe(false);
			// The uninitialized manager has exactly the active poll interval; no
			// redundant init timer is armed while a retained terminal is running.
			expect(vi.getTimerCount()).toBe(1);

			const branch: Array<{ type: "custom_message"; details: unknown }> = [];
			const sendMessage = vi.fn((message: { details?: unknown }) => {
				branch.push({ type: "custom_message", details: message.details });
			});
			const pi = { sendMessage };
			const ctx = {
				sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
				isIdle: () => true,
			};
			// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
			coordinator = new TerminalDeliveryCoordinator(pi as never, target);
			// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
			coordinator.bind(ctx as never);
			await vi.advanceTimersByTimeAsync(0);
			expect(sendMessage).not.toHaveBeenCalled();
			expect(reads.scans).toBe(2);

			faults.clear();
			now += 999;
			await vi.advanceTimersByTimeAsync(999);
			expect(sendMessage).not.toHaveBeenCalled();
			expect(store.isIndexedOwner("term-active-skipped", "session-a")).toBe(false);
			expect(reads.scans).toBe(2);

			now += 1;
			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
			expect(reads.scans).toBe(3);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "terminal-result" });
			expect(target.get("term-active-skipped", "session-a")).toMatchObject({
				id: "term-active-skipped",
				deliveryState: "delivered",
			});
			expect(durableTask("term-active-skipped")).toMatchObject({ deliveryState: "delivered" });
			expect(target.get("term-active-init", "session-a")).toMatchObject({ status: "running" });
		} finally {
			coordinator?.dispose();
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("re-arms the init retry timer when the last active task settles after stop with an incomplete index", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const faults = new Map<string, Error>();
			const store = new TerminalTaskStore({
				rootDir,
				metaReadFault: (path) => faults.get(path),
			});
			persistRunningTask(store, "term-stop-active", "session-a", 1_000);
			const seeded = persistSettledTask(store, "term-stop-skipped", "session-a", 2_000, "skipped");
			const pending = { ...seeded, deliveryState: "pending" as const, observedAt: undefined, consumedAt: undefined };
			const metaPath = join(dirname(seeded.logFile), "meta.json");
			writeFileSync(metaPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
			chmodSync(metaPath, 0o600);
			faults.set(metaPath, transientFault("EIO"));

			target = manager({ store, pollIntervalMs: 60_000 });
			expect(vi.getTimerCount()).toBe(1);
			expect(target.get("term-stop-skipped", "session-a")).toBeUndefined();

			const stopped = await target.stop(["term-stop-active"], "session-a");
			expect(stopped[0]).toMatchObject({ id: "term-stop-active", outcome: "cancelled" });
			// The poll was cleared before final settlement; final clearPoll sees no
			// poll interval and must still arm the idle init retry.
			expect(vi.getTimerCount()).toBe(1);
			expect(store.isIndexedOwner("term-stop-skipped", "session-a")).toBe(false);

			faults.clear();
			now += 1_000;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(target.get("term-stop-skipped", "session-a")).toMatchObject({ id: "term-stop-skipped" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("escalates init retry timers across consecutive incomplete attempts", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			class ScriptedInitStore extends TerminalTaskStore {
				public attempts = 0;
				public incompleteAttempts = 3;
				public override refreshIndex(): TerminalTaskIndexRefreshResult {
					this.attempts += 1;
					if (this.incompleteAttempts > 0) {
						this.incompleteAttempts -= 1;
						return { ok: true, complete: false, snapshots: [] };
					}
					return super.refreshIndex();
				}
			}
			const store = new ScriptedInitStore({ rootDir });
			target = manager({ store, pollIntervalMs: 60_000 });
			expect(store.attempts).toBe(1);

			// The startup entry point takes over the constructor's armed retry and opens
			// the first 1s lazy-retry window.
			expect(target.list("session-a")).toEqual([]);
			expect(store.attempts).toBe(2);
			expect(vi.getTimerCount()).toBe(1);

			now += 999;
			await vi.advanceTimersByTimeAsync(999);
			expect(store.attempts).toBe(2);

			now += 1;
			await vi.advanceTimersByTimeAsync(1);
			expect(store.attempts).toBe(3);
			expect(vi.getTimerCount()).toBe(1);

			now += 1_999;
			await vi.advanceTimersByTimeAsync(1_999);
			expect(store.attempts).toBe(3);

			now += 1;
			await vi.advanceTimersByTimeAsync(1);
			expect(store.attempts).toBe(4);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("clears init retry timers on complete scans and detach", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		let detached: TerminalTaskManager | undefined;
		try {
			class FlakyInitStore extends TerminalTaskStore {
				public attempts = 0;
				public remainingFailures = Number.POSITIVE_INFINITY;
				public override refreshIndex(): TerminalTaskIndexRefreshResult {
					this.attempts += 1;
					if (this.remainingFailures > 0) {
						this.remainingFailures -= 1;
						return { ok: false, complete: false, snapshots: [] };
					}
					return super.refreshIndex();
				}
			}

			const store = new FlakyInitStore({ rootDir });
			target = manager({ store, pollIntervalMs: 60_000 });
			expect(target.list("session-a")).toEqual([]);
			expect(store.attempts).toBe(2);
			expect(vi.getTimerCount()).toBe(1);

			store.remainingFailures = 0;
			now += 1_000;
			expect(target.refreshSnapshotsFromStore()).toMatchObject({ ok: true, complete: true });
			expect(vi.getTimerCount()).toBe(0);
			const attemptsAfterComplete = store.attempts;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(store.attempts).toBe(attemptsAfterComplete);
			target.detach();
			target = undefined;

			const detachStore = new FlakyInitStore({ rootDir });
			detached = manager({ store: detachStore, pollIntervalMs: 60_000 });
			expect(detached.list("session-a")).toEqual([]);
			expect(detachStore.attempts).toBe(2);
			expect(vi.getTimerCount()).toBe(1);
			detached.detach();
			detached = undefined;
			expect(vi.getTimerCount()).toBe(0);
			now += 1_000;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(detachStore.attempts).toBe(2);
		} finally {
			target?.detach();
			detached?.detach();
			vi.useRealTimers();
		}
	});

	it("lets direct init entries take over an armed retry without double-arming", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			class FlakyInitStore extends TerminalTaskStore {
				public attempts = 0;
				public override refreshIndex(): TerminalTaskIndexRefreshResult {
					this.attempts += 1;
					return { ok: false, complete: false, snapshots: [] };
				}
			}
			const store = new FlakyInitStore({ rootDir });
			target = manager({ store, pollIntervalMs: 60_000 });

			expect(target.list("session-a")).toEqual([]);
			expect(store.attempts).toBe(2);
			expect(vi.getTimerCount()).toBe(1);

			expect(target.get("term-missing", "session-a")).toBeUndefined();
			expect(store.attempts).toBe(2);
			expect(vi.getTimerCount()).toBe(1);

			now += 1_000;
			expect(target.claimPending("session-a", true)).toEqual([]);
			expect(store.attempts).toBe(3);
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(0);
			expect(store.attempts).toBe(3);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("re-arms init retries when a mid-life takeover refresh skips an unindexed record transiently", () => {
		const reads = { scans: 0, metadata: 0 };
		const faults = new Map<string, Error>();
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
			metaReadFault: (path) => faults.get(path),
		});
		const target = manager({ store });
		expect(reads.scans).toBe(1);

		// An external writer lands a settled pending completion; its metadata
		// read fails transiently at the mid-life takeover refresh.
		const seeded = persistSettledTask(store, "term-takeover", "session-b", 2_000, "takeover");
		const pending = { ...seeded, deliveryState: "pending" as const, observedAt: undefined, consumedAt: undefined };
		const metaPath = join(dirname(seeded.logFile), "meta.json");
		writeFileSync(metaPath, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
		chmodSync(metaPath, 0o600);
		faults.set(metaPath, transientFault("EIO"));
		const takeover = target.refreshSnapshotsFromStore();
		expect(takeover.ok).toBe(true);
		expect(takeover.complete).toBe(false);
		// The incomplete takeover keeps init-retry state armed: the next entry
		// point retries the scan (still faulted) instead of never rescanning.
		expect(target.get("term-takeover", "session-b")).toBeUndefined();
		expect(reads.scans).toBe(3);

		// Fault cleared: the next entry after the backoff picks the record up.
		faults.clear();
		now += 1_000;
		expect(target.get("term-takeover", "session-b")).toMatchObject({ id: "term-takeover", status: "completed" });
		expect(reads.scans).toBe(4);
		// The complete scan stops the retries.
		now += 60_000;
		expect(target.list("session-b").map((task) => task.id)).toEqual(["term-takeover"]);
		expect(reads.scans).toBe(4);
	});

	it("treats corrupt quarantine as a terminal decision and does not arm init retries", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		persistSettledTask(store, "term-healthy", "session-a", 1_000);
		const corruptDirectory = join(store.rootDir, "term-corrupt-1000");
		mkdirSync(corruptDirectory, { mode: 0o700 });
		chmodSync(corruptDirectory, 0o700);
		writeFileSync(join(corruptDirectory, "output.log"), "", { mode: 0o600 });
		chmodSync(join(corruptDirectory, "output.log"), 0o600);
		writeFileSync(join(corruptDirectory, "meta.json"), "{not json", { mode: 0o600 });
		chmodSync(join(corruptDirectory, "meta.json"), 0o600);

		const target = manager({ store });
		expect(reads.scans).toBe(1);
		expect(target.get("term-healthy", "session-a")).toMatchObject({ id: "term-healthy" });
		// A later takeover refresh that quarantines another corrupt record stays
		// complete: a terminal quarantine decision is full generation coverage.
		writeFileSync(join(corruptDirectory, "meta.json"), "still {not json", { mode: 0o600 });
		expect(target.refreshSnapshotsFromStore().complete).toBe(true);
		expect(reads.scans).toBe(2);
		// No init retries are armed: entry points never rescan.
		now += 60_000;
		expect(target.list("session-a").map((task) => task.id)).toEqual(["term-healthy"]);
		expect(target.check("term-healthy", "session-a")?.task).toBeDefined();
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(reads.scans).toBe(2);
	});

	it("seeds the index from the coordinator's acknowledge entry so a non-idle reconcile lands durable receipts", () => {
		class FlakyConstructorScanStore extends TerminalTaskStore {
			public attempts = 0;
			public remainingFailures = 1;
			public override refreshIndex(): TerminalTaskIndexRefreshResult {
				this.attempts += 1;
				if (this.remainingFailures > 0) {
					this.remainingFailures -= 1;
					return { ok: false, complete: false, snapshots: [] };
				}
				return super.refreshIndex();
			}
		}
		const store = new FlakyConstructorScanStore({ rootDir });
		// A durable claimed completion written by the previous writer: only a
		// seeded projection can match the receipt the coordinator observes.
		const seeded = persistSettledTask(store, "term-ack-lazy", "session-a", 1_000, "ack");
		const claimed = {
			...seeded,
			deliveryState: "claimed" as const,
			completionId: "completion-ack-lazy",
			deliveryClaimToken: "claim-ack-lazy",
			observedAt: undefined,
			consumedAt: undefined,
		};
		const metaFile = join(dirname(seeded.logFile), "meta.json");
		writeFileSync(metaFile, `${JSON.stringify(claimed)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);

		const target = manager({ store, pollIntervalMs: 60_000 });
		// The constructor scan failed: the manager stays uninitialized (the compact
		// index is empty; isIndexedOwner is the no-I/O check no entry guard seeds).
		expect(store.attempts).toBe(1);
		expect(store.isIndexedOwner("term-ack-lazy", "session-a")).toBe(false);

		const sendMessage = vi.fn();
		const pi = { sendMessage };
		// The branch models Pi's observable transcript: the receipt the
		// coordinator must acknowledge is observable there.
		const branch = [{ type: "custom_message", details: { completionId: "completion-ack-lazy", deliveryClaimToken: "claim-ack-lazy" } }];
		const ctx = {
			sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
			isIdle: () => false,
		};
		// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
		const coordinator = new TerminalDeliveryCoordinator(pi as never, target);
		// Non-idle path (touch/reconcile): the acknowledge entry must seed the
		// uninitialized index through the same coalesced lazy retry, or a claimed
		// completion would go unacknowledged with no lease timer armed.
		// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
		coordinator.reconcile(ctx as never);

		expect(store.attempts).toBe(2);
		expect(target.get("term-ack-lazy", "session-a")).toMatchObject({ id: "term-ack-lazy" });
		expect(durableTask("term-ack-lazy")).toMatchObject({ deliveryState: "delivered" });
		expect(sendMessage).not.toHaveBeenCalled();
		coordinator.dispose();
	});

	it.skipIf(process.platform === "win32")("dedupes the store-level refresh-failure diagnostic per scan episode", () => {
		const diagnostics: Array<TerminalTaskStoreDiagnostic | { kind: "manager"; message: string }> = [];
		const onDiagnostic = (entry: TerminalTaskStoreDiagnostic | { kind: "manager"; message: string }): void => {
			diagnostics.push(entry);
		};
		const reads = { scans: 0, metadata: 0 };
		// The production manager shares one callback with its store, so a real
		// store (chmod-faulted root, not a refreshIndex override) emits the
		// store-level io diagnostic this test pins.
		const store = new TerminalTaskStore({
			rootDir,
			onDiagnostic,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		persistSettledTask(store, "term-quiet-io", "session-a", 1_000);
		// Fault the root inside the create callback: the harness's default-store
		// construction re-chmods the root during option assembly, so the fault must
		// be applied after that and before the manager's constructor scans.
		const target = manager({ store, onDiagnostic, pollIntervalMs: 60_000 }, (options) => {
			chmodSync(rootDir, 0o000);
			return new TerminalTaskManager(options);
		});
		try {
			// The failed constructor scan is diagnosed once at each level: one store
			// io entry plus one deduped manager episode entry.
			expect(reads.scans).toBe(1);
			expect(diagnostics.filter((entry) => entry.kind === "io")).toHaveLength(1);
			expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(1);

			// The first lazy retry fails too and stays quiet at both levels.
			expect(target.get("term-quiet-io", "session-a")).toBeUndefined();
			expect(reads.scans).toBe(2);
			expect(diagnostics.filter((entry) => entry.kind === "io")).toHaveLength(1);
			expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(1);

			// Further entries at the same clock reading coalesce into the backoff.
			target.list("session-a");
			expect(target.get("term-quiet-io", "session-a")).toBeUndefined();
			expect(reads.scans).toBe(2);
			expect(diagnostics).toHaveLength(2);

			// Each later escalated-backoff retry fails silently: the store-level
			// refresh-failure diagnostic stays deduped for the whole episode, and
			// consecutive failures double the next window (1s, 2s, 4s).
			now += 1_000;
			expect(target.get("term-quiet-io", "session-a")).toBeUndefined();
			expect(reads.scans).toBe(3);
			now += 1_000;
			expect(target.get("term-quiet-io", "session-a")).toBeUndefined();
			expect(reads.scans).toBe(3);
			now += 1_000;
			expect(target.list("session-a")).toEqual([]);
			expect(reads.scans).toBe(4);
			expect(diagnostics).toHaveLength(2);

			// The first successful scan ends the episode silently and resets both
			// dedupes and the backoff schedule.
			chmodSync(rootDir, 0o700);
			now += 4_000;
			expect(target.get("term-quiet-io", "session-a")).toMatchObject({ id: "term-quiet-io" });
			expect(reads.scans).toBe(5);
			expect(diagnostics).toHaveLength(2);

			// A failure after the reset is diagnosed again.
			chmodSync(rootDir, 0o000);
			now += 1_000;
			expect(target.refreshSnapshotsFromStore().ok).toBe(false);
			expect(reads.scans).toBe(6);
			expect(diagnostics.filter((entry) => entry.kind === "io")).toHaveLength(2);
			expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(1);
		} finally {
			chmodSync(rootDir, 0o700);
		}
	});

	it("escalates lazy init-retry backoff across consecutive failures and resets on the first complete scan", () => {
		class FlakyInitStore extends TerminalTaskStore {
			public attempts = 0;
			public remainingFailures = Number.POSITIVE_INFINITY;
			public override refreshIndex(): TerminalTaskIndexRefreshResult {
				this.attempts += 1;
				if (this.remainingFailures > 0) {
					this.remainingFailures -= 1;
					return { ok: false, complete: false, snapshots: [] };
				}
				return super.refreshIndex();
			}
		}
		const store = new FlakyInitStore({ rootDir });
		persistSettledTask(store, "term-backoff", "session-a", 1_000);
		const target = manager({ store });
		// The constructor scan is the first failed attempt; the first lazy retry
		// still runs immediately and waits the base delay afterwards.
		expect(store.attempts).toBe(1);
		expect(target.get("term-backoff", "session-a")).toBeUndefined();
		expect(store.attempts).toBe(2);

		// Consecutive failed attempts double the next window — 1s, 2s, 4s, 8s,
		// 16s, 32s, then the 60s cap holds. Each mid-window entry coalesces.
		const attempt = (advance: number): number => {
			now += advance;
			target.get("term-backoff", "session-a");
			return store.attempts;
		};
		expect(attempt(1_000)).toBe(3); // base window
		expect(attempt(1_999)).toBe(3); // 2s window coalesces at +1.999s
		expect(attempt(1)).toBe(4); // T+3s
		expect(attempt(3_999)).toBe(4); // 4s window coalesces
		expect(attempt(1)).toBe(5); // T+7s
		expect(attempt(7_999)).toBe(5); // 8s window coalesces
		expect(attempt(1)).toBe(6); // T+15s
		expect(attempt(15_999)).toBe(6); // 16s window coalesces
		expect(attempt(1)).toBe(7); // T+31s
		expect(attempt(31_999)).toBe(7); // 32s window coalesces
		expect(attempt(1)).toBe(8); // T+63s
		expect(attempt(59_999)).toBe(8); // cap window coalesces
		expect(attempt(1)).toBe(9); // T+123s
		expect(attempt(59_999)).toBe(9); // cap stays the schedule ceiling
		expect(attempt(1)).toBe(10); // T+183s

		// The fault clears: the next gated attempt is the first complete scan. It
		// seeds the generation (per-task change plus one publication) and resets
		// the escalation, after which no entry point rescans at all.
		store.remainingFailures = 0;
		const changes: TerminalTaskSnapshot[] = [];
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
		const changesBefore = changes.length;
		const publicationsBefore = publications.length;
		expect(attempt(60_000)).toBe(11);
		expect(target.get("term-backoff", "session-a")).toMatchObject({ id: "term-backoff", status: "completed" });
		expect(changes.slice(changesBefore).map((task) => task.id)).toEqual(["term-backoff"]);
		expect(publications.length - publicationsBefore).toBe(1);
		now += 300_000;
		expect(target.list("session-a")).toHaveLength(1);
		expect(target.claimPending("session-a", true)).toEqual([]);
		expect(store.attempts).toBe(11);

		unsubscribeProjection();
		unsubscribeTasks();
	});

	it("restarts the escalation from the base delay after a complete scan and re-diagnoses failed⇄incomplete transitions", () => {
		class ScriptedInitStore extends TerminalTaskStore {
			public attempts = 0;
			public script: Array<"fail" | "incomplete"> = [];
			public override refreshIndex(): TerminalTaskIndexRefreshResult {
				this.attempts += 1;
				const step = this.script.shift();
				if (step === "fail") return { ok: false, complete: false, snapshots: [] };
				if (step === "incomplete") return { ok: true, complete: false, snapshots: [] };
				return super.refreshIndex();
			}
		}
		const diagnostics: Array<TerminalTaskStoreDiagnostic | { kind: "manager"; message: string }> = [];
		const store = new ScriptedInitStore({ rootDir });
		store.script = ["fail", "fail", "fail"];
		persistSettledTask(store, "term-reset", "session-a", 1_000);
		const target = manager({ store, onDiagnostic: (entry) => diagnostics.push(entry) });
		const failureMessage = "terminal store scan failed before the projection was seeded; entry points retry lazily until the first successful scan";
		const incompleteMessage = "terminal store scan indexed an incomplete generation; entry points retry lazily until a complete scan";
		// The constructor and the first lazy retry fail: one failed-episode
		// diagnostic, deduped across consecutive failures of the same kind.
		expect(target.get("term-reset", "session-a")).toBeUndefined();
		expect(store.attempts).toBe(2);
		expect(diagnostics.map((entry) => entry.kind === "manager" ? entry.message : entry.kind)).toEqual([failureMessage]);
		// The second lazy retry needs the doubled 2s window; then the script is
		// exhausted and the complete scan seeds and resets the episode.
		now += 1_000;
		expect(target.get("term-reset", "session-a")).toBeUndefined();
		expect(store.attempts).toBe(3);
		now += 2_000;
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset", status: "completed" });
		expect(store.attempts).toBe(4);
		expect(diagnostics.map((entry) => entry.kind === "manager" ? entry.message : entry.kind)).toEqual([failureMessage]);

		// An incomplete explicit refresh re-arms the retries and re-diagnoses ONCE
		// for the failed→incomplete transition. The scripted generation reports no
		// records, so the manager prunes its retained projection while the store's
		// untouched compact index still answers explicit reads (get re-adopts).
		store.script = ["incomplete"];
		expect(target.refreshSnapshotsFromStore().complete).toBe(false);
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset" });
		expect(diagnostics.map((entry) => entry.kind === "manager" ? entry.message : entry.kind)).toEqual([failureMessage, incompleteMessage]);

		// Consecutive incomplete LAZY attempts also escalate — but from the BASE
		// again: 1s then 2s, not the previous episode's larger windows.
		store.script = ["incomplete", "incomplete"];
		now += 5_000;
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset" });
		expect(store.attempts).toBe(6);
		expect(diagnostics.filter((entry) => entry.kind === "manager")).toHaveLength(2);
		now += 1_000;
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset" });
		expect(store.attempts).toBe(7);
		now += 1_000;
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset" });
		expect(store.attempts).toBe(7); // 2s window coalesces at +1s
		now += 1_000;
		// The script is empty: the complete scan re-adopts the pruned record,
		// resets the dedupe and schedule, and stops the retries.
		expect(target.get("term-reset", "session-a")).toMatchObject({ id: "term-reset", status: "completed" });
		expect(store.attempts).toBe(8);
		now += 60_000;
		expect(target.list("session-a")).toHaveLength(1);
		expect(store.attempts).toBe(8);
		// Same-kind episodes never repeat the message; only transitions did.
		expect(diagnostics.map((entry) => entry.kind === "manager" ? entry.message : entry.kind)).toEqual([failureMessage, incompleteMessage]);
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

	it("drains queued refresh notifications and wakes a parked waiter when the refresh loops throw", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			const adopted: string[] = [];
			const recovered: string[] = [];
			target = manager({
				store,
				pollIntervalMs: 60_000,
				onRefreshAdopt: (id) => adopted.push(id),
				onRefreshRecover: (id) => {
					recovered.push(id);
					if (id === "term-boom") throw new Error("injected refresh failure");
				},
			});
			const task = await start(target);
			const waiting = target.wait([task.id], "session-a", 60_000);
			// Parked: the wait timer plus the poll interval are pending.
			expect(vi.getTimerCount()).toBe(2);

			// An external writer settles the running record at the same revision:
			// recovery-gated, so its per-task change is collected for the fan-out.
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
			// A second, older record is new to the projection: the store's
			// createdAt-desc order processes it after the rewritten record, and its
			// recovery seam throws mid-loop — after the first change was collected.
			persistSettledTask(store, "term-boom", "session-a", 500, "boom");

			expect(() => target!.refreshSnapshotsFromStore()).toThrow("injected refresh failure");
			expect(recovered).toEqual([task.id, "term-boom"]);

			// The parked waiter must wake from the thrown refresh's drain, not the
			// clock: advancing well short of the 60s wait timeout must not be what
			// resolves it.
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

			// Nothing queued leaks into the next refresh: it behaves like a clean
			// no-change pass — both records re-adopted, nothing recovered, no
			// per-task delivery, and no publication beyond subscribeChanges'
			// registration replay.
			adopted.length = 0;
			recovered.length = 0;
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const changes: TerminalTaskSnapshot[] = [];
			const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect([...adopted].sort()).toEqual([task.id, "term-boom"]);
			expect(recovered).toEqual([]);
			expect(publications).toHaveLength(1);
			expect(changes).toHaveLength(0);

			// And a real durable change still fans out normally. (The wait resolution
			// above already observed the record, advancing its durable revision.)
			external.refreshIndex();
			const settled = external.getIndexed(task.id)!;
			external.transition(task.id, settled.revision, (current) => ({ ...current, title: "bumped", updatedAt: 3_000 }));
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(publications).toHaveLength(2);
			expect(changes).toEqual([expect.objectContaining({ id: task.id, title: "bumped" })]);
			unsubscribeProjection();
			unsubscribeTasks();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("publishes the projection once for a same-revision content-only rewrite and stays silent on no-change refreshes", () => {
		const reads = { scans: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { if (kind === "full-scan") reads.scans += 1; },
		});
		persistSettledTask(store, "term-quiet", "session-a", 1_000, "before");
		const target = manager({ store, pollIntervalMs: 60_000 });
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const changes: TerminalTaskSnapshot[] = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));
		const scansBefore = reads.scans;
		// subscribeChanges' registration replay is the only publication so far.
		expect(publications).toHaveLength(1);

		// A refresh with zero changes stays silent — no publication, no per-task
		// delivery — even though every record is re-adopted (fresh object, equal
		// content), and it costs exactly one scan.
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(reads.scans - scansBefore).toBe(1);
		expect(publications).toHaveLength(1);
		expect(changes).toHaveLength(0);

		// Same-revision, same-owner content-only rewrite: adopted into the stored
		// snapshot with no per-task noise, but the projection publishes exactly
		// once with the updated content — still exactly one scan, no rescan.
		const durable = store.getIndexed("term-quiet")!;
		const metaFile = join(dirname(durable.logFile), "meta.json");
		writeFileSync(metaFile, `${JSON.stringify({ ...durable, title: "rewritten", updatedAt: 1_500 })}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(reads.scans - scansBefore).toBe(2);
		expect(publications).toHaveLength(2);
		expect(publications.at(-1)).toEqual([expect.objectContaining({ id: "term-quiet", revision: 1, title: "rewritten", updatedAt: 1_500 })]);
		expect(changes).toHaveLength(0);
		expect(target.get("term-quiet", "session-a")).toMatchObject({ revision: 1, title: "rewritten" });

		// A following refresh with no change is silent again.
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(publications).toHaveLength(2);
		expect(changes).toHaveLength(0);
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

	it("wakes delivery when a same-revision rewrite reopens a settled completion and stays projection-only for cosmetic rewrites", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const recovered: string[] = [];
		// Seeded before construction so the constructor adopts the suppressed record
		// and the refresh spy matrix below observes only the external rewrite.
		const seeded = persistSettledTask(store, "term-reopen", "session-a", 1_000, "reopen");
		expect(seeded.deliveryState).toBe("suppressed");
		const target = manager({ store, pollIntervalMs: 60_000, onRefreshRecover: (id) => recovered.push(id) });
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const changes: TerminalTaskSnapshot[] = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

		// The settled record the previous writer already observed/consumed is
		// suppressed on disk: nothing is deliverable when the coordinator binds.
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(recovered).toEqual([]);

		// The double's branch models Pi's observable transcript: every sent
		// terminal-result becomes a custom_message entry, so the coordinator's
		// acknowledge pass can observe its own delivery receipt exactly as in the
		// real runtime.
		const branch: Array<{ type: "custom_message"; details: unknown }> = [];
		const sendMessage = vi.fn((message: { details?: unknown }) => {
			branch.push({ type: "custom_message", details: message.details });
		});
		const pi = { sendMessage };
		const ctx = {
			sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
			isIdle: () => true,
		};
		// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
		const coordinator = new TerminalDeliveryCoordinator(pi as never, target);
		// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
		coordinator.bind(ctx as never);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(sendMessage).not.toHaveBeenCalled();

		// An external writer rewrites the record at the SAME revision, same owner,
		// same status, same process identity — flipping only delivery fields back to
		// pending-eligible. The refresh must join a per-task change (the coordinator
		// listens for per-task notifications only) without any recovery side effect,
		// and the coordinator must schedule a flush delivering the terminal result.
		const durable = store.getIndexed("term-reopen")!;
		const metaFile = join(dirname(durable.logFile), "meta.json");
		const reopened = {
			...durable,
			deliveryState: "pending" as const,
			observedAt: undefined,
			consumedAt: undefined,
		};
		writeFileSync(metaFile, `${JSON.stringify(reopened)}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);

		const changesBefore = changes.length;
		const publicationsBefore = publications.length;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(changes.slice(changesBefore).map((task) => task.id)).toEqual(["term-reopen"]);
		expect(changes.at(-1)).toMatchObject({ id: "term-reopen", revision: seeded.revision, status: "completed", deliveryState: "pending" });
		expect(publications.length - publicationsBefore).toBe(1);
		// Delivery-only change: adopted, but the recovery gate never ran.
		expect(recovered).toEqual([]);

		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "terminal-result" });
		// The flush's acknowledge settles the record as delivered on disk; wait for
		// that durable advance so the cosmetic rewrite below starts from it.
		await vi.waitFor(() => expect(store.getIndexed("term-reopen")!.deliveryState).toBe("delivered"));
		const changesAfterDelivery = changes.length;
		const publicationsAfterDelivery = publications.length;

		// A same-revision cosmetic rewrite (title only; every delivery-eligibility
		// and receipt field equal) stays projection-only: exactly one publication,
		// zero per-task noise, still no recovery side effect.
		const delivered = store.getIndexed("term-reopen")!;
		writeFileSync(metaFile, `${JSON.stringify({ ...delivered, title: "cosmetic" })}\n`, { mode: 0o600 });
		chmodSync(metaFile, 0o600);
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);
		expect(changes.length).toBe(changesAfterDelivery);
		expect(publications.length - publicationsAfterDelivery).toBe(1);
		expect(publications.at(-1)).toEqual([expect.objectContaining({ id: "term-reopen", title: "cosmetic" })]);
		expect(recovered).toEqual([]);

		coordinator.dispose();
		unsubscribeProjection();
		unsubscribeTasks();
	});

	it("wakes delivery when a claimed record's same-revision rewrite moves updatedAt backward and stays projection-only for non-claimed cosmetic rewrites", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			const recovered: string[] = [];
			now = 100_000;
			// Seeded before construction so the constructor adopts the claimed record
			// and the refresh spy below observes only the external rewrite.
			const seeded = persistSettledTask(store, "term-lease", "session-a", 1_000, "lease");
			// A rival coordinator claimed the completion before dying: claimed with a
			// token and a FRESH updatedAt (store schema keeps observation timestamps
			// cleared for claimed records).
			const claimedFresh = {
				...seeded,
				deliveryState: "claimed" as const,
				deliveryClaimToken: "claim-lease",
				observedAt: undefined,
				consumedAt: undefined,
				updatedAt: 100_000,
			};
			const metaFile = join(dirname(seeded.logFile), "meta.json");
			writeFileSync(metaFile, `${JSON.stringify(claimedFresh)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);

			target = manager({ store, pollIntervalMs: 60_000, claimLeaseMs: 30_000, onRefreshRecover: (id) => recovered.push(id) });
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const changes: TerminalTaskSnapshot[] = [];
			const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

			// The double's branch models Pi's observable transcript so the
			// coordinator's acknowledge pass can observe its own delivery receipt.
			const branch: Array<{ type: "custom_message"; details: unknown }> = [];
			const sendMessage = vi.fn((message: { details?: unknown }) => {
				branch.push({ type: "custom_message", details: message.details });
			});
			const pi = { sendMessage };
			const ctx = {
				sessionManager: { getSessionId: () => "session-a", getBranch: () => branch },
				isIdle: () => true,
			};
			// SAFETY: the double implements exactly the ExtensionAPI members the coordinator touches.
			const coordinator = new TerminalDeliveryCoordinator(pi as never, target);
			// SAFETY: the double implements exactly the ExtensionContext members the coordinator touches.
			coordinator.bind(ctx as never);
			await vi.advanceTimersByTimeAsync(0);
			// The unexpired lease arms exactly one retry timer at the full
			// claim-lease delay, and nothing delivers yet.
			expect(sendMessage).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(1);

			// An external writer rewrites the record at the SAME revision, same
			// owner, same status, same process identity, and identical
			// deliveryState/completionPolicy/completionId/deliveryClaimToken —
			// moving updatedAt BACKWARD past lease expiry. isClaimable reads
			// updatedAt, so the completion is eligible NOW, while the armed retry
			// timer still waits out the stale remainder computed from the newer
			// timestamp. The refresh must join a per-task change so the coordinator
			// recalculates and delivers promptly instead of waiting out that delay.
			const expired = { ...claimedFresh, updatedAt: 65_000 };
			writeFileSync(metaFile, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);

			const changesBefore = changes.length;
			const publicationsBefore = publications.length;
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(changes.slice(changesBefore).map((task) => task.id)).toEqual(["term-lease"]);
			expect(changes.at(-1)).toMatchObject({ id: "term-lease", revision: seeded.revision, status: "completed", deliveryState: "claimed", updatedAt: 65_000 });
			expect(publications.length - publicationsBefore).toBe(1);
			// Delivery-only change: adopted, but the recovery gate never ran.
			expect(recovered).toEqual([]);

			// The coordinator recalculates from the fresher timestamp and delivers
			// promptly: advancing a sliver of the stale delay (the old timer needed
			// ~29s more) suffices — fake timers pin no reliance on the old timer.
			await vi.advanceTimersByTimeAsync(1_000);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "terminal-result" });
			// The flush's acknowledge settles the record as delivered on disk, and
			// the recalculated retry timer is torn down with the lease gone.
			await vi.advanceTimersByTimeAsync(0);
			expect(store.getIndexed("term-lease")!.deliveryState).toBe("delivered");
			expect(vi.getTimerCount()).toBe(0);

			// A same-revision non-claimed cosmetic rewrite (title + updatedAt; the
			// delivered record holds no lease) stays projection-only: exactly one
			// publication, zero per-task noise, still no recovery side effect.
			const delivered = store.getIndexed("term-lease")!;
			writeFileSync(metaFile, `${JSON.stringify({ ...delivered, title: "cosmetic", updatedAt: 99_000 })}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);
			const changesBeforeCosmetic = changes.length;
			const publicationsBeforeCosmetic = publications.length;
			expect(target.refreshSnapshotsFromStore().ok).toBe(true);
			expect(changes.length).toBe(changesBeforeCosmetic);
			expect(publications.length - publicationsBeforeCosmetic).toBe(1);
			expect(publications.at(-1)).toEqual([expect.objectContaining({ id: "term-lease", title: "cosmetic", updatedAt: 99_000 })]);
			expect(recovered).toEqual([]);
			expect(sendMessage).toHaveBeenCalledTimes(1);

			coordinator.dispose();
			unsubscribeProjection();
			unsubscribeTasks();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
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

	it("classifies a locked no-op adoption of a divergent durable snapshot like a refresh", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			// Seeded before construction: the constructor adopts the settled record.
			const seeded = persistSettledTask(store, "term-noop", "session-a", 1_000, "before");
			target = manager({ store, pollIntervalMs: 60_000 });
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const changes: TerminalTaskSnapshot[] = [];
			const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

			// An external writer flips the settled record to running at the SAME
			// revision (complete fresh process identity; anchors matching the harness
			// capture so recovery's reconcile cannot mutate the record).
			const metaFile = join(dirname(seeded.logFile), "meta.json");
			const running = {
				...seeded,
				status: "running" as const,
				pid: 5_100,
				processGroupId: 5_100,
				processStartTime: "start-5100",
				processTreeVerification: { members: [{ pid: 5_101, processStartTime: "child-5101" }] },
				deliveryState: "none" as const,
				settledAt: undefined,
				exitCode: undefined,
				observedAt: undefined,
				consumedAt: undefined,
				completionId: undefined,
				updatedAt: 1_500,
			};
			writeFileSync(metaFile, `${JSON.stringify(running)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);

			// The mutation path selects the stale settled entry; the locked
			// authoritative snapshot is running and the observation predicate no-ops.
			// The locked no-op adoption must classify the divergence like a refresh:
			// recovery side effects (launch-gate release, arm, reconcile) plus
			// per-task/projection notification — not a silent adoption.
			const changesBefore = changes.length;
			const publicationsBefore = publications.length;
			expect(target.check("term-noop", "session-a")?.task).toMatchObject({
				id: "term-noop",
				status: "running",
				pid: 5_100,
				revision: seeded.revision,
			});
			// The poll is armed: exactly one pending timer (the task's poll interval).
			expect(vi.getTimerCount()).toBe(1);
			expect(changes.slice(changesBefore)).toEqual([expect.objectContaining({ id: "term-noop", status: "running" })]);
			expect(publications.length - publicationsBefore).toBe(1);
			expect(publications.at(-1)).toEqual([expect.objectContaining({ id: "term-noop", status: "running" })]);
			expect(target.get("term-noop", "session-a")).toMatchObject({ status: "running" });
			await vi.advanceTimersByTimeAsync(0);
			// Recovery's reconcile could not mutate (anchors match) and the durable
			// record keeps its external revision.
			expect(durableTask("term-noop")).toMatchObject({ status: "running", revision: seeded.revision });

			// Subsequent behavior is normal: the armed poll settles from durable
			// exit evidence and tears its timer down. The marker must be private
			// (0600): the store validates artifact modes on every record read.
			writeFileSync(exitFile(seeded), "0", { mode: 0o600 });
			chmodSync(exitFile(seeded), 0o600);
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.advanceTimersByTimeAsync(50);
			expect(target.get("term-noop", "session-a")).toMatchObject({ status: "completed", exitCode: 0 });
			expect(vi.getTimerCount()).toBe(0);

			// Consume the completion so the record reaches its quiescent suppressed
			// state before the delivery-eligibility phase.
			target.check("term-noop", "session-a");
			const quiesced = store.getIndexed("term-noop")!;
			expect(quiesced).toMatchObject({ deliveryState: "suppressed", revision: seeded.revision + 2 });
			await vi.advanceTimersByTimeAsync(0);
			const changesAfterSettle = changes.length;

			// A same-revision external rewrite flipping only a delivery receipt field
			// (completionId) is delivery-relevant: the no-op adoption raises the
			// per-task notification that wakes the coordinator — with no recovery side
			// effect and no new timer.
			writeFileSync(metaFile, `${JSON.stringify({ ...quiesced, completionId: "completion-external" })}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);
			expect(target.check("term-noop", "session-a")?.task).toMatchObject({ completionId: "completion-external", deliveryState: "suppressed" });
			expect(changes.length - changesAfterSettle).toBe(1);
			expect(changes.at(-1)).toMatchObject({ id: "term-noop", completionId: "completion-external" });
			expect(vi.getTimerCount()).toBe(0);
			expect(durableTask("term-noop")!.revision).toBe(quiesced.revision);

			// A cosmetic no-op adoption (title-only rewrite) stays quiet per-task
			// with no recovery: projection-only, exactly as at the refresh boundary.
			const changesAfterReceipt = changes.length;
			const publicationsAfterReceipt = publications.length;
			writeFileSync(metaFile, `${JSON.stringify({ ...store.getIndexed("term-noop")!, title: "cosmetic" })}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);
			expect(target.check("term-noop", "session-a")?.task).toMatchObject({ title: "cosmetic" });
			expect(changes.length).toBe(changesAfterReceipt);
			expect(publications.length - publicationsAfterReceipt).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
			expect(durableTask("term-noop")!.revision).toBe(quiesced.revision);

			unsubscribeProjection();
			unsubscribeTasks();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("classifies a locked no-op against a revision-bumped durable snapshot like a refresh", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			// Seeded before construction: the constructor adopts the settled record at v1.
			const seeded = persistSettledTask(store, "term-stale-noop", "session-a", 1_000, "before");
			target = manager({ store, pollIntervalMs: 60_000 });
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const changes: TerminalTaskSnapshot[] = [];
			const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

			// An external writer flips the settled record to running at a BUMPED
			// revision (complete fresh process identity; anchors matching the harness
			// capture so recovery's reconcile cannot mutate the record).
			const metaFile = join(dirname(seeded.logFile), "meta.json");
			const running = {
				...seeded,
				revision: seeded.revision + 1,
				status: "running" as const,
				pid: 5_100,
				processGroupId: 5_100,
				processStartTime: "start-5100",
				processTreeVerification: { members: [{ pid: 5_101, processStartTime: "child-5101" }] },
				deliveryState: "none" as const,
				settledAt: undefined,
				exitCode: undefined,
				observedAt: undefined,
				consumedAt: undefined,
				completionId: undefined,
				updatedAt: 1_500,
			};
			writeFileSync(metaFile, `${JSON.stringify(running)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);

			// The mutation path selects the stale settled v1 entry; the first
			// transition attempt fails the revision CAS, the retry silently adopts the
			// reloaded running v2 snapshot, and the observation predicate no-ops on
			// it. The locked no-op adoption must classify the divergence against the
			// snapshot retained BEFORE the mutation — not against the reloaded
			// snapshot the retry loop adopted mid-flight — so the divergence recovers
			// exactly like a refresh discovery: recovery side effects (launch-gate
			// release, arm, reconcile) plus per-task and projection notification.
			const changesBefore = changes.length;
			const publicationsBefore = publications.length;
			expect(target.check("term-stale-noop", "session-a")?.task).toMatchObject({
				id: "term-stale-noop",
				status: "running",
				pid: 5_100,
				revision: seeded.revision + 1,
			});
			// The poll is armed: exactly one pending timer (the task's poll interval).
			expect(vi.getTimerCount()).toBe(1);
			expect(changes.slice(changesBefore)).toEqual([expect.objectContaining({ id: "term-stale-noop", status: "running", revision: seeded.revision + 1 })]);
			expect(publications.length - publicationsBefore).toBe(1);
			expect(publications.at(-1)).toEqual([expect.objectContaining({ id: "term-stale-noop", status: "running" })]);
			expect(target.get("term-stale-noop", "session-a")).toMatchObject({ status: "running" });
			await vi.advanceTimersByTimeAsync(0);
			// Recovery's reconcile could not mutate (anchors match) and the durable
			// record keeps its external revision.
			expect(durableTask("term-stale-noop")).toMatchObject({ status: "running", revision: seeded.revision + 1 });

			// The armed poll is a real recovery side effect: durable exit evidence
			// settles the task and tears the timer down. The marker must be private
			// (0600): the store validates artifact modes on every record read.
			writeFileSync(exitFile(seeded), "0", { mode: 0o600 });
			chmodSync(exitFile(seeded), 0o600);
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.advanceTimersByTimeAsync(50);
			expect(target.get("term-stale-noop", "session-a")).toMatchObject({ status: "completed", exitCode: 0 });
			expect(vi.getTimerCount()).toBe(0);

			unsubscribeProjection();
			unsubscribeTasks();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("fans a locked no-op whose recovery mutates synchronously through one final per-task payload", async () => {
		vi.useFakeTimers();
		let target: TerminalTaskManager | undefined;
		try {
			const store = new TerminalTaskStore({ rootDir });
			const seeded = persistSettledTask(store, "term-noop-order", "session-a", 1_000, "before");
			target = manager({ store, pollIntervalMs: 60_000 });
			const publications: Array<readonly TerminalTaskSnapshot[]> = [];
			const changes: TerminalTaskSnapshot[] = [];
			const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
			const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

			// External writer flips settled v1 to running v2 with STALE anchors that
			// differ from the harness capture: recovery's reconcile must run its
			// synchronous tree-verification mutation (bumping the record to v3)
			// before the no-op site's own notification would fire.
			const metaFile = join(dirname(seeded.logFile), "meta.json");
			const running = {
				...seeded,
				revision: seeded.revision + 1,
				status: "running" as const,
				pid: 5_100,
				processGroupId: 5_100,
				processStartTime: "start-5100",
				processTreeVerification: { members: [{ pid: 9_999, processStartTime: "stale-anchor" }] },
				deliveryState: "none" as const,
				settledAt: undefined,
				exitCode: undefined,
				observedAt: undefined,
				consumedAt: undefined,
				completionId: undefined,
				updatedAt: 1_500,
			};
			writeFileSync(metaFile, `${JSON.stringify(running)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);

			const changesBefore = changes.length;
			const publicationsBefore = publications.length;
			expect(target.check("term-noop-order", "session-a")?.task).toMatchObject({ status: "running", revision: seeded.revision + 1 });

			// The synchronous reconcile mutation (v3) and the site's own adoption
			// notification fold into ONE final per-task payload per id and exactly
			// one projection publication: the pre-recovery locked v2 snapshot is
			// never notified after the newer v3 (no newer-then-stale per-task
			// sequence) and no duplicate projection fan-out happens.
			expect(changes.slice(changesBefore)).toEqual([
				expect.objectContaining({ id: "term-noop-order", status: "running", revision: seeded.revision + 2 }),
			]);
			expect(publications.length - publicationsBefore).toBe(1);
			expect(publications.at(-1)).toEqual([
				expect.objectContaining({ id: "term-noop-order", status: "running", revision: seeded.revision + 2 }),
			]);
			expect(target.get("term-noop-order", "session-a")).toMatchObject({ revision: seeded.revision + 2 });
			expect(durableTask("term-noop-order")).toMatchObject({ status: "running", revision: seeded.revision + 2 });
			expect(vi.getTimerCount()).toBe(1);

			unsubscribeProjection();
			unsubscribeTasks();
		} finally {
			target?.detach();
			vi.useRealTimers();
		}
	});

	it("defers a projection publication raised inside a refresh batch to the batch close", () => {
		const store = new TerminalTaskStore({ rootDir });
		const target = manager({ store, pollIntervalMs: 60_000 });
		const publications: Array<readonly TerminalTaskSnapshot[]> = [];
		const changes: TerminalTaskSnapshot[] = [];
		const unsubscribeProjection = target.subscribeChanges((snapshots) => publications.push(snapshots));
		const unsubscribeTasks = target.addChangeListener((snapshot) => changes.push(snapshot));

		// A running record appears on disk only after construction, so the refresh
		// adopts it as new and recovery schedules the reconcile synchronously
		// inside the refresh's notification batch.
		const seeded = persistRunningTask(store, "term-midbatch", "session-a", 1_000);
		const metaFile = join(dirname(seeded.logFile), "meta.json");
		// The record's anchors are absent, so reconcile would normally mutate; the
		// capture hook instead rewrites the record cosmetically between the scan
		// and the locked re-read (same revision/identity/delivery fields, new
		// title, anchors now matching the capture), so the reconcile's
		// verification mutation NO-OPS against a content-only divergence and the
		// locked no-op site calls publishProjection mid-refresh-batch.
		const rewritten = { ...seeded, title: "rewritten-midbatch", processTreeVerification: { members: [{ pid: 4_001, processStartTime: "child-4001" }] } };
		const originalCapture = tree.operations.captureTreeVerification;
		tree.operations.captureTreeVerification = (identity: ProcessTreeIdentity) => {
			tree.operations.captureTreeVerification = originalCapture;
			writeFileSync(metaFile, `${JSON.stringify(rewritten)}\n`, { mode: 0o600 });
			chmodSync(metaFile, 0o600);
			return originalCapture!.call(tree.operations, identity);
		};

		const changesBefore = changes.length;
		const publicationsBefore = publications.length;
		expect(target.refreshSnapshotsFromStore().ok).toBe(true);

		// The mid-batch publication defers: the close publishes exactly once, and
		// its payload is the final retained snapshot (rewritten content included).
		expect(changes.slice(changesBefore)).toEqual([
			expect.objectContaining({ id: "term-midbatch", title: "rewritten-midbatch" }),
		]);
		expect(publications.length - publicationsBefore).toBe(1);
		expect(publications.at(-1)).toEqual([
			expect.objectContaining({ id: "term-midbatch", title: "rewritten-midbatch" }),
		]);
		expect(target.get("term-midbatch", "session-a")).toMatchObject({ title: "rewritten-midbatch" });

		unsubscribeProjection();
		unsubscribeTasks();
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
