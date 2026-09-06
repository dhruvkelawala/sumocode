import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { systemProcessTree } from "../background-tasks/process-tree.js";
import { prepareRetainedBootstrap } from "./retained-bootstrap.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { runRetainedSupervisorEntry } from "./retained-supervisor-entry.js";
import type { spawnPiChild } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

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

function fixture() {
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
		schemaVersion: 2, revision: 1, id: "sa-entry", ownerSessionId: "session-a", backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: "openai/test", roleId: "reviewer",
		createdAt: Date.now(), updatedAt: Date.now(), settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const descriptor = prepareRetainedBootstrap(record, {
		cwd: root, baseRef: "HEAD", model: { provider: "openai", modelId: "test", label: "openai/test" }, thinking: "low",
		builtInTools: ["read"], role: { id: "reviewer", label: "reviewer" }, pi, adapterEntry: null, modelBootstrapEntry: null, visible: null,
	}, { prompt: "private task text", systemPrompt: "private role text" });
	const args = ["--task-dir", taskDir, "--registry-dir", registryDir, "--id", record.id, "--owner-session", record.ownerSessionId, "--nonce", descriptor.nonce];
	return { root, taskDir, registryDir, registry, record, descriptor, args };
}

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
