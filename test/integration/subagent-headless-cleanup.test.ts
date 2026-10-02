import type { SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPiChildSpawner, retainedProcessTree, type HeadlessLaunchGate } from "../../src/subagents/backend-pi.js";
import { systemProcessTree, type ProcessTreeVerification, type ProcessTreeIdentity } from "../../src/background-tasks/process-tree.js";
import type { RunOutcome } from "../../src/subagents/domain.js";
import { spawnSupervisedApp, spawnSupervisedGatedIpcProcess } from "./harness-supervisor.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["abort", "natural-exit"])("proves a retained headless tree empty after %s with a TERM-ignoring descendant", async (mode) => {
	// pnpm's script shim may inject NODE_PATH; retained children reject loader overrides.
	vi.stubEnv("NODE_PATH", undefined);
	vi.stubEnv("NODE_OPTIONS", undefined);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-headless-cleanup-")));
	const ready = join(root, "ready.json");
	const pi = join(root, "pi");
	const worker = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');`;
	writeFileSync(pi, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
// WAIT-CLASS: fixture-delay — keep the synthetic Pi process alive until scoped tree termination.
setInterval(() => {}, 1000);
const worker = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
worker.once('message', () => {
 process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', text: 'preserved answer' } }) + '\\n');
 writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, descendant: worker.pid }));
 ${mode === "natural-exit" ? "process.exit(0);" : ""}
});
`, { mode: 0o700 });
	chmodSync(pi, 0o700);
	let launched: ReturnType<typeof spawnSupervisedGatedIpcProcess> | undefined;
	const spawn = (command: string, args: string[], options: SpawnOptions) => {
		launched = spawnSupervisedGatedIpcProcess(command, args, options);
		return launched.child;
	};
	let tree: { identity: ProcessTreeIdentity; verification: ProcessTreeVerification } | undefined;
	const signals: string[] = [];
	let refusals = 0;
	const operations = { ...retainedProcessTree, signalTree: async (...args: Parameters<typeof retainedProcessTree.signalTree>) => {
		signals.push(args[1]);
		return retainedProcessTree.signalTree(...args);
	} };
	const gate: HeadlessLaunchGate = {
		beforeSpawn: () => randomUUID(),
		beforePrompt: (pid) => {
			const start = operations.captureStartTime(pid);
			if (!start) throw new Error("no anchor identity");
			const identity = { pid, processGroupId: pid, processStartTime: start };
			const verification = operations.captureTreeVerification!(identity);
			if (!verification) throw new Error("no anchor birth verification");
			tree = { identity, verification };
		},
		beforeStdin: () => undefined,
		beforeSignal: () => { if (!tree) throw new Error("no signal authority"); return tree; },
		onRefused: () => { refusals++; },
	};
	// SAFETY: the supervised spawn retains Node's piped child/IPC surface and audits this entire group.
	const child = createPiChildSpawner(spawn as never, () => undefined, () => pi, () => undefined, operations)({
		prompt: "fixture", cwd: root, inherited: {}, launchGate: gate,
	});
	let outcome: RunOutcome | undefined;
	if (Symbol.asyncIterator in child.events) throw new Error("callback backend expected");
	child.events((event) => { if (event.kind === "run-settled") outcome = event.outcome; });
	try {
		await child.ready;
		// WAIT-CLASS: poll-interval — wait for the real descendant's installed TERM handler, not just spawn.
		await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 4000 });
		if (mode === "abort") await child.interrupt();
		// WAIT-CLASS: poll-interval — settlement must follow verified group drainage, including after direct Pi exit.
		await vi.waitFor(() => expect(outcome?.kind).toBe(mode === "abort" ? "interrupted" : "completed"), { timeout: 9000 });
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(refusals).toBe(0);
		expect(tree).toBeDefined();
		expect(operations.isTreeEmpty(tree!.identity, tree!.verification)).toBe(true);
		expect(JSON.stringify(outcome)).toContain("preserved answer");
		writeFileSync(join(launched!.evidence.evidenceDir, "cleanup.json"), JSON.stringify({ mode, signals, outcome, empty: true, child: JSON.parse(readFileSync(ready, "utf8")) }));
	} catch (error) {
		await launched?.captureFailure(JSON.stringify({ mode, signals, refusals, outcome }));
		throw error;
	} finally {
		await launched?.terminate();
	}
}, 20_000);

it.each([
	["classic", "steering-ack"], ["rpc", "steering-ack"],
	["classic", "headless-cleanup"], ["rpc", "headless-cleanup"],
] as const)("source Pi keeps Effect cold through %s readiness before %s", async (profile, subject) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-source-effect-cold-")));
	const repository = fileURLToPath(new URL("../../", import.meta.url));
	const cold = join(root, "cold.json");
	const loaded = join(root, "loaded.json");
	const probe = join(root, "probe.ts");
	writeFileSync(probe, `import { writeFileSync } from 'node:fs';
const symbols = [];
const original = Symbol.for;
Symbol.for = (key) => { if (key.startsWith('effect/') || key.startsWith('~effect/')) symbols.push(key); return original(key); };
export default function install(pi) {
 pi.on('session_start', async () => {
  writeFileSync(${JSON.stringify(cold)}, JSON.stringify(symbols), {mode:0o600});
  await import(${JSON.stringify(join(repository, `src/subagents/${subject}-effect.ts`))});
  writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(symbols), {mode:0o600});
 });
}
`, { mode: 0o600 });
	const cli = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
	const entry = join(repository, profile === "classic" ? "src/extension.ts" : "src/rpc-child-extension.ts");
	const launched = spawnSupervisedApp(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-session", "--approve", "-e", probe, "-e", entry], {
		cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: root,
			SUMOCODE_ROOT_DIR: repository, SUMOCODE_LAUNCHER: undefined, SUMOCODE_BG_CHILD: undefined,
			SUMOCODE_RPC_CHILD: profile === "rpc" ? "1" : undefined, SUMOCODE_STATE_DIR: join(root, "state"),
			SUMO_TUI_DIAG_FILE: join(root, "diagnostic.jsonl"), NODE_PATH: undefined, NODE_OPTIONS: undefined },
	});
	let stdout = "";
	launched.child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
	try {
		const exited = new Promise<number | null>((resolveExit, rejectExit) => {
			launched.child.once("error", rejectExit);
			launched.child.once("close", resolveExit);
		});
		launched.child.stdin!.end('{"type":"get_commands"}\n');
		expect(await exited).toBe(0);
		expect(stdout).toContain('"name":"reload"');
		expect(JSON.parse(readFileSync(cold, "utf8"))).toEqual([]);
		expect(JSON.parse(readFileSync(loaded, "utf8")).length).toBeGreaterThan(0);
	} catch (error) {
		await launched.captureFailure(stdout);
		throw error;
	} finally {
		try {
			// WAIT-CLASS: poll-interval — EOF may precede short-lived Git probes; this observation uses PGID only, never signals.
			expect(await systemProcessTree.waitForTreeEmpty({ pid: launched.pid, processGroupId: launched.pgid, processStartTime: "observed source probe" }, 2000)).toBe(true);
		} finally { await launched.terminate(); }
	}
}, 30_000);
