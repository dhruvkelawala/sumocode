import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { reconstructRetained } from "./retained-adoption.js";
import { RetainedResults } from "./retained-results.js";

afterEach(() => vi.useRealTimers());

function fixture() {
	vi.useFakeTimers(); vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "adoption-race-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task"); mkdirSync(taskDir, { mode: 0o700 });
	new RetainedResults(taskDir).append({ kind: "run-started" });
	const writer = { token: "writer", pid: 10001, processStartTime: "writer-birth" };
	const old = { token: "old", pid: 10002, processStartTime: "old-birth" };
	const next = { token: "next", pid: 10003, processStartTime: "next-birth" };
	let oldAlive = true;
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: writer, inspectWriter: (owner) => owner.token === "old" && !oldAlive ? "dead" : "alive",
	});
	const tree = (pid: number, birth: string) => ({ identity: { pid, processGroupId: pid, processStartTime: birth },
		verification: { members: [{ pid, processStartTime: birth }] } });
	let record: SubagentRecord = registry.create({ schemaVersion: 2, revision: 1, id: "sa-race", ownerSessionId: "origin",
		backend: "visible", status: "starting", taskDir, child: null, supervisor: null, pane: null, worktree: null,
		sessionFilePath: null, modelLabel: null, roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null }, result: null, manifest: null,
		writerLease: null, controlLease: null, controlHead: 0 });
	record = registry.acquireWriter(record.id, record.revision, 60_000);
	record = registry.transition(record.id, record.revision, record.writerLease!.generation, (current) => ({ ...current,
		status: "running", child: tree(4242, "child-birth"), supervisor: tree(writer.pid, writer.processStartTime),
		pane: { agentName: "worker", paneId: "pane-1" }, telemetry: { startedAt: 1000, lastProgressAt: null } }));
	record = registry.acquireControl(record.id, record.revision, record.writerLease!.generation, record.controlHead, old, 1000);
	oldAlive = false; vi.setSystemTime(2001);
	const operations: ProcessTreeOperations = {
		census: () => [record.supervisor!.identity, record.child!.identity], captureStartTime: vi.fn(),
		identityMatches: vi.fn(() => "same" as const), verificationMatches: vi.fn(() => "same" as const),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async () => ({ ok: false, gone: false })),
		waitForTreeEmpty: vi.fn(async () => false),
	};
	const update = (change: (current: SubagentRecord) => SubagentRecord) => {
		const current = registry.get(record.id)!;
		return registry.transition(current.id, current.revision, current.writerLease!.generation, change);
	};
	const recover = (duringInspection: () => void) => {
		const host: TerminalHost = { kind: "herdr", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn(),
			inspectPane: async () => {
				duringInspection();
				return { ok: true, shellPid: 4242, foregroundProcessGroupId: 4242, foregroundPids: [4343] };
			} };
		return reconstructRetained(registry, next, "successor", operations, host,
			{ exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })) });
	};
	return { registry, record, next, operations, update, recover, recordPath: join(root, "registry", `${record.id}.json`) };
}

it.each([false, true])("adopts with writer heartbeat during pane inspection: %s", async (heartbeat) => {
	const f = fixture();
	let inspectedRevision = 0;
	const [result] = await f.recover(() => {
		if (heartbeat) f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
		inspectedRevision = f.registry.get(f.record.id)!.revision;
	});
	expect(inspectedRevision).toBe(f.record.revision + (heartbeat ? 1 : 0));
	if (heartbeat) {
		expect(() => f.registry.forController(f.next).recoverControl(f.record.id, f.record.revision, 0, "stale"))
			.toThrow("revision");
	}
	expect(result).toMatchObject({ classification: "adopted", reason: undefined });
	expect(f.registry.get(f.record.id)).toMatchObject({ writerLease: f.record.writerLease, child: f.record.child,
		supervisor: f.record.supervisor, controllerGeneration: 1, controllerSessionId: "successor",
		revision: inspectedRevision + 1 });
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("accepts repeated fenced telemetry writes without dropping the newest counters", async () => {
	const f = fixture();
	const [result] = await f.recover(() => {
		for (let i = 1; i <= 3; i++) {
			vi.setSystemTime(2001 + i);
			f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastProgressAt: 2001 + i,
				lastHeartbeatAt: 2001 + i, reportedTokens: i * 10, reportedCostUsd: i * 0.01 } }));
		}
	});
	expect(result.classification).toBe("adopted");
	expect(f.registry.get(f.record.id)?.telemetry).toEqual({ startedAt: 1000, lastProgressAt: 2004,
		lastHeartbeatAt: 2004, reportedTokens: 30, reportedCostUsd: 0.03 });
});

it.each(["child", "supervisor", "pane"] as const)("refuses replaced %s evidence during pane inspection", async (field) => {
	const f = fixture();
	let replaced = f.record;
	const [result] = await f.recover(() => {
		f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
		const current = f.registry.get(f.record.id)!;
		replaced = field === "pane" ? { ...current, pane: { ...current.pane!, paneId: "replacement" } }
			: { ...current, [field]: { ...current[field]!, verification: {
				members: [{ pid: current[field]!.identity.pid, processStartTime: "replacement-birth" }] } } };
		// The writer API forbids changing these anchors; model replacement of the stored record.
		writeFileSync(f.recordPath, `${JSON.stringify(replaced)}\n`, { mode: 0o600 });
	});
	expect(result.classification).toBe("ambiguous");
	expect(f.registry.get(f.record.id)).toEqual(replaced);
	expect(result.entry.supervisor).toBeUndefined();
	expect(f.operations.captureStartTime).not.toHaveBeenCalled();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it.each(["writer-generation", "competing-controller", "settling"] as const)("refuses %s change during pane inspection", async (change) => {
	const f = fixture();
	let changed = f.record;
	const [result] = await f.recover(() => {
		if (change === "writer-generation") changed = f.registry.acquireWriter(f.record.id, f.record.revision, 60_000);
		else if (change === "competing-controller") changed = f.registry.forController({ ...f.next, token: "contender" })
			.recoverControl(f.record.id, f.record.revision, 0, "contender-session");
		else changed = f.update((record) => ({ ...record, status: "settling" }));
	});
	expect(result.classification).toBe("ambiguous");
	expect(f.registry.get(f.record.id)).toEqual(changed);
	expect(result.entry.supervisor).toBeUndefined();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it.each(["different", "unknown"] as const)("refuses %s child and supervisor identity after telemetry churn", async (state) => {
	for (const pid of [4242, 10001]) {
		const f = fixture();
		let changed = f.record;
		const [result] = await f.recover(() => {
			changed = f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
			vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === pid ? state : "same");
		});
		expect(result.classification).toBe("ambiguous");
		expect(f.registry.get(f.record.id)).toEqual(changed);
		expect(f.operations.captureStartTime).not.toHaveBeenCalled();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	}
});

it("keeps CAS refusal when another heartbeat follows the fresh read", async () => {
	const f = fixture();
	let checks = 0;
	let changed = f.record;
	const [result] = await f.recover(() => {
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => {
			if (identity.pid === 4242 && ++checks === 2) {
				changed = f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
			}
			return "same";
		});
	});
	expect(checks).toBe(2);
	expect(result.classification).toBe("ambiguous");
	expect(f.registry.get(f.record.id)).toEqual(changed);
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});
