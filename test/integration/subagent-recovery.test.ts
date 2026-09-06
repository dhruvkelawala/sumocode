import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { signalVerifiedProcessTree, type ProcessTreeOperations } from "../../src/background-tasks/process-tree.js";
import type { HeadlessLaunchGate, SpawnedChild, spawnPiChild } from "../../src/subagents/backend-pi.js";
import type { SubagentEvent, SubagentSnapshot } from "../../src/subagents/domain.js";
import { installSubagents } from "../../src/subagents/index.js";
import type { SubagentManager } from "../../src/subagents/manager.js";
import { SubagentRegistry, type SubagentRecord } from "../../src/subagents/registry.js";
import { controlAuthority, reconstructRetained } from "../../src/subagents/retained-adoption.js";
import { censusRetained } from "../../src/subagents/retained-census.js";
import { createPaneChildSpawner } from "../../src/subagents/backend-pane.js";
import type { TerminalHost } from "../../src/terminal-host/types.js";
import { RetainedHeadlessSupervisor, RetainedVisibleSupervisor } from "../../src/subagents/retained-supervisor.js";
import { RetainedResults } from "../../src/subagents/retained-results.js";
import { cleanupOwnedTree, type OwnedTree } from "./fixtures/subagent-feasibility-cleanup.js";

// No fixture broker may stand in for a production cross-process controller.
// Real mode is fail-closed until that adapter can register every group through
// spawnSupervisedProcess/spawnPiPty and audit original births before release.
const realMode = process.env.PLAN112_RECOVERY_BACKEND === "real";
const REAL_BLOCKER = "REAL_BACKEND_UNIMPLEMENTED: real-process harness adapter and birth-registered release/zero-owned audit are missing; no process launched";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

function requireFakeBackend(): void {
	if (realMode) throw new Error(REAL_BLOCKER);
	if (process.env.PLAN112_RECOVERY_BACKEND && process.env.PLAN112_RECOVERY_BACKEND !== "fake") {
		throw new Error("PLAN112_RECOVERY_BACKEND must be fake or real");
	}
}

function fixture(cut?: "starting" | "pre-release", backend: "headless" | "visible" = "headless", remoteControls = false) {
	requireFakeBackend();
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "subagent-recovery-")));
	chmodSync(directory, 0o700);
	const taskDir = join(directory, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const writer = { token: "writer", pid: process.pid, processStartTime: "host-birth" };
	let writerState: "alive" | "dead" | "unknown" = "alive";
	let originState: "alive" | "dead" | "unknown" = "alive";
	const registry = new SubagentRegistry(join(directory, "registry"), "origin", {
		writerIdentity: writer,
		inspectWriter: (identity) => identity.token === "writer" ? writerState : identity.token === "origin" ? originState : "alive",
	});
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-model", ownerSessionId: "origin", backend, status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const operations: ProcessTreeOperations = {
		census: vi.fn<NonNullable<ProcessTreeOperations["census"]>>(() => [{ pid: process.pid, processGroupId: process.pid, processStartTime: "host-birth" },
			{ pid: 42, processGroupId: 42, processStartTime: "anchor-birth" }]),
		captureStartTime: vi.fn(() => "anchor-command"), identityMatches: vi.fn(() => "same" as const), verificationMatches: vi.fn(() => "same" as const),
		captureTreeVerification: vi.fn((identity) => ({ members: [{ pid: identity.pid, processStartTime: "anchor-birth" }] })),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: vi.fn(async () => true),
	};
	let emit!: (event: SubagentEvent) => void;
	let gate!: HeadlessLaunchGate;
	const interrupt = vi.fn();
	const send = vi.fn(async (_text: string) => undefined);
	const requestClose = vi.fn();
	const subscribe = vi.fn((listener: typeof emit) => { emit = listener; listener({ kind: "run-started" }); });
	const spawn = vi.fn((options: Parameters<typeof spawnPiChild>[0]): SpawnedChild => {
		gate = options.launchGate!;
		expect(registry.get(record.id)).toMatchObject({ status: "starting", supervisor: expect.any(Object) });
		if (cut !== "starting") {
			gate.beforeSpawn();
			if (cut !== "pre-release") gate.beforePrompt(42);
		}
		return { events: subscribe, interrupt, send, requestClose };
	});
	const buildManifest = vi.fn(async () => ({ baseRef: "HEAD", changedPaths: [], commits: 0, exit: "completed" as const, durationMs: 1 }));
	const supervisor = { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "host-command" }, verification: { members: [{ pid: process.pid, processStartTime: "host-birth" }] } };
	const host: TerminalHost = {
		kind: "herdr", closePane: vi.fn(), openCommandInSplit: vi.fn(), notify: vi.fn(),
		inspectPane: vi.fn<NonNullable<TerminalHost["inspectPane"]>>(async () => ({ ok: true, shellPid: 42, foregroundProcessGroupId: 42, foregroundPids: [42] })),
		startAgentPane: vi.fn<NonNullable<TerminalHost["startAgentPane"]>>(async (_pi, launch) => {
			expect(registry.get(record.id)).toMatchObject({ status: "starting", writerLease: { generation: 1 }, child: null });
			const nonce = launch.shellCommand.split("'").at(-2)!;
			vi.mocked(operations.captureStartTime).mockReturnValue(`birth <cmd> ${join(taskDir, "run.sh")} ${nonce}`);
			writeFileSync(join(taskDir, "launch.born"), `${nonce}\n42\n42\nanchor-birth\n`, { mode: 0o600 });
			return { ok: true, agentName: "worker", paneId: "pane:1", pane: { host: "herdr", paneId: "pane:1" } };
		}),
	};
	const paneBackend = createPaneChildSpawner({ processTree: operations, resolveLauncher: () => "/synthetic/sumocode" });
	const visibleSpawn = vi.fn((options: Parameters<typeof paneBackend>[0]): SpawnedChild => {
		const child = paneBackend(options);
		let seq = 0;
		return { ...child, events: (listener) => {
			subscribe(listener);
			if (Symbol.asyncIterator in child.events) throw new Error("callback pane backend expected");
			child.events(listener);
		}, send: async (text, fence) => {
			await send(text);
			const pending = child.send!(text, fence);
			const file = join(taskDir, "control", `steer-${++seq}.txt`);
			renameSync(file, `${file}.consumed`);
			if (!remoteControls) await vi.advanceTimersByTimeAsync(250);
			await pending;
		} };
	});
	const owner = backend === "headless" ? new RetainedHeadlessSupervisor({ registry, initial: record, supervisor,
		launch: { prompt: "synthetic task", cwd: taskDir, inherited: {}, builtInTools: [] }, baseRef: "HEAD",
	}, { operations, spawn, buildManifest }) : new RetainedVisibleSupervisor({ registry, initial: record, supervisor,
		launch: { prompt: "synthetic task", cwd: taskDir, id: record.id, name: "worker", host, pi: { exec: vi.fn() }, placement: { kind: "new-tab", label: "worker" } }, baseRef: "HEAD",
	}, { operations, spawn: visibleSpawn, buildManifest });
	const managers: SubagentManager[] = [];
	function install(session: string, token = session, diskRecovery = false) {
		type Handler = (event: { type: string; reason: string }, ctx: ExtensionContext) => void | Promise<void>;
		const handlers = new Map<string, Handler>();
		const delivery = vi.fn();
		type Tool = { name: string; execute: (id: string, params: { id?: string; ids?: string[] }) => Promise<{ details: unknown }> };
		const tools = new Map<string, Tool>();
		const api = { on: (name: string, handler: Handler) => { handlers.set(name, handler); },
			registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
			sendMessage: delivery, exec: vi.fn() };
		const controller = { ...writer, token,
			pid: remoteControls ? process.pid + (diskRecovery ? 2000 : 1000) : process.pid,
			processStartTime: remoteControls ? `${token}-birth` : writer.processStartTime };
		// SAFETY: this fake supplies the installer's public methods; tests invoke only id/ids tools.
		const manager = installSubagents(api as never, {
			spawnPiChild: () => { throw new Error("replacement must not respawn"); },
			terminalHost: host,
			retainedRegistry: diskRecovery ? registry.forController(controller) : undefined,
			managerDependencies: { controllerIdentity: controller, processOperations: operations },
		});
		const fire = async (name: string, reason = "startup") => {
			// SAFETY: lifecycle handlers use only idle/UI flags and the current session ID.
			const context = { isIdle: () => true, hasUI: false, sessionManager: { getSessionId: () => session } } as ExtensionContext;
			await handlers.get(name)?.({ type: name, reason }, context);
		};
		const runtime = { manager, delivery, fire, tools };
		managers.push(manager);
		return runtime;
	}
	const snapshot: SubagentSnapshot = { id: record.id, title: "worker", prompt: "synthetic task", cwd: taskDir, baseRef: "HEAD", status: "running", createdAt: 1000,
		visible: backend === "visible", usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
	const track = async (runtime: ReturnType<typeof install>) => {
		if (backend === "visible") { await vi.advanceTimersByTimeAsync(50); await owner.ready; }
		const current = owner.record;
		const granted = registry.acquireControl(current.id, current.revision, current.writerLease!.generation, current.controlHead, runtime.manager.controllerIdentity, 60_000);
		const authority = controlAuthority(granted);
		await runtime.manager.trackRetained({ registry: registry.forController(runtime.manager.controllerIdentity), supervisor: owner, snapshot, authority });
		return authority;
	};
	const finish = async () => {
		await owner.ready;
		if (backend === "visible") {
			writeFileSync(join(taskDir, "response.md"), "preserved result", { mode: 0o600 });
			writeFileSync(join(taskDir, "exit.code"), "0", { mode: 0o600 });
			await vi.advanceTimersByTimeAsync(750);
		} else emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "preserved result" } });
		expect(await owner.settlement).toBe("settled");
	};
	cleanups.push(async () => {
		for (const manager of managers) manager.detachForReplacement();
		if (backend === "headless") gate.onRefused();
		else { vi.mocked(operations.identityMatches).mockReturnValue("unknown"); try { owner.renew(); } catch { /* Stop only the fake owner. */ } await vi.advanceTimersByTimeAsync(750); }
		expect(vi.getTimerCount(), "all fake owner/manager timers disposed; no OS groups were created").toBe(0);
	});
	return { directory, taskDir, registry, record, owner, gate, operations, spawn: backend === "headless" ? spawn : visibleSpawn, subscribe, interrupt, send, requestClose, buildManifest, emit: (event: SubagentEvent) => emit(event), install, track, finish,
		writerState: (state: typeof writerState) => { writerState = state; }, originState: (state: typeof originState) => { originState = state; } };
}

type Fixture = ReturnType<typeof fixture>;
function artifacts(f: Fixture): string[] {
	return ["result.json", "manifest.json"].map((file) => readFileSync(join(f.taskDir, file), "utf8"));
}
async function blocked(f: Fixture, runtime: ReturnType<Fixture["install"]>): Promise<void> {
	expect(runtime.manager.canDeliver(f.record.id)).toBe(false);
	await runtime.manager.cancel([f.record.id]);
	await runtime.manager.close([f.record.id]);
	await expect(runtime.manager.sendTo(f.record.id, "forbidden")).rejects.toThrow();
	await runtime.fire("agent_end");
	expect(runtime.delivery).not.toHaveBeenCalled();
	expect(f.interrupt).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
	expect(f.requestClose).not.toHaveBeenCalled();
	expect(f.operations.signalTree).not.toHaveBeenCalled();
}

async function replaceAndComplete(reason: string, beforeSettle = true, backend: "headless" | "visible" = "headless"): Promise<void> {
	const f = fixture(undefined, backend);
	const old = f.install("origin");
	const authority = await f.track(old);
	const initial = f.owner.record;
	if (!beforeSettle) await f.finish();
	await old.fire("session_shutdown", reason);
	const next = f.install(reason === "reload" ? "origin" : "successor", "successor");
	await next.fire("session_start", reason);
	expect(f.registry.inspectControl(authority)).toBe(false);
	expect(f.registry.inspectControl(controlAuthority(f.owner.record))).toBe(true);
	expect(f.owner.record.controlLease?.owner.token).toBe("successor");
	if (beforeSettle) {
		await next.manager.sendTo(f.record.id, "steer after recovery");
		expect(f.send).toHaveBeenCalledExactlyOnceWith("steer after recovery");
		await f.finish();
	}
	expect(next.manager.get(f.record.id)).toMatchObject({ status: "done", finalText: "preserved result", recovery: "adopted" });
	const saved = artifacts(f);
	await old.fire("agent_end");
	await next.fire("agent_end");
	await next.fire("agent_end");
	expect(old.delivery).not.toHaveBeenCalled();
	expect(next.delivery).toHaveBeenCalledTimes(1);
	await next.fire("session_shutdown", "new");
	const final = f.install("final");
	await final.fire("session_start", "new");
	await final.fire("agent_end");
	expect(final.delivery).not.toHaveBeenCalled();
	expect(f.owner.record).toMatchObject({ controllerGeneration: 2, child: initial.child, supervisor: initial.supervisor, delivery: { state: "sent" } });
	expect(artifacts(f)).toEqual(saved);
	expect(f.spawn).toHaveBeenCalledTimes(1);
	expect(f.subscribe).toHaveBeenCalledTimes(1);
	expect(f.interrupt).not.toHaveBeenCalled();
	if (backend === "headless") expect(f.operations.signalTree).not.toHaveBeenCalled();
	else expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
}

describe("production recovery matrix", () => {
	for (const backend of ["headless", "visible"] as const) {
		for (const replacement of ["same-process factory replacement", "host-Pi reload", "parent crash-restart"] as const) {
			it(`feasibility: ${backend} across ${replacement}`, async () => {
				requireFakeBackend();
				if (replacement === "same-process factory replacement") await replaceAndComplete("new", true, backend);
				else {
					const f = fixture(undefined, backend, true);
					const old = f.install("origin");
					const oldAuthority = await f.track(old);
					const original = f.owner.record;
					expect(old.manager.controllerIdentity.pid).not.toBe(original.supervisor!.identity.pid);
					// Fake kernel death, not a cooperative transfer or global replacement descriptor.
					old.manager.detachForReplacement();
					f.originState("dead");
					// Advance lease time without replaying a minute of unrelated pane polling.
					for (const elapsed of [20_000, 20_000, 20_001]) {
						vi.setSystemTime(Date.now() + elapsed);
						f.owner.renew();
					}
					const next = f.install(replacement === "host-Pi reload" ? "origin" : "successor", "successor", true);
					await next.fire("session_start", "restart");
					expect(f.registry.inspectControl(oldAuthority)).toBe(false);
					expect(next.manager.get(f.record.id)?.recovery).toBe("adopted");
					const steering = next.manager.sendTo(f.record.id, "steer after disk recovery");
					await vi.advanceTimersByTimeAsync(1000);
					await steering;
					expect(f.send).toHaveBeenCalledExactlyOnceWith("steer after disk recovery");
					await f.finish();
					await vi.advanceTimersByTimeAsync(250);
					expect(next.manager.get(f.record.id)).toMatchObject({ status: "done", finalText: "preserved result" });
					await next.fire("agent_end"); await next.fire("agent_end");
					expect(next.delivery).toHaveBeenCalledTimes(1);
					expect(old.delivery).not.toHaveBeenCalled();
					expect(f.owner.record).toMatchObject({ child: original.child, supervisor: original.supervisor, controllerGeneration: 1, delivery: { state: "sent" } });
					expect(f.spawn).toHaveBeenCalledTimes(1);
					expect(f.subscribe).toHaveBeenCalledTimes(1);
				}
			});
		}
	}
	for (const reason of ["new", "resume", "fork", "reload"]) {
		it(`ownership handoff: /${reason} keeps exactly one controller`, () => replaceAndComplete(reason));
	}
	it("ownership handoff: live-old-owner persist-only refuses the contender", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		const lease = f.owner.record.controlLease;
		// The live owner cannot verify the proposed successor's child anchor.
		vi.mocked(f.operations.identityMatches).mockReturnValue("unknown");
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await blocked(f, next);
		expect(f.owner.record.controlLease).toEqual(lease);
		expect(f.registry.inspectControl(authority)).toBe(true);
		vi.mocked(f.operations.identityMatches).mockReturnValue("same");
		await f.finish();
		expect(f.owner.record.status).toBe("settled");
		expect(old.delivery).not.toHaveBeenCalled();
		expect(next.delivery).not.toHaveBeenCalled();
	});
	it("ownership handoff: ambiguous-identity blocked with zero signal/delivery", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		vi.mocked(f.operations.verificationMatches!).mockReturnValue("unknown");
		await old.fire("session_shutdown", "resume");
		const next = f.install("successor");
		await next.fire("session_start", "resume");
		expect(next.manager.get(f.record.id)?.recovery).toBe("ambiguous");
		expect(f.registry.inspectControl(authority)).toBe(true);
		await blocked(f, next);
	});
	it("ownership handoff: expired-owner CAS takeover records lost, not recovered pipes", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await old.fire("session_shutdown", "resume");
		f.writerState("dead"); f.originState("dead");
		vi.setSystemTime(61_001);
		const next = f.install("successor");
		await next.fire("session_start", "resume");
		expect(f.owner.record).toMatchObject({ status: "lost", controllerGeneration: 1, writerLease: { generation: 2, owner: { token: "successor" } } });
		expect(f.registry.inspectControl(authority)).toBe(false);
		await blocked(f, next);
		const taken = f.owner.record;
		expect(() => f.registry.handoffController(taken.id, taken.revision, 0, "other", 60_000)).toThrow();
		expect(f.owner.record).toEqual(taken);
	});
	it("ownership handoff: two competing successors cannot acquire two controllers", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		const first = f.install("first");
		const second = f.install("second");
		await Promise.all([first.manager.adoptFrom(old.manager, "first"), second.manager.adoptFrom(old.manager, "second")]);
		expect([first, second].filter((runtime) => runtime.manager.get(f.record.id))).toHaveLength(1);
		expect(f.owner.record.controllerGeneration).toBe(1);
		expect(f.registry.inspectControl(controlAuthority(f.owner.record))).toBe(true);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
});

describe("durable failure boundaries", () => {
	for (const cut of ["starting", "pre-release", "running", "settling", "post-manifest"] as const) {
		it(`transition crash: ${cut} preserves durable accounting`, async () => {
			const f = fixture(cut === "starting" || cut === "pre-release" ? cut : undefined);
			if (cut === "starting" || cut === "pre-release") {
				f.gate.onRefused();
				await expect(f.owner.ready).rejects.toThrow();
			} else {
				await f.owner.ready;
				if (cut === "running") f.gate.onRefused();
				else {
					const die = () => { vi.setSystemTime(61_001); f.writerState("dead"); expect(() => f.owner.renew()).toThrow(); };
					if (cut === "settling") f.buildManifest.mockImplementation(async () => { die(); return { baseRef: "HEAD", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }; });
					else {
						const write = RetainedResults.prototype.writeManifest;
						vi.spyOn(RetainedResults.prototype, "writeManifest").mockImplementation(function (this: RetainedResults, manifest) {
							const pointer = write.call(this, manifest); die(); return pointer;
						});
					}
					f.emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "crash result" } });
				}
			}
			expect(await f.owner.settlement).toBe("ambiguous");
			const durable = f.registry.get(f.record.id)!;
			expect(["running", "settling", "settled", "lost", "ambiguous"]).toContain(durable.status);
			expect(durable.supervisor).not.toBeNull();
			expect(durable.child?.identity.pid ?? null).toBe(cut === "starting" || cut === "pre-release" ? null : 42);
			expect(durable.completionId).toBeNull();
			expect(f.operations.signalTree).not.toHaveBeenCalled();
			if (cut === "post-manifest") expect(artifacts(f)).toHaveLength(2);
		});
	}
	it("transition crash: spawned pre-release anchor must have a durable record", async () => {
		for (const cut of ["starting", "pre-release"] as const) {
			const f = fixture(cut);
			const before = f.registry.get(f.record.id)!;
			expect(before.launchIntent).toEqual(cut === "starting" ? null : { nonce: expect.any(String) });
			expect(before.child).toBeNull();
			f.writerState("dead");
			const nonce = before.launchIntent?.nonce;
			vi.mocked(f.operations.census!).mockReturnValue(nonce ? [{ pid: 42, processGroupId: 42, processStartTime: "anchor-birth", anchorNonce: nonce }] : []);
			const [observed] = censusRetained(f.registry, f.operations);
			expect(observed.launch).toBe(cut === "starting" ? "never-launched" : "launched-unknown");
			await reconstructRetained(f.registry, { token: "next", pid: 99, processStartTime: "next-birth" }, "next", f.operations);
			const classification = cut === "starting" ? "lost" : "ambiguous";
			expect(readFileSync(join(f.directory, "registry", `${f.record.id}.recovery-${before.revision}-${classification}.json`), "utf8")).toContain(classification);
			expect(f.registry.get(f.record.id)).toEqual(before);
			expect(f.operations.signalTree).not.toHaveBeenCalled();
			expect(f.operations.captureStartTime).not.toHaveBeenCalled();
		}
	});
	for (const identity of ["different", "unknown"] as const) {
		it(`PID reuse denial: ${identity} anchor denies control and signals`, async () => {
			const f = fixture();
			const old = f.install("origin");
			await f.track(old);
			const initial = f.owner.record.child!;
			vi.mocked(f.operations.identityMatches).mockReturnValue(identity);
			vi.mocked(f.operations.verificationMatches!).mockReturnValue(identity);
			await expect(old.manager.sendTo(f.record.id, "forbidden")).rejects.toThrow();
			await expect(old.manager.cancel([f.record.id])).rejects.toThrow();
			expect((await signalVerifiedProcessTree(f.operations, initial.identity, "SIGKILL", initial.verification)).ok).toBe(false);
			expect(f.owner.record.child).toEqual(initial);
			expect(f.operations.signalTree).not.toHaveBeenCalled();
			expect(f.interrupt).not.toHaveBeenCalled();
		});
	}
	it("writer death/takeover: former writer cannot publish after successor CAS", async () => {
		const f = fixture();
		await f.owner.ready;
		f.writerState("dead");
		vi.setSystemTime(61_001);
		const successor = f.registry.forController({ token: "successor", pid: process.pid, processStartTime: "host-birth" });
		const current = f.owner.record;
		const taken = successor.acquireWriter(current.id, current.revision, 60_000);
		expect(taken.writerLease?.generation).toBe(2);
		f.emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "stale result" } });
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.owner.record).toEqual(taken);
		expect(f.owner.completion).toBeUndefined();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it("corrupt records: replacement preserves bytes and blocks all effects", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await f.finish();
		const saved = artifacts(f);
		const path = join(f.directory, "registry", `${f.record.id}.json`);
		writeFileSync(path, "{broken", { mode: 0o600 });
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await blocked(f, next);
		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(artifacts(f)).toEqual(saved);
	});
	it("explicit cancel after recovery: only the successor interrupts once", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await f.owner.ready;
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await old.manager.cancel([f.record.id]);
		const cancelling = next.manager.cancel([f.record.id]);
		expect(f.interrupt).toHaveBeenCalledTimes(1);
		f.emit({ kind: "run-settled", outcome: { kind: "interrupted", partialText: "partial" } });
		expect(await f.owner.settlement).toBe("settled");
		await cancelling;
		expect(f.owner.record.outcome).toBe("interrupted");
		expect(artifacts(f)).toHaveLength(2);
	});
});

describe("sender exact-once with explicit uncertainty", () => {
	it("exact-once delivery: settle-after-handoff sends one completion", () => replaceAndComplete("new"));
	it("exact-once delivery: settle-before-handoff sends one completion", () => replaceAndComplete("new", false));
	for (const cut of ["admission-before-call", "send-before-ack", "notice-before-ack"] as const) {
		it(`exact-once delivery: ${cut} does not replay uncertain submission`, async () => {
			const f = fixture();
			const old = f.install("origin");
			const authority = await f.track(old);
			await f.finish();
			const saved = artifacts(f);
			if (cut === "send-before-ack") {
				old.delivery.mockImplementation(() => { throw new Error("submission made; return lost"); });
				await old.fire("agent_end");
			} else f.registry.forController(old.manager.controllerIdentity).advanceDelivery(f.owner.record.revision, authority, "send");
			await old.fire("agent_end");
			expect(old.delivery).toHaveBeenCalledTimes(cut === "send-before-ack" ? 1 : 0);
			await old.fire("session_shutdown", "resume");
			const next = f.install("successor");
			if (cut === "notice-before-ack") next.delivery.mockImplementation(() => { throw new Error("notice submitted; return lost"); });
			await next.fire("session_start", "resume");
			await next.fire("agent_end");
			expect(next.delivery).toHaveBeenCalledTimes(1);
			expect(next.delivery.mock.calls[0]?.[0]).toMatchObject({ customType: "subagent-delivery-uncertain", content: `delivery of ${f.record.id} uncertain; result manifest available at ${join(f.taskDir, "manifest.json")}; use inspect` });
			await next.fire("session_shutdown", "reload");
			const final = f.install("final");
			await final.fire("session_start", "reload");
			await final.fire("agent_end");
			expect(final.delivery).not.toHaveBeenCalled();
			expect(f.owner.record.delivery).toMatchObject({ state: "delivery-uncertain", notice: { state: cut === "notice-before-ack" ? "delivery-uncertain" : "sent" } });
			expect(artifacts(f)).toEqual(saved);
		});
	}
	for (const action of ["check", "wait", "cancel", "close"] as const) {
		it(`exact-once delivery: ${action} race with replacement`, async () => {
			const f = fixture();
			const old = f.install("origin");
			await f.track(old);
			await f.finish();
			const completionId = f.owner.record.completionId;
			const saved = artifacts(f);
			const tool = old.tools.get(`subagent_${action}`)!;
			const inline = await tool.execute("call", action === "check" ? { id: f.record.id } : { ids: [f.record.id] });
			expect(inline.details).toBeDefined();
			await old.fire("session_shutdown", "new");
			const next = f.install("successor");
			await next.fire("session_start", "new");
			await next.fire("agent_end");
			expect(old.delivery).not.toHaveBeenCalled();
			expect(next.delivery, `${action}: CONSUMPTION_HANDOFF_GAP if replayed: settled close consumes only the outgoing delivery buffer, not manager.consumedIds; check is read-only`).toHaveBeenCalledTimes(action === "check" ? 1 : 0);
			expect(f.owner.record.completionId).toBe(completionId);
			expect(artifacts(f)).toEqual(saved);
		});
	}
});

describe("cleanup/zero-owned accounting", () => {
	const tree: OwnedTree = { identity: { pid: 42, processGroupId: 42, processStartTime: "anchor" }, verification: { members: [{ pid: 42, processStartTime: "birth" }] } };
	for (const state of ["same", "different", "unknown"] as const) {
		it(`cleanup: ${state} original anchor, unknown never means zero`, async () => {
			requireFakeBackend();
			let empty = false;
			const operations: ProcessTreeOperations = {
				captureStartTime: () => undefined, identityMatches: () => state, verificationMatches: () => state,
				isTreeEmpty: () => empty,
				signalTree: vi.fn(async () => { empty = true; return { ok: true, gone: true }; }),
				waitForTreeEmpty: async () => empty,
			};
			expect(await cleanupOwnedTree(operations, tree, () => {})).toBe(state === "same");
			expect(operations.signalTree).toHaveBeenCalledTimes(state === "same" ? 1 : 0);
			expect(operations.isTreeEmpty(tree.identity, tree.verification)).toBe(state === "same");
		});
	}
	it("cleanup: retained anchor lifetime and installation census", async () => {
		const f = fixture();
		await f.owner.ready;
		const original = f.owner.record;
		expect(censusRetained(f.registry, f.operations)[0]).toMatchObject({ launch: "verified", censusKnown: true });
		// Pi can exit while the original anchor remains the cleanup capability.
		vi.mocked(f.operations.census!).mockReturnValue([{ pid: 42, processGroupId: 42, processStartTime: "anchor-birth" }]);
		expect(censusRetained(f.registry, f.operations)[0].launch).toBe("verified");
		vi.mocked(f.operations.census!).mockReturnValue(undefined);
		expect(censusRetained(f.registry, f.operations)[0]).toMatchObject({ launch: "ambiguous", censusKnown: false });
		vi.mocked(f.operations.census!).mockReturnValue([]);
		expect(censusRetained(f.registry, f.operations)[0].launch).toBe("ambiguous");
		vi.mocked(f.operations.isTreeEmpty).mockReturnValue(true);
		expect(censusRetained(f.registry, f.operations)[0].launch).toBe("empty");
		expect(f.owner.record).toEqual(original);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
});
