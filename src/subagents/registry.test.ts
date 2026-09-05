import { chmodSync, mkdtempSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SubagentRegistry, type SubagentRecord, type RegistryWriter } from "./registry.js";

const writerA: RegistryWriter = { token: "writer-a", pid: 101, processStartTime: "birth-a" };
const writerB: RegistryWriter = { token: "writer-b", pid: 102, processStartTime: "birth-b" };

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
		completionId: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null,
	};
	return { root, directory, record };
}

describe("SubagentRegistry writer CAS", () => {
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

describe("SubagentRegistry private records", () => {
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
