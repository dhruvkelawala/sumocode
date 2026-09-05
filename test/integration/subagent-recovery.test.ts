import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiChildSpawner, type SpawnedChild } from "../../src/subagents/backend-pi.js";
import { createPaneChildSpawner } from "../../src/subagents/backend-pane.js";
import type { SubagentEvent } from "../../src/subagents/domain.js";
import { systemProcessTree, terminateProcessTree, signalVerifiedProcessTree, type ProcessTreeIdentity, type ProcessTreeVerification } from "../../src/background-tasks/process-tree.js";
import { shellEscape } from "../../src/background-tasks/visible-spawn.js";
import { JsonLineDecoder } from "../../src/child-protocol.js";
import { spawnSupervisedProcess, type SupervisedProcess } from "./harness-supervisor.js";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const PI = resolve("node_modules/.bin/pi");
const EXTENSION = resolve("test/integration/fixtures/subagent-feasibility-extension.ts");
const replacements = ["factory replacement", "host-Pi reload", "parent crash-restart"] as const;
const backends = ["headless", "visible"] as const;
interface ParentEvent { event: string; reason: string; pid: number; generation: string }
interface Request { generation: string; pid: number; action: string }
interface OwnedTree { identity: ProcessTreeIdentity; verification: ProcessTreeVerification }
const owned: OwnedTree[] = [];
const processes: SupervisedProcess[] = [];
const ptys: SpawnedPiPty[] = [];
const handles: SpawnedChild[] = [];
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
		PI_OFFLINE: "1", TERM: "xterm-256color", PLAN112_ROOT: root, PLAN112_ROLE: role,
		SUMOCODE_INTEGRATION_RUN_ROOT: process.env.SUMOCODE_INTEGRATION_RUN_ROOT,
		SUMOCODE_INTEGRATION_MANIFEST: process.env.SUMOCODE_INTEGRATION_MANIFEST,
	};
}
function parent() {
	const proc = spawnSupervisedProcess(PI, ["--mode", "rpc", "--offline", "--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", EXTENSION, "--session-dir", join(root, "sessions")], {
		cwd: join(root, "workspace"), env: privateEnv("parent"), stdio: ["pipe", "pipe", "pipe"],
	});
	processes.push(proc);
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

// This test process is the independent, tracked feasibility supervisor. It owns
// the existing backend handles, not a Pi session context. Production adoption is
// deliberately absent: the experiment asks whether public Pi transport suffices.
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
			processes.push(proc);
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
					const pty = spawnPiPty({ command: "/bin/bash", args: ["-c", `umask 077; printf '%s' "$$" > ${shellEscape(join(root, "pane.pid"))}; ${options.shellCommand}`], cwd: options.cwd, env: privateEnv("visible") });
					ptys.push(pty);
					pid = Number(await waitFor("pane pid", () => existsSync(join(root, "pane.pid")) && readFileSync(join(root, "pane.pid"), "utf8")));
					return { ok: true, pane: { host: "herdr", paneId: String(pid) }, agentName: "proof", paneId: String(pid) };
				},
				async closePane() { throw new Error("visible proof uses graceful task close, not pane-id signals"); },
				async openCommandInSplit() { throw new Error("not used"); },
				async notify() {},
			},
		});
	}
	handles.push(child);
	const events: SubagentEvent[] = [];
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend API explicitly permits callback or AsyncIterable subscriptions.
	if (typeof child.events !== "function") throw new Error("expected callback backend");
	child.events((event) => { events.push(event); append("events.jsonl", event); });
	await waitFor("real provider stream", () => existsSync(join(workerRoot, "stream-ready")));
	return { child, tree: capture(pid), events };
}

afterEach(async () => {
	// Do not call harness PID-only termination on a live tree. On unsafe identity,
	// fail and retain all roots; harness audit is the separate last-resort owner.
	for (const tree of owned) {
		if (systemProcessTree.isTreeEmpty(tree.identity, tree.verification)) continue;
		if (!await terminateProcessTree(systemProcessTree, tree.identity, { termGraceMs: 500, killGraceMs: 2000 })) throw new Error(`unsafe cleanup; retained ${root}`);
		expect(systemProcessTree.isTreeEmpty(tree.identity, tree.verification)).toBe(true);
	}
	for (const proc of processes) await proc.terminate();
	for (const pty of ptys) await pty.cleanupAndWait();
	// All live processes are gone before clearing any backend polling resources.
	for (const handle of handles) handle.interrupt();
	append("audit.jsonl", { zeroSurvivors: true, trees: owned.length });
	owned.length = processes.length = ptys.length = handles.length = 0;
}, 30_000);

describe("Plan112 supervised feasibility (not production adoption)", () => {
	for (const backend of backends) for (const replacement of replacements) {
		it(`feasibility: ${backend} across ${replacement}`, async () => {
			root = mkdtempSync(join(tmpdir(), "sumocode-plan112-proof-"));
			for (const dir of ["home", "tmp", "agent", "workspace", "sessions"]) mkdirSync(join(root, dir), { mode: 0o700 });
			expect(JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version).toBe("0.84.4");
			let controller = parent();
			const initial = await waitFor("parent startup", () => rows<ParentEvent>("parents.jsonl").find((event) => event.event === "start"));
			const parentTree = capture(controller.proc.pid);
			const run = await launch(backend);
			const cancelRoot = join(root, "cancel-probe");
			mkdirSync(cancelRoot, { mode: 0o700 });
			const controlled = backend === "headless" ? await launch(backend, cancelRoot) : run;
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
			await controller.request("prompt", "/proof-quit");
			// This observation precedes afterEach: it is NOT a cleanup/gate verdict.
			append("observation.jsonl", { backend, replacement, recoveredResult: true, contract: "independent supervisor retains backend handle; Pi parent replacement only", pi: "0.84.4" });
			console.log(`[Plan112] ${backend} / ${replacement}: result recovered; cleanup verdict still pending; evidence ${root}`);
		}, 60_000);
	}
});
