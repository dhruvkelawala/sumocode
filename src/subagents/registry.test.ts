import * as fs from "node:fs";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentRegistry, type SubagentRecord, type RegistryWriter } from "./registry.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- OS fault seam: private fixtures use real fs except explicitly injected ownership/rename failures.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

const writerA: RegistryWriter = { token: "writer-a", pid: 101, processStartTime: "birth-a" };
const writerB: RegistryWriter = { token: "writer-b", pid: 102, processStartTime: "birth-b" };

function foreignOwner(path: string): void {
	const lstat = fs.lstatSync;
	vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
		const stat = lstat(...args);
		if (stat && args[0] === path) stat.uid = Number(stat.uid) + 1;
		return stat;
	});
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-registry-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const directory = join(root, "registry");
	const record: SubagentRecord = {
		schemaVersion: 1, revision: 1, id: "sa-proof", ownerSessionId: "session-a",
		backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null,
		modelLabel: null, roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null,
	};
	return { root, directory, record };
}

describe("SubagentRegistry writer CAS", () => {
	it("uses epoch deadlines, refuses rollback and fences old generations after renewal", () => {
		const { directory, record } = fixture();
		let now = 1000;
		const registry = new SubagentRegistry(directory, "session-a", { now: () => now, writerIdentity: writerA, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		now = 999;
		expect(() => registry.acquireWriter(record.id, 2, 100)).toThrow(/clock/);
		now = 1100;
		expect(() => registry.transition(record.id, 2, 1, (r) => r)).toThrow(/expired/);
		const renewed = registry.acquireWriter(record.id, 2, 100);
		expect(renewed.writerLease).toMatchObject({ generation: 2, renewedAt: 1100, expiresAt: 1200 });
		expect(() => registry.transition(record.id, 3, 1, (r) => r)).toThrow(/lease/);
		expect(() => registry.transition(record.id, 3, 2, (r) => { now = 1200; return r; })).toThrow(/expired/);
		expect(registry.get(record.id)?.revision).toBe(3);
		for (const duration of [0, -1, 0.1, NaN, Infinity, 60001]) expect(() => registry.acquireWriter(record.id, 3, duration)).toThrow();
		now = NaN;
		expect(() => registry.acquireWriter(record.id, 3, 100)).toThrow(/clock/);
	});

	it("checks PID/birth/token together and rejects unverifiable candidates", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		a.create(record);
		a.acquireWriter(record.id, 1, 100);
		for (const changed of [{ token: "different" }, { pid: 103 }, { processStartTime: "reused-pid" }]) {
			const contender = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: { ...writerA, ...changed } });
			expect(() => contender.transition(record.id, 2, 1, (r) => r)).toThrow(/lease/);
		}
		const unknown = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA, inspectWriter: () => "unknown" });
		expect(() => unknown.acquireWriter(record.id, 2, 100)).toThrow(/identity/);
		const wrongOwner = new SubagentRegistry(directory, "session-b", { ...options, writerIdentity: writerA });
		expect(() => wrongOwner.acquireWriter(record.id, 2, 100)).toThrow(/owner/);
	});

	it("uses the existing kernel birth probe, never a PID-only writer credential", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { now: () => 1000 });
		registry.create(record);
		const forged = new SubagentRegistry(directory, "session-a", { now: () => 1000, writerIdentity: { token: "forged", pid: process.pid, processStartTime: "wrong birth" } });
		expect(() => forged.acquireWriter(record.id, 1, 100)).toThrow(/identity/);
		const acquired = registry.acquireWriter(record.id, 1, 100);
		expect(acquired.writerLease?.owner.pid).toBe(process.pid);
		expect(acquired.writerLease?.owner.processStartTime).not.toBe("wrong birth");
	});

	it("holds the disk lock through the callback, rejecting a competing store before either writes", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", options);
		const b = new SubagentRegistry(directory, "session-a", options);
		a.create(record);
		a.acquireWriter(record.id, 1, 100);
		const result = a.transition(record.id, 2, 1, (r) => {
			expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lock/);
			expect(b.get(record.id)?.revision).toBe(2);
			return { ...r, roleId: "winner" };
		});
		expect(result.revision).toBe(3);
		expect(b.get(record.id)?.roleId).toBe("winner");
	});

	it("preserves durable process/worktree/completion evidence and keeps unknown recovery truthful", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const registry = new SubagentRegistry(directory, "session-a", options);
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" }, verification: { members: [{ pid: 200, processStartTime: "birth" }] } };
		const supervisor = { identity: { pid: 201, processGroupId: 201, processStartTime: "supervisor + nonce" }, verification: { members: [{ pid: 201, processStartTime: "supervisor" }] } };
		registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "running", child, supervisor, worktree: { path: record.taskDir, repoRoot: record.taskDir, baseRef: "base", branch: "sumo/proof" } }));
		const lost = registry.transition(record.id, 3, 1, (r) => ({ ...r, status: "lost" }));
		expect(lost).toMatchObject({ child, supervisor, completionId: null, outcome: null, settledAt: null, result: null });
		expect(() => registry.transition(record.id, 4, 1, (r) => ({ ...r, child: null }))).toThrow(/preserved/);
		expect(() => registry.transition(record.id, 4, 1, (r) => ({ ...r, ownerSessionId: "other" }))).toThrow(/immutable/);
		const settled = registry.transition(record.id, 4, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, outcome: "failed", completionId: "completion-1", delivery: { state: "pending", claim: null } }));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(settled);
		expect(() => registry.transition(record.id, 5, 1, (r) => ({ ...r, completionId: "completion-2" }))).toThrow(/preserved/);
		const ambiguous = registry.transition(record.id, 5, 1, (r) => ({ ...r, status: "ambiguous" }));
		expect(ambiguous.completionId).toBe("completion-1");
	});

	it("fences competing revisions and generations; expiry alone never evicts a live writer", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let oldState: "alive" | "dead" | "unknown" = "alive";
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === writerA.token ? oldState : "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const b = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		a.create(record);
		const first = a.acquireWriter(record.id, 1, 100);
		expect(first.revision).toBe(2);
		expect(first.writerLease).toEqual({ owner: writerA, generation: 1, renewedAt: 1000, expiresAt: 1100 });
		expect(() => b.acquireWriter(record.id, 1, 100)).toThrow(/revision/);
		expect(() => b.transition(record.id, 2, 1, (r) => ({ ...r, roleId: "reviewer" }))).toThrow(/lease/);
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "dead";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		now = 1100;
		oldState = "alive";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "unknown";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "dead";
		const second = b.acquireWriter(record.id, 2, 100);
		expect(second.revision).toBe(3);
		expect(second.writerLease?.generation).toBe(2);
		expect(() => a.transition(record.id, 3, 1, (r) => r)).toThrow(/lease/);
		const updated = b.transition(record.id, 3, 2, (r) => ({ ...r, roleId: "reviewer" }));
		expect(updated).toMatchObject({ revision: 4, updatedAt: 1100, roleId: "reviewer" });
		expect(() => b.transition(record.id, 3, 2, (r) => r)).toThrow(/revision/);
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(updated);
	});
});

afterEach(() => { vi.restoreAllMocks(); });

describe("SubagentRegistry private records", () => {
	it("refuses launched evidence at creation and completion claims without an observed outcome", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + launch nonce" }, verification: { members: [{ pid: 200, processStartTime: "birth" }] } };
		expect(() => registry.create({ ...record, child })).toThrow();
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, completionId: "completion-a", delivery: { state: "pending", claim: null } }))).toThrow(/schema/);
		expect(registry.get(record.id)?.revision).toBe(2);
	});

	it.each([
		{ schemaVersion: 2 }, { revision: 0 }, { revision: 1.5 }, { id: "sa-other" },
		{ prompt: "private prompt must not be metadata" }, { "": "hidden payload" }, { status: "done" },
		{ backend: {} }, { createdAt: -1 }, { updatedAt: 999 }, { completionId: "fake" },
		{ delivery: { state: "claimed", claim: null } }, { child: { identity: { pid: 2 } } },
		{ modelLabel: "x".repeat(4097) }, { taskDir: "/tmp/../escape" },
		{ result: { file: "../result.json", bytes: 0 } }, { manifest: { file: "manifest.json", bytes: 4194305 } },
	])("preserves and refuses corrupt schema %j on read and write", (patch) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		const corrupt = JSON.stringify({ ...record, ...patch });
		writeFileSync(path, corrupt, { mode: 0o600 });
		expect(() => registry.get(record.id)).toThrow();
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(corrupt);
	});

	it("refuses truncated and oversized documents without replacing their evidence", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		for (const content of ["{", " ".repeat(262145)]) {
			writeFileSync(path, content);
			expect(() => registry.get(record.id)).toThrow();
			expect(() => registry.create(record)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(content);
		}
	});

	it("refuses symlinked roots, ancestors, records, task directories and result artifacts", () => {
		const { root, directory, record } = fixture();
		const alias = join(root, "alias");
		symlinkSync(root, alias);
		expect(() => new SubagentRegistry(alias, "session-a")).toThrow();
		expect(() => new SubagentRegistry(join(alias, "new-registry"), "session-a")).toThrow();
		const registry = new SubagentRegistry(directory, "session-a");
		const target = join(root, "foreign.json");
		writeFileSync(target, "untouched", { mode: 0o600 });
		symlinkSync(target, join(directory, "sa-proof.json"));
		expect(() => registry.create(record)).toThrow();
		expect(() => registry.get(record.id)).toThrow();
		expect(() => registry.create({ ...record, id: "sa-alias", taskDir: alias })).toThrow();
		expect(readFileSync(target, "utf8")).toBe("untouched");
	});

	it("refuses widened and foreign-owned paths rather than chmod-repairing them", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		chmodSync(path, 0o644);
		expect(() => registry.get(record.id)).toThrow();
		expect(statSync(path).mode & 0o777).toBe(0o644);
		chmodSync(path, 0o600);
		foreignOwner(path);
		expect(() => registry.get(record.id)).toThrow(/owned/);
		vi.restoreAllMocks();
		chmodSync(directory, 0o755);
		expect(() => new SubagentRegistry(directory, "session-a")).toThrow();
		expect(statSync(directory).mode & 0o777).toBe(0o755);
	});

	it("preserves foreign-owned lock evidence instead of reclaiming it by PID", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const path = join(directory, "sa-proof.json.lock");
		const content = JSON.stringify({ schemaVersion: 1, token: "foreign", pid: process.pid, processStartTime: "not-current-birth" });
		writeFileSync(path, content, { mode: 0o600 });
		foreignOwner(path);
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/owned/);
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(registry.get(record.id)?.revision).toBe(1);
	});

	it.each([false, true])("reopens the atomic canonical revision after rename failure (committed=%s), retaining crash debris", (committed) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const debris = join(directory, ".crashed-writer.tmp");
		writeFileSync(debris, "{partial", { mode: 0o600 });
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (to !== join(directory, "sa-proof.json")) return rename(from, to);
			if (committed) rename(from, to);
			throw new Error("injected rename failure");
		});
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/injected/);
		vi.restoreAllMocks();
		const reopened = new SubagentRegistry(directory, "session-a").get(record.id);
		expect(reopened?.revision).toBe(committed ? 2 : 1);
		expect(reopened?.writerLease?.generation ?? null).toBe(committed ? 1 : null);
		expect(readFileSync(debris, "utf8")).toBe("{partial");
		expect(readdirSync(directory)).toContain(".crashed-writer.tmp");
	});

	it("round-trips bounded private result pointers, rejecting replaced or missing evidence", () => {
		const { root, directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const content = JSON.stringify({ finalText: "private result" });
		const resultPath = join(record.taskDir, "result.json");
		writeFileSync(resultPath, content, { mode: 0o600 });
		const result = { file: "result.json" as const, bytes: Buffer.byteLength(content) };
		const settled = registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, outcome: "completed", completionId: "completion-1", delivery: { state: "pending", claim: null }, result }));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(settled);
		expect(readFileSync(join(directory, "sa-proof.json"), "utf8")).not.toContain("private result");
		fs.renameSync(resultPath, join(root, "preserved-result.json"));
		expect(() => registry.get(record.id)).toThrow();
		symlinkSync(join(root, "preserved-result.json"), resultPath);
		expect(() => registry.get(record.id)).toThrow(/regular/);
		expect(readFileSync(join(root, "preserved-result.json"), "utf8")).toBe(content);
	});

	it.each(["{", JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, token: "broken", pid: -1 })])("preserves corrupt lock %s without attempting takeover", (content) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json.lock");
		writeFileSync(path, content, { mode: 0o600 });
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(registry.get(record.id)?.revision).toBe(1);
	});

	it.each([
		{ generation: 0, owner: writerA, renewedAt: 1000, expiresAt: 1100 },
		{ generation: 1, owner: { ...writerA, processStartTime: null }, renewedAt: 1000, expiresAt: 1100 },
		{ generation: 1, owner: writerA, renewedAt: 1000, expiresAt: 1000 },
		{ generation: 1, owner: writerA, renewedAt: 1001, expiresAt: 1100 },
	])("refuses corrupt durable writer leases %j", (writerLease) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		const content = JSON.stringify({ ...record, writerLease });
		writeFileSync(path, content);
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/corrupt/);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("preserves visible pane/session references and a lost record whose task directory is gone", () => {
		const { root, directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		const pane = { agentName: "worker", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1" };
		registry.create({ ...record, backend: "visible", pane, sessionFilePath: join(record.taskDir, "session.jsonl") });
		registry.acquireWriter(record.id, 1, 100);
		const lost = registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "lost" }));
		fs.renameSync(record.taskDir, join(root, "preserved-task"));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(lost);
		expect(lost).toMatchObject({ pane, child: null, supervisor: null, completionId: null, outcome: null });
	});

	it.each([
		[{ pid: 200, processStartTime: "birth" }, { pid: 200, processStartTime: "duplicate" }],
		[{ pid: 201, processStartTime: "not-leader" }],
		[{ pid: 200, processStartTime: "" }],
		[],
	].map((members) => ({ members })))("rejects incomplete or duplicate process anchors %j", ({ members }) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" }, verification: { members } };
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, child }))).toThrow(/schema/);
		expect(registry.get(record.id)?.child).toBeNull();
	});

	it("bounds the serialized document, including atomic writer formatting, before publication", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = {
			identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" },
			verification: { members: Array.from({ length: 2200 }, (_, index) => ({ pid: 200 + index, processStartTime: "b".repeat(64) })) },
		};
		expect(Buffer.byteLength(JSON.stringify({ ...record, child }))).toBeLessThan(262144);
		expect(Buffer.byteLength(JSON.stringify({ ...record, child }, null, 2))).toBeGreaterThan(262144);
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, child }))).toThrow(/schema/);
		expect(registry.get(record.id)?.revision).toBe(2);
	});

	it("requires a private parent so another user cannot rename the registry during a write", () => {
		const { root, directory } = fixture();
		chmodSync(root, 0o777);
		try { expect(() => new SubagentRegistry(directory, "session-a")).toThrow(); }
		finally { chmodSync(root, 0o700); }
	});

	it("round-trips a versioned unlaunched record without inventing process or completion evidence", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		expect(registry.create(record)).toEqual(record);
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(record);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(directory, "sa-proof.json")).mode & 0o777).toBe(0o600);
		expect(() => registry.create(record)).toThrow();
		expect(() => new SubagentRegistry(directory, "session-b").get(record.id)).toThrow(/owner/);
	});
});
