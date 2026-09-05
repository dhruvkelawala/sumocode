import { chmodSync, mkdtempSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";

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
