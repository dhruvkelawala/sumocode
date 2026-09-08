import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { installSubagents } from "./index.js";
import { readRetainedBootstrap } from "./retained-bootstrap.js";
import { serveRetainedControl } from "./retained-control.js";
import { RetainedResults } from "./retained-results.js";
import { RetainedRuntime } from "./retained-runtime.js";
import type { RegistryWriter } from "./registry.js";

afterEach(() => { vi.unstubAllEnvs(); });

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-retained-runtime-")));
	vi.stubEnv("SUMOCODE_STATE_DIR", root);
	const piBinary = join(root, "pi.js");
	writeFileSync(piBinary, "#!/usr/bin/env node\n", { mode: 0o700 });
	const controller = { token: "parent", pid: 1234, processStartTime: "parent-birth" };
	const writer = { token: "writer", pid: 4321, processStartTime: "writer-birth" };
	const operations: ProcessTreeOperations = { ...systemProcessTree, identityMatches: () => "same", verificationMatches: () => "same",
		census: () => [] };
	const spawnOwner = vi.fn((_command: string, args: readonly string[]) => {
		const id = args[args.indexOf("--id") + 1];
		const registry = retention.registry("session").forController(writer);
		const initial = registry.get(id)!;
		expect(initial).toMatchObject({ status: "starting", child: null, writerLease: null, controlLease: null });
		const { descriptor, prompt } = readRetainedBootstrap(initial, args[args.indexOf("--nonce") + 1]);
		expect(prompt).toBe("private task text");
		expect(descriptor.config).toMatchObject({ controller, model: { label: "provider/model" }, builtInTools: ["read"] });
		const held = registry.acquireWriter(id, initial.revision, 60_000);
		const evidence = (pid: number) => ({ identity: { pid, processGroupId: pid, processStartTime: `command-${pid}` },
			verification: { members: [{ pid, processStartTime: `birth-${pid}` }] } });
		const running = registry.transition(id, held.revision, 1, (record) => ({ ...record, status: "running",
			supervisor: evidence(writer.pid), child: evidence(5678), launchIntent: { nonce: descriptor.nonce } }));
		registry.acquireControl(id, running.revision, 1, 0, controller, 60_000);
		return Object.assign(new EventEmitter(), { pid: writer.pid, unref: vi.fn() });
	});
	const retention = new RetainedRuntime({ spawnOwner, operations, registryOptions: { inspectWriter: () => "alive" },
		provenance: () => ({ pi: piBinary, sumocode: piBinary }) });
	const disposable = vi.fn();
	function install(identity: RegistryWriter = controller, session = "session") {
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
		const sendMessage = vi.fn();
		const api = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
			registerTool: vi.fn(), sendMessage };
		// SAFETY: this caller double supplies the installation and lifecycle API used in these tests.
		const manager = installSubagents(api as never, { retention, spawnPiChild: disposable,
			terminalHost: { kind: "none", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn() },
			managerDependencies: { controllerIdentity: identity, processOperations: operations, captureGitContext: async () => ({ baseRef: "base-sha" }) } });
		// SAFETY: lifecycle handlers use only these context members when UI is disabled.
		const context = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => session } } as never;
		// SAFETY: both exercised lifecycle handlers only read the event reason.
		const fire = (event: string, reason = "startup") => handlers.get(event)!({ reason } as never, context);
		return { manager, fire, sendMessage };
	}
	const task = { prompt: "private task text", title: "worker", cwd: root,
		inherited: { model: { provider: "provider", id: "model" }, thinking: "low" }, builtInTools: ["read"] };
	return { root, controller, writer, retention, operations, spawnOwner, disposable, install, task };
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

it.each(["before", "during"] as const)("delivers a production child's completion after transferring with cleanup %s observation", async (phase) => {
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
			if (identity.pid === f.writer.pid) return "same";
			if (current.status === "running") settling();
			return "different";
		};
		await observed;
		expect(next.manager.get(result.id)).toMatchObject({ status: "running", recovery: "adopted" });
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
