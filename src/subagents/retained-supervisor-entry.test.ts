import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { systemProcessTree } from "../background-tasks/process-tree.js";
import { prepareRetainedBootstrap } from "./retained-bootstrap.js";
import { SubagentRegistry, type RegistryWriter, type SubagentRecord } from "./registry.js";
import { controlAuthority, reserveRemoteControl } from "./retained-control.js";
import { runRetainedSupervisorEntry } from "./retained-supervisor-entry.js";
import type { spawnPiChild } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";
import type { TerminalHost } from "../terminal-host/types.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- kernel boundary only; registry/bootstrap/controller use real private files.
vi.mock("../background-tasks/process-tree.js", () => ({
	captureProcessBirthTime: () => "birth",
	systemProcessTree: {
		captureStartTime: vi.fn(() => "command"),
		captureTreeVerification: vi.fn((identity) => ({ members: [{ pid: identity.pid, processStartTime: "birth" }] })),
		identityMatches: vi.fn(() => "same"), verificationMatches: vi.fn(() => "same"),
		signalTree: vi.fn(), isTreeEmpty: vi.fn(), waitForTreeEmpty: vi.fn(),
	},
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(controller?: RegistryWriter, visible = false) {
	vi.useFakeTimers();
	vi.spyOn(process, "kill").mockReturnValue(true);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-entry-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const pi = join(root, "pi");
	writeFileSync(pi, "#!/usr/bin/env node\n", { mode: 0o700 });
	const registryDir = join(root, "registry");
	const registry = new SubagentRegistry(registryDir, "session-a");
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-entry", ownerSessionId: "session-a", backend: visible ? "visible" : "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: "openai/test", roleId: "reviewer",
		createdAt: Date.now(), updatedAt: Date.now(), settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const descriptor = prepareRetainedBootstrap(record, {
		controller,
		cwd: root, baseRef: "HEAD", model: { provider: "openai", modelId: "test", label: "openai/test" }, thinking: "low",
		builtInTools: ["read"], role: { id: "reviewer", label: "reviewer" }, pi, adapterEntry: null, modelBootstrapEntry: null,
		visible: visible ? { name: "visible worker", placement: { kind: "new-tab", label: "subagents" }, launcher: pi, provisioningTimeoutMs: 1_234 } : null,
	}, { prompt: "private task text", systemPrompt: "private role text" });
	const args = ["--task-dir", taskDir, "--registry-dir", registryDir, "--id", record.id, "--owner-session", record.ownerSessionId, "--nonce", descriptor.nonce];
	return { root, taskDir, registryDir, registry, record, descriptor, args };
}

it("grants production control before launch and keeps settled transfer available until delivery", async () => {
	const controller = { token: "parent-controller", pid: process.pid, processStartTime: "birth" };
	const f = fixture(controller);
	f.registry.create(f.record);
	let granted: RegistryWriter | undefined;
	let emit!: (event: SubagentEvent) => void;
	const run = runRetainedSupervisorEntry(f.args, {
		spawn: (options) => {
			granted = f.registry.get(f.record.id)?.controlLease?.owner;
			return { ready: Promise.resolve(), interrupt: vi.fn(), events: (listener) => {
				emit = listener;
				options.launchGate!.beforeSpawn();
				options.launchGate!.beforePrompt(4242);
			} };
		},
		buildManifest: async () => ({ baseRef: "HEAD", headRef: "end", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }),
	});
	emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
	await run;
	expect(granted).toEqual(controller);
	expect(f.registry.get(f.record.id)?.writerLease?.owner.token).not.toBe(controller.token);
	const successor = { token: "replacement-controller", pid: process.pid, processStartTime: "birth" };
	const current = f.registry.get(f.record.id)!;
	const transfer = reserveRemoteControl(f.registry.forController(controller), controlAuthority(current), { owner: successor, sessionId: "replacement" });
	const observed = transfer.catch((error: Error) => error);
	await vi.advanceTimersByTimeAsync(5500);
	const reserved = await observed;
	expect(reserved).toMatchObject({ controlReservation: { owner: successor, sessionId: "replacement" } });
	if (reserved instanceof Error) throw reserved;
	const next = f.registry.forController(successor);
	const grantedRecord = next.acquireControl(reserved.id, reserved.revision, reserved.writerLease!.generation, reserved.controlHead, successor, 60_000, "replacement");
	const authority = controlAuthority(grantedRecord);
	const sending = next.advanceDelivery(grantedRecord.revision, authority, "send");
	next.advanceDelivery(sending.revision, authority, "sent");
	await vi.advanceTimersByTimeAsync(20_000);
	expect(vi.getTimerCount()).toBe(0);
});

it("launches the visible backend from the same private production descriptor", async () => {
	const f = fixture({ token: "parent", pid: process.pid, processStartTime: "birth" }, true);
	vi.mocked(systemProcessTree.isTreeEmpty).mockReturnValue(true);
	f.registry.create(f.record);
	const host: TerminalHost = { kind: "herdr", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn(),
		inspectPane: async () => ({ ok: true, shellPid: 4242, foregroundProcessGroupId: 4242, foregroundPids: [4242] }) };
	const launch = vi.fn();
	await runRetainedSupervisorEntry(f.args, { host, executor: { exec: vi.fn() }, spawnPane: (options) => {
		launch(options);
		let ready!: () => void;
		let refuse!: (error: Error) => void;
		return { interrupt: vi.fn(), ready: new Promise<void>((resolve, reject) => { ready = resolve; refuse = reject; }), events: (emit) => {
			void (async () => {
				const nonce = f.descriptor.nonce;
				const gate = options.launchGate!;
				gate.beforeSpawn({ taskDir: f.taskDir, nonce });
				await gate.wrapperBorn({ taskDir: f.taskDir, nonce,
					process: { identity: { pid: 4242, processGroupId: 4242, processStartTime: `wrapper ${join(f.taskDir, "run.sh")} ${nonce}` },
						verification: { members: [{ pid: 4242, processStartTime: "birth" }] } },
					pane: { agentName: "worker", paneId: "p1", pane: { host: "herdr", paneId: "p1" } } });
				gate.beforeRelease();
				ready();
				emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "visible answer" } });
			})().catch(refuse);
		} };
	}, buildManifest: async () => ({ baseRef: "HEAD", headRef: "end", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }) });
	expect(launch).toHaveBeenCalledWith(expect.objectContaining({ prompt: "private task text", appendSystemPrompt: "private role text",
		model: "openai/test", thinking: "low", tools: ["read"], retainedTaskDir: f.taskDir, provisioningTimeoutMs: 1_234 }));
	expect(f.registry.get(f.record.id)).toMatchObject({ backend: "visible", status: "settled" });
});

it("refuses invalid private bootstrap before writer acquisition or backend construction", async () => {
	const f = fixture();
	f.registry.create(f.record);
	writeFileSync(join(f.taskDir, "bootstrap-prompt.json"), '"changed"\n', { mode: 0o600 });
	const spawn = vi.fn();
	await expect(runRetainedSupervisorEntry(f.args, { spawn })).rejects.toThrow("retained_entry_failed");
	expect(f.registry.get(f.record.id)).toEqual(f.record);
	expect(spawn).not.toHaveBeenCalled();
	expect(existsSync(join(f.taskDir, "events.jsonl"))).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});

for (const refusal of ["missing", "owned", "control", "taskDir", "session", "role", "model", "worktree", "backend", "status"] as const) {
	it(`rejects ${refusal} registry admission without changing evidence`, async () => {
		const f = fixture();
		let record = f.record;
		if (refusal === "taskDir") record = { ...record, taskDir: f.root };
		if (refusal === "session") record = { ...record, ownerSessionId: "other" };
		if (refusal === "role") record = { ...record, roleId: "other" };
		if (refusal === "model") record = { ...record, modelLabel: "openai/other" };
		if (refusal === "worktree") record = { ...record, worktree: { path: f.root, repoRoot: f.root, baseRef: "HEAD", branch: "other" } };
		if (refusal === "backend") record = { ...record, backend: "visible" };
		if (refusal === "status") record = { ...record, status: "queued" };
		if (refusal !== "missing") {
			const registry = new SubagentRegistry(f.registryDir, record.ownerSessionId);
			registry.create(record);
			if (refusal === "owned" || refusal === "control") {
				const owned = registry.acquireWriter(record.id, 1, 60_000);
				if (refusal === "control") registry.acquireControl(record.id, owned.revision, owned.writerLease!.generation, 0, owned.writerLease!.owner, 60_000);
			}
		}
		const file = join(f.registryDir, `${record.id}.json`);
		const before = existsSync(file) ? readFileSync(file, "utf8") : null;
		const spawn = vi.fn();
		await expect(runRetainedSupervisorEntry(f.args, { spawn })).rejects.toThrow("retained_entry_failed");
		expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(before);
		expect(spawn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
}

for (const refusal of ["missing-arg", "extra-token", "duplicate", "relative", "nonce", "id", "owner", "mode", "missing-registry"] as const) {
	it(`fails closed for ${refusal} bootstrap arguments`, async () => {
		const f = fixture();
		f.registry.create(f.record);
		const args = [...f.args];
		if (refusal === "missing-arg") args.pop();
		if (refusal === "extra-token") args.push("--writer-token", "requester-token");
		if (refusal === "duplicate") args[2] = "--task-dir";
		if (refusal === "relative") args[3] = "relative";
		if (refusal === "nonce") args[9] = "00000000-0000-4000-8000-000000000000";
		if (refusal === "id") args[5] = "sa-other";
		if (refusal === "owner") args[7] = "other";
		if (refusal === "mode") chmodSync(join(f.taskDir, "bootstrap.json"), 0o644);
		if (refusal === "missing-registry") args[3] = join(f.root, "absent");
		const spawn = vi.fn();
		await expect(runRetainedSupervisorEntry(args, { spawn })).rejects.toThrow("retained_entry_failed");
		expect(f.registry.get(f.record.id)).toEqual(f.record);
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(f.root, "absent"))).toBe(false);
	});
}

it("self-acquires before launch, passes the retained descriptor, and keeps the heartbeat alive through real settlement", async () => {
	const f = fixture();
	f.registry.create(f.record);
	const interval = vi.spyOn(globalThis, "setInterval");
	let emit!: (event: SubagentEvent) => void;
	const spawn = vi.fn<typeof spawnPiChild>((options) => {
		const owned = f.registry.get(f.record.id)!;
		expect(owned.writerLease?.owner.pid).toBe(process.pid);
		expect(owned.supervisor?.identity.pid).toBe(process.pid);
		expect(options.retainedBootstrap).toEqual(f.descriptor);
		expect(Object.isFrozen(options.retainedBootstrap)).toBe(true);
		expect(options.prompt).toBe("private task text");
		expect(options).not.toHaveProperty("appendSystemPrompt");
		return { ready: Promise.resolve(), interrupt: vi.fn(), events: (listener) => {
			emit = listener;
			options.launchGate!.beforeSpawn();
			options.launchGate!.beforePrompt(4242);
		} };
	});
	let finishManifest!: () => void;
	const manifest = new Promise<void>((resolve) => { finishManifest = resolve; });
	let done = false;
	const run = runRetainedSupervisorEntry(f.args, { spawn, buildManifest: async () => {
		await manifest;
		return { baseRef: "HEAD", headRef: "end", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 };
	} }).then(() => { done = true; });
	await Promise.resolve();
	expect(done).toBe(false);
	expect(interval.mock.results[0].value.hasRef()).toBe(true);
	emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
	await vi.advanceTimersByTimeAsync(20_000);
	expect(done).toBe(false);
	expect(f.registry.get(f.record.id)?.writerLease?.generation).toBe(2);
	finishManifest();
	await run;
	expect(f.registry.get(f.record.id)?.status).toBe("settled");
	expect(vi.getTimerCount()).toBe(0);
});

it("settles readiness refusal without leaving a heartbeat or publishing completion", async () => {
	const f = fixture();
	f.registry.create(f.record);
	const run = runRetainedSupervisorEntry(f.args, { spawn: () => ({
		ready: Promise.reject(new Error("private backend detail")), interrupt: vi.fn(), events: () => undefined,
	}) });
	await expect(run).rejects.toThrow(/^retained_entry_failed$/);
	expect(f.registry.get(f.record.id)?.status).toBe("ambiguous");
	expect(f.registry.get(f.record.id)?.completionId).toBeNull();
	expect(vi.getTimerCount()).toBe(0);
});

it("ends on writer loss without kills, late publication, or dangling timers", async () => {
	const f = fixture();
	f.registry.create(f.record);
	let emit!: (event: SubagentEvent) => void;
	const interrupt = vi.fn();
	const run = runRetainedSupervisorEntry(f.args, { spawn: (options) => ({
		ready: Promise.resolve(), interrupt, events: (listener) => {
			emit = listener; options.launchGate!.beforeSpawn(); options.launchGate!.beforePrompt(4242);
		},
	}) });
	const rejected = expect(run).rejects.toThrow("retained_entry_failed");
	const before = f.registry.get(f.record.id);
	vi.setSystemTime(Date.now() + 61_000);
	await vi.advanceTimersByTimeAsync(20_000);
	await rejected;
	emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "late" } });
	expect(f.registry.get(f.record.id)).toEqual(before);
	expect(existsSync(join(f.taskDir, "result.json"))).toBe(false);
	expect(interrupt).not.toHaveBeenCalled();
	expect(systemProcessTree.signalTree).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
