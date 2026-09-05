import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { createPiChildSpawner } from "./backend-pi.js";
import { SubagentRegistry, type RegistryProcess, type SubagentRecord } from "./registry.js";
import { createRetainedHeadlessLaunchGate } from "./retained-supervisor.js";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-launch-gate-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	let now = 1000;
	const supervisor: RegistryProcess = {
		identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "supervisor-command" },
		verification: { members: [{ pid: process.pid, processStartTime: "supervisor-birth" }] },
	};
	const registry = new SubagentRegistry(join(root, "registry"), "session-a", {
		now: () => now,
		writerIdentity: { token: "owner", pid: process.pid, processStartTime: "supervisor-birth" },
		inspectWriter: () => "alive",
	});
	const record: SubagentRecord = {
		schemaVersion: 1, revision: 1, id: "sa-proof", ownerSessionId: "session-a",
		backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null,
		modelLabel: null, roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null,
	};
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn(() => "child-command"),
		identityMatches: vi.fn(() => "same" as const),
		captureTreeVerification: vi.fn((identity) => ({ members: [{ pid: identity.pid, processStartTime: "child-birth" }] })),
		verificationMatches: vi.fn(() => "same" as const),
		isTreeEmpty: vi.fn(() => false),
		signalTree: vi.fn(async () => ({ ok: true, gone: false })),
		waitForTreeEmpty: vi.fn(async () => false),
	};
	return { registry, record, supervisor, operations, setNow: (value: number) => { now = value; } };
}

describe("retained supervisor headless launch admission", () => {
	it("drives the production backend gate: starting at spawn and durable running at stdin write", async () => {
		const f = fixture();
		const proc = Object.assign(new EventEmitter(), {
			pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
			stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn(() => {
				expect(f.registry.get("sa-proof")).toMatchObject({ status: "running", child: { identity: { pid: 4242 } } });
			}) }, kill: vi.fn(),
		});
		const spawn = vi.fn(() => {
			expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", supervisor: f.supervisor, child: null });
			return proc;
		});
		const launchGate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		// SAFETY: this fake implements the backend's piped child-process surface; no process is launched.
		const child = createPiChildSpawner(spawn as never, () => undefined, () => "/selected/pi")({
			prompt: "private λ", cwd: f.record.taskDir, inherited: {}, launchGate,
		});
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend explicitly exposes callback or AsyncIterable events.
		if (typeof child.events !== "function") throw new Error("expected callback backend");
		child.events(() => {});
		expect(proc.stdin.write).not.toHaveBeenCalled();
		proc.emit("spawn");
		await child.ready;
		expect(proc.stdin.write).toHaveBeenCalledExactlyOnceWith("private λ");
		expect(spawn).toHaveBeenCalledTimes(1);
		proc.emit("close", 0);
	});

	it("persists starting and the supervisor before spawn, then child anchors before release", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", supervisor: f.supervisor, child: null });
		gate.beforeSpawn();
		expect(f.registry.get("sa-proof")?.status).toBe("starting");
		gate.beforePrompt(4242);
		expect(f.registry.get("sa-proof")).toMatchObject({
			status: "running", child: { identity: { pid: 4242, processGroupId: 4242, processStartTime: "child-command" }, verification: { members: [{ pid: 4242, processStartTime: "child-birth" }] } },
		});
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expect(() => gate.beforeSpawn()).toThrow(/already used/);
		expect(() => gate.beforePrompt(4242)).toThrow(/unavailable/);
	});

	for (const cut of ["before spawn", "before release"] as const) {
		for (const refusal of ["revision", "expiry", "supervisor death", "corrupt record"] as const) {
			it(`refuses ${refusal} ${cut} without capture, release or signals`, () => {
				const f = fixture();
				const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
				if (cut === "before release") gate.beforeSpawn();
				const record = f.registry.get("sa-proof")!;
				if (refusal === "revision") f.registry.acquireWriter(record.id, record.revision, 60_000);
				if (refusal === "expiry") f.setNow(61_000);
				if (refusal === "supervisor death") f.operations.identityMatches = () => "different";
				if (refusal === "corrupt record") writeFileSync(join(f.record.taskDir, "..", "registry", "sa-proof.json"), "{broken", { mode: 0o600 });
				expect(() => cut === "before spawn" ? gate.beforeSpawn() : gate.beforePrompt(4242)).toThrow();
				expect(f.operations.captureStartTime).not.toHaveBeenCalled();
				expect(f.operations.signalTree).not.toHaveBeenCalled();
			});
		}
	}

	it("refuses expiry during OS capture without publishing child authority", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		gate.beforeSpawn();
		f.operations.captureTreeVerification = () => {
			f.setNow(61_000);
			return { members: [{ pid: 4242, processStartTime: "child-birth" }] };
		};
		expect(() => gate.beforePrompt(4242)).toThrow(/expired/);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", child: null });
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});

	it("preserves captured child anchors when final identity verification refuses release", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		gate.beforeSpawn();
		f.operations.identityMatches = (identity) => identity.pid === 4242 ? "unknown" : "same";
		expect(() => gate.beforePrompt(4242)).toThrow(/ambiguous/);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", child: { identity: { pid: 4242 } } });
		expect(() => gate.beforePrompt(4242)).toThrow(/unavailable/);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});

	it("does not create a record for a foreign supervisor or visible backend", () => {
		const f = fixture();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, { ...f.record, backend: "visible" }, f.supervisor, f.operations)).toThrow();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, f.record, { ...f.supervisor, identity: { ...f.supervisor.identity, pid: process.pid + 1 } }, f.operations)).toThrow();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, f.record, { ...f.supervisor, identity: { ...f.supervisor.identity, processGroupId: process.pid + 1 } }, f.operations)).toThrow();
		expect(f.registry.get("sa-proof")).toBeUndefined();
	});
});
