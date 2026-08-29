import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	StaleTerminalTaskRevisionError,
	TerminalTaskLockBusyError,
	TerminalTaskStore,
	parseTerminalTaskSnapshot,
	type TerminalTaskStoreDiagnostic,
} from "./task-store.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

function privateWrite(path: string, contents: string): void {
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function transientFault(code: string): Error {
	return Object.assign(new Error(`injected ${code} metadata read failure`), { code });
}

function taskDirectory(store: TerminalTaskStore, id: string, createdAt = 1_000): string {
	const directory = join(store.rootDir, `${id}-${createdAt}`);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	privateWrite(join(directory, "output.log"), "");
	return directory;
}

function snapshot(store: TerminalTaskStore, id: string, ownerSessionId = "session-a", createdAt = 1_000): TerminalTaskSnapshot {
	const directory = taskDirectory(store, id, createdAt);
	return {
		schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
		revision: 1,
		id,
		ownerSessionId,
		command: "pnpm test",
		cwd: "/repo",
		title: "tests",
		status: "starting",
		completionPolicy: "passive",
		createdAt,
		updatedAt: createdAt,
		deliveryState: "none",
		logFile: join(directory, "output.log"),
	};
}

function runRacer(rootDir: string, id: string, gate: string, ready: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const fixture = fileURLToPath(new URL("../../test/fixtures/terminal-store-racer.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		const child = execFile(join(process.cwd(), "node_modules", ".bin", "jiti"), [fixture, rootDir, id, gate, ready], (error, stdout, stderr) => {
			if (error && !("code" in error)) reject(error);
			else resolve({ code: child.exitCode, stdout, stderr });
		});
	});
}

describe("TerminalTaskStore", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-store-"));
		chmodSync(rootDir, 0o700);
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("places the default durable store in the current user's Pi agent directory", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const agentDir = join(rootDir, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const store = new TerminalTaskStore();
			expect(store.rootDir).toBe(realpathSync(join(agentDir, "state", "sumocode-terminals")));
			expect(lstatSync(store.rootDir).isDirectory()).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("persists atomic revision-checked transitions", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-a");
		const metaPath = join(dirname(initial.logFile), "meta.json");
		store.create(initial, metaPath);

		const running = store.transition(initial.id, 1, (current) => ({
			...current,
			status: "running",
			updatedAt: 2_000,
			pid: 42,
			processGroupId: 42,
			processStartTime: "start",
		}));

		expect(running.revision).toBe(2);
		expect(store.getIndexed(initial.id)).toEqual(running);
		expect(() => store.transition(initial.id, 1, (current) => ({ ...current }))).toThrow(StaleTerminalTaskRevisionError);
	});

	it("serializes CAS across store instances so one writer succeeds and one is stale", async () => {
		const first = new TerminalTaskStore({ rootDir });
		const initial = snapshot(first, "term-race");
		first.create(initial, join(dirname(initial.logFile), "meta.json"));
		const second = new TerminalTaskStore({ rootDir });
		second.refreshIndex();

		const winner = first.transition(initial.id, 1, (current) => ({ ...current, title: "first", updatedAt: 2_000 }));
		expect(winner.title).toBe("first");
		expect(() => second.transition(initial.id, 1, (current) => ({ ...current, title: "second", updatedAt: 2_000 }))).toThrow(StaleTerminalTaskRevisionError);
		expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots[0]?.title).toBe("first");
	});

	it("serializes a real subprocess revision race with one success and one stale result", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-subprocess-race");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		const gate = join(store.rootDir, "race.gate");
		const readyA = join(store.rootDir, "race-a.ready");
		const readyB = join(store.rootDir, "race-b.ready");
		const first = runRacer(store.rootDir, initial.id, gate, readyA);
		const second = runRacer(store.rootDir, initial.id, gate, readyB);
		await vi.waitFor(() => expect(existsSync(readyA) && existsSync(readyB)).toBe(true), { timeout: 5_000 });
		privateWrite(gate, "go\n");

		const results = await Promise.all([first, second]);
		expect(results.map((result) => result.stdout.trim()).sort()).toEqual(["stale", "success"]);
		expect(results.every((result) => result.code === 0)).toBe(true);
		expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots[0]?.revision).toBe(2);
	});

	it("filters indexed records by durable owner session", () => {
		const store = new TerminalTaskStore({ rootDir });
		const first = snapshot(store, "term-a", "session-a");
		const second = snapshot(store, "term-b", "session-b");
		store.create(first, join(dirname(first.logFile), "meta.json"));
		store.create(second, join(dirname(second.logFile), "meta.json"));

		expect(store.listOwnedIndexed("session-a").map((task) => task.id)).toEqual(["term-a"]);
		expect(store.listOwnedIndexed("session-b").map((task) => task.id)).toEqual(["term-b"]);
	});

	it("selects 1500 owned candidates across owners with zero metadata reads", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const owners = ["session-a", "session-b", "session-c"];
		for (let index = 0; index < 1_500; index += 1) {
			const task = snapshot(store, `term-indexed-${index}`, owners[index % owners.length]!, 1_000 + index);
			privateWrite(join(dirname(task.logFile), "meta.json"), `${JSON.stringify(task)}\n`);
		}

		expect(store.refreshIndex().snapshots).toHaveLength(1_500);
		expect(reads).toEqual({ scans: 1, metadata: 1_500 });
		reads.scans = 0;
		reads.metadata = 0;

		const candidates = store.listOwnedIndexed("session-a");
		expect(candidates).toHaveLength(500);
		expect(candidates.every((task) => task.ownerSessionId === "session-a")).toBe(true);
		expect(store.listOwnedIndexed("session-b")).toHaveLength(500);
		expect(store.listOwnedIndexed("session-c")).toHaveLength(500);
		expect(store.listOwnedIndexed("session-unknown")).toEqual([]);
		expect(candidates[0]).not.toHaveProperty("command");
		expect(candidates[0]).not.toHaveProperty("cwd");
		expect(candidates[0]).not.toHaveProperty("title");
		expect(candidates[0]).not.toHaveProperty("logFile");
		expect(reads).toEqual({ scans: 0, metadata: 0 });
	}, 120_000);

	it("creates 1500 indexed records with zero scans, zero rereads, and no per-create sort", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const sortCalls = vi.spyOn(Array.prototype, "sort");
		try {
			for (let index = 0; index < 1_500; index += 1) {
				const task = snapshot(store, `term-created-${index}`, index % 2 === 0 ? "session-a" : "session-b", 1_000 + index);
				store.create(task, join(dirname(task.logFile), "meta.json"));
			}
		} finally {
			sortCalls.mockRestore();
		}
		// Real store.create never rescans the directory, rereads metadata, or
		// re-sorts owner buckets per create; ordering is applied lazily on read.
		expect(reads).toEqual({ scans: 0, metadata: 0 });
		expect(sortCalls).not.toHaveBeenCalled();

		const owned = store.listOwnedIndexed("session-a");
		expect(owned).toHaveLength(750);
		expect(owned.every((task) => task.ownerSessionId === "session-a")).toBe(true);
		expect(owned.map((task) => task.createdAt)).toEqual(Array.from({ length: 750 }, (_, position) => 2_498 - position * 2));
		expect(store.listOwnedIndexed("session-b")).toHaveLength(750);
	}, 120_000);

	it("serves an old indexed ID with one metadata read and zero full scans", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const initial = snapshot(store, "term-evicted");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		store.refreshIndex();
		reads.scans = 0;
		reads.metadata = 0;

		expect(store.getIndexed(initial.id)).toEqual(initial);
		expect(reads).toEqual({ scans: 0, metadata: 1 });
		expect(store.getIndexed("term-missing")).toBeUndefined();
		expect(reads).toEqual({ scans: 0, metadata: 1 });
	});

	it("rereads only the selected record before mutation", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const initial = snapshot(store, "term-selected");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		reads.scans = 0;
		reads.metadata = 0;

		const transitioned = store.transition(initial.id, initial.revision, (current) => ({ ...current, title: "selected", updatedAt: 2_000 }));
		expect(transitioned).toMatchObject({ revision: 2, title: "selected" });
		expect(reads).toEqual({ scans: 0, metadata: 1 });
	});

	it("rejects a duplicate id at create before any durable write, whatever the owner", () => {
		const store = new TerminalTaskStore({ rootDir });
		const first = snapshot(store, "term-dup", "session-a", 1_000);
		store.create(first, join(dirname(first.logFile), "meta.json"));
		// Same id, different owner/timestamp/path: exactly the leak-shaped create.
		const second = snapshot(store, "term-dup", "session-b", 2_000);
		const secondPath = join(dirname(second.logFile), "meta.json");

		expect(() => store.create(second, secondPath)).toThrow(/already indexed/);
		expect(existsSync(secondPath)).toBe(false);
		// Owner buckets keep their integrity: A still lists only its own record,
		// B stays empty, and the indexed id still resolves to A's durable record.
		expect(store.listOwnedIndexed("session-a")).toEqual([expect.objectContaining({ id: "term-dup", ownerSessionId: "session-a" })]);
		expect(store.listOwnedIndexed("session-b")).toEqual([]);
		expect(store.getIndexed("term-dup")).toEqual(first);

		// A duplicate found during refresh stays diagnosed and skipped, never
		// indexed twice and never assigned to two owner buckets.
		privateWrite(secondPath, `${JSON.stringify(second)}\n`);
		const diagnostics: TerminalTaskStoreDiagnostic[] = [];
		const verifier = new TerminalTaskStore({ rootDir, onDiagnostic: (entry) => diagnostics.push(entry) });
		expect(verifier.refreshIndex().snapshots.map((task) => task.id)).toEqual(["term-dup"]);
		expect(diagnostics.filter((entry) => entry.kind === "duplicate")).toHaveLength(1);
		const holdingOwners = ["session-a", "session-b"].filter((owner) => verifier.listOwnedIndexed(owner).length > 0);
		expect(holdingOwners).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")("keeps the last good index across a transient scan failure", () => {
		const diagnostics: TerminalTaskStoreDiagnostic[] = [];
		const store = new TerminalTaskStore({ rootDir, onDiagnostic: (entry) => diagnostics.push(entry) });
		const initial = snapshot(store, "term-transient");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		expect(store.refreshIndex().snapshots).toHaveLength(1);
		// A fresh store whose first refresh fails naturally stays empty.
		const fresh = new TerminalTaskStore({ rootDir });

		chmodSync(rootDir, 0o000);
		try {
			const failed = store.refreshIndex();
			expect(failed.ok).toBe(false);
			expect(failed.snapshots).toEqual([]);
			expect(diagnostics.at(-1)).toMatchObject({ kind: "io", path: store.rootDir });
			// The failed refresh must not replace the last good generation.
			expect(store.listOwnedIndexed("session-a").map((task) => task.id)).toEqual(["term-transient"]);
			expect(fresh.refreshIndex().ok).toBe(false);
		} finally {
			chmodSync(rootDir, 0o700);
		}
		// The preserved index still resolves the durable path once I/O recovers.
		expect(store.getIndexed(initial.id)).toEqual(initial);

		// The next successful explicit refresh replaces the projection normally.
		const later = snapshot(store, "term-later", "session-b", 2_000);
		privateWrite(join(dirname(later.logFile), "meta.json"), `${JSON.stringify(later)}\n`);
		const recovered = store.refreshIndex();
		expect(recovered.ok).toBe(true);
		expect(recovered.snapshots.map((task) => task.id).sort()).toEqual(["term-later", "term-transient"]);
		expect(store.listOwnedIndexed("session-b")).toEqual([expect.objectContaining({ id: "term-later" })]);
	});

	it("retains a known record's index entry when only its metadata read fails transiently", () => {
		const diagnostics: TerminalTaskStoreDiagnostic[] = [];
		const faults = new Map<string, Error>();
		const store = new TerminalTaskStore({
			rootDir,
			onDiagnostic: (entry) => diagnostics.push(entry),
			metaReadFault: (path) => faults.get(path),
		});
		const initial = snapshot(store, "term-transient-read");
		const metaPath = join(dirname(initial.logFile), "meta.json");
		store.create(initial, metaPath);
		const healthy = snapshot(store, "term-healthy", "session-b", 2_000);
		privateWrite(join(dirname(healthy.logFile), "meta.json"), `${JSON.stringify(healthy)}\n`);

		faults.set(metaPath, transientFault("EACCES"));
		const failed = store.refreshIndex();
		expect(failed.ok).toBe(true);
		expect(failed.snapshots.map((task) => task.id)).toEqual(["term-healthy"]);
		expect(failed.preservedIds).toEqual(["term-transient-read"]);
		// The transient read is diagnosed as I/O, not corruption.
		expect(diagnostics.at(-1)).toMatchObject({ kind: "io", path: metaPath });
		// The prior path and compact entry are retained for the owner.
		expect(store.listOwnedIndexed("session-a")).toEqual([expect.objectContaining({ id: "term-transient-read" })]);
		expect(store.isIndexedOwner("term-transient-read", "session-a")).toBe(true);
		faults.clear();
		// The retained path resolves the durable record again without a rescan.
		expect(store.getIndexed("term-transient-read")).toEqual(initial);

		// The next successful refresh reports the preserved record normally.
		const recovered = store.refreshIndex();
		expect(recovered.ok).toBe(true);
		expect(recovered.snapshots.map((task) => task.id).sort()).toEqual(["term-healthy", "term-transient-read"]);
		expect(recovered.preservedIds).toEqual([]);

		// True corruption still quarantines and prunes the record.
		privateWrite(metaPath, "{not json");
		const corrupt = store.refreshIndex();
		expect(corrupt.ok).toBe(true);
		expect(corrupt.snapshots.map((task) => task.id)).toEqual(["term-healthy"]);
		expect(corrupt.preservedIds).toEqual([]);
		expect(store.listOwnedIndexed("session-a")).toEqual([]);
	});

	it("preserves the indexed entry for exactly the transient read errnos", () => {
		const codes = ["EACCES", "EIO", "EMFILE", "ENFILE", "EAGAIN"];
		const faults = new Map<string, Error>();
		const store = new TerminalTaskStore({ rootDir, metaReadFault: (path) => faults.get(path) });
		const records = codes.map((_code, index) => {
			const record = snapshot(store, `term-transient-${index}`, "session-a", 1_000 + index);
			privateWrite(join(dirname(record.logFile), "meta.json"), `${JSON.stringify(record)}\n`);
			return record;
		});
		expect(store.refreshIndex().snapshots).toHaveLength(codes.length);
		for (const [index, code] of codes.entries()) {
			const metaPath = join(dirname(records[index]!.logFile), "meta.json");
			faults.set(metaPath, transientFault(code));
			const failed = store.refreshIndex();
			expect(failed.ok).toBe(true);
			expect(failed.preservedIds).toEqual([records[index]!.id]);
			expect(store.isIndexedOwner(records[index]!.id, "session-a")).toBe(true);
			faults.delete(metaPath);
		}
		// A non-errno injected failure is not transient: the record quarantines.
		const lastPath = join(dirname(records[0]!.logFile), "meta.json");
		faults.set(lastPath, new Error("injected non-errno failure"));
		const invalid = store.refreshIndex();
		expect(invalid.preservedIds).toEqual([]);
		expect(invalid.snapshots).toHaveLength(codes.length - 1);
		expect(store.isIndexedOwner(records[0]!.id, "session-a")).toBe(false);
	});

	it("refreshes the compact indexed entry from the locked snapshot when the update no-ops", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-noop-index");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		store.transition(initial.id, 1, (current) => ({ ...current, title: "advanced", updatedAt: 2_000 }));
		// An external writer advances the record again; this store's compact
		// candidate still shows the pre-external revision until a locked decision
		// rereads the record.
		const external = new TerminalTaskStore({ rootDir });
		external.refreshIndex();
		external.transition(initial.id, 2, (current) => ({ ...current, title: "external", updatedAt: 3_000 }));
		expect(store.listOwnedIndexed("session-a")[0]?.revision).toBe(2);

		// A locked no-op decision returns the authoritative snapshot unchanged and
		// refreshes that record's compact entry from it.
		expect(store.transition(initial.id, 3, () => undefined)).toMatchObject({ revision: 3, title: "external" });
		expect(store.listOwnedIndexed("session-a")[0]).toMatchObject({ revision: 3, updatedAt: 3_000 });
	});

	it("answers isIndexedOwner from the compact index with no I/O", () => {
		const reads = { scans: 0, metadata: 0 };
		const store = new TerminalTaskStore({
			rootDir,
			onRead: (kind) => { reads[kind === "full-scan" ? "scans" : "metadata"] += 1; },
		});
		const own = snapshot(store, "term-owner", "session-a");
		store.create(own, join(dirname(own.logFile), "meta.json"));
		const foreign = snapshot(store, "term-foreign", "session-b");
		privateWrite(join(dirname(foreign.logFile), "meta.json"), `${JSON.stringify(foreign)}\n`);
		store.refreshIndex();
		reads.scans = 0;
		reads.metadata = 0;

		expect(store.isIndexedOwner("term-owner", "session-a")).toBe(true);
		expect(store.isIndexedOwner("term-owner", "session-b")).toBe(false);
		expect(store.isIndexedOwner("term-foreign", "session-b")).toBe(true);
		expect(store.isIndexedOwner("term-missing", "session-a")).toBe(false);
		// Membership is pure index state: no scan, no metadata read.
		expect(reads).toEqual({ scans: 0, metadata: 0 });
	});

	it("strictly rejects schema-v4 traversal, identity, path, and state invariant violations", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-valid");
		expect(parseTerminalTaskSnapshot(initial)).toEqual(initial);
		expect(parseTerminalTaskSnapshot({ ...initial, id: "term-../escape" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, status: "running", pid: 0, processGroupId: 4, processStartTime: "start" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, status: "running", pid: 4, processGroupId: 4, processStartTime: "" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, deliveryState: "pending" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, deliveryClaimToken: "claim-without-claim" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, processTreeVerification: { members: [] } })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, logFile: "../output.log" })).toBeUndefined();

		const invalid = { ...initial, logFile: join(store.rootDir, "outside.log") };
		privateWrite(join(dirname(initial.logFile), "meta.json"), `${JSON.stringify(invalid)}\n`);
		expect(store.refreshIndex().snapshots).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects symlink/reparse roots, task directories, metadata, and artifacts", () => {
		const canonicalRoot = join(rootDir, "canonical-root");
		mkdirSync(canonicalRoot, { mode: 0o700 });
		chmodSync(canonicalRoot, 0o700);
		const rootLink = join(rootDir, "root-link");
		symlinkSync(canonicalRoot, rootLink, "dir");
		expect(() => new TerminalTaskStore({ rootDir: rootLink })).toThrow(/symlink/);

		const linkedStoreRoot = join(rootDir, "linked-store");
		mkdirSync(linkedStoreRoot, { mode: 0o700 });
		chmodSync(linkedStoreRoot, 0o700);
		const linkedStore = new TerminalTaskStore({ rootDir: linkedStoreRoot });
		const outsideDirectory = join(rootDir, "outside-task");
		mkdirSync(outsideDirectory, { mode: 0o700 });
		chmodSync(outsideDirectory, 0o700);
		symlinkSync(outsideDirectory, join(linkedStore.rootDir, "term-linked-1000"), "dir");
		const linkedDiagnostic = vi.fn();
		expect(new TerminalTaskStore({ rootDir: linkedStore.rootDir, onDiagnostic: linkedDiagnostic }).refreshIndex().snapshots).toEqual([]);
		expect(linkedDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt", message: expect.stringMatching(/symlink|reparse/) }));

		const metadataStoreRoot = join(rootDir, "metadata-store");
		mkdirSync(metadataStoreRoot, { mode: 0o700 });
		chmodSync(metadataStoreRoot, 0o700);
		const metadataDiagnostic = vi.fn();
		const metadataStore = new TerminalTaskStore({ rootDir: metadataStoreRoot, onDiagnostic: metadataDiagnostic });
		const metadataTask = snapshot(metadataStore, "term-meta-link");
		const outsideMeta = join(rootDir, "outside-meta.json");
		privateWrite(outsideMeta, `${JSON.stringify(metadataTask)}\n`);
		symlinkSync(outsideMeta, join(dirname(metadataTask.logFile), "meta.json"));
		expect(metadataStore.refreshIndex().snapshots).toEqual([]);
		expect(metadataDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt" }));

		const onDiagnostic = vi.fn();
		const store = new TerminalTaskStore({ rootDir, onDiagnostic });
		const initial = snapshot(store, "term-link");
		rmSync(initial.logFile);
		const outside = join(store.rootDir, "outside.log");
		privateWrite(outside, "secret");
		symlinkSync(outside, initial.logFile);
		privateWrite(join(dirname(initial.logFile), "meta.json"), `${JSON.stringify(initial)}\n`);

		expect(store.refreshIndex().snapshots).toEqual([]);
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt" }));
	});

	it("logically quarantines corrupt and legacy records without overwriting them", () => {
		const onDiagnostic = vi.fn();
		const store = new TerminalTaskStore({ rootDir, onDiagnostic });
		const corruptDir = join(store.rootDir, "corrupt");
		const legacyDir = join(store.rootDir, "legacy");
		mkdirSync(corruptDir, { mode: 0o700 });
		mkdirSync(legacyDir, { mode: 0o700 });
		chmodSync(corruptDir, 0o700);
		chmodSync(legacyDir, 0o700);
		const corruptPath = join(corruptDir, "meta.json");
		const legacyPath = join(legacyDir, "meta.json");
		privateWrite(corruptPath, "{not json");
		privateWrite(legacyPath, JSON.stringify({ schemaVersion: 3, id: "bg-old" }));

		expect(store.refreshIndex().snapshots).toEqual([]);
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt", path: corruptPath }));
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "legacy", path: legacyPath }));
		expect(readFileSync(corruptPath, "utf8")).toBe("{not json");
		expect(existsSync(legacyPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("enforces 0700 directories and 0600 metadata under a permissive umask", () => {
		const previousUmask = process.umask(0);
		try {
			const store = new TerminalTaskStore({ rootDir });
			const initial = snapshot(store, "term-modes");
			const metaPath = join(dirname(initial.logFile), "meta.json");
			store.create(initial, metaPath);
			expect(lstatSync(store.rootDir).mode & 0o777).toBe(0o700);
			expect(lstatSync(dirname(initial.logFile)).mode & 0o777).toBe(0o700);
			expect(lstatSync(metaPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("never opens an ABA gap when a stale lock is replaced before takeover", () => {
		let lockPath = "";
		let replaced = false;
		const store = new TerminalTaskStore({
			rootDir,
			lockTimeoutMs: 30,
			lockPollMs: 1,
			beforeAbandonedLockRename: () => {
				if (replaced) return;
				replaced = true;
				rmSync(lockPath, { recursive: true, force: true });
				mkdirSync(lockPath, { mode: 0o700 });
				chmodSync(lockPath, 0o700);
				privateWrite(join(lockPath, "owner.json"), `${JSON.stringify({ token: "replacement", pid: process.pid, verifiable: false })}\n`);
			},
		});
		const initial = snapshot(store, "term-lock-aba");
		const metaPath = join(dirname(initial.logFile), "meta.json");
		store.create(initial, metaPath);
		lockPath = join(dirname(metaPath), ".meta.lock");
		mkdirSync(lockPath, { mode: 0o700 });
		chmodSync(lockPath, 0o700);
		privateWrite(join(lockPath, "owner.json"), `${JSON.stringify({ token: "dead", pid: 2_147_483_647, processStartTime: "old", verifiable: true })}\n`);

		expect(() => store.transition(initial.id, 1, (current) => ({ ...current, title: "unsafe", updatedAt: 2_000 }))).toThrow(TerminalTaskLockBusyError);
		expect(new TerminalTaskStore({ rootDir }).refreshIndex().snapshots.find((task) => task.id === initial.id)).toMatchObject({ revision: 1, title: "tests" });
		expect(readdirSync(dirname(metaPath)).some((name) => name.startsWith(".meta.lock.takeover-"))).toBe(true);
	});

	it("breaks only an abandoned lock whose dead owner is proven", () => {
		const store = new TerminalTaskStore({ rootDir, lockTimeoutMs: 30, lockPollMs: 1 });
		const initial = snapshot(store, "term-lock");
		const metaPath = join(dirname(initial.logFile), "meta.json");
		store.create(initial, metaPath);
		const lockDir = join(dirname(metaPath), ".meta.lock");
		mkdirSync(lockDir, { mode: 0o700 });
		chmodSync(lockDir, 0o700);
		privateWrite(join(lockDir, "owner.json"), `${JSON.stringify({ token: "dead", pid: 2_147_483_647, processStartTime: "old", verifiable: true })}\n`);
		expect(store.transition(initial.id, 1, (current) => ({ ...current, title: "recovered", updatedAt: 2_000 })).title).toBe("recovered");
		expect(existsSync(lockDir)).toBe(false);

		mkdirSync(lockDir, { mode: 0o700 });
		chmodSync(lockDir, 0o700);
		privateWrite(join(lockDir, "owner.json"), `${JSON.stringify({ token: "live-unverified", pid: process.pid, verifiable: false })}\n`);
		expect(() => store.transition(initial.id, 2, (current) => ({ ...current, title: "unsafe", updatedAt: 3_000 }))).toThrow(TerminalTaskLockBusyError);
		expect(existsSync(lockDir)).toBe(true);
	});
});
