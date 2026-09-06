import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { createRetainedHeadlessLaunchGate } from "./retained-supervisor.js";
import { censusRetained } from "./retained-census.js";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "retained-census-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task"); mkdirSync(taskDir, { mode: 0o700 });
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: { token: "writer", pid: process.pid, processStartTime: "birth" }, inspectWriter: () => "alive",
	});
	const initial: SubagentRecord = { schemaVersion: 2, revision: 1, id: "sa-census", ownerSessionId: "origin", backend: "headless",
		status: "starting", taskDir, child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null,
		roleId: null, createdAt: 1, updatedAt: 1, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0 };
	const operations: ProcessTreeOperations = {
		census: vi.fn<NonNullable<ProcessTreeOperations["census"]>>(() => [{ pid: 42, processGroupId: 42, processStartTime: "birth" }]),
		captureStartTime: vi.fn(() => "command"), identityMatches: vi.fn(() => "same" as const), verificationMatches: vi.fn(() => "same" as const),
		captureTreeVerification: (identity) => ({ members: [{ pid: identity.pid, processStartTime: "birth" }] }),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: vi.fn(async () => true),
	};
	const gate = createRetainedHeadlessLaunchGate(registry, initial, {
		identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "command" },
		verification: { members: [{ pid: process.pid, processStartTime: "birth" }] },
	}, operations);
	return { registry, gate, operations, initial, census: () => censusRetained(registry, operations)[0] };
}

it("persists admission before spawn and never promotes a nonce census hint to cleanup authority", () => {
	const f = fixture();
	expect(f.census().launch).toBe("never-launched");
	const nonce = f.gate.beforeSpawn();
	expect(nonce).toEqual(expect.any(String));
	if (!nonce) throw new Error("missing persisted nonce");
	const before = f.registry.get(f.initial.id)!;
	expect(before).toMatchObject({ launchIntent: { nonce }, child: null, status: "starting" });
	vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 42, processStartTime: "birth", anchorNonce: nonce }]);
	expect(f.census()).toMatchObject({ launch: "launched-unknown", members: [{ pid: 42 }] });
	vi.mocked(f.operations.census!).mockReturnValue([]);
	expect(f.census().launch).toBe("launched-unknown");
	expect(f.registry.get(f.initial.id)).toEqual(before);
	expect(f.operations.captureStartTime).not.toHaveBeenCalled();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
	expect(() => f.registry.transition(before.id, before.revision, before.writerLease!.generation, (record) => ({ ...record, launchIntent: null }))).toThrow("preserved");
	expect(() => f.gate.beforeSpawn()).toThrow("already used");
});

it.each(["missing", "throws", "reused", "moved", "unknown", "nonempty"] as const)("fails closed on %s census evidence", (fault) => {
	const f = fixture(); f.gate.beforeSpawn(); f.gate.beforePrompt(42);
	const before = f.registry.get(f.initial.id);
	if (fault === "missing") vi.mocked(f.operations.census!).mockReturnValue(undefined);
	if (fault === "throws") vi.mocked(f.operations.census!).mockImplementation(() => { throw new Error("denied"); });
	if (fault === "reused") vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 42, processStartTime: "other" }]);
	if (fault === "moved") vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 43, processStartTime: "birth" }]);
	if (fault === "unknown") vi.mocked(f.operations.verificationMatches!).mockReturnValue("unknown");
	if (fault === "nonempty") vi.mocked(f.operations.census!).mockReturnValue([]);
	expect(f.census().launch).toBe("ambiguous");
	expect(f.registry.get(f.initial.id)).toEqual(before);
	expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("enumerates same-group children while the anchor remains after Pi exits", () => {
	const f = fixture(); f.gate.beforeSpawn(); f.gate.beforePrompt(42);
	vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 42, processStartTime: "birth" }, { pid: 43, processGroupId: 42, processStartTime: "pi-birth" }, { pid: 99, processGroupId: 99, processStartTime: "foreign" }]);
	expect(f.census().members?.map((member) => member.pid)).toEqual([42, 43]);
	vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 42, processStartTime: "birth" }]);
	expect(f.census().launch).toBe("verified");
	vi.mocked(f.operations.census!).mockReturnValue([]);
	vi.mocked(f.operations.isTreeEmpty).mockReturnValue(true);
	expect(f.census().launch).toBe("empty");
});
