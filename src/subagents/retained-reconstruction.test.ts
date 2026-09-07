import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { HostResult, PaneProcessInfo, TerminalHost } from "../terminal-host/types.js";
import type { SubagentEvent } from "./domain.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { controlAuthority, reconstructRetained, verifyRetained } from "./retained-adoption.js";
import { RetainedHeadlessSupervisor } from "./retained-supervisor.js";
import { RetainedResults } from "./retained-results.js";
import { SubagentManager } from "./manager.js";

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
	vi.useFakeTimers(); vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "retained-reconstruction-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task"); mkdirSync(taskDir, { mode: 0o700 });
	const writer = { token: "supervisor", pid: process.pid, processStartTime: "supervisor-birth" };
	const old = { token: "old", pid: 10001, processStartTime: "old-birth" };
	const next = { token: "next", pid: 10002, processStartTime: "next-birth" };
	let oldState: "alive" | "dead" | "unknown" = "dead";
	let writerState: "alive" | "dead" | "unknown" = "alive";
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: writer,
		inspectWriter: (identity) => identity.token === "old" ? oldState : identity.token === "supervisor" ? writerState : "alive",
	});
	const operations: ProcessTreeOperations = {
		census: () => [{ pid: process.pid, processGroupId: process.pid, processStartTime: "supervisor-birth" },
			{ pid: 4242, processGroupId: 4242, processStartTime: "anchor-birth" }],
		captureStartTime: vi.fn(() => "anchor-command"), identityMatches: vi.fn(() => "same" as const),
		verificationMatches: vi.fn(() => "same" as const),
		captureTreeVerification: (identity) => ({ members: [{ pid: identity.pid, processStartTime: "anchor-birth" }] }),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: vi.fn(async () => true),
	};
	const initial: SubagentRecord = { schemaVersion: 2, revision: 1, id: "sa-proof", ownerSessionId: "origin", backend: "headless",
		status: "starting", taskDir, child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null,
		roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0 };
	let emit!: (event: SubagentEvent) => void;
	const send = vi.fn(async (_text: string) => undefined);
	const interrupt = vi.fn(); const close = vi.fn();
	const owner = new RetainedHeadlessSupervisor({ registry, initial,
		supervisor: { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "supervisor-command" },
			verification: { members: [{ pid: process.pid, processStartTime: "supervisor-birth" }] } },
		launch: { prompt: "private prompt", cwd: taskDir, inherited: {}, builtInTools: [] }, baseRef: "HEAD",
	}, { operations, spawn: (options) => {
		options.launchGate!.beforeSpawn(); options.launchGate!.beforePrompt(4242);
		return { events: (listener) => { emit = listener; emit({ kind: "run-started" }); }, send, interrupt, requestClose: close };
	}, buildManifest: async () => ({ exit: "completed", durationMs: 2, baseRef: "HEAD", changedPaths: ["file.ts"], commits: 0 }) });
	await owner.ready;
	oldState = "alive";
	const record = owner.record;
	const granted = registry.acquireControl(record.id, record.revision, record.writerLease!.generation, record.controlHead, old, 1000);
	oldState = "dead";
	vi.setSystemTime(2001);
	disposals.push(() => { vi.mocked(operations.identityMatches).mockReturnValue("unknown"); try { owner.renew(); } catch { /* Fake owner lifetime only. */ } });
	return { registry, owner, next, operations, send, interrupt, close, taskDir, granted,
		recover: () => reconstructRetained(registry, next, "next-session", operations),
		oldState: (state: typeof oldState) => { oldState = state; }, writerState: (state: typeof writerState) => { writerState = state; },
		finish: async () => { emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "durable answer" } }); await owner.settlement; } };
}

it("names every visible pane association refusal using content-free categories", async () => {
	const child = { identity: { pid: 4242, processGroupId: 4242, processStartTime: "anchor-command" },
		verification: { members: [{ pid: 4242, processStartTime: "anchor-birth" }] } };
	const record = { schemaVersion: 2, revision: 1, id: "sa-proof", ownerSessionId: "origin", backend: "visible", status: "running", taskDir: "/private/tmp/task",
		child, supervisor: child, pane: { agentName: "worker", paneId: "pane-1" }, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null, delivery: { state: "none", claim: null }, result: null, manifest: null,
		writerLease: null, controlLease: null, controlHead: 0 } satisfies SubagentRecord;
	const operations = (): ProcessTreeOperations => ({
		captureStartTime: vi.fn(), identityMatches: vi.fn(() => "same" as const), verificationMatches: vi.fn(() => "same" as const),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async () => ({ ok: false, gone: false })), waitForTreeEmpty: vi.fn(async () => false),
	});
	const host = (inspect: () => Promise<HostResult<PaneProcessInfo>>): TerminalHost => ({
		kind: "herdr", inspectPane: inspect, openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn(),
	});
	const associated = (): Promise<HostResult<PaneProcessInfo>> => Promise.resolve({ ok: true, shellPid: 4242, foregroundProcessGroupId: 4242, foregroundPids: [4343] });
	// SAFETY: verification only checks that the executor boundary is present before passing it to the fake host.
	const pi = { exec: vi.fn() } as never;
	const results = [];
	results.push(await verifyRetained({ ...record, pane: { agentName: "worker" } }, operations(), host(associated), pi));
	results.push(await verifyRetained(record, operations(), undefined, pi));
	results.push(await verifyRetained(record, operations(), { ...host(associated), inspectPane: undefined }, pi));
	results.push(await verifyRetained(record, operations(), { ...host(associated), kind: "none" }, pi));
	results.push(await verifyRetained(record, operations(), host(associated)));
	results.push(await verifyRetained(record, operations(), host(async () => { throw new Error("private adapter detail"); }), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: false, error: "private adapter detail" })), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: true, shellPid: 4242, foregroundProcessGroupId: null, foregroundPids: [4242] })), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: true, shellPid: 4242, foregroundProcessGroupId: 99, foregroundPids: [4343] })), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: true, shellPid: null, foregroundProcessGroupId: 4242, foregroundPids: [4343] })), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: true, shellPid: 99, foregroundProcessGroupId: 4242, foregroundPids: [4343] })), pi));
	results.push(await verifyRetained(record, operations(), host(async () => ({ ok: true, shellPid: 4242, foregroundProcessGroupId: 4242, foregroundPids: [] })), pi));
	const members = [{ pid: 4242, processStartTime: "anchor-birth" }];
	const missingRoot = { ...record, child: { ...child, verification: { members } } };
	results.push(await verifyRetained(missingRoot, operations(), host(async () => { members.length = 0; return associated(); }), pi));
	const missingVerifier = operations();
	results.push(await verifyRetained(record, missingVerifier, host(async () => { delete missingVerifier.verificationMatches; return associated(); }), pi));
	for (const observed of ["different", "unknown"] as const) {
		const changed = operations();
		vi.mocked(changed.identityMatches).mockReturnValueOnce("same").mockReturnValue(observed);
		results.push(await verifyRetained(record, changed, host(associated), pi));
	}
	for (const observed of ["different", "unknown"] as const) {
		const changed = operations();
		vi.mocked(changed.verificationMatches!).mockReturnValueOnce("same").mockReturnValue(observed);
		results.push(await verifyRetained(record, changed, host(associated), pi));
	}
	expect(results.map((result) => result.reason)).toEqual([
		{ code: "visible-pane-reference", expected: "pane-id", observed: "missing" },
		{ code: "visible-pane-host", expected: "available", observed: "missing" },
		{ code: "visible-pane-inspector", expected: "available", observed: "missing" },
		{ code: "visible-pane-host", expected: "pane-capable", observed: "none" },
		{ code: "visible-pane-executor", expected: "available", observed: "missing" },
		{ code: "visible-pane-inspection", expected: "verified", observed: "error" },
		{ code: "visible-pane-inspection", expected: "verified", observed: "refused" },
		{ code: "visible-pane-foreground-process-group", expected: "same", observed: "missing" },
		{ code: "visible-pane-foreground-process-group", expected: "same", observed: "different" },
		{ code: "visible-pane-shell-process", expected: "same", observed: "missing" },
		{ code: "visible-pane-shell-process", expected: "same", observed: "different" },
		{ code: "visible-pane-foreground-processes", expected: "present", observed: "missing" },
		{ code: "visible-pane-child-root-recheck", expected: "present", observed: "missing" },
		{ code: "visible-pane-child-verifier-recheck", expected: "available", observed: "missing" },
		{ code: "visible-pane-child-identity-recheck", expected: "same", observed: "different" },
		{ code: "visible-pane-child-identity-recheck", expected: "same", observed: "unknown" },
		{ code: "visible-pane-child-verification-recheck", expected: "same", observed: "different" },
		{ code: "visible-pane-child-verification-recheck", expected: "same", observed: "unknown" },
	]);
	expect(await verifyRetained(record, operations(), host(associated), pi)).toEqual({ classification: "verified" });
	expect(JSON.stringify(results)).not.toContain("private adapter detail");
});

it("discovers from disk, uses private controls once, and reads immutable completion evidence", async () => {
	const f = await fixture();
	const before = f.owner.record;
	const [{ entry, classification }] = await f.recover();
	expect(classification).toBe("adopted");
	expect(f.owner.record).toMatchObject({ writerLease: before.writerLease, supervisor: before.supervisor, child: before.child, controllerGeneration: 1 });
	const handle = entry.supervisor!.controllerChild(entry.authority);
	const sent = handle.send!("new controller");
	await vi.advanceTimersByTimeAsync(750); await sent;
	expect(f.send).toHaveBeenCalledExactlyOnceWith("new controller");
	await vi.advanceTimersByTimeAsync(750);
	expect(f.send).toHaveBeenCalledTimes(1);
	expect(readFileSync(join(f.taskDir, "controller-1.json.claimed"), "utf8")).toContain("head");
	await f.finish();
	expect(entry.supervisor!.completion?.outcome).toEqual({ kind: "completed", finalText: "durable answer" });
	expect(RetainedResults.read(f.taskDir)?.manifest).toMatchObject({ exit: "completed", durationMs: 2, changedPaths: ["file.ts"], baseRef: "HEAD", commits: 0 });
});

it.each(["alive", "unknown"] as const)("does not acquire control when the old host is %s", async (state) => {
	const f = await fixture(); f.oldState(state);
	const before = f.owner.record;
	const [{ entry, classification }] = await f.recover();
	expect(classification).toBe(state === "alive" ? "persist-only" : "ambiguous");
	expect(f.owner.record).toEqual(before);
	if (state === "alive") {
		expect(() => entry.supervisor!.controllerChild(entry.authority)).toThrow("persist-only");
		await f.finish();
		expect(entry.supervisor!.completion?.outcome).toMatchObject({ finalText: "durable answer" });
	}
	expect(f.send).not.toHaveBeenCalled(); expect(f.operations.signalTree).not.toHaveBeenCalled();
});

it("requires expiry as well as proved death, and fences two successor CAS contenders", async () => {
	const f = await fixture(); vi.setSystemTime(1999);
	expect((await f.recover())[0].classification).toBe("ambiguous");
	vi.setSystemTime(2001);
	const current = f.owner.record;
	const registry = f.registry.forController(f.next);
	registry.recoverControl(current.id, current.revision, 0, "next-session");
	expect(() => registry.recoverControl(current.id, current.revision, 0, "next-session")).toThrow();
	expect(f.registry.inspectControl(controlAuthority(f.granted))).toBe(false);
});

it.each(["different", "unknown"] as const)("refuses %s supervisor or child evidence without recapture or effects", async (state) => {
	for (const pid of [process.pid, 4242]) {
		const f = await fixture();
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === pid ? state : "same");
		const before = f.owner.record;
		expect((await f.recover())[0].classification).toBe("ambiguous");
		expect(f.owner.record).toEqual(before);
		expect(f.send).not.toHaveBeenCalled(); expect(f.operations.signalTree).not.toHaveBeenCalled();
	}
});

it.each(["dead", "unknown"] as const)("never adopts a %s supervisor writer", async (state) => {
	const f = await fixture(); f.writerState(state);
	const before = f.owner.record;
	expect((await f.recover())[0].classification).toBe("ambiguous");
	expect(f.owner.record).toEqual(before);
});

it.each(["corrupt", "symlink", "public"] as const)("refuses %s durable journal before acquisition", async (fault) => {
	const f = await fixture();
	const path = join(f.taskDir, "event-1.json");
	if (fault === "corrupt") writeFileSync(path, "{}", { mode: 0o600 });
	else if (fault === "public") chmodSync(path, 0o644);
	else { renameSync(path, `${path}.saved`); symlinkSync(`${path}.saved`, path); }
	const before = f.owner.record;
	expect((await f.recover())[0].classification).toBe("ambiguous");
	expect(f.owner.record).toEqual(before);
});

it("refuses a queued stale control before the supervisor touches the backend", async () => {
	const f = await fixture();
	const [{ entry }] = await f.recover();
	const pending = entry.supervisor!.controllerChild(entry.authority).send!("stale");
	const refused = expect(pending).rejects.toThrow("changed");
	const current = f.owner.record;
	f.registry.releaseControl(current.revision, current.writerLease!.generation, entry.authority);
	await vi.advanceTimersByTimeAsync(750); await refused;
	expect(f.send).not.toHaveBeenCalled();
});

it("discovers prior sessions only inside the configured installation directory", async () => {
	const f = await fixture();
	const fresh = new SubagentRegistry(join(dirname(f.taskDir), "registry"), "unrelated-session", {
		writerIdentity: f.next, inspectWriter: (identity) => identity.token === "old" ? "dead" : "alive",
	});
	expect(() => fresh.get("sa-proof")).toThrow("owner mismatch");
	const [recovered] = await reconstructRetained(fresh, f.next, "unrelated-session", f.operations);
	expect(recovered.classification).toBe("adopted");
	expect(recovered.entry.authority.ownerSessionId).toBe("origin");
});

it("rejects writer expiry during the takeover identity inspection", async () => {
	const f = await fixture();
	const current = f.owner.record;
	const fresh = new SubagentRegistry(join(dirname(f.taskDir), "registry"), "origin", {
		writerIdentity: f.next, inspectWriter: (identity) => {
			if (identity.token === "supervisor") vi.setSystemTime(current.writerLease!.expiresAt);
			return identity.token === "old" ? "dead" : "alive";
		},
	});
	expect(() => fresh.recoverControl(current.id, current.revision, 0, "next-session")).toThrow();
	expect(f.owner.record).toEqual(current);
});

it("rejects an escaped oversized control payload before publishing a request", async () => {
	const f = await fixture();
	const [{ entry }] = await f.recover();
	expect(() => entry.supervisor!.controllerChild(entry.authority).send!("\u0000".repeat(32 * 1024))).toThrow("byte limit");
	expect(() => readFileSync(join(f.taskDir, "controller-1.json"))).toThrow();
	expect(f.send).not.toHaveBeenCalled();
});

it("keeps a live-controller manager mirror readable but unable to send, cancel, close, or deliver", async () => {
	const f = await fixture(); f.oldState("alive");
	const manager = new SubagentManager(() => { throw new Error("no respawn"); }, { controllerIdentity: f.next, processOperations: f.operations });
	disposals.push(() => manager.detachForReplacement());
	await manager.reconstruct(f.registry, "next-session");
	expect(manager.get("sa-proof")?.recovery).toBe("persist-only");
	expect(manager.canDeliver("sa-proof")).toBe(false);
	await expect(manager.sendTo("sa-proof", "forbidden")).rejects.toThrow();
	await manager.cancel(["sa-proof"]); await manager.close(["sa-proof"]);
	expect(f.interrupt).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
	await f.finish(); await vi.advanceTimersByTimeAsync(250);
	expect(manager.get("sa-proof")).toMatchObject({ recovery: "persist-only", status: "done", finalText: "durable answer" });
	expect(manager.canDeliver("sa-proof")).toBe(false);
});

it.each(["interrupt", "requestClose"] as const)("routes %s through the original supervisor, once", async (action) => {
	const f = await fixture();
	const [{ entry }] = await f.recover();
	entry.supervisor!.controllerChild(entry.authority)[action]!();
	await vi.advanceTimersByTimeAsync(750);
	expect(action === "interrupt" ? f.interrupt : f.close).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(750);
	expect(action === "interrupt" ? f.interrupt : f.close).toHaveBeenCalledTimes(1);
});

it("caps the immutable journal without rewriting its prefix or retaining private text", async () => {
	const f = await fixture();
	const dir = join(f.taskDir, "bounded"); mkdirSync(dir, { mode: 0o700 });
	const journal = new RetainedResults(dir);
	journal.append({ kind: "run-started" });
	const first = readFileSync(join(dir, "event-1.json"), "utf8");
	for (let i = 0; i < 260; i++) journal.append({ kind: "assistant-delta", delta: "private text" });
	expect(readFileSync(join(dir, "event-1.json"), "utf8")).toBe(first);
	expect(readFileSync(join(dir, "event-256.json"), "utf8")).not.toContain("private text");
	expect(() => readFileSync(join(dir, "event-257.json"))).toThrow();
	expect(RetainedResults.read(dir)).toBeUndefined();
}, 15_000);

it("leaves a lost acknowledgement claimed instead of replaying the backend effect", async () => {
	const f = await fixture();
	f.send.mockImplementation(async () => { throw new Error("effect outcome unknown"); });
	const [{ entry }] = await f.recover();
	const pending = entry.supervisor!.controllerChild(entry.authority).send!("uncertain");
	const refused = expect(pending).rejects.toThrow("uncertain");
	await vi.advanceTimersByTimeAsync(750); await refused;
	await vi.advanceTimersByTimeAsync(750);
	expect(f.send).toHaveBeenCalledTimes(1);
});
