import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { reconstructRetained } from "./retained-adoption.js";
import { RetainedResults } from "./retained-results.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
	const inspectWriter = vi.fn((owner: typeof writer) => owner.token === "old" && !oldAlive ? "dead" as const : "alive" as const);
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: writer, inspectWriter,
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
	return { registry, record, next, operations, inspectWriter, update, recover, recordPath: join(root, "registry", `${record.id}.json`) };
}

function beforeRecovery(f: ReturnType<typeof fixture>, inject: (attempt: number) => void) {
	const forController = SubagentRegistry.prototype.forController;
	let attempts = 0;
	vi.spyOn(SubagentRegistry.prototype, "forController").mockImplementation(function (this: SubagentRegistry, identity) {
		const controller = forController.call(this, identity);
		if (identity.token !== f.next.token) return controller;
		const recoverControl = controller.recoverControl.bind(controller);
		controller.recoverControl = (...args) => {
			// Runs outside the registry lock: the adopter read `fresh` and is about to CAS.
			if (existsSync(`${f.recordPath}.lock`) || controller.get(args[0])!.revision !== args[1]) {
				throw new Error(`test seam expected an unlocked registry at the adopter's read revision: lock=${existsSync(`${f.recordPath}.lock`)} current=${controller.get(args[0])!.revision} arg=${args[1]}`);
			}
			inject(++attempts);
			return recoverControl(...args);
		};
		return controller;
	});
	return () => attempts;
}

it("retries a heartbeat between the final read and real recovery CAS", async () => {
	const f = fixture();
	const attempts = beforeRecovery(f, (attempt) => {
		if (attempt === 1) f.update((record) => ({ ...record, telemetry: { ...record.telemetry!,
			lastHeartbeatAt: 2001, reportedTokens: 42, reportedCostUsd: 0.03 } }));
	});
	const [result] = await f.recover(() => {});
	expect(result.classification).toBe("adopted");
	expect(attempts()).toBe(2);
	expect(f.registry.get(f.record.id)).toMatchObject({ revision: f.record.revision + 2,
		telemetry: { lastHeartbeatAt: 2001, reportedTokens: 42, reportedCostUsd: 0.03 },
		controllerGeneration: 1, controllerSessionId: "successor", writerLease: f.record.writerLease,
		child: f.record.child, supervisor: f.record.supervisor });
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

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

it.each([4242, 10001])("adopts with writer heartbeat during the final anchor check for pid %s", async (pid) => {
	const f = fixture();
	let checks = 0;
	let changed = f.record;
	const [result] = await f.recover(() => {
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => {
			if (identity.pid === pid && ++checks === 2) {
				changed = f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
			}
			return "same";
		});
	});
	expect(checks).toBe(2);
	expect(result.classification).toBe("adopted");
	expect(f.registry.get(f.record.id)).toMatchObject({ telemetry: changed.telemetry,
		revision: changed.revision + 1, controllerGeneration: 1, controllerSessionId: "successor",
		writerLease: f.record.writerLease, child: f.record.child, supervisor: f.record.supervisor });
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("adopts with writer heartbeat during controller liveness inspection", async () => {
	const f = fixture();
	let changed = f.record;
	let injected = false;
	f.inspectWriter.mockImplementation((owner) => {
		if (owner.token !== "old") return "alive";
		if (!injected) {
			injected = true;
			changed = f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
		}
		return "dead";
	});
	const [result] = await f.recover(() => {});
	expect(injected).toBe(true);
	expect(result.classification).toBe("adopted");
	expect(f.registry.get(f.record.id)).toMatchObject({ telemetry: changed.telemetry,
		revision: changed.revision + 1, controllerGeneration: 1, controllerSessionId: "successor",
		writerLease: f.record.writerLease, child: f.record.child, supervisor: f.record.supervisor });
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it.each(["child", "supervisor", "pane", "writer-lease", "control-lease", "controller", "status"] as const)(
	"refuses changed %s during controller liveness inspection", async (field) => {
		const f = fixture();
		let changed = f.record;
		let injected = false;
		f.inspectWriter.mockImplementation((owner) => {
			if (owner.token !== "old") return "alive";
			if (!injected) {
				injected = true;
				const current = f.registry.get(f.record.id)!;
				if (field === "writer-lease") changed = f.registry.acquireWriter(current.id, current.revision, 60_000);
				else if (field === "controller") changed = f.registry.forController({ ...f.next, token: "contender" })
					.recoverControl(current.id, current.revision, 0, "contender-session");
				else if (field === "status") changed = f.update((record) => ({ ...record, status: "settling" }));
				else {
					changed = field === "pane" ? { ...current, pane: { ...current.pane!, paneId: "replacement" } }
						: field === "control-lease" ? { ...current, controlLease: { ...current.controlLease!, expiresAt: 2002 } }
							: { ...current, [field]: { ...current[field]!, verification: {
								members: [{ pid: current[field]!.identity.pid, processStartTime: "replacement-birth" }] } } };
					// Model stored evidence replacement that the writer API forbids.
					writeFileSync(f.recordPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
				}
			}
			return "dead";
		});
		const [result] = await f.recover(() => {});
		expect(injected).toBe(true);
		expect(result.classification).toBe("ambiguous");
		expect(f.registry.get(f.record.id)).toEqual(changed);
		expect(result.entry.supervisor).toBeUndefined();
		expect(f.operations.captureStartTime).not.toHaveBeenCalled();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	},
);

it("keeps exact revision CAS refusal for a heartbeat after the final read", () => {
	const f = fixture();
	const controller = f.registry.forController(f.next);
	const fresh = controller.get(f.record.id)!;
	const changed = f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 } }));
	expect(() => controller.recoverControl(fresh.id, fresh.revision, fresh.controllerGeneration ?? 0, "successor"))
		.toThrow("revision");
	expect(controller.get(f.record.id)).toEqual(changed);
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("stops retrying after three revision conflicts without granting control", async () => {
	const f = fixture();
	const attempts = beforeRecovery(f, (attempt) => {
		// Each heartbeat is later than the last, so every write is a legitimate telemetry update.
		vi.setSystemTime(2001 + attempt);
		f.update((record) => ({ ...record, telemetry: { ...record.telemetry!, lastHeartbeatAt: 2001 + attempt } }));
	});
	const [result] = await f.recover(() => {});
	expect(result.classification).toBe("ambiguous");
	expect(attempts()).toBe(3);
	expect(f.registry.get(f.record.id)?.telemetry?.lastHeartbeatAt).toBe(2004);
	const record = f.registry.get(f.record.id)!;
	expect(record.controlHead).toBe(1);
	expect(record.controllerGeneration).toBeUndefined();
	expect(record.controllerSessionId).toBeUndefined();
	expect(result.entry.supervisor).toBeUndefined();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("does not retry when a replacement controller wins between the read and the CAS", async () => {
	const f = fixture();
	const attempts = beforeRecovery(f, (attempt) => {
		if (attempt === 1) {
			const current = f.registry.get(f.record.id)!;
			f.registry.forController({ ...f.next, token: "contender" }).recoverControl(current.id, current.revision, 0, "contender-session");
		}
	});
	const [result] = await f.recover(() => {});
	expect(result.classification).toBe("ambiguous");
	expect(attempts()).toBe(1);
	expect(f.registry.get(f.record.id)).toMatchObject({ controllerSessionId: "contender-session", controllerGeneration: 1 });
	expect(result.entry.supervisor).toBeUndefined();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});
