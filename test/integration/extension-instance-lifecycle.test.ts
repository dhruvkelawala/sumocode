import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

interface RpcClient {
	readonly child: ChildProcessWithoutNullStreams;
	request(command: Record<string, unknown>): Promise<any>;
}

interface LifecycleEvidence {
	readonly kind: "factory" | "start" | "shutdown";
	readonly instance: number;
	readonly reason?: string;
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launch(extension: string, sessionDir: string, sessionFile: string, evidenceFile: string): RpcClient {
	const child = spawn(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc",
		"--offline",
		"--approve",
		"--no-extensions",
		"-e", extension,
		"--session-dir", sessionDir,
		"--session", sessionFile,
	], {
		cwd: process.cwd(),
		env: { ...process.env, PI_EXTENSION_LIFECYCLE_EVIDENCE: evidenceFile },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const waiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		const value = JSON.parse(line) as { id?: string };
		if (!value.id) return;
		const waiter = waiters.get(value.id);
		if (!waiter) return;
		waiters.delete(value.id);
		clearTimeout(waiter.timer);
		waiter.resolve(value);
	});
	child.once("exit", (code, signal) => {
		for (const waiter of waiters.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`Pi RPC child exited early (code=${String(code)}, signal=${String(signal)})`));
		}
		waiters.clear();
	});
	let sequence = 0;
	return {
		child,
		request(command): Promise<any> {
			const id = `extension-lifecycle-${++sequence}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					reject(new Error(`Timed out waiting for ${String(command.type)}`));
				}, 10_000);
				waiters.set(id, { resolve, reject, timer });
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			});
		},
	};
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function readEvidence(path: string): LifecycleEvidence[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LifecycleEvidence);
}

describe("Pi 0.80.6 extension instance lifecycle", () => {
	it("recreates the extension factory for new, resume, and fork", async () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-extension-lifecycle-"));
		roots.push(root);
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

		const client = launch(extension, sessionDir, sessionFile, evidenceFile);
		await client.request({ type: "get_state" });
		await client.request({ type: "new_session" });
		await client.request({ type: "switch_session", sessionPath: sessionFile });
		await client.request({ type: "fork", entryId: "abcd1234" });
		client.child.kill("SIGTERM");
		await waitForExit(client.child);

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
