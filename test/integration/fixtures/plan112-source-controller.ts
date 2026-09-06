import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemProcessTree } from "../../../src/background-tasks/process-tree.js";
import { createPiChildSpawner, type SpawnedChild } from "../../../src/subagents/backend-pi.js";
import type { RunOutcome, SubagentSnapshot } from "../../../src/subagents/domain.js";
import { installSubagents } from "../../../src/subagents/index.js";
import { SubagentRegistry, type RegistryProcess, type RegistryWriter, type SubagentRecord } from "../../../src/subagents/registry.js";
import { controlAuthority } from "../../../src/subagents/retained-adoption.js";
import { prepareRetainedBootstrap } from "../../../src/subagents/retained-bootstrap.js";
import { censusRetained } from "../../../src/subagents/retained-census.js";
import { RetainedHeadlessSupervisor } from "../../../src/subagents/retained-supervisor.js";

interface ControllerReport {
	error?: string; expiresAt?: number; headlessSteering?: boolean; child?: RegistryProcess | null;
	outcome?: RunOutcome; census?: string; recovery?: string; settlement?: string; deliveries?: number; steering?: string;
}

/** Real controllers share only the registry directory across Node processes. */
export async function runSourceController(root: string, mode: string, pi: string, provider: string): Promise<void> {
	const put = (name: string, value: ControllerReport | RegistryWriter): void => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600, flag: "wx" });
	const registry = new SubagentRegistry(join(root, "registry"), "origin");
	if (mode === "origin") {
		const runtime = install("origin", registry);
		put("origin-identity.json", runtime.manager.controllerIdentity);
		return;
	}
	if (mode === "successor") {
		const before = registry.get("sa-real")!;
		const observations = censusRetained(registry);
		assert.equal(observations[0]?.launch, "verified");
		assert.equal(observations[0]?.censusKnown, true);
		const runtime = install("successor", registry);
		await runtime.fire("session_start", "restart");
		assert.equal(runtime.manager.get(before.id)?.recovery, "adopted");
		assert.equal(registry.inspectControl(controlAuthority(before)), false);
		assert.deepEqual(registry.get(before.id)?.child, before.child);
		assert.deepEqual(registry.get(before.id)?.supervisor, before.supervisor);
		try {
			const result = await runtime.manager.sendTo(before.id, "steer after disk recovery");
			assert.deepEqual(result, { capability: "unsupported: headless steering" });
			put("successor-result.json", { steering: "unsupported: headless steering", census: "verified", recovery: "adopted" });
		} finally { runtime.manager.detachForReplacement(); }
		return;
	}
	assert(["same-process", "owner"].includes(mode));
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const now = Date.now();
	const initial: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-real", ownerSessionId: "origin", backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: "source-proof/fixed", roleId: "synthetic-role",
		createdAt: now, updatedAt: now, settledAt: null, completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const descriptor = prepareRetainedBootstrap(initial, {
		cwd: join(root, "cwd"), baseRef: "HEAD", pi, adapterEntry: provider, modelBootstrapEntry: null, visible: null,
		model: { provider: "source-proof", modelId: "fixed", label: "source-proof/fixed" }, thinking: "off", builtInTools: [],
		role: { id: "synthetic-role", label: "synthetic role" },
	}, { prompt: "synthetic recovery task", systemPrompt: "synthetic private role" });
	let backend!: SpawnedChild;
	const spawner = createPiChildSpawner(registeredAnchorSpawn(root), () => provider, () => pi);
	const owner = new RetainedHeadlessSupervisor({ registry, initial, supervisor: captureBirth(process.pid), baseRef: "HEAD",
		launch: { cwd: join(root, "cwd"), prompt: "synthetic recovery task", inherited: {}, builtInTools: [], thinking: "off",
			model: "source-proof/fixed", retainedBootstrap: descriptor },
	}, { spawn: (options) => { backend = spawner(options); return backend; } });
	await owner.ready;
	await waitForFile(join(root, "provider-called.json"));
	put("owner-ready.json", { headlessSteering: Boolean(backend.send), child: owner.record.child });
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
	const old = install("origin");
	const current = owner.record;
	const granted = registry.acquireControl(current.id, current.revision, current.writerLease!.generation, current.controlHead, old.manager.controllerIdentity, 60_000);
	const authority = controlAuthority(granted);
	const snapshot: SubagentSnapshot = { id: initial.id, title: "worker", prompt: "synthetic recovery task", cwd: join(root, "cwd"), baseRef: "HEAD",
		status: "running", createdAt: now, visible: false, usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
	await old.manager.trackRetained({ registry: registry.forController(old.manager.controllerIdentity), supervisor: owner, snapshot, authority });
	await old.fire("session_shutdown", "new");
	const next = install("successor");
	try {
		await next.fire("session_start", "new");
		assert.equal(registry.inspectControl(authority), false);
		assert.equal(next.manager.get(initial.id)?.recovery, "adopted");
		assert.deepEqual(owner.record.child, current.child);
		assert.equal(backend.send, undefined);
		const result = await next.manager.sendTo(initial.id, "steer after recovery");
		assert.deepEqual(result, { capability: "unsupported: headless steering" });
		put("finish", {});
		assert.equal(await owner.settlement, "settled");
		assert.equal(next.manager.get(initial.id)?.finalText, "preserved result");
		await old.fire("agent_end");
		await next.fire("agent_end"); await next.fire("agent_end");
		assert.equal(old.deliveries.length, 0);
		assert.equal(next.deliveries.length, 1);
		put("same-process-result.json", { steering: "unsupported: headless steering", recovery: "adopted", settlement: "settled", deliveries: 1 });
	} finally { old.manager.detachForReplacement(); next.manager.detachForReplacement(); }
}

function install(session: string, registry?: SubagentRegistry) {
	type Handler = (event: { type: string; reason: string }, context: ExtensionContext) => void | Promise<void>;
	const handlers = new Map<string, Handler>();
	const deliveries: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	const api = { on: (name: string, handler: Handler) => { handlers.set(name, handler); }, registerTool: () => {},
		sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => { deliveries.push(message); }, exec: () => { throw new Error("unexpected controller exec"); } };
	// SAFETY: only installer registration and idle lifecycle methods are exercised.
	const manager = installSubagents(api as never, { retainedRegistry: registry, spawnPiChild: () => { throw new Error("replacement must not respawn"); } });
	return { manager, deliveries, fire: async (name: string, reason = "startup") => {
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

function registeredAnchorSpawn(root: string): typeof spawn {
	// SAFETY: preserves spawn's overloads and original IPC/pipe handle.
	return ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
		const child = spawn(command, args, options);
		writeFileSync(join(root, "anchor-spawn.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600, flag: "wx" });
		child.once("spawn", () => {
			const birth = captureBirth(child.pid!);
			writeFileSync(join(root, "anchor-birth.json"), JSON.stringify(birth), { mode: 0o600, flag: "wx" });
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

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!existsSync(path)) {
		assert(Date.now() < deadline, `timed out: ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
