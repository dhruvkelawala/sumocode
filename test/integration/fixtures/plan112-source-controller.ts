import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemProcessTree, type ProcessTreeOperations } from "../../../src/background-tasks/process-tree.js";
import { herdrTerminalHost } from "../../../src/terminal-host/herdr.js";
import type { PiExecLike } from "../../../src/terminal-host/types.js";
import { createPiChildSpawner, type SpawnedChild } from "../../../src/subagents/backend-pi.js";
import type { RunOutcome, SubagentRecoveryReason, SubagentSnapshot } from "../../../src/subagents/domain.js";
import { installSubagents } from "../../../src/subagents/index.js";
import { SubagentRegistry, type RegistryProcess, type RegistryWriter, type SubagentRecord } from "../../../src/subagents/registry.js";
import { controlAuthority } from "../../../src/subagents/retained-adoption.js";
import { prepareRetainedBootstrap } from "../../../src/subagents/retained-bootstrap.js";
import { censusRetained } from "../../../src/subagents/retained-census.js";
import { RetainedHeadlessSupervisor, RetainedVisibleSupervisor } from "../../../src/subagents/retained-supervisor.js";
import { buildCompletionManifest } from "../../../src/subagents/manifest.js";
import { runLocalFault } from "./plan112-local-faults.js";
import { visibleRecoveryExecutor, visibleRecoveryLaunch } from "./plan112-visible-recovery.js";

interface ControllerReport {
	error?: string; expiresAt?: number; headlessSteering?: boolean; child?: RegistryProcess | null;
	outcome?: RunOutcome; census?: string; recovery?: string; recoveryReason?: SubagentRecoveryReason; settlement?: string; deliveries?: number; steering?: string;
}

/** Real controllers share only the registry directory across Node processes. */
export async function runSourceController(root: string, mode: string, pi: string, provider: string): Promise<void> {
	const put = (name: string, value: ControllerReport | RegistryWriter): void => publishReport(join(root, name), JSON.stringify(value));
	const registry = new SubagentRegistry(join(root, "registry"), "origin");
	const visible = existsSync(join(root, "visible"));
	const create = (session: string, retainedRegistry?: SubagentRegistry) => install(session, retainedRegistry, { visible });
	// SAFETY: the admitted test parent alone writes this private JSON string.
	const scenario = existsSync(join(root, "scenario.json")) ? JSON.parse(readFileSync(join(root, "scenario.json"), "utf8")) as string : "";
	const cut = (point: string): void => {
		if (scenario !== `crash:${point}`) return;
		put("cut-ready.json", {});
		// Only the external birth-verified owner may end this held controller.
		while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	};
	if (mode === "probe") { put("probe-ready.json", {}); return; }
	if (mode === "contender") {
		const before = registry.get("sa-real")!;
		const runtime = create("contender", registry);
		try {
			await runtime.fire("session_start", "restart");
			assert.notEqual(runtime.manager.get(before.id)?.recovery, "adopted");
			assert.deepEqual(registry.get(before.id)?.controlLease, before.controlLease);
			await runtime.manager.cancel([before.id]);
			await runtime.fire("agent_end");
			assert.equal(runtime.deliveries.length, 0);
			put("contender-result.json", {});
		} finally { runtime.manager.detachForReplacement(); }
		return;
	}
	if (mode === "delivery-successor" || mode === "delivery-final") {
		const runtime = create(mode, registry);
		try {
			if (scenario === "delivery:notice-before-ack" && mode === "delivery-successor") runtime.afterSend(() => {
				put("notice-cut-ready.json", {});
				while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			});
			await runtime.fire("session_start", "restart");
			await runtime.fire("agent_end"); await runtime.fire("agent_end");
			assert.equal(runtime.deliveries.length, mode === "delivery-final" ? 0 : 1);
			if (mode === "delivery-successor") assert.equal(runtime.deliveries[0]?.customType, "subagent-delivery-uncertain");
			put(`${mode}-result.json`, { deliveries: runtime.deliveries.length });
		} finally { runtime.manager.detachForReplacement(); }
		return;
	}
	if (mode.startsWith("race-")) {
		const runtime = create(mode, registry);
		put(`${mode}-ready.json`, {});
		await waitForFile(join(root, "race-release"));
		await runtime.fire("session_start", "restart");
		put(`${mode}-result.json`, { recovery: runtime.manager.get("sa-real")?.recovery ?? "absent" });
		return;
	}
	if (mode === "recover-lost") {
		const before = registry.get("sa-real")!;
		const runtime = create("successor", registry);
		try {
			await runtime.fire("session_start", "restart");
			const after = registry.get(before.id)!;
			assert.equal(after.status, "lost");
			assert.equal(after.writerLease!.generation, before.writerLease!.generation + 1);
			assert.deepEqual(after.child, before.child);
			assert.equal(runtime.deliveries.length, 0);
			put("recover-lost-result.json", {});
		} finally { runtime.manager.detachForReplacement(); }
		return;
	}
	if (mode === "takeover") {
		const before = registry.get("sa-real")!;
		const taken = registry.acquireWriter(before.id, before.revision, 60_000);
		assert.equal(taken.writerLease!.generation, before.writerLease!.generation + 1);
		assert.deepEqual(taken.child, before.child);
		assert.throws(() => registry.forController(before.writerLease!.owner).transition(taken.id, taken.revision, before.writerLease!.generation, (record) => record));
		put("takeover-result.json", {});
		return;
	}
	if (mode === "origin") {
		const runtime = create("origin", registry);
		put("origin-identity.json", runtime.manager.controllerIdentity);
		return;
	}
	if (mode === "successor") {
		const before = registry.get("sa-real")!;
		const observations = censusRetained(registry);
		assert.equal(observations[0]?.launch, "verified");
		assert.equal(observations[0]?.censusKnown, true);
		const runtime = create("successor", registry);
		await runtime.fire("session_start", "restart");
		const recovered = runtime.manager.get(before.id);
		if (recovered?.recovery !== "adopted") {
			put("successor-result.json", { error: "retained recovery refused", recovery: recovered?.recovery ?? "absent", recoveryReason: recovered?.recoveryReason });
			return;
		}
		assert.equal(registry.inspectControl(controlAuthority(before)), false);
		assert.deepEqual(registry.get(before.id)?.child, before.child);
		assert.deepEqual(registry.get(before.id)?.supervisor, before.supervisor);
		try {
			const result = await runtime.manager.sendTo(before.id, "steer after disk recovery");
			if (visible) assert("id" in result && result.id === before.id && result.visible);
			else assert.deepEqual(result, { capability: "unsupported: headless steering" });
			put("successor-result.json", { steering: visible ? "consumed" : "unsupported: headless steering", census: "verified", recovery: "adopted" });
		} finally { runtime.manager.detachForReplacement(); }
		return;
	}
	assert(["same-process", "owner"].includes(mode));
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const now = Date.now();
	const initial: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-real", ownerSessionId: "origin", backend: visible ? "visible" : "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: "source-proof/fixed", roleId: "synthetic-role",
		createdAt: now, updatedAt: now, settledAt: null, completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const descriptor = visible ? undefined : prepareRetainedBootstrap(initial, {
		cwd: join(root, "cwd"), baseRef: "HEAD", pi, adapterEntry: provider, modelBootstrapEntry: null, visible: null,
		model: { provider: "source-proof", modelId: "fixed", label: "source-proof/fixed" }, thinking: "off", builtInTools: [],
		role: { id: "synthetic-role", label: "synthetic role" },
	}, { prompt: "synthetic recovery task", systemPrompt: "synthetic private role" });
	let backend!: SpawnedChild;
	const spawner = createPiChildSpawner(registeredAnchorSpawn(root, scenario), () => provider, () => pi);
	const pane = visible ? visibleRecoveryLaunch(root, pi, provider) : undefined;
	const owner = pane ? new RetainedVisibleSupervisor({ registry, initial, supervisor: captureBirth(process.pid), baseRef: "HEAD",
		launch: { cwd: join(root, "cwd"), prompt: "synthetic recovery task", appendSystemPrompt: "synthetic private role",
			name: "plan112 recovery", id: initial.id, host: pane.host, pi: pane.pi, placement: { kind: "new-tab", label: "plan112 recovery" },
			model: "source-proof/fixed", thinking: "off", tools: [] },
	}, { spawn: (options) => { backend = pane.spawn(options); return backend; } }) : new RetainedHeadlessSupervisor({ registry, initial, supervisor: captureBirth(process.pid), baseRef: "HEAD",
		launch: { cwd: join(root, "cwd"), prompt: "synthetic recovery task", inherited: {}, builtInTools: [], thinking: "off",
			model: "source-proof/fixed", retainedBootstrap: descriptor },
	}, {
		spawn: (options) => {
			cut("starting");
			const gate = options.launchGate!;
			backend = spawner({ ...options, launchGate: { ...gate, beforePrompt: (pid) => { cut("pre-release"); gate.beforePrompt(pid); } } });
			if (scenario === "cancel") {
				const interrupt = backend.interrupt;
				let count = 0;
				backend = { ...backend, interrupt: (...args) => {
					writeFileSync(join(root, "interrupt-count.json"), JSON.stringify(++count), { mode: 0o600 });
					return interrupt(...args);
				} };
			}
			return backend;
		},
		buildManifest: async (options) => { cut("settling"); return buildCompletionManifest(options); },
		onManifestWritten: () => cut("post-manifest"),
	});
	await owner.ready;
	await waitForFile(join(root, "provider-called.json"));
	if (scenario === "expired-owner") {
		const record = owner.record;
		registry.acquireControl(record.id, record.revision, record.writerLease!.generation, record.controlHead, record.writerLease!.owner, 60_000);
	}
	put("owner-ready.json", { headlessSteering: Boolean(backend.send), child: owner.record.child });
	cut("running");
	if (mode === "same-process" && scenario) {
		assert(owner instanceof RetainedHeadlessSupervisor);
		await runLocalFault(root, scenario, registry, owner, initial, create);
		put("same-process-result.json", { steering: "unsupported: headless steering" });
		return;
	}
	if (mode === "owner") {
		await waitForFile(join(root, "origin-identity.json"));
		// SAFETY: the test's private controller publishes its actual PID/birth;
		// acquireControl independently verifies liveness before granting it.
		const controller = JSON.parse(readFileSync(join(root, "origin-identity.json"), "utf8")) as RegistryWriter;
		const record = owner.record;
		const granted = registry.acquireControl(record.id, record.revision, record.writerLease!.generation, record.controlHead, controller, 3000);
		put("origin-ready.json", { expiresAt: granted.controlLease!.expiresAt });
		assert.equal(await owner.settlement, "settled");
		put("owner-result.json", { outcome: owner.completion?.outcome });
		return;
	}
	const old = create("origin");
	const current = owner.record;
	const granted = registry.acquireControl(current.id, current.revision, current.writerLease!.generation, current.controlHead, old.manager.controllerIdentity, 60_000);
	const authority = controlAuthority(granted);
	const snapshot: SubagentSnapshot = { id: initial.id, title: "worker", prompt: "synthetic recovery task", cwd: join(root, "cwd"), baseRef: "HEAD",
		status: "running", createdAt: now, visible, usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
	await old.manager.trackRetained({ registry: registry.forController(old.manager.controllerIdentity), supervisor: owner, snapshot, authority });
	await old.fire("session_shutdown", "new");
	const next = create("successor");
	try {
		await next.fire("session_start", "new");
		assert.equal(registry.inspectControl(authority), false);
		const recovered = next.manager.get(initial.id);
		if (recovered?.recovery !== "adopted") {
			put("same-process-result.json", { error: "retained recovery refused", recovery: recovered?.recovery ?? "absent", recoveryReason: recovered?.recoveryReason });
			return;
		}
		assert.deepEqual(owner.record.child, current.child);
		assert.equal(Boolean(backend.send), visible);
		const result = await next.manager.sendTo(initial.id, "steer after recovery");
		if (visible) assert("id" in result && result.id === initial.id && result.visible);
		else assert.deepEqual(result, { capability: "unsupported: headless steering" });
		put("finish", {});
		assert.equal(await owner.settlement, "settled");
		assert.equal(next.manager.get(initial.id)?.finalText, "preserved result");
		await old.fire("agent_end");
		await next.fire("agent_end"); await next.fire("agent_end");
		assert.equal(old.deliveries.length, 0);
		assert.equal(next.deliveries.length, 1);
		put("same-process-result.json", { steering: visible ? "consumed" : "unsupported: headless steering", recovery: "adopted", settlement: "settled", deliveries: 1 });
	} finally { old.manager.detachForReplacement(); next.manager.detachForReplacement(); }
}

export function install(session: string, registry?: SubagentRegistry,
	options: { visible?: boolean; executor?: PiExecLike; operations?: ProcessTreeOperations } = {}) {
	type Handler = (event: { type: string; reason: string }, context: ExtensionContext) => void | Promise<void>;
	const handlers = new Map<string, Handler>();
	const deliveries: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	type Tool = { name: string; execute: (id: string, params: { id?: string; ids?: string[] }) => Promise<{ details: unknown }> };
	const tools = new Map<string, Tool>();
	let afterSend: (() => void) | undefined;
	const api = { on: (name: string, handler: Handler) => { handlers.set(name, handler); }, registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
		sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => { deliveries.push(message); afterSend?.(); },
		exec: options.visible ? (options.executor ?? visibleRecoveryExecutor).exec : () => { throw new Error("unexpected controller exec"); } };
	const refuseSpawn = () => { throw new Error("replacement must not respawn"); };
	// SAFETY: only installer registration and idle lifecycle methods are exercised.
	const manager = installSubagents(api as never, { retainedRegistry: registry,
		terminalHost: options.visible ? herdrTerminalHost : undefined,
		managerDependencies: { processOperations: options.operations },
		spawnPiChild: refuseSpawn, spawnPaneChild: refuseSpawn });
	return { manager, deliveries, tools, afterSend: (callback: () => void) => { afterSend = callback; }, fire: async (name: string, reason = "startup") => {
		// SAFETY: these lifecycle handlers need only the session ID and idle/UI flags.
		const context = { isIdle: () => true, hasUI: false, sessionManager: { getSessionId: () => session } } as ExtensionContext;
		await handlers.get(name)?.({ type: name, reason }, context);
	} };
}

export function captureBirth(pid: number) {
	const processStartTime = systemProcessTree.captureStartTime(pid);
	assert(processStartTime, "birth: command identity unknown");
	const identity = { pid, processGroupId: pid, processStartTime };
	const verification = systemProcessTree.captureTreeVerification!(identity);
	assert(verification && verification.members.some((member) => member.pid === pid), "birth: group identity unknown");
	return { identity, verification };
}

function registeredAnchorSpawn(root: string, scenario: string): typeof spawn {
	// SAFETY: preserves spawn's overloads and original IPC/pipe handle.
	return ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
		const child = spawn(command, args, options);
		if (scenario === "census") child.on("message", (message) => {
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parse the real anchor IPC boundary; unrelated messages must pass untouched.
			if (message && typeof message === "object" && "kind" in message && message.kind === "exited") {
				writeFileSync(join(root, "pi-exited.json"), "{}", { mode: 0o600, flag: "wx" });
				const deadline = Date.now() + 10_000;
				while (!existsSync(join(root, "census-release"))) {
					assert(Date.now() < deadline, "census observation timeout");
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				}
			}
		});
		publishReport(join(root, "anchor-spawn.json"), JSON.stringify({ pid: child.pid }));
		child.once("spawn", () => {
			const birth = captureBirth(child.pid!);
			publishReport(join(root, "anchor-birth.json"), JSON.stringify(birth));
			// Block only this source driver. Vitest registers the original birth with
			// the shared supervisor before the backend's later spawn callback releases Pi.
			const deadline = Date.now() + 10_000;
			while (!existsSync(join(root, `admit-${child.pid}`))) {
				if (Date.now() >= deadline) throw new Error("anchor birth admission timeout");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		});
		return child;
	}) as typeof spawn;
}

function publishReport(path: string, text: string): void {
	writeFileSync(`${path}.pending`, text, { mode: 0o600, flag: "wx" });
	renameSync(`${path}.pending`, path);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!existsSync(path)) {
		assert(Date.now() < deadline, `timed out: ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
