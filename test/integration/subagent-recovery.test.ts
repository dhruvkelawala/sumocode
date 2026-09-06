import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiChildSpawner, type SpawnedChild, type spawnPiChild } from "../../src/subagents/backend-pi.js";
import { createPaneChildSpawner } from "../../src/subagents/backend-pane.js";
import type { SubagentEvent, SubagentSnapshot } from "../../src/subagents/domain.js";
import { SubagentManager } from "../../src/subagents/manager.js";
import { SubagentRegistry, type SubagentRecord } from "../../src/subagents/registry.js";
import { controlAuthority } from "../../src/subagents/retained-adoption.js";
import { RetainedHeadlessSupervisor } from "../../src/subagents/retained-supervisor.js";
import { systemProcessTree, terminateProcessTree, signalVerifiedProcessTree, type ProcessTreeOperations } from "../../src/background-tasks/process-tree.js";
import { shellEscape } from "../../src/background-tasks/visible-spawn.js";
import { JsonLineDecoder } from "../../src/child-protocol.js";
import { spawnSupervisedProcess } from "./harness-supervisor.js";
import { spawnPiPty } from "./spawn-pi-pty.js";
import { cleanupOwnedTree, type OwnedTree } from "./fixtures/subagent-feasibility-cleanup.js";

const PI = resolve("node_modules/.bin/pi");
const supervisorMode = process.env.PLAN112_SUPERVISOR;
const selectedCell = process.env.PLAN112_CELL;
const EXTENSION = resolve("test/integration/fixtures/subagent-feasibility-extension.ts");
const replacements = ["factory replacement", "host-Pi reload", "parent crash-restart"] as const;
const backends = ["headless", "visible"] as const;
interface ParentEvent { event: string; reason: string; pid: number; generation: string }
interface Request { generation: string; pid: number; action: string }
const owned: OwnedTree[] = [];
const supervisorRoots: string[] = [];
let root = "";

function append<T>(name: string, value: T): void {
	appendFileSync(join(root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function rows<T>(name: string): T[] {
	const path = join(root, name);
	if (!existsSync(path)) return [];
	// SAFETY: this private fixture owns each named journal's schema and writer.
	// Ignore only the uncommitted trailing line.
	return readFileSync(path, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line) as T);
}
async function waitFor<T>(label: string, read: () => T | undefined | false): Promise<T> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined && value !== false) return value;
		await new Promise((done) => setTimeout(done, 25));
	}
	throw new Error(`${label} timed out; retained evidence ${root}`);
}
function capture(pid: number): OwnedTree {
	const processStartTime = systemProcessTree.captureStartTime(pid);
	if (!processStartTime) throw new Error(`unsafe identity ${pid}; retained ${root}`);
	const identity = { pid, processGroupId: pid, processStartTime };
	const verification = systemProcessTree.captureTreeVerification?.(identity);
	if (!verification) throw new Error(`unsafe tree ${pid}; retained ${root}`);
	const tree = { identity, verification };
	owned.push(tree);
	append("identities.jsonl", tree);
	return tree;
}
function privateEnv(role: string): NodeJS.ProcessEnv {
	return {
		PATH: `${resolve("node_modules/.bin")}:/usr/bin:/bin:/usr/sbin:/sbin:${resolve(process.execPath, "..")}`,
		HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_OFFLINE: "1", TERM: "xterm-256color", PLAN112_ROOT: root, PLAN112_ROLE: role, PLAN112_PROCESS_NONCE: randomUUID(),
		SUMOCODE_INTEGRATION_RUN_ROOT: process.env.SUMOCODE_INTEGRATION_RUN_ROOT,
		SUMOCODE_INTEGRATION_MANIFEST: process.env.SUMOCODE_INTEGRATION_MANIFEST,
	};
}
function parent() {
	const proc = spawnSupervisedProcess(PI, ["--mode", "rpc", "--offline", "--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", EXTENSION, "--session-dir", join(root, "sessions")], {
		cwd: join(root, "workspace"), env: privateEnv("parent"), stdio: ["pipe", "pipe", "pipe"],
	});
	// SAFETY: parent() explicitly pipes all three streams.
	const child = proc.child as ChildProcessWithoutNullStreams;
	const replies = new Map<string, { success: boolean; error?: string }>();
	let sequence = 0;
	const decoder = new JsonLineDecoder({ onLine: (line) => {
		// SAFETY: the pinned local Pi supplies correlated RPC response objects.
		const value = JSON.parse(line) as { id?: string; success: boolean; error?: string };
		if (value.id) replies.set(value.id, value);
	}, onError: (error) => { throw error; } });
	child.stdout.on("data", (chunk) => decoder.write(chunk));
	return {
		proc,
		async request(type: string, message?: string) {
			const id = String(++sequence);
			child.stdin.write(`${JSON.stringify({ id, type, message })}\n`);
			const reply = await waitFor(`RPC ${type}`, () => replies.get(id));
			expect(reply, reply.error).toMatchObject({ success: true });
		},
	};
}

// The gated fixture supervisor retains the backend handles. The outer test
// persists the supervisor identity and audits its death boundary; no production adoption.
function broker(child: SpawnedChild, tree: OwnedTree) {
	let owner: ParentEvent | undefined;
	let lastSequence = 0;
	return {
		adopt(candidate: ParentEvent): boolean {
			if (owner) {
				const released = rows<ParentEvent>("parents.jsonl").some((event) => event.event === "shutdown" && event.generation === owner!.generation);
				const oldTree = owned.find((entry) => entry.identity.pid === owner!.pid);
				if (!released && (!oldTree || !systemProcessTree.isTreeEmpty(oldTree.identity, oldTree.verification))) return false;
			}
			if (systemProcessTree.identityMatches(tree.identity) !== "same") return false;
			owner = candidate;
			append("ownership.jsonl", { generation: candidate.generation, pid: candidate.pid });
			return true;
		},
		async control(): Promise<boolean> {
			const requests = rows<Request>("requests.jsonl");
			const request = requests[lastSequence++];
			if (!request || request.generation !== owner?.generation || request.pid !== owner.pid || systemProcessTree.identityMatches(tree.identity) !== "same") {
				append("controls.jsonl", { accepted: false, request });
				return false;
			}
			if (request.action === "steer") await child.send!("post-replacement-steer");
			else if (request.action === "close") child.requestClose!();
			else if (request.action === "cancel") {
				// The persisted identity check precedes the existing backend handle's
				// signal path; cleanup below independently verifies the whole tree.
				child.interrupt();
			} else throw new Error(`unknown fixture control ${request.action}`);
			append("controls.jsonl", { accepted: true, request });
			return true;
		},
	};
}

async function launch(backend: typeof backends[number], workerRoot = root): Promise<{ child: SpawnedChild; tree: OwnedTree; events: SubagentEvent[] }> {
	let pid = 0;
	let child: SpawnedChild;
	if (backend === "headless") {
		// SAFETY: the backend supplies command/argv; this fixture fixes spawn options.
		const spawnImpl = ((command: string, args: string[]) => {
			const proc = spawnSupervisedProcess(command, [...args, "--offline", "--no-skills", "--no-prompt-templates", "-e", EXTENSION], {
				cwd: join(root, "workspace"), env: { ...privateEnv("headless"), PLAN112_ROOT: workerRoot }, stdio: ["pipe", "pipe", "pipe"],
			});
			pid = proc.pid;
			return proc.child;
		}) as typeof spawn;
		child = createPiChildSpawner(spawnImpl, () => undefined, () => PI)({ prompt: "held synthetic task", cwd: join(root, "workspace"), model: "plan112-fixture/held", inherited: {}, builtInTools: [] });
	} else {
		const launcher = join(root, "visible-launcher.sh");
		writeFileSync(launcher, `#!/bin/bash\nset -eu\numask 077\nwhile [ "$1" != "--task-dir" ]; do shift; done\nshift\nexport PLAN112_TASK_DIR="$1"\nexport SUMOCODE_TASK_MODE=1 SUMOCODE_TASK_KEEP_OPEN=1\nexport SUMOCODE_TASK_CONTROL_DIR="$1/control" SUMOCODE_TASK_RESPONSE_FILE="$1/response.md" SUMOCODE_TASK_EXIT_FILE="$1/exit.code" SUMOCODE_TASK_STARTED_FILE="$1/started.marker" SUMOCODE_TASK_DIAG_FILE="$1/diag.jsonl"\nexec ${shellEscape(PI)} --offline --approve --no-extensions --no-skills --no-prompt-templates --no-tools --provider plan112-fixture --model held -e ${shellEscape(EXTENSION)}\n`, { mode: 0o700 });
		child = createPaneChildSpawner({ baseDir: join(root, "tasks"), resolveLauncher: () => launcher, pollIntervalMs: 25, sendAckPollMs: 25 })({
			prompt: "held synthetic task", name: "proof", cwd: join(root, "workspace"), id: "proof", tools: [], placement: { kind: "new-tab", label: "proof" },
			pi: { exec: async () => { throw new Error("fixture must not invoke operator terminal host"); } },
			host: {
				kind: "herdr",
				async startAgentPane(_pi, options) {
					spawnPiPty({ command: "/bin/bash", args: ["-c", `umask 077; printf '%s' "$$" > ${shellEscape(join(root, "pane.pid"))}; ${options.shellCommand}`], cwd: options.cwd, env: privateEnv("visible") });
					pid = Number(await waitFor("pane pid", () => existsSync(join(root, "pane.pid")) && readFileSync(join(root, "pane.pid"), "utf8")));
					return { ok: true, pane: { host: "herdr", paneId: String(pid) }, agentName: "proof", paneId: String(pid) };
				},
				async closePane() { throw new Error("visible proof uses graceful task close, not pane-id signals"); },
				async openCommandInSplit() { throw new Error("not used"); },
				async notify() {},
			},
		});
	}
	const events: SubagentEvent[] = [];
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend API explicitly permits callback or AsyncIterable subscriptions.
	if (typeof child.events !== "function") throw new Error("expected callback backend");
	child.events((event) => { events.push(event); append("events.jsonl", event); });
	await waitFor("real provider stream", () => existsSync(join(workerRoot, "stream-ready")));
	const tree = capture(pid);
	expect(existsSync(join(workerRoot, "work-started"))).toBe(false);
	writeFileSync(join(workerRoot, "identity-release"), "identity persisted", { mode: 0o600 });
	await waitFor("work released after durable identity", () => existsSync(join(workerRoot, "work-started")));
	return { child, tree, events };
}

async function supervisedCell(backend: typeof backends[number], replacement: typeof replacements[number], caseRoot: string, mode: string): Promise<void> {
	supervisorRoots.push(caseRoot);
	const harness = join(caseRoot, "harness");
	mkdirSync(harness, { mode: 0o700 });
	const proc = spawnSupervisedProcess(process.execPath, [
		`--title=plan112-${caseRoot}`, resolve("node_modules/vitest/vitest.mjs"),
		"run", "test/integration/subagent-recovery.test.ts", "--pool=threads", "--maxWorkers=1", "--fileParallelism=false", "-t", "feasibility:",
	], { cwd: process.cwd(), env: {
		PATH: process.env.PATH, HOME: caseRoot, TMPDIR: caseRoot,
		PLAN112_SUPERVISOR: mode, PLAN112_CELL: `${backend}/${replacement}`, PLAN112_ROOT: caseRoot,
		SUMOCODE_INTEGRATION_RUN_ROOT: harness, SUMOCODE_INTEGRATION_MANIFEST: join(harness, "children.jsonl"),
	}, stdio: ["ignore", "pipe", "pipe"] });
	proc.child.stdout!.on("data", (chunk) => appendFileSync(join(caseRoot, "supervisor-output.log"), chunk, { mode: 0o600 }));
	await waitFor("supervisor start gate", () => existsSync(join(caseRoot, "supervisor-ready")));
	expect(Number(readFileSync(join(caseRoot, "supervisor-ready"), "utf8"))).toBe(proc.pid);
	const supervisor = capture(proc.pid);
	expect(supervisor.identity.processStartTime).toContain(caseRoot);
	writeFileSync(join(caseRoot, "supervisor.json"), `${JSON.stringify(supervisor)}\n`, { mode: 0o600, flag: "wx" });
	if (mode !== "before-release") writeFileSync(join(caseRoot, "supervisor-release"), "tracked", { mode: 0o600 });
	if (mode === "recover") {
		await waitFor("supervisor completed", () => proc.child.exitCode !== null || proc.child.signalCode !== null);
		expect(proc.child.exitCode, `supervisor output retained at ${caseRoot}`).toBe(0);
	} else {
		if (mode === "running") await waitFor("tracked children before supervisor death", () => existsSync(join(caseRoot, "supervisor-running")));
		else expect(existsSync(join(caseRoot, "identities.jsonl"))).toBe(caseRoot === root);
		expect((await signalVerifiedProcessTree(systemProcessTree, supervisor.identity, "SIGKILL", supervisor.verification)).ok).toBe(true);
		await waitFor("dead supervisor tree empty", () => systemProcessTree.isTreeEmpty(supervisor.identity, supervisor.verification));
		append("supervisor-failure.jsonl", { backend, mode, supervisor, empty: true, outcome: mode === "running" ? "lost backend handle; verified cleanup only, not adoption" : "no child released" });
	}
}

afterEach(async () => {
	const trees = owned.splice(0);
	const roots = supervisorRoots.splice(0);
	if (!root) return;
	const failures: unknown[] = [];
	for (const tree of trees) {
		if (!await cleanupOwnedTree(systemProcessTree, tree, (value) => append("cleanup.jsonl", value))) failures.push(tree);
	}
	// Freeze supervisors before reading their last committed child identities.
	// This also runs after assertion/timeouts, not just the happy-path return.
	for (const caseRoot of roots) {
		const supervisorFile = join(caseRoot, "supervisor.json");
		// SAFETY: the outer fixture exclusively writes this private identity file.
		const supervisor = existsSync(supervisorFile) ? JSON.parse(readFileSync(supervisorFile, "utf8")) as OwnedTree : undefined;
		if (!supervisor || !systemProcessTree.isTreeEmpty(supervisor.identity, supervisor.verification)) {
			failures.push({ unfrozenSupervisor: caseRoot });
			continue;
		}
		const identityFile = join(caseRoot, "identities.jsonl");
		// SAFETY: the stopped supervisor wrote complete OwnedTree lines synchronously.
		const persisted: OwnedTree[] = existsSync(identityFile) ? readFileSync(identityFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as OwnedTree) : [];
		for (const tree of persisted) {
			if (trees.some((entry) => entry.identity.pid === tree.identity.pid)) continue;
			trees.push(tree);
			if (!await cleanupOwnedTree(systemProcessTree, tree, (value) => append("cleanup.jsonl", value))) failures.push(tree);
		}
		// SAFETY: the harness owns this private journal; only spawn event/PID are read.
		const manifest = readFileSync(join(caseRoot, "harness", "children.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; pid: number });
		for (const entry of manifest.filter((event) => event.event === "spawn")) {
			if (!trees.some((tree) => tree.identity.pid === entry.pid)) failures.push({ untrackedSpawn: entry, caseRoot });
		}
	}
	const finalTrees = trees.map((tree) => ({ ...tree, empty: systemProcessTree.isTreeEmpty(tree.identity, tree.verification) }));
	failures.push(...finalTrees.filter((tree) => !tree.empty));
	append("audit.jsonl", { zeroSurvivors: failures.length === 0, trees: trees.length, failures, finalTrees });
	if (failures.length) throw new Error(`unsafe cleanup; retained ${root}: ${JSON.stringify(failures)}`);
	// Do not call the harness's PID-only termination, even after an empty
	// observation: a reused numeric PGID must never turn into cleanup authority.
	if (!supervisorMode && rows<{ supervisorBoundary?: boolean }>("observation.jsonl").at(-1)?.supervisorBoundary) {
		append("verdict.jsonl", { classification: "recoverable", contract: "tracked retained supervisor; not production adoption or supervisor-death recovery", zeroSurvivors: true, trees: trees.length });
	}
	root = "";
}, 30_000);

describe("cleanup ownership regression", () => {
	const tree: OwnedTree = { identity: { pid: 123, processGroupId: 123, processStartTime: "unique-launch" }, verification: { members: [{ pid: 124, processStartTime: "child-birth" }] } };
	function operations(): ProcessTreeOperations {
		return {
			captureStartTime: () => undefined,
			identityMatches: () => "unknown",
			captureTreeVerification: () => undefined,
			verificationMatches: () => "same",
			isTreeEmpty: () => false,
			signalTree: vi.fn(async () => ({ ok: true, gone: false })),
			waitForTreeEmpty: async () => true,
		};
	}
	it("cleanup: old recapture loses durable descendant authority; retained anchors succeed", async () => {
		const ops = operations();
		expect(await terminateProcessTree(ops, tree.identity, { termGraceMs: 0, killGraceMs: 0 })).toBe(false);
		expect(ops.signalTree).not.toHaveBeenCalled();
		expect(await cleanupOwnedTree(ops, tree, () => {})).toBe(true);
		expect(ops.signalTree).toHaveBeenCalledExactlyOnceWith(tree.identity, "SIGTERM", tree.verification);
	});
	it("cleanup: concurrent graceful exit is success only after empty-tree proof", async () => {
		const ops = operations();
		ops.identityMatches = () => "different";
		ops.isTreeEmpty = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
		expect(await cleanupOwnedTree(ops, tree, () => {})).toBe(true);
		expect(ops.signalTree).not.toHaveBeenCalled();
	});
	for (const status of ["different", "unknown"] as const) it(`cleanup: ${status} nonempty tree fails closed without signalling`, async () => {
		const ops = operations();
		ops.identityMatches = () => status;
		ops.verificationMatches = () => status;
		expect(await cleanupOwnedTree(ops, tree, () => {})).toBe(false);
		expect(ops.signalTree).not.toHaveBeenCalled();
	});
	it("cleanup: refusal inside the system signal boundary cannot become success while nonempty", async () => {
		const ops = operations();
		ops.signalTree = vi.fn(async () => ({ ok: false, gone: false, identityStatus: "different" as const }));
		expect(await cleanupOwnedTree(ops, tree, () => {})).toBe(false);
		expect(ops.signalTree).toHaveBeenCalledTimes(1);
	});
});

// WIP slice 3: production owner/manager composition, fake headless backend only.
// Real source/native/visible processes and the six-cell crash matrix remain separate gates.
describe("Plan112 production recovery model", () => {
	afterEach(() => { vi.useRealTimers(); });

	it.each(["before-settle", "after-settle"])("recovery-model: headless %s preserves one result through two replacements", async (cut) => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "subagent-recovery-model-")));
		chmodSync(directory, 0o700);
		const taskDir = join(directory, "task");
		mkdirSync(taskDir, { mode: 0o700 });
		const writer = { token: "writer", pid: process.pid, processStartTime: "host-birth" };
		const registry = new SubagentRegistry(join(directory, "registry"), "origin", { writerIdentity: writer, inspectWriter: () => "alive" });
		const record: SubagentRecord = {
			schemaVersion: 2, revision: 1, id: "sa-model", ownerSessionId: "origin", backend: "headless", status: "starting", taskDir,
			child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
			createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
			delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
		};
		const ops: ProcessTreeOperations = {
			captureStartTime: () => "anchor-command", identityMatches: () => "same", verificationMatches: () => "same",
			captureTreeVerification: (identity) => ({ members: [{ pid: identity.pid, processStartTime: "anchor-birth" }] }),
			isTreeEmpty: () => false, signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: async () => false,
		};
		let emit!: (event: SubagentEvent) => void;
		const interrupt = vi.fn();
		const subscribe = vi.fn((listener: typeof emit) => { emit = listener; listener({ kind: "run-started" }); });
		const spawn = vi.fn((options: Parameters<typeof spawnPiChild>[0]): SpawnedChild => {
			options.launchGate!.beforeSpawn();
			options.launchGate!.beforePrompt(42);
			return { events: subscribe, interrupt };
		});
		const owner = new RetainedHeadlessSupervisor({ registry, initial: record,
			supervisor: { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "host-command" }, verification: { members: [{ pid: process.pid, processStartTime: "host-birth" }] } },
			launch: { prompt: "synthetic task", cwd: taskDir, inherited: {}, builtInTools: [] }, baseRef: "HEAD",
		}, { operations: ops, spawn, buildManifest: async () => ({ baseRef: "HEAD", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }) });
		const manager = (token: string) => new SubagentManager(() => { throw new Error("replacement must not respawn"); }, { controllerIdentity: { ...writer, token }, processOperations: ops });
		const old = manager("origin");
		const initial = owner.record;
		const granted = registry.acquireControl(initial.id, initial.revision, initial.writerLease!.generation, initial.controlHead, old.controllerIdentity, 60_000);
		const snapshot: SubagentSnapshot = { id: record.id, title: "worker", prompt: "synthetic task", cwd: taskDir, baseRef: "HEAD", status: "running", createdAt: 1000,
			usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
		await old.trackRetained({ registry: registry.forController(old.controllerIdentity), supervisor: owner, snapshot, authority: controlAuthority(granted) });
		const finish = async () => {
			await owner.ready;
			emit({ kind: "run-settled", outcome: { kind: "completed", finalText: "preserved result" } });
			await owner.settlement;
		};
		if (cut === "after-settle") await finish();
		const next = manager("successor");
		await next.adoptFrom(old, "successor");
		if (cut === "before-settle") await finish();
		expect(next.get(record.id)).toMatchObject({ status: "done", finalText: "preserved result", recovery: "adopted" });
		const artifacts = ["result.json", "manifest.json"].map((file) => readFileSync(join(taskDir, file), "utf8"));
		const piSend = vi.fn();
		const payload = { id: record.id, title: "worker", status: "done", content: next.get(record.id)!.finalText, details: {} };
		old.deliver(payload, piSend);
		next.deliver(payload, piSend);
		next.deliver(payload, piSend);
		const final = manager("final");
		await final.adoptFrom(next, "final");
		final.deliver(payload, piSend);
		expect(piSend).toHaveBeenCalledExactlyOnceWith(payload);
		expect(owner.record).toMatchObject({ controllerGeneration: 2, child: initial.child, supervisor: initial.supervisor, delivery: { state: "sent" } });
		expect(["result.json", "manifest.json"].map((file) => readFileSync(join(taskDir, file), "utf8"))).toEqual(artifacts);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(interrupt).not.toHaveBeenCalled();
		expect(ops.signalTree).not.toHaveBeenCalled();
	});
});

describe("Plan112 supervised feasibility (not production adoption)", () => {
	for (const backend of backends) for (const replacement of replacements) {
		if (supervisorMode && selectedCell !== `${backend}/${replacement}`) continue;
		it(`feasibility: ${backend} across ${replacement}`, async () => {
			if (!supervisorMode) {
				root = mkdtempSync(join(tmpdir(), "sumocode-plan112-proof-"));
				await supervisedCell(backend, replacement, root, "recover");
				if (replacement === "parent crash-restart") {
					for (const boundary of ["before-release", "running"] as const) {
						const probe = join(root, `supervisor-death-${boundary}`);
						mkdirSync(probe, { mode: 0o700 });
						await supervisedCell(backend, replacement, probe, boundary);
					}
				}
				append("observation.jsonl", { backend, replacement, supervisorBoundary: true, cleanupPending: true });
				console.log(`[Plan112] ${backend} / ${replacement}: supervised observations complete; evidence ${root}`);
				return;
			}
			root = process.env.PLAN112_ROOT!;
			writeFileSync(join(root, "supervisor-ready"), String(process.pid), { mode: 0o600 });
			await waitFor("durable supervisor release", () => existsSync(join(root, "supervisor-release")));
			// SAFETY: the outer fixture writes this private file before releasing us.
			const supervisor = JSON.parse(readFileSync(join(root, "supervisor.json"), "utf8")) as OwnedTree;
			expect(supervisor.identity.pid).toBe(process.pid);
			expect(systemProcessTree.identityMatches(supervisor.identity)).toBe("same");
			append("supervisor-boundary.jsonl", { event: "released", pid: process.pid, identityVerified: true });
			for (const dir of ["home", "tmp", "agent", "workspace", "sessions"]) mkdirSync(join(root, dir), { mode: 0o700 });
			expect(JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version).toBe("0.84.4");
			let controller = parent();
			const initial = await waitFor("parent startup", () => rows<ParentEvent>("parents.jsonl").find((event) => event.event === "start"));
			const parentTree = capture(controller.proc.pid);
			const run = await launch(backend);
			const cancelRoot = join(root, "cancel-probe");
			mkdirSync(cancelRoot, { mode: 0o700 });
			const controlled = backend === "headless" ? await launch(backend, cancelRoot) : run;
			if (supervisorMode === "running") {
				writeFileSync(join(root, "supervisor-running"), "children tracked and held", { mode: 0o600 });
				await waitFor("intentional supervisor death", () => false);
			}
			const control = broker(controlled.child, controlled.tree);
			expect(control.adopt(initial)).toBe(true);
			// A real second Pi controller cannot steal a live owner's handle.
			const contender = parent();
			const competing = await waitFor("contender startup", () => rows<ParentEvent>("parents.jsonl").find((event) => event.pid === contender.proc.pid && event.event === "start"));
			capture(contender.proc.pid);
			expect(control.adopt(competing)).toBe(false);
			await contender.request("prompt", "/proof-control cancel");
			expect(await control.control()).toBe(false);
			await contender.request("prompt", "/proof-quit");
			if (replacement === "factory replacement") await controller.request("new_session");
			else {
				if (replacement === "host-Pi reload") await controller.request("prompt", "/proof-quit");
				else expect((await signalVerifiedProcessTree(systemProcessTree, parentTree.identity, "SIGKILL", parentTree.verification)).ok).toBe(true);
				await waitFor("former parent tree empty", () => systemProcessTree.isTreeEmpty(parentTree.identity, parentTree.verification));
				controller = parent();
			}
			const next = await waitFor("replacement startup", () => rows<ParentEvent>("parents.jsonl").find((event) => event.event === "start" && event.generation !== initial.generation && event.pid === controller.proc.pid));
			if (replacement !== "factory replacement") capture(controller.proc.pid);
			expect(control.adopt(next)).toBe(true);
			expect(systemProcessTree.identityMatches(run.tree.identity)).toBe("same");
			// A stale queued request stays fenced even after its process has exited.
			append("requests.jsonl", { ...initial, action: "cancel" });
			expect(await control.control()).toBe(false);
			const wrongIdentity = { ...run.tree.identity, processStartTime: "wrong-start" };
			expect((await signalVerifiedProcessTree(systemProcessTree, wrongIdentity, "SIGTERM")).ok).toBe(false);
			expect(systemProcessTree.identityMatches(run.tree.identity)).toBe("same");
			if (backend === "visible") {
				await controller.request("prompt", "/proof-control steer");
				expect(await control.control()).toBe(true);
			} else {
				await controller.request("prompt", "/proof-control cancel");
				expect(await control.control()).toBe(true);
				const cancelled = await waitFor("adopted headless cancellation", () => controlled.events.find((event) => event.kind === "run-settled"));
				expect(cancelled).toMatchObject({ kind: "run-settled", outcome: { kind: "interrupted" } });
				await waitFor("cancelled tree empty", () => systemProcessTree.isTreeEmpty(controlled.tree.identity, controlled.tree.verification));
			}
			writeFileSync(join(root, "release"), "released after replacement", { mode: 0o600 });
			if (backend === "visible") {
				await waitFor("steered task response", () => {
					const task = readdirSync(join(root, "tasks"))[0]!;
					const response = join(root, "tasks", task, "response.md");
					return existsSync(response) && readFileSync(response, "utf8") === "recovered-steered-result\n";
				});
				await controller.request("prompt", "/proof-control close");
				expect(await control.control()).toBe(true);
			}
			const settled = await waitFor("post-replacement backend result", () => run.events.find((event) => event.kind === "run-settled"));
			expect(settled).toMatchObject({ kind: "run-settled", outcome: { kind: "completed", finalText: backend === "visible" ? "recovered-steered-result\n" : "recovered-result" } });
			await controller.request("prompt", "/proof-recover");
			const recovered = rows<{ generation: string; events: string }>("recovered.jsonl").at(-1)!;
			expect(recovered.generation).toBe(next.generation);
			expect(JSON.parse(recovered.events.trim().split("\n").at(-1)!)).toEqual(settled);
			// Deterministically schedule the old cleanup's check/signal race using
			// a public shutdown hook, without changing any process API.
			await controller.request("prompt", "/proof-quit-gated");
			await waitFor("quit gate", () => existsSync(join(root, "quit-ready")));
			const quitting = owned.find((tree) => tree.identity.pid === controller.proc.pid)!;
			expect(systemProcessTree.isTreeEmpty(quitting.identity, quitting.verification)).toBe(false);
			writeFileSync(join(root, "quit-release"), "graceful exit between check and signal", { mode: 0o600 });
			await waitFor("graceful exit before signal verification", () => systemProcessTree.isTreeEmpty(quitting.identity, quitting.verification));
			const oldCleanup = await terminateProcessTree(systemProcessTree, quitting.identity, { termGraceMs: 500, killGraceMs: 2000 });
			expect(oldCleanup).toBe(false);
			const safeCleanup = await cleanupOwnedTree(systemProcessTree, quitting, (value) => append("cleanup-repro.jsonl", value));
			expect(safeCleanup).toBe(true);
			append("cleanup-repro.jsonl", { oldCleanup, safeCleanup, interleaving: "nonempty check; graceful exit; recapture/identity refusal; independent empty-tree proof" });
			// This observation precedes afterEach: it is NOT a cleanup/gate verdict.
			append("observation.jsonl", { backend, replacement, recoveredResult: true, contract: "independent supervisor retains backend handle; Pi parent replacement only", pi: "0.84.4" });
			console.log(`[Plan112] ${backend} / ${replacement}: result recovered; cleanup verdict still pending; evidence ${root}`);
		}, supervisorMode ? 60_000 : 180_000);
	}
});
