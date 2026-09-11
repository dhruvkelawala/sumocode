import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureProcessBirthTime, systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { AgentPanePlacement, TerminalHost } from "../terminal-host/types.js";
import { installSubagents } from "./index.js";
import { readRetainedBootstrap } from "./retained-bootstrap.js";
import { controlAuthority, serveRetainedControl } from "./retained-control.js";
import { observeRemoteRetained } from "./retained-adoption.js";
import { RetainedResults } from "./retained-results.js";
import { RetainedRuntime } from "./retained-runtime.js";
import { runRetainedSupervisorEntry } from "./retained-supervisor-entry.js";
import type { RegistryWriter } from "./registry.js";

afterEach(() => { vi.unstubAllEnvs(); });

function fixture(configuredPi?: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-retained-runtime-")));
	vi.stubEnv("SUMOCODE_STATE_DIR", root);
	const piBinary = join(root, "pi.js");
	writeFileSync(piBinary, "#!/usr/bin/env node\n", { mode: 0o700 });
	const controller = { token: "parent", pid: 1234, processStartTime: "parent-birth" };
	const writer = { token: "writer", pid: 4321, processStartTime: "writer-birth" };
	const operations: ProcessTreeOperations = { ...systemProcessTree, identityMatches: () => "same", verificationMatches: () => "same",
		census: () => [] };
	const visibleLaunches: Array<{ id: string; placement: AgentPanePlacement; provisioningTimeoutMs?: number }> = [];
	let paneSequence = 0;
	const spawnOwner = vi.fn((_command: string, args: readonly string[]) => {
		const id = args[args.indexOf("--id") + 1];
		const registry = retention.registry("session").forController(writer);
		const initial = registry.get(id)!;
		expect(initial).toMatchObject({ status: "starting", child: null, writerLease: null, controlLease: null });
		const { descriptor, prompt } = readRetainedBootstrap(initial, args[args.indexOf("--nonce") + 1]);
		expect(prompt).toBe("private task text");
		expect(descriptor.config).toMatchObject({ controller, model: { label: "provider/model" }, builtInTools: ["read"] });
		const visible = descriptor.config.visible;
		if (visible) {
			visibleLaunches.push({ id, placement: visible.placement, provisioningTimeoutMs: visible.provisioningTimeoutMs });
		}
		const held = registry.acquireWriter(id, initial.revision, 60_000);
		const evidence = (pid: number) => ({ identity: { pid, processGroupId: pid, processStartTime: `command-${pid}` },
			verification: { members: [{ pid, processStartTime: `birth-${pid}` }] } });
		paneSequence += 1;
		const pane = visible ? { agentName: "worker", workspaceId: "w1",
			tabId: visible.placement.kind === "tab" ? visible.placement.tabId : `w1:t${paneSequence}`,
			paneId: `w1:p${paneSequence}` } : null;
		const running = registry.transition(id, held.revision, 1, (record) => ({ ...record, status: "running",
			supervisor: evidence(writer.pid), child: evidence(5678), pane, launchIntent: { nonce: descriptor.nonce } }));
		registry.acquireControl(id, running.revision, 1, 0, controller, 60_000);
		return Object.assign(new EventEmitter(), { pid: writer.pid, unref: vi.fn() });
	});
	const retention = new RetainedRuntime({ spawnOwner, operations, registryOptions: { inspectWriter: () => "alive" },
		provenance: () => ({ pi: configuredPi ?? piBinary, sumocode: piBinary }) });
	const disposable = vi.fn();
	function install(identity: RegistryWriter = controller, session = "session", host: TerminalHost = { kind: "none", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn() }) {
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
		const sendMessage = vi.fn();
		const api = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
			registerTool: vi.fn(), sendMessage };
		// SAFETY: this caller double supplies the installation and lifecycle API used in these tests.
		const manager = installSubagents(api as never, { retention, spawnPiChild: disposable,
			terminalHost: host,
			managerDependencies: { controllerIdentity: identity, processOperations: operations, captureGitContext: async () => ({ baseRef: "base-sha" }) } });
		// SAFETY: lifecycle handlers use only these context members when UI is disabled.
		const context = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => session } } as never;
		// SAFETY: both exercised lifecycle handlers only read the event reason.
		const fire = (event: string, reason = "startup") => handlers.get(event)!({ reason } as never, context);
		return { manager, fire, sendMessage };
	}
	const task = { prompt: "private task text", title: "worker", cwd: root,
		inherited: { model: { provider: "provider", id: "model" }, thinking: "low" }, builtInTools: ["read"] };
	return { root, controller, writer, retention, operations, spawnOwner, disposable, install, task, visibleLaunches };
}

it("retains a normally installed production launch instead of using the disposable backend", async () => {
	const f = fixture();
	const runtime = f.install();
	try {
		await runtime.fire("session_start");
		const result = await runtime.manager.spawn(f.task);
		expect(result).toMatchObject({ status: "running", recovery: "adopted" });
		expect(runtime.manager.hasRetainedChildren).toBe(true);
		expect(f.disposable).not.toHaveBeenCalled();
		expect(f.spawnOwner).toHaveBeenCalledOnce();
		expect(JSON.stringify(f.spawnOwner.mock.calls)).not.toContain("private task text");
	} finally { runtime.manager.detachForReplacement(); }
});

it("counts a retained-visible pane persisted by the owner in placement and reclaims it after settlement", async () => {
	const f = fixture();
	vi.stubEnv("HERDR_TAB_ID", undefined);
	const host: TerminalHost = {
		kind: "herdr",
		inspectPane: vi.fn(async () => ({ ok: true as const, shellPid: 5678, foregroundProcessGroupId: 5678, foregroundPids: [5678] })),
		openCommandInSplit: vi.fn(async () => ({ ok: false as const, error: "unsupported" })),
		closePane: vi.fn(async () => ({ ok: false as const, error: "unsupported" })),
		notify: vi.fn(async () => undefined),
	};
	const runtime = f.install(f.controller, "session", host);
	try {
		await runtime.fire("session_start");
		const first = await runtime.manager.spawn({ ...f.task, visible: true });
		if (!("id" in first)) throw new Error("first visible child was not admitted");
		// Retained ids carry the title slug plus the 4-char installation namespace.
		expect(first.id).toMatch(/^sa-worker-1-[0-9a-f]{4}$/);
		// The owner persists the pane in the registry instead of emitting
		// `pane-attached`; the manager observer must surface it and follow its tab.
		expect(first).toMatchObject({ status: "running", recovery: "adopted", pane: { tabId: "w1:t1", paneId: "w1:p1" } });
		expect(runtime.manager.get(first.id)?.pane).toEqual({ agentName: "worker", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" });
		expect(f.visibleLaunches[0]).toMatchObject({ id: first.id, placement: { kind: "new-tab", label: "subagents" } });
		expect(f.visibleLaunches[0]?.provisioningTimeoutMs).toEqual(expect.any(Number));
		expect(f.visibleLaunches[0]?.provisioningTimeoutMs).toBeGreaterThan(0);
		expect(f.visibleLaunches[0]?.provisioningTimeoutMs).toBeLessThanOrEqual(4_750);

		// The recorded pane occupies w1:t1, so the next spawn must split that tab
		// instead of provisioning a duplicate: placement counts retained panes.
		const second = await runtime.manager.spawn({ ...f.task, visible: true });
		if (!("id" in second)) throw new Error("second visible child was not admitted");
		expect(f.visibleLaunches[1]).toMatchObject({ id: second.id, placement: { kind: "tab", tabId: "w1:t1", direction: "down" } });

		const registry = f.retention.registry("session").forController(f.writer);
		// The private task dir follows the id (join(tasks, task.id)).
		expect(registry.get(first.id)?.taskDir.endsWith(`/${first.id}`)).toBe(true);
		const settle = (id: string): void => {
			const record = registry.get(id)!;
			const artifacts = new RetainedResults(record.taskDir);
			artifacts.append({ kind: "run-started" });
			const result = artifacts.writeResult({ kind: "completed", finalText: "done" });
			const manifest = artifacts.writeManifest({ exit: "completed", durationMs: 1 });
			registry.transition(id, record.revision, record.writerLease!.generation, (current) => ({ ...current, status: "settled", outcome: "completed",
				settledAt: Date.now(), completionId: `completion-${id}`, result: result.pointer, manifest, delivery: { state: "undelivered" } }));
		};
		settle(first.id);
		await vi.waitFor(() => expect(runtime.manager.get(first.id)?.status).toBe("done"));
		settle(second.id);
		await vi.waitFor(() => expect(runtime.manager.get(second.id)?.status).toBe("done"));

		// Both settled panes are gone, so the next spawn must plan a fresh tab
		// rather than target the emptied one: reclamation sees the retained slot.
		const third = await runtime.manager.spawn({ ...f.task, visible: true });
		if (!("id" in third)) throw new Error("third visible child was not admitted");
		expect(f.visibleLaunches[2]).toMatchObject({ id: third.id, placement: { kind: "new-tab", label: "subagents" } });
	} finally {
		runtime.manager.detachForReplacement();
	}
});

it("surfaces a retained-visible pane_unavailable reason and orphan slot through spawn", async () => {
	const f = fixture();
	const host: TerminalHost = {
		kind: "herdr",
		startAgentPane: vi.fn(async () => ({
			ok: false as const, code: "pane_unavailable",
			error: "herdr tab create failed", reason: "herdr tab create failed; cleanup: close refused",
			orphanPaneId: "w1:p9", orphanTabId: "w1:t9",
		})),
		openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn(),
	};
	// The mock replaces only the detached-process boundary; the real owner entry
	// runs in-process, so the refusal travels host -> backend -> supervisor ->
	// registry -> parent -> manager exactly as production does. An in-process
	// owner is not a group leader, so verification is stubbed the way a detached
	// production owner would provide it.
	const operations: ProcessTreeOperations = { ...f.operations,
		captureTreeVerification: () => ({ members: [{ pid: process.pid, processStartTime: captureProcessBirthTime(process.pid)! }] }) };
	f.spawnOwner.mockImplementation((_command, args) => {
		void runRetainedSupervisorEntry(args.slice(1), { host, executor: { exec: vi.fn() }, operations }).catch(() => undefined);
		return Object.assign(new EventEmitter(), { pid: f.writer.pid, unref: vi.fn() });
	});
	const runtime = f.install({ token: "parent", pid: process.pid, processStartTime: captureProcessBirthTime(process.pid)! }, "session", host);
	try {
		await runtime.fire("session_start");
		const result = await runtime.manager.spawn({ ...f.task, visible: true });
		expect(result).toMatchObject({
			status: "error",
			errorCode: "pane_unavailable",
			errorReason: "herdr tab create failed; cleanup: close refused",
			errorText: expect.stringContaining("herdr tab create failed"),
			paneStillOpen: true,
			pane: { agentName: expect.stringMatching(/^sa-worker-1-[0-9a-f]{4}$/), paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1" },
		});
		// A refused admitted launch never falls back to the disposable backend.
		expect(f.disposable).not.toHaveBeenCalled();
	} finally { runtime.manager.detachForReplacement(); }
});

it("bounds the owner-bootstrap wait by the caller's remaining provisioning budget", async () => {
	const f = fixture();
	// Never publish a running record: the parent must give up on the caller's
	// remaining budget instead of the fixed owner-startup wait.
	f.spawnOwner.mockImplementation(() => Object.assign(new EventEmitter(), { pid: f.writer.pid, unref: vi.fn() }));
	const startedAt = Date.now();
	// SAFETY: the stalled owner never publishes a record, so this PiExecLike double is never invoked.
	await expect(f.retention.spawn({ ...f.task, visible: true, placement: { kind: "new-tab", label: "subagents" },
		signal: new AbortController().signal, id: "sa-budget", baseRef: "base-sha", provisioningTimeoutMs: 120 },
	"session", f.controller, { kind: "none", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn() }, { exec: vi.fn() } as never))
		.rejects.toThrow("retained launch unconfirmed");
	expect(Date.now() - startedAt).toBeLessThan(2_000);
});

it.each(["before", "during", "after"] as const)("delivers a production child's completion after transferring with cleanup %s observation", async (phase) => {
	const f = fixture();
	const previous = f.install();
	await previous.fire("session_start");
	const result = await previous.manager.spawn(f.task);
	if (!("id" in result)) throw new Error("test child was not admitted");
	const registry = f.retention.registry("session").forController(f.writer);
	const stop = serveRetainedControl(registry, result.id, () => ({ events: () => undefined, interrupt: vi.fn() }), (authority, successor) => {
		const fresh = registry.get(result.id)!;
		return registry.reserveControl(fresh.revision, authority, `${result.id}:${authority.head + 1}`, { ...successor, writerGeneration: 1 });
	});
	const next = f.install({ token: "successor", pid: 9876, processStartTime: "next-birth" }, "replacement");
	try {
		await previous.fire("session_shutdown", "new");
		await next.fire("session_start");
		expect(next.manager.get(result.id)).toMatchObject({ status: "running", recovery: "adopted" });
		const running = registry.get(result.id)!;
		const observed = new Promise<void>((resolve) => {
			const stop = next.manager.addChangeListener(() => { stop(); resolve(); });
		});
		let current = running;
		const settling = () => { current = registry.transition(result.id, current.revision, 1, (record) => ({ ...record, status: "settling" })); };
		if (phase === "before") settling();
		f.operations.identityMatches = (identity) => {
			if (identity.pid === f.writer.pid) {
				if (current.status === "running" && phase === "during") settling();
				return "same";
			}
			return "different";
		};
		if (phase === "after") current = registry.transition(result.id, current.revision, 1, (record) => ({ ...record,
			telemetry: { startedAt: record.createdAt, lastProgressAt: Date.now() } }));
		await observed;
		expect(next.manager.get(result.id)).toMatchObject({ status: "running", recovery: "adopted" });
		if (phase === "after") {
			const observer = observeRemoteRetained(registry, current, f.operations);
			expect(() => observer.controllerChild(controlAuthority(current))).toThrow("retained owner changed");
			settling();
		}
		const artifacts = new RetainedResults(current.taskDir);
		artifacts.append({ kind: "run-started" });
		const completed = artifacts.writeResult({ kind: "completed", finalText: "retained answer" });
		const manifest = artifacts.writeManifest({ baseRef: "base-sha", headRef: "head-sha", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 10 });
		registry.transition(result.id, current.revision, 1, (record) => ({ ...record, status: "settled", outcome: "completed",
			settledAt: Date.now(), completionId: "completed-once", result: completed.pointer, manifest, delivery: { state: "undelivered" } }));
		f.operations.identityMatches = () => "different";
		await vi.waitFor(() => expect(next.manager.get(result.id)).toMatchObject({ status: "done", finalText: "retained answer" }));
		expect(next.sendMessage).toHaveBeenCalledOnce();
		expect(previous.sendMessage).not.toHaveBeenCalled();
		expect(f.spawnOwner).toHaveBeenCalledOnce();
		expect(registry.get(result.id)?.writerLease?.owner).toEqual(f.writer);
	} finally { stop(); previous.manager.detachForReplacement(); next.manager.detachForReplacement(); }
});

it("marks an unsupported executable launch as disposable instead of claiming retention", async () => {
	const f = fixture();
	writeFileSync(join(f.root, "pi.js"), "#!/bin/sh\n", { mode: 0o700 });
	f.disposable.mockReturnValue({ events: () => undefined, interrupt: vi.fn() });
	const runtime = f.install();
	try {
		await runtime.fire("session_start");
		expect(await runtime.manager.spawn(f.task)).toMatchObject({ recovery: "unsupported" });
		expect(runtime.manager.hasRetainedChildren).toBe(false);
		expect(f.spawnOwner).not.toHaveBeenCalled();
		expect(f.disposable).toHaveBeenCalledOnce();
	} finally { runtime.manager.disposeAll(); }
});


it("keeps a production launch observable while telemetry changes during identity checks", async () => {
	const f = fixture();
	const runtime = f.install();
	try {
		await runtime.fire("session_start");
		f.operations.identityMatches = () => {
			const registry = f.retention.registry("session").forController(f.writer);
			const { record } = registry.discover()[0];
			registry.transition(record.id, record.revision, 1, (value) => ({ ...value, telemetry: { startedAt: value.createdAt,
				lastProgressAt: Date.now(), reportedTokens: (value.telemetry?.reportedTokens ?? 0) + 1 } }));
			return "same";
		};
		expect(await runtime.manager.spawn(f.task)).toMatchObject({ status: "running", recovery: "adopted" });
	} finally { runtime.manager.detachForReplacement(); }
});

it.each(["missing-path", "missing-command", "shared-write"])("keeps the disposable backend when retained executable probing refuses %s", async (layout) => {
	const f = fixture(layout === "missing-path" ? "/nonexistent/sumocode-test/pi" : layout === "missing-command" ? "sumocode-test-missing-pi" : undefined);
	if (layout === "shared-write") chmodSync(join(f.root, "pi.js"), 0o722);
	f.disposable.mockReturnValue({ events: () => undefined, interrupt: vi.fn() });
	const runtime = f.install();
	try {
		await runtime.fire("session_start");
		expect(await runtime.manager.spawn(f.task)).toMatchObject({ recovery: "unsupported" });
		expect(f.spawnOwner).not.toHaveBeenCalled();
		expect(f.disposable).toHaveBeenCalledOnce();
		expect(f.retention.registry("session").discover()).toEqual([]);
	} finally { runtime.manager.disposeAll(); }
});

it("does not retry an admitted retained launch through the disposable backend", async () => {
	const f = fixture();
	f.spawnOwner.mockImplementation(() => { throw new Error("owner launch failed"); });
	const runtime = f.install();
	try {
		await runtime.fire("session_start");
		expect(await runtime.manager.spawn(f.task)).toMatchObject({ status: "error", errorText: expect.stringContaining("owner launch failed") });
		expect(f.disposable).not.toHaveBeenCalled();
		expect(f.retention.registry("session").discover()).toHaveLength(1);
	} finally { runtime.manager.disposeAll(); }
});
