import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSupervisedProcess, type SupervisedProcess } from "./harness-supervisor.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

interface RpcRequest {
	readonly type: string;
	readonly message?: string;
	readonly sessionPath?: string;
	readonly entryId?: string;
}

interface RpcClient {
	request(command: RpcRequest): Promise<any>;
	terminate(): Promise<void>;
}

interface LifecycleEvidence {
	readonly kind: "factory" | "start" | "shutdown";
	readonly instance: number;
	readonly reason?: string;
}

const roots: string[] = [];
const children: SupervisedProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) await child.terminate();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launch(extension: string, sessionDir: string, sessionFile: string, evidenceFile: string, agentDir: string): RpcClient {
	const supervised = spawnSupervisedProcess(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc",
		"--offline",
		"--approve",
		"--no-extensions",
		"-e", extension,
		"--session-dir", sessionDir,
		"--session", sessionFile,
	], {
		cwd: process.cwd(),
		env: buildSpawnEnv(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_EXTENSION_LIFECYCLE_EVIDENCE: evidenceFile }),
		stdio: ["pipe", "pipe", "pipe"],
	});
	// SAFETY: launch fixes all three stdio channels to `pipe`, so Node provides non-null streams.
	const child = supervised.child as ChildProcessWithoutNullStreams;
	children.push(supervised);
	const waiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		// SAFETY: every RPC reply frame is a JSON object with an id field matching
		// a pending waiter; non-object frames are ignored below via the id guard.
		const value = JSON.parse(line) as { id?: string };
		if (!value.id) return;
		const waiter = waiters.get(value.id);
		if (!waiter) return;
		waiters.delete(value.id);
		clearTimeout(waiter.timer);
		waiter.resolve(value);
	});
	child.once("exit", (code, signal) => {
		if (!supervised.shouldCaptureExitFailure(waiters.size > 0)) return;
		void supervised.captureFailure().then((evidenceDir) => {
			for (const waiter of waiters.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(`Pi RPC child exited early (code=${String(code)}, signal=${String(signal)}). Evidence: ${evidenceDir}`));
			}
			waiters.clear();
		});
	});
	let sequence = 0;
	return {
		request(command): Promise<any> {
			const id = `extension-lifecycle-${++sequence}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					void supervised.captureFailure().then((evidenceDir) => reject(new Error(`Timed out waiting for ${String(command.type)}. Evidence: ${evidenceDir}`)));
				}, 10_000);
				waiters.set(id, { resolve, reject, timer });
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			});
		},
		terminate(): Promise<void> {
			return supervised.terminate();
		},
	};
}

function readEvidence(path: string): LifecycleEvidence[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) =>
		// SAFETY: the evidence file is written only by the fixture extension above,
		// which emits exactly the LifecycleEvidence shape for each record call.
		JSON.parse(line) as LifecycleEvidence,
	);
}

describe("Pi 0.80.6 extension instance lifecycle", () => {
	it("recreates the extension factory for new, resume, and fork", async () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-extension-lifecycle-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { mode: 0o700 });
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const evidenceFile = join(root, "lifecycle.jsonl");
		const extension = join(root, "lifecycle-extension.ts");
		const sessionFile = join(sessionDir, "seed.jsonl");
		writeFileSync(extension, [
			'import { appendFileSync } from "node:fs";',
			"let nextInstance = 0;",
			"export default function (pi: any): void {",
			"  const instance = ++nextInstance;",
			"  const evidence = process.env.PI_EXTENSION_LIFECYCLE_EVIDENCE!;",
			"  const record = (value: unknown) => appendFileSync(evidence, `${JSON.stringify(value)}\\n`);",
			'  record({ kind: "factory", instance });',
			'  pi.on("session_start", (event: any) => record({ kind: "start", instance, reason: event.reason }));',
			'  pi.on("session_shutdown", (event: any) => record({ kind: "shutdown", instance, reason: event.reason }));',
			"}",
			"",
		].join("\n"));
		writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "019f8a78-b4f5-7b7b-b774-2d2e4bce9001", timestamp: "2026-07-22T16:00:00.000Z", cwd: process.cwd() }),
			JSON.stringify({ type: "message", id: "abcd1234", parentId: null, timestamp: "2026-07-22T16:00:01.000Z", message: { role: "user", content: "fork this prompt", timestamp: 1_784_736_001_000 } }),
			"",
		].join("\n"));

		const client = launch(extension, sessionDir, sessionFile, evidenceFile, agentDir);
		await client.request({ type: "get_state" });
		await client.request({ type: "new_session" });
		await client.request({ type: "switch_session", sessionPath: sessionFile });
		await client.request({ type: "fork", entryId: "abcd1234" });
		await client.terminate();

		const evidence = readEvidence(evidenceFile);
		expect(evidence.filter(({ kind }) => kind === "factory").map(({ instance }) => instance)).toEqual([1, 2, 3, 4]);
		// RPC mode binds each replacement twice in Pi 0.80.6 (runtime-host
		// rebind plus command-handler rebind), but both starts target the same
		// newly-created factory instance.
		expect(evidence.filter(({ kind }) => kind === "start")).toEqual([
			{ kind: "start", instance: 1, reason: "startup" },
			{ kind: "start", instance: 2, reason: "new" },
			{ kind: "start", instance: 2, reason: "new" },
			{ kind: "start", instance: 3, reason: "resume" },
			{ kind: "start", instance: 3, reason: "resume" },
			{ kind: "start", instance: 4, reason: "fork" },
			{ kind: "start", instance: 4, reason: "fork" },
		]);
		expect(evidence.filter(({ kind }) => kind === "shutdown")).toEqual([
			{ kind: "shutdown", instance: 1, reason: "new" },
			{ kind: "shutdown", instance: 2, reason: "resume" },
			{ kind: "shutdown", instance: 3, reason: "fork" },
			{ kind: "shutdown", instance: 4, reason: "quit" },
		]);
	}, 30_000);
});
