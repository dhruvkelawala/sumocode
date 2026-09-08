import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPrivateJson } from "../activity/persistence.js";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { TerminalHost } from "../terminal-host/types.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { SubagentEvent, SubagentSnapshot } from "./domain.js";
import { installSubagents } from "./index.js";
import { SubagentRegistry, type RegistryWriter, type SubagentRecord } from "./registry.js";
import { controlAuthority, type RetainedSubagent } from "./retained-adoption.js";
import { RetainedHeadlessSupervisor } from "./retained-supervisor.js";
import { RetainedResults } from "./retained-results.js";

afterEach(() => { vi.useRealTimers(); });

function fixture(backend: "headless" | "visible" = "headless") {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "manager-adoption-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const writer: RegistryWriter = { token: "writer", pid: process.pid, processStartTime: "host-birth" };
	const identities = (token: string): RegistryWriter => ({ ...writer, token });
	let writerState: "alive" | "dead" | "unknown" = "alive";
	let successorState: "alive" | "dead" | "unknown" = "alive";
	let originState: "alive" | "dead" | "unknown" = "alive";
	let idle = true;
	const registry = new SubagentRegistry(join(root, "registry"), "origin", {
		writerIdentity: writer, inspectWriter: (owner) => owner.token === "writer" ? writerState : owner.token === "origin" ? originState : successorState,
	});
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn(() => "anchor-command"), identityMatches: vi.fn(() => "same" as const),
		captureTreeVerification: vi.fn((identity) => ({ members: [{ pid: identity.pid, processStartTime: "anchor-birth" }] })),
		verificationMatches: vi.fn(() => "same" as const), isTreeEmpty: vi.fn(() => false),
		signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: vi.fn(async () => false),
	};
	const host: TerminalHost = {
		kind: "herdr", inspectPane: vi.fn(async () => ({ ok: true as const, shellPid: 42, foregroundProcessGroupId: 42, foregroundPids: [42] })),
		openCommandInSplit: vi.fn(async () => ({ ok: false as const, error: "unsupported" })),
		closePane: vi.fn(async () => ({ ok: false, error: "unsupported" })),
		notify: vi.fn(async () => undefined),
	};
	const interrupt = vi.fn();
	const send = vi.fn(async (_text: string) => undefined);
	const requestClose = vi.fn();
	let emit!: (event: SubagentEvent) => void;
	const subscriptions = vi.fn();
	const spawn = vi.fn((options: { launchGate?: Parameters<typeof import("./backend-pi.js").spawnPiChild>[0]["launchGate"] }): SpawnedChild => {
		options.launchGate?.beforeSpawn();
		options.launchGate?.beforePrompt(42);
		return { interrupt, send, requestClose, events: (listener) => { subscriptions(); emit = listener; listener({ kind: "run-started" }); } };
	});
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-1", ownerSessionId: "origin", backend, status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const supervisorProcess = { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "host-command" }, verification: { members: [{ pid: process.pid, processStartTime: "host-birth" }] } };
	let supervisor: NonNullable<RetainedSubagent["supervisor"]>;
	let finish: () => Promise<void>;
	let observerCount = 0;
	let maxObservers = 0;
	if (backend === "headless") {
		const owner = new RetainedHeadlessSupervisor({ registry, initial: record, supervisor: supervisorProcess,
			launch: { prompt: "task", cwd: taskDir, inherited: {}, builtInTools: [] }, baseRef: "HEAD" },
		{ operations, spawn, buildManifest: async () => ({ baseRef: "HEAD", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }) });
		supervisor = { get record() { return owner.record; }, get completion() { return owner.completion; },
			reserveControl: (authority, successor) => owner.reserveControl(authority, successor),
			controllerChild: (authority) => owner.controllerChild(authority),
			subscribe: (listener) => {
				observerCount++; maxObservers = Math.max(maxObservers, observerCount);
				const off = owner.subscribe(listener);
				return () => { observerCount--; off(); };
			},
		};
		const retainedEmit = emit;
		finish = async () => { await owner.ready; retainedEmit({ kind: "run-settled", outcome: { kind: "completed", finalText: "answer" } }); await owner.settlement; };
	} else {
		// Visible supervisor boundary: fake owner, real registry CAS and durable settlement.
		registry.create(record);
		let r = registry.acquireWriter(record.id, 1, 60_000);
		r = registry.transition(r.id, r.revision, r.writerLease!.generation, (current) => ({ ...current, status: "running", supervisor: supervisorProcess,
			child: { identity: { pid: 42, processGroupId: 42, processStartTime: "anchor-command" }, verification: { members: [{ pid: 42, processStartTime: "anchor-birth" }] } },
			pane: { paneId: "pane-1", agentName: "worker" } }));
		const listeners = new Set<(r: SubagentRecord) => void>();
		let completion: RetainedHeadlessSupervisor["completion"];
		supervisor = { get record() { return registry.get(record.id)!; }, get completion() { return completion; },
			reserveControl: (authority, successor) => {
				const current = registry.get(record.id)!;
				return registry.reserveControl(current.revision, authority, `${record.id}:${authority.head + 1}`, { ...successor, writerGeneration: current.writerLease!.generation });
			},
			controllerChild: (authority) => ({ events: () => undefined, interrupt: () => { if (registry.inspectControl(authority)) return interrupt(); },
				send: async (text) => { if (registry.inspectControl(authority)) await send(text); }, requestClose: () => { if (registry.inspectControl(authority)) requestClose(); } }),
			subscribe: (listener) => { listeners.add(listener); maxObservers = Math.max(maxObservers, listeners.size); return () => { listeners.delete(listener); }; },
		};
		finish = async () => {
			const current = registry.get(record.id)!;
			const artifacts = new RetainedResults(taskDir);
			artifacts.append({ kind: "run-started" });
			completion = { outcome: { kind: "completed", finalText: "answer" }, manifest: { exit: "completed", durationMs: 1 } };
			const result = artifacts.writeResult(completion.outcome);
			const manifest = artifacts.writeManifest(completion.manifest);
			const settled = registry.transition(current.id, current.revision, current.writerLease!.generation, (r) => ({ ...r, status: "settled", outcome: "completed", settledAt: 1000, completionId: "completion", delivery: { state: "undelivered" }, result: result.pointer, manifest }));
			for (const listener of listeners) listener(settled);
		};
	}
	const snapshot: SubagentSnapshot = { id: record.id, title: "worker", prompt: "task", cwd: taskDir, baseRef: "HEAD", status: "running", createdAt: 1000,
		visible: backend === "visible", pane: supervisor.record.pane ?? undefined, usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
	function install(session: string, retainedLaunch = false, token = session) {
		type Handler = (event: { type: string; reason: string }, ctx: ExtensionContext) => void | Promise<void>;
		const handlers = new Map<string, Handler>();
		const delivery = vi.fn();
		const api = { on: (name: string, handler: Handler) => { handlers.set(name, handler); }, registerTool: vi.fn(), sendMessage: delivery, exec: vi.fn() };
		// SAFETY: this fake implements every API operation used by installSubagents.
		const manager = installSubagents(api as never, { terminalHost: host, spawnPiChild: retainedLaunch ? () => {
			const current = registry.get(record.id)!;
			const granted = registry.acquireControl(record.id, current.revision, current.writerLease!.generation, current.controlHead, identities(token), 60_000);
			return supervisor.controllerChild(controlAuthority(granted));
		} : spawn,
			managerDependencies: { controllerIdentity: identities(token), processOperations: operations, captureGitContext: async () => ({}), buildCompletionManifest: async () => ({ baseRef: "HEAD", changedPaths: [], commits: 0, exit: "interrupted", durationMs: 1 }) } });
		const fire = async (name: string, reason = "startup") => {
			// SAFETY: these lifecycle handlers read only idle/UI flags and the session ID.
			await handlers.get(name)?.({ type: name, reason }, { isIdle: () => idle, hasUI: false, sessionManager: { getSessionId: () => session } } as never);
		};
		return { manager, delivery, fire };
	}
	async function track(runtime: ReturnType<typeof install>) {
		const current = registry.get(record.id)!;
		const granted = registry.acquireControl(record.id, current.revision, current.writerLease!.generation, current.controlHead, runtime.manager.controllerIdentity, 60_000);
		await runtime.manager.trackRetained({ registry: registry.forController(runtime.manager.controllerIdentity), supervisor, snapshot, authority: controlAuthority(granted) });
		return controlAuthority(granted);
	}
	return { root, registry, record, operations, host, interrupt, send, requestClose, spawn, subscriptions, supervisor, finish, install, track,
		maxObservers: () => maxObservers, writerState: (value: typeof writerState) => { writerState = value; }, successorState: (value: typeof successorState) => { successorState = value; },
		originState: (value: typeof originState) => { originState = value; }, setIdle: (value: boolean) => { idle = value; } };
}

function expectArtifacts(f: ReturnType<typeof fixture>): void {
	expect(readPrivateJson(join(f.record.taskDir, "result.json"), 4096)).toMatchObject({ outcome: { kind: "completed", finalText: "answer" } });
	expect(readPrivateJson(join(f.record.taskDir, "manifest.json"), 4096)).toMatchObject({ manifest: { exit: "completed" } });
}

describe("durable sender delivery", () => {
	it("records lost work when disk recovery takes over an expired dead writer", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		old.manager.detachForReplacement();
		f.writerState("dead"); f.originState("dead");
		vi.setSystemTime(61_001);
		const next = f.install("successor");
		await next.manager.reconstruct(f.registry, "successor");
		expect(f.registry.get("sa-1")).toMatchObject({ status: "lost", writerLease: { generation: 2 } });
		expect(next.manager.get("sa-1")?.recovery).toBe("lost");
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expect(next.delivery).not.toHaveBeenCalled();
		next.manager.detachForReplacement();
	});

	it("recovers only settled delivery after dead-writer expiry without a live child", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await f.finish();
		old.manager.detachForReplacement();
		f.writerState("dead"); f.originState("dead");
		vi.setSystemTime(61_001);
		vi.mocked(f.operations.identityMatches).mockReturnValue("different");
		vi.mocked(f.operations.verificationMatches!).mockReturnValue("different");
		const next = f.install("successor");
		await next.manager.reconstruct(f.registry, "successor");
		expect(next.manager.get("sa-1")).toMatchObject({ recovery: "adopted", status: "done", finalText: "answer" });
		expect(f.registry.inspectControl(authority)).toBe(false);
		await next.fire("agent_end"); await next.fire("agent_end");
		expect(next.delivery).toHaveBeenCalledTimes(1);
		await next.manager.cancel(["sa-1"]);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expectArtifacts(f);
		next.manager.detachForReplacement();
	});

	it.each(["headless", "visible"] as const)("%s settles before replacement and the successor sends once", async (backend) => {
		const f = fixture(backend);
		const old = f.install("origin");
		await f.track(old);
		await f.finish();
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === 42 ? "different" : "same");
		expect(f.registry.get("sa-1")?.delivery).toEqual({ state: "undelivered" });
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await next.fire("agent_end");
		expect(old.delivery).not.toHaveBeenCalled();
		expect(next.delivery).toHaveBeenCalledTimes(1);
		expect(f.registry.get("sa-1")?.delivery).toMatchObject({ state: "sent" });
		expectArtifacts(f);
	});

	it("does not replay a sent completion into a replacement session", async () => {
		const f = fixture();
		const old = f.install("origin");
		await old.fire("session_start");
		await f.track(old);
		await f.finish();
		expect(old.delivery).toHaveBeenCalledTimes(1);
		await old.fire("session_shutdown", "fork");
		const next = f.install("successor");
		await next.fire("session_start", "fork");
		await next.fire("agent_end");
		expect(next.delivery).not.toHaveBeenCalled();
		expect(f.registry.get("sa-1")?.delivery).toMatchObject({ state: "sent" });
		expectArtifacts(f);
	});

	it.each(["before-call", "cas-return", "before-return"])("%s crash leaves one uncertainty notice, never a completion replay", async (cut) => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await f.finish();
		if (cut === "before-call") {
			const record = f.registry.get("sa-1")!;
			f.registry.forController(old.manager.controllerIdentity).advanceDelivery(record.revision, authority, "send");
		} else if (cut === "cas-return") {
			const advance = SubagentRegistry.prototype.advanceDelivery;
			const fault = vi.spyOn(SubagentRegistry.prototype, "advanceDelivery").mockImplementation(function (this: SubagentRegistry, ...args) {
				advance.call(this, ...args);
				throw new Error("admission committed; return lost");
			});
			try { await old.fire("agent_end"); }
			finally { fault.mockRestore(); }
		} else {
			old.delivery.mockImplementation(() => { throw new Error("controller lost before return"); });
			await old.fire("agent_end");
		}
		expect(f.registry.get("sa-1")?.delivery).toMatchObject({ state: "sending", controllerGeneration: 0 });
		await old.fire("agent_end");
		expect(old.delivery).toHaveBeenCalledTimes(cut === "before-return" ? 1 : 0);
		await old.fire("session_shutdown", "resume");
		const next = f.install("successor");
		await next.fire("session_start", "resume");
		await next.fire("agent_end");
		expect(next.delivery).toHaveBeenCalledTimes(1);
		expect(next.delivery.mock.calls[0]).toEqual([
			expect.objectContaining({ customType: "subagent-delivery-uncertain", display: true, content: `delivery of sa-1 uncertain; result manifest available at ${join(f.record.taskDir, "manifest.json")}; use inspect` }),
			{ deliverAs: "followUp", triggerTurn: true },
		]);
		expect(f.registry.get("sa-1")?.delivery).toMatchObject({ state: "delivery-uncertain", notice: { state: "sent" } });
		await next.fire("session_shutdown", "reload");
		const final = f.install("final");
		await final.fire("session_start", "reload");
		expect(final.delivery).not.toHaveBeenCalled();
		expectArtifacts(f);
	});

	it("does not recursively replay an uncertainty notice whose own send was lost", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await f.finish();
		f.registry.forController(old.manager.controllerIdentity).advanceDelivery(f.registry.get("sa-1")!.revision, authority, "send");
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		next.delivery.mockImplementation(() => { throw new Error("notice return lost"); });
		await next.fire("session_start", "new");
		expect(next.delivery).toHaveBeenCalledTimes(1);
		await next.fire("session_shutdown", "new");
		const final = f.install("final");
		await final.fire("session_start", "new");
		await final.fire("agent_end");
		expect(final.delivery).not.toHaveBeenCalled();
		expect(f.registry.get("sa-1")?.delivery).toMatchObject({ state: "delivery-uncertain", notice: { state: "delivery-uncertain" } });
		expectArtifacts(f);
	});

	it.each(["new", "fork", "resume"])("/%s reservation fences the old sender before successor admission", async (reason) => {
		const f = fixture();
		const old = f.install("origin");
		const stale = await f.track(old);
		await f.finish();
		const reserve = f.supervisor.reserveControl.bind(f.supervisor);
		const send = vi.fn();
		vi.spyOn(f.supervisor, "reserveControl").mockImplementation((authority, successor) => {
			const reserved = reserve(authority, successor);
			old.manager.deliver({ id: "sa-1", title: "worker", status: "done", content: "answer", details: {} }, send);
			for (const action of ["send", "sent", "uncertain"] as const) {
				expect(() => f.registry.forController(old.manager.controllerIdentity).advanceDelivery(reserved.revision, stale, action)).toThrow("stale delivery controller");
			}
			return reserved;
		});
		await old.fire("session_shutdown", reason);
		const next = f.install("successor");
		await next.fire("session_start", reason);
		expect(send).not.toHaveBeenCalled();
		expect(old.delivery).not.toHaveBeenCalled();
		expect(next.delivery).toHaveBeenCalledTimes(1);
		const current = f.registry.get("sa-1")!;
		for (const action of ["send", "sent", "uncertain"] as const) {
			expect(() => f.registry.forController(old.manager.controllerIdentity).advanceDelivery(current.revision, stale, action)).toThrow("stale delivery controller");
		}
		expectArtifacts(f);
	});

	it.each(["identities-undelivered", "identities-sending", "supervisor-undelivered", "supervisor-sending"])("%s loss blocks replay and preserves settled artifacts", async (fault) => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await f.finish();
		if (fault.endsWith("-sending")) f.registry.forController(old.manager.controllerIdentity).advanceDelivery(f.registry.get("sa-1")!.revision, authority, "send");
		if (fault.startsWith("identities")) {
			vi.mocked(f.operations.identityMatches).mockReturnValue("different");
			vi.mocked(f.operations.isTreeEmpty).mockReturnValue(true);
		} else f.writerState("dead");
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await next.fire("agent_end");
		expect(next.manager.get("sa-1")?.recovery).toBe("ambiguous");
		expect(next.delivery).not.toHaveBeenCalled();
		expect(old.delivery).not.toHaveBeenCalled();
		expectArtifacts(f);
	});

	it("rejects duplicate same-revision admission and writer bypass of delivery CAS", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await f.finish();
		const record = f.registry.get("sa-1")!;
		const first = f.registry.forController(old.manager.controllerIdentity);
		const second = f.registry.forController(old.manager.controllerIdentity);
		const results = await Promise.allSettled([first, second].map(async (registry) => registry.advanceDelivery(record.revision, authority, "send")));
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
		const sending = f.registry.get("sa-1")!;
		expect(() => second.advanceDelivery(sending.revision, authority, "send")).toThrow("delivery state transition refused");
		expect(() => first.advanceDelivery(sending.revision, authority, "uncertain")).toThrow("delivery state transition refused");
		expect(() => f.registry.transition(sending.id, sending.revision, sending.writerLease!.generation, (r) => ({ ...r, delivery: { state: "undelivered" } }))).toThrow("delivery requires controller CAS");
		await old.fire("agent_end");
		expect(old.delivery).not.toHaveBeenCalled();
		expectArtifacts(f);
	});

	it("blocks a successor when delivery state is corrupted during replacement", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await f.finish();
		await old.fire("session_shutdown", "new");
		const record = f.registry.get("sa-1")!;
		writeFileSync(join(f.root, "registry", "sa-1.json"), JSON.stringify({ ...record, delivery: { state: "sent", completionId: "other" } }), { mode: 0o600 });
		const next = f.install("successor");
		await next.fire("session_start", "new");
		expect(next.manager.canDeliver("sa-1")).toBe(false);
		expect(next.manager.get("sa-1")?.recovery).toBe("ambiguous");
		expect(next.delivery).not.toHaveBeenCalled();
		expect(old.delivery).not.toHaveBeenCalled();
		expectArtifacts(f);
	});

	it.each(["unknown-state", "wrong-id", "future-generation", "future-time"])("blocks %s without sending or changing result artifacts", async (fault) => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await f.finish();
		const record = f.registry.get("sa-1")!;
		const delivery = { state: fault === "unknown-state" ? "broken" : "sending", completionId: fault === "wrong-id" ? "other" : record.completionId,
			controllerGeneration: fault === "future-generation" ? 1 : 0, at: fault === "future-time" ? 1001 : 1000 };
		writeFileSync(join(f.root, "registry", "sa-1.json"), JSON.stringify({ ...record, delivery }), { mode: 0o600 });
		await old.fire("agent_end");
		expect(old.manager.canDeliver("sa-1")).toBe(false);
		expect(old.manager.get("sa-1")?.recovery).toBe("ambiguous");
		expect(old.delivery).not.toHaveBeenCalled();
		expectArtifacts(f);
	});
});

describe("manager replacement adoption", () => {
	for (const backend of ["headless", "visible"] as const) {
		it.each(["new", "fork", "resume", "reload"])(`${backend} /%s transfers once and delivers later settlement to the successor`, async (reason) => {
			const f = fixture(backend);
			const old = f.install("origin");
			await old.fire("session_start");
			const authority = await f.track(old);
			const writer = f.registry.get("sa-1")!.writerLease;
			await old.fire("session_shutdown", reason);
			const next = f.install("successor");
			await next.fire("session_start", reason);
			await next.fire("session_start", reason);
			await next.manager.adoptFrom(old.manager, "successor");
			expect(f.registry.get("sa-1")).toMatchObject({ writerLease: writer, ownerSessionId: "origin", controllerSessionId: "successor", controllerGeneration: 1 });
			expect(f.registry.inspectControl(authority)).toBe(false);
			expect(next.manager.canDeliver("sa-1")).toBe(true);
			expect(f.maxObservers()).toBe(1);
			expect(f.subscriptions).toHaveBeenCalledTimes(backend === "headless" ? 1 : 0);
			expect(f.interrupt).not.toHaveBeenCalled();
			await f.finish();
			await next.fire("agent_end");
			await next.fire("agent_end");
			expect(old.delivery).not.toHaveBeenCalled();
			expect(next.delivery).toHaveBeenCalledTimes(1);
			expect(next.manager.get("sa-1")).toMatchObject({ status: "done", finalText: "answer", recovery: "adopted" });
			expect(f.spawn).toHaveBeenCalledTimes(backend === "headless" ? 1 : 0);
		});
	}

	it.each(["headless", "visible"] as const)("%s delivers a retained settlement after the original control lease window", async (backend) => {
		const f = fixture(backend);
		const old = f.install("origin");
		await old.fire("session_start");
		const authority = await f.track(old);
		expect(f.registry.inspectControl(authority)).toBe(true);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await next.manager.adoptFrom(old.manager, "successor");
		f.setIdle(false);
		await f.finish();
		expect(next.delivery).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(61_000);
		f.setIdle(true);
		await next.fire("agent_end");
		expect(next.delivery).toHaveBeenCalledTimes(1);
		expect(next.manager.get("sa-1")).toMatchObject({ status: "done", finalText: "answer", recovery: "adopted" });
	});

	it.each(["unknown-anchor", "different-anchor", "anchor-gone", "unknown-writer", "dead-unexpired-writer", "expired-live-writer", "dead-writer-live-controller", "blocked-successor", "pane-moved"])("%s persists uncertainty and makes no signals/delivery", async (fault) => {
		const f = fixture(fault === "pane-moved" ? "visible" : "headless");
		const old = f.install("origin");
		await f.track(old);
		if (fault === "unknown-anchor" || fault === "different-anchor") vi.mocked(f.operations.identityMatches).mockReturnValue(fault === "unknown-anchor" ? "unknown" : "different");
		if (fault === "anchor-gone") {
			vi.mocked(f.operations.identityMatches).mockReturnValue("different");
			vi.mocked(f.operations.isTreeEmpty).mockReturnValue(true);
		}
		if (fault === "unknown-writer") f.writerState("unknown");
		if (fault === "dead-unexpired-writer") { f.writerState("dead"); f.originState("dead"); }
		if (fault === "expired-live-writer") vi.setSystemTime(61_001);
		if (fault === "dead-writer-live-controller") { f.writerState("dead"); vi.setSystemTime(61_001); }
		if (fault === "blocked-successor") f.successorState("unknown");
		if (fault === "pane-moved") vi.mocked(f.host.inspectPane!).mockResolvedValue({ ok: true, shellPid: 42, foregroundProcessGroupId: 88, foregroundPids: [88] });
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		const classification = fault === "anchor-gone" ? "lost" : "ambiguous";
		expect(next.manager.get("sa-1")?.recovery).toBe(classification);
		if (fault === "pane-moved") expect(next.manager.get("sa-1")?.recoveryReason).toEqual({
			code: "visible-pane-foreground-process-group",
			expected: "same",
			observed: "different",
		});
		expect(next.manager.canDeliver("sa-1")).toBe(false);
		await next.manager.cancel(["sa-1"]);
		await next.manager.close(["sa-1"]);
		await expect(next.manager.sendTo("sa-1", "text")).rejects.toThrow();
		await next.fire("agent_end");
		expect(f.interrupt).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.requestClose).not.toHaveBeenCalled();
		expect(next.delivery).not.toHaveBeenCalled();
		const observation = readdirSync(join(f.root, "registry")).find((file) => file.endsWith(`-${classification}.json`));
		expect(observation).toBeDefined();
		const recorded = readPrivateJson(join(f.root, "registry", observation!), 4096);
		expect(recorded).toMatchObject({ id: "sa-1", controllerGeneration: 0, classification });
		if (fault === "pane-moved") expect(recorded).toMatchObject({
			reason: { code: "visible-pane-foreground-process-group", expected: "same", observed: "different" },
		});
	});

	// Post-exec panes report the persistent shell (child pid) with the agent as a
	// separate foreground child, so each pane shape below must refuse with its own reason.
	it.each([
		["shell-missing", { ok: true as const, shellPid: null, foregroundProcessGroupId: 42, foregroundPids: [4343] },
			{ code: "visible-pane-shell-process", expected: "same", observed: "missing" }],
		["shell-different", { ok: true as const, shellPid: 99, foregroundProcessGroupId: 42, foregroundPids: [4343] },
			{ code: "visible-pane-shell-process", expected: "same", observed: "different" }],
		["empty-foreground", { ok: true as const, shellPid: 42, foregroundProcessGroupId: 42, foregroundPids: [] },
			{ code: "visible-pane-foreground-processes", expected: "present", observed: "missing" }],
	])("visible pane %s persists the refusal reason in snapshot and recovery observation", async (_fault, pane, reason) => {
		const f = fixture("visible");
		const old = f.install("origin");
		await f.track(old);
		vi.mocked(f.host.inspectPane!).mockResolvedValue(pane);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		expect(next.manager.get("sa-1")?.recovery).toBe("ambiguous");
		expect(next.manager.get("sa-1")?.recoveryReason).toEqual(reason);
		expect(next.manager.canDeliver("sa-1")).toBe(false);
		const observation = readdirSync(join(f.root, "registry")).find((file) => file.endsWith("-ambiguous.json"));
		expect(observation).toBeDefined();
		expect(readPrivateJson(join(f.root, "registry", observation!), 4096)).toMatchObject({
			id: "sa-1", controllerGeneration: 0, classification: "ambiguous", reason,
		});
	});

	it("advances controller generation on reload even when the session ID does not change", async () => {
		const f = fixture();
		const old = f.install("origin");
		const authority = await f.track(old);
		await old.fire("session_shutdown", "reload");
		const next = f.install("origin", false, "reload-controller");
		await next.fire("session_start", "reload");
		expect(f.registry.get("sa-1")).toMatchObject({ ownerSessionId: "origin", controllerSessionId: "origin", controllerGeneration: 1, controlLease: { owner: { token: "reload-controller" } } });
		expect(f.registry.inspectControl(authority)).toBe(false);
		await f.finish();
		expect(next.delivery).toHaveBeenCalledTimes(1);
	});

	it("allows only one of two racing successor managers to adopt", async () => {
		const f = fixture("visible");
		const old = f.install("origin");
		await f.track(old);
		old.manager.detachForReplacement();
		const first = f.install("first");
		const second = f.install("second");
		await Promise.all([first.manager.adoptFrom(old.manager, "first"), second.manager.adoptFrom(old.manager, "second")]);
		expect(f.registry.get("sa-1")?.controllerGeneration).toBe(1);
		expect([first, second].filter((runtime) => runtime.manager.get("sa-1"))).toHaveLength(1);
		expect(f.maxObservers()).toBe(1);
		expect(f.interrupt).not.toHaveBeenCalled();
		await f.finish();
	});

	it("registers a retained backend through production spawn without a second parser subscription", async () => {
		const f = fixture();
		const old = f.install("origin", true);
		await old.manager.spawn({ title: "worker", prompt: "task", cwd: f.record.taskDir });
		expect(old.manager.hasRetainedChildren).toBe(true);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await f.finish();
		expect(f.subscriptions).toHaveBeenCalledTimes(1);
		expect(f.spawn).toHaveBeenCalledTimes(1);
		expect(next.delivery).toHaveBeenCalledTimes(1);
	});

	it("releases successor queue capacity when the adopted child settles", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		for (let i = 0; i < 9; i++) await next.manager.spawn({ title: "legacy", prompt: "task", cwd: f.record.taskDir });
		const queued = await next.manager.spawn({ title: "queued", prompt: "task", cwd: f.record.taskDir });
		expect(queued.status).toBe("queued");
		await f.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(next.manager.get("sa-11")?.status).toBe("running");
		expect(f.spawn).toHaveBeenCalledTimes(11);
		expect(next.delivery).toHaveBeenCalledTimes(1);
	});

	it("keeps one controller through two replacements and renews without moving writer ownership", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		await vi.advanceTimersByTimeAsync(32_000);
		const renewed = f.registry.get("sa-1")!;
		expect(renewed.controlLease?.expiresAt).toBeGreaterThan(61_000);
		expect(renewed.writerLease?.owner.token).toBe("writer");
		expect(renewed.controllerGeneration).toBe(1);
		await next.fire("session_shutdown", "reload");
		const final = f.install("final");
		await final.fire("session_start", "reload");
		expect(f.registry.get("sa-1")?.controllerGeneration).toBe(2);
		expect(f.registry.inspectControl(controlAuthority(renewed))).toBe(false);
		await f.finish();
		expect(next.delivery).not.toHaveBeenCalled();
		expect(final.delivery).toHaveBeenCalledTimes(1);
		expect(f.maxObservers()).toBe(1);
		expect(f.subscriptions).toHaveBeenCalledTimes(1);
	});

	it("fences a revoked successor before signal and delivery effects", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		const current = f.registry.get("sa-1")!;
		f.registry.releaseControl(current.revision, current.writerLease!.generation, controlAuthority(current));
		await expect(next.manager.sendTo("sa-1", "steer")).rejects.toThrow("control refused");
		await expect(next.manager.cancel(["sa-1"])).rejects.toThrow("control refused");
		await f.finish();
		await next.fire("agent_end");
		expect(f.interrupt).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		expect(next.delivery).not.toHaveBeenCalled();
	});

	it("marks retained cancellation ambiguous when interrupt admission is refused", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await old.fire("session_shutdown", "new");
		const next = f.install("successor");
		await next.fire("session_start", "new");
		f.interrupt.mockImplementation(() => Promise.reject(new Error("acknowledgement lost")));
		await expect(next.manager.cancel(["sa-1"])).resolves.toEqual(["sa-1 control unavailable; inspect retained evidence"]);
		expect(next.manager.get("sa-1")?.recovery).toBe("ambiguous");
	});

	it("uses dead-and-expired generation CAS without pretending a lost parser was recovered", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		await old.fire("session_shutdown", "resume");
		f.writerState("dead");
		f.originState("dead");
		const next = f.install("successor");
		vi.setSystemTime(61_001);
		await next.fire("session_start", "resume");
		expect(f.registry.get("sa-1")).toMatchObject({ status: "lost", controllerSessionId: "successor", controllerGeneration: 1, writerLease: { generation: 2 } });
		expect(next.manager.get("sa-1")?.recovery).toBe("lost");
		expect(next.delivery).not.toHaveBeenCalled();
		expect(f.interrupt).not.toHaveBeenCalled();
	});

	it("does not recapture a replaced registry directory while creating the successor view", async () => {
		const f = fixture();
		const old = f.install("origin");
		await f.track(old);
		old.manager.detachForReplacement();
		const directory = join(f.root, "registry");
		const original = join(f.root, "original-registry");
		renameSync(directory, original);
		mkdirSync(directory, { mode: 0o700 });
		copyFileSync(join(original, "sa-1.json"), join(directory, "sa-1.json"));
		const next = f.install("successor");
		await expect(next.manager.adoptFrom(old.manager, "successor")).rejects.toThrow("registry directory replaced");
		expect(next.manager.list()).toEqual([]);
		expect(old.manager.hasRetainedChildren).toBe(true);
		expect(next.delivery).not.toHaveBeenCalled();
		expect(f.interrupt).not.toHaveBeenCalled();
	});

	it("disposes non-retained legacy children and classifies them unsupported", async () => {
		const f = fixture();
		const old = f.install("origin");
		await old.manager.spawn({ title: "legacy", prompt: "task", cwd: f.record.taskDir });
		await old.fire("session_shutdown", "fork");
		expect(f.interrupt).toHaveBeenCalledTimes(1);
		expect(old.manager.get("sa-1")?.recovery).toBe("unsupported");
		expect(old.manager.hasRetainedChildren).toBe(false);
	});
});
