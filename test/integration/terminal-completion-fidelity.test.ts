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
}

interface RpcClient {
	request(command: RpcRequest): Promise<any>;
	terminate(): Promise<void>;
}

const roots: string[] = [];
const children: SupervisedProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) await child.terminate();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launch(extension: string, sessionDir: string, sessionFile: string, agentDir: string): RpcClient {
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
		env: buildSpawnEnv(process.env, { PI_CODING_AGENT_DIR: agentDir }),
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
			const id = `terminal-fidelity-${++sequence}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					void supervised.captureFailure().then((evidenceDir) => reject(new Error(`Timed out waiting for ${String(command.type)}. Evidence: ${evidenceDir}`)));
				}, 5_000);
				waiters.set(id, { resolve, reject, timer });
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			});
		},
		terminate(): Promise<void> {
			return supervised.terminate();
		},
	};
}

describe("terminal completion Pi fidelity", () => {
	it("preserves completion details across sendMessage, RPC replay, and session hydration", async () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-terminal-fidelity-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { mode: 0o700 });
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const extension = join(root, "terminal-fidelity-extension.ts");
		const sessionFile = join(sessionDir, "seed.jsonl");
		writeFileSync(extension, `export default function (pi: any): void {\n\tpi.registerCommand("terminal-fidelity", {\n\t\thandler: async () => {\n\t\t\tpi.sendMessage({ customType: "terminal-result", content: "probe", display: true, details: { completionId: "completion-probe", deliveryClaimToken: "claim-probe", ownerSessionId: "session-probe", activity: { id: "term-probe", kind: "terminal", title: "probe", status: "succeeded" } } }, { deliverAs: "followUp", triggerTurn: false });\n\t\t},\n\t});\n}\n`);
		writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "019f8a78-b4f5-7b7b-b774-2d2e4bce9000", timestamp: "2026-07-22T15:40:00.000Z", cwd: process.cwd() }),
			JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: "2026-07-22T15:40:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "seed" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1_784_734_801_000 } }),
			"",
		].join("\n"));

		const first = launch(extension, sessionDir, sessionFile, agentDir);
		await first.request({ type: "prompt", message: "/terminal-fidelity" });
		const live = await first.request({ type: "get_messages" });
		await first.terminate();

		const persistedAfterSend = readFileSync(sessionFile, "utf8");
		expect(persistedAfterSend.match(/completion-probe/g)).toHaveLength(1);
		expect(persistedAfterSend).toContain('"customType":"terminal-result"');

		const second = launch(extension, sessionDir, sessionFile, agentDir);
		const hydrated = await second.request({ type: "get_messages" });
		await second.terminate();

		const findProbes = (response: any) => response.data.messages.filter((message: any) => message.role === "custom" && message.customType === "terminal-result");
		expect(findProbes(live)).toHaveLength(1);
		expect(findProbes(hydrated)).toHaveLength(1);
		for (const probe of [findProbes(live)[0], findProbes(hydrated)[0]]) {
			expect(probe).toMatchObject({
				details: {
					completionId: "completion-probe",
					deliveryClaimToken: "claim-probe",
					ownerSessionId: "session-probe",
					activity: { id: "term-probe", kind: "terminal", status: "succeeded" },
				},
			});
		}
	});
});
