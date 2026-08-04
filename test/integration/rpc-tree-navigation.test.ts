import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

interface RpcValue {
	readonly id?: string;
	readonly type?: string;
	readonly method?: string;
	readonly statusKey?: string;
	readonly statusText?: string;
	readonly [key: string]: unknown;
}

interface RpcClient {
	readonly child: ChildProcessWithoutNullStreams;
	readonly events: readonly RpcValue[];
	request(command: Record<string, unknown>): Promise<RpcValue>;
	waitForOutcome(): Promise<RpcValue>;
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const requestId = "019f8a78-b4f5-7b7b-b774-2d2e4bce9001";

async function createSession(root: string): Promise<{ file: string; id: string }> {
	const id = "019f8a78-b4f5-7b7b-b774-2d2e4bce9002";
	const file = join(root, "synthetic-tree.jsonl");
	await writeFile(file, [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd: process.cwd() }),
		JSON.stringify({ type: "message", id: "tree-user", parentId: null, timestamp: "2026-08-04T00:00:01.000Z", message: { role: "user", content: "selected prompt", timestamp: 1_785_830_401_000 } }),
		JSON.stringify({ type: "message", id: "tree-assistant", parentId: "tree-user", timestamp: "2026-08-04T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "current answer" }], timestamp: 1_785_830_402_000 } }),
		JSON.stringify({ type: "message", id: "veto-target", parentId: null, timestamp: "2026-08-04T00:00:03.000Z", message: { role: "user", content: "veto this navigation" } }),
		"",
	].join("\n"), "utf8");
	return { file, id };
}

async function createHook(root: string): Promise<{ file: string; evidence: string }> {
	const file = join(root, "tree-hook.mjs");
	const evidence = join(root, "tree-hook-evidence.jsonl");
	await writeFile(file, `import { appendFileSync } from "node:fs";
const evidence = process.env.SUMOCODE_TREE_HOOK_EVIDENCE;
function record(value) { appendFileSync(evidence, JSON.stringify(value) + "\\n"); }
export default function install(pi) {
  record({ type: "install" });
  pi.on("session_before_tree", (event) => {
    record({ type: "session_before_tree", targetId: event.preparation.targetId, summarize: event.preparation.userWantsSummary, customInstructions: event.preparation.customInstructions ?? null });
    if (event.preparation.targetId === "veto-target") return { cancel: true };
    if (event.preparation.userWantsSummary) return { summary: { summary: "fixed synthetic branch summary", details: { source: "test" } } };
    return undefined;
  });
  pi.on("session_tree", (event) => record({ type: "session_tree", newLeafId: event.newLeafId, oldLeafId: event.oldLeafId }));
}
`, "utf8");
	return { file, evidence };
}

function launch(extension: string, fauxProvider: string, hook: string, sessionFile: string, agentDir: string, evidence: string): RpcClient {
	const child = spawn(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc", "--offline", "--approve", "--no-extensions",
		"-e", extension,
		"-e", fauxProvider,
		"-e", hook,
		"--model", "sumocode-visual/active-working",
		"--session", sessionFile,
	], {
		cwd: process.cwd(),
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, SUMOCODE_RPC_CHILD: "1", SUMOCODE_TREE_HOOK_EVIDENCE: evidence },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const responses = new Map<string, { resolve(value: RpcValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	const outcomes: RpcValue[] = [];
	const events: RpcValue[] = [];
	const outcomeWaiters: Array<{ resolve(value: RpcValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = [];
	let sequence = 0;
	createInterface({ input: child.stdout }).on("line", (line) => {
		const value = JSON.parse(line) as RpcValue;
		if (value.type === "extension_ui_request" && value.method === "setStatus" && value.statusKey === "sumocode.rpc-tree-navigation-result") {
			const waiter = outcomeWaiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(value);
			} else outcomes.push(value);
			return;
		}
		if (value.type === "extension_ui_request" && typeof value.id === "string") {
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: value.id, cancelled: true })}\n`);
			return;
		}
		if (!value.id) {
			events.push(value);
			return;
		}
		const waiter = responses.get(value.id);
		if (!waiter) return;
		responses.delete(value.id);
		clearTimeout(waiter.timer);
		waiter.resolve(value);
	});
	child.once("exit", (code, signal) => {
		const error = new Error(`Pi RPC child exited (code=${String(code)}, signal=${String(signal)})`);
		for (const waiter of responses.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		responses.clear();
		for (const waiter of outcomeWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	});
	return {
		child,
		events,
		request(command): Promise<RpcValue> {
			const id = `tree-navigation-${++sequence}`;
			return new Promise((resolveResponse, rejectResponse) => {
				const timer = setTimeout(() => {
					responses.delete(id);
					rejectResponse(new Error(`Timed out waiting for ${String(command.type)}`));
				}, 15_000);
				responses.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			});
		},
		waitForOutcome(): Promise<RpcValue> {
			const immediate = outcomes.shift();
			if (immediate) return Promise.resolve(immediate);
			return new Promise((resolveOutcome, rejectOutcome) => {
				const timer = setTimeout(() => rejectOutcome(new Error("Timed out waiting for tree navigation outcome")), 15_000);
				outcomeWaiters.push({ resolve: resolveOutcome, reject: rejectOutcome, timer });
			});
		},
	};
}

afterEach(async () => {
	const running = children.splice(0);
	await Promise.all(running.map(async (child) => {
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	}));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("real Pi RPC tree navigation bridge", () => {
	it("navigates in place through the hidden command without changing session identity or emitting extension_error", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-rpc-tree-navigation-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const { file: sessionFile, id: sessionId } = await createSession(root);
		const { file: hook, evidence } = await createHook(root);
		const client = launch(resolve(process.cwd(), "src/extension.ts"), resolve(process.cwd(), "scripts/visual-v2/runtime-faux-provider.mjs"), hook, sessionFile, agentDir, evidence);

		const initial = await client.request({ type: "get_state" });
		expect(initial.success).toBe(true);
		expect(initial.data).toMatchObject({ sessionId, sessionFile });
		const beforeEntries = await client.request({ type: "get_entries" });
		const beforeLeaf = (beforeEntries.data as { leafId: string }).leafId;

		const payload = Buffer.from(JSON.stringify({ requestId, targetId: "tree-user", summarize: false }), "utf8").toString("base64url");
		const prompt = client.request({ type: "prompt", message: `/sumo:rpc-tree-navigate ${payload}` });
		const outcome = client.waitForOutcome();
		expect(await prompt).toMatchObject({ type: "response", command: "prompt", success: true });
		expect(await outcome).toMatchObject({ statusKey: "sumocode.rpc-tree-navigation-result" });
		const outcomePayload = JSON.parse(Buffer.from((await outcome).statusText!, "base64url").toString("utf8")) as { status: string; leafId: string | null; editorText?: string };
		expect(outcomePayload).toMatchObject({ status: "committed", leafId: null, editorText: "selected prompt" });

		const after = await client.request({ type: "get_state" });
		const afterEntries = await client.request({ type: "get_entries" });
		const afterMessages = await client.request({ type: "get_messages" });
		expect(after.data).toMatchObject({ sessionId, sessionFile });
		expect((afterEntries.data as { leafId: string | null }).leafId).not.toBe(beforeLeaf);
		expect(afterMessages.data).toEqual({ messages: [] });
		expect(JSON.stringify(after)).not.toContain("extension_error");
		const evidenceLines = (await readFile(evidence, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
		expect(evidenceLines.map((line) => line.type)).toEqual(["install", "session_before_tree", "session_tree"]);
		expect(client.events.some((event) => event.type === "extension_error")).toBe(false);
	}, 30_000);

	it("handles default and exact custom summaries, vetoes safely, and keeps one extension instance", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-rpc-tree-summary-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const { file: sessionFile, id: sessionId } = await createSession(root);
		const { file: hook, evidence } = await createHook(root);
		const client = launch(resolve(process.cwd(), "src/extension.ts"), resolve(process.cwd(), "scripts/visual-v2/runtime-faux-provider.mjs"), hook, sessionFile, agentDir, evidence);
		const before = await client.request({ type: "get_state" });
		expect(before.data).toMatchObject({ sessionId, sessionFile });

		let invocation = 0;
		const invoke = async (targetId: string, summarize: boolean, customInstructions?: string) => {
			invocation += 1;
			const navigationRequestId = `019f8a78-b4f5-7b7b-b774-2d2e4bce${String(910 + invocation).padStart(4, "0")}`;
			const payload = Buffer.from(JSON.stringify({ requestId: navigationRequestId, targetId, summarize, ...(customInstructions === undefined ? {} : { customInstructions }) }), "utf8").toString("base64url");
			const prompt = client.request({ type: "prompt", message: `/sumo:rpc-tree-navigate ${payload}` });
			const outcomePromise = client.waitForOutcome();
			expect(await prompt).toMatchObject({ type: "response", command: "prompt", success: true });
			return JSON.parse(Buffer.from((await outcomePromise).statusText!, "base64url").toString("utf8")) as { status: string; leafId: string | null };
		};

		await expect(invoke("tree-user", true)).resolves.toMatchObject({ status: "committed" });
		await expect(invoke("tree-user", true, "retain these exact decisions\nand list unresolved risks")).resolves.toMatchObject({ status: "committed" });
		const afterSummary = await client.request({ type: "get_state" });
		expect(afterSummary.data).toMatchObject({ sessionId, sessionFile });
		const entries = await client.request({ type: "get_entries" });
		expect(JSON.stringify(entries.data)).toContain("branch_summary");
		const messages = await client.request({ type: "get_messages" });
		expect(JSON.stringify(messages.data)).toContain("fixed synthetic branch summary");

		const beforeVeto = await client.request({ type: "get_entries" });
		const beforeVetoMessages = await client.request({ type: "get_messages" });
		const veto = await invoke("veto-target", false);
		expect(veto.status).toBe("cancelled");
		const afterVeto = await client.request({ type: "get_entries" });
		const afterVetoMessages = await client.request({ type: "get_messages" });
		expect((afterVeto.data as { leafId: string | null }).leafId).toBe((beforeVeto.data as { leafId: string | null }).leafId);
		expect(afterVetoMessages.data).toEqual(beforeVetoMessages.data);
		const evidenceLines = (await readFile(evidence, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; customInstructions?: string | null });
		const treeHooks = evidenceLines.filter((line) => line.type === "session_before_tree");
		expect(treeHooks.map((line) => line.customInstructions)).toContain("retain these exact decisions\nand list unresolved risks");
		expect(evidenceLines.filter((line) => line.type === "install")).toHaveLength(1);
		expect(client.events.some((event) => event.type === "extension_error")).toBe(false);
	}, 30_000);

	it("navigates a 6,001-entry linear session in place without nested transport data", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-rpc-tree-long-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const sessionId = "019f8a78-b4f5-7b7b-b774-2d2e4bce9010";
		const sessionFile = join(root, "long-tree.jsonl");
		const entries = Array.from({ length: 6_001 }, (_, index) => JSON.stringify({ type: "message", id: `long-${index}`, parentId: index === 0 ? null : `long-${index - 1}`, timestamp: `2026-08-04T01:00:${String(index % 60).padStart(2, "0")}.000Z`, message: { role: index % 2 === 0 ? "user" : "assistant", content: `long prompt ${index}`, timestamp: 1_780_000_000_000 + index } }));
		await writeFile(sessionFile, [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-04T01:00:00.000Z", cwd: process.cwd() }), ...entries, ""].join("\n"), "utf8");
		const { file: hook, evidence } = await createHook(root);
		const client = launch(resolve(process.cwd(), "src/extension.ts"), resolve(process.cwd(), "scripts/visual-v2/runtime-faux-provider.mjs"), hook, sessionFile, agentDir, evidence);
		const beforeState = await client.request({ type: "get_state" });
		const beforeEntries = await client.request({ type: "get_entries" });
		const beforeLeaf = (beforeEntries.data as { leafId: string | null }).leafId;
		const payload = Buffer.from(JSON.stringify({ requestId, targetId: "long-5999", summarize: false }), "utf8").toString("base64url");
		const prompt = client.request({ type: "prompt", message: `/sumo:rpc-tree-navigate ${payload}` });
		const outcome = client.waitForOutcome();
		expect(await prompt).toMatchObject({ success: true });
		const outcomeResponse = await outcome;
		expect(outcomeResponse).toMatchObject({ statusKey: "sumocode.rpc-tree-navigation-result" });
		expect(JSON.parse(Buffer.from(outcomeResponse.statusText!, "base64url").toString("utf8"))).toMatchObject({ status: "committed", leafId: "long-5999" });
		const afterState = await client.request({ type: "get_state" });
		const afterEntries = await client.request({ type: "get_entries" });
		expect(afterState.data).toMatchObject({ sessionId, sessionFile });
		expect((afterEntries.data as { leafId: string | null }).leafId).not.toBe(beforeLeaf);
		const afterMessages = await client.request({ type: "get_messages" });
		expect(JSON.stringify(afterMessages.data)).toContain("long prompt 0");
		expect(JSON.stringify(client.events)).not.toContain("extension_error");
		// The child stays alive after the in-place navigation; a replacement
		// session would have changed the state identity or ended this process.
		expect(client.child.exitCode).toBeNull();
		expect(beforeState.data).toMatchObject({ sessionId, sessionFile });
	}, 30_000);

	it("keeps ordinary fork as a replacement session", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-rpc-tree-fork-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const original = await createSession(root);
		const { file: hook, evidence } = await createHook(root);
		const client = launch(resolve(process.cwd(), "src/extension.ts"), resolve(process.cwd(), "scripts/visual-v2/runtime-faux-provider.mjs"), hook, original.file, agentDir, evidence);
		const before = await client.request({ type: "get_state" });
		const response = await client.request({ type: "fork", entryId: "tree-user" });
		expect(response).toMatchObject({ type: "response", command: "fork", success: true });
		const after = await client.request({ type: "get_state" });
		expect((after.data as { sessionId: string; sessionFile: string }).sessionId).not.toBe((before.data as { sessionId: string }).sessionId);
		expect((after.data as { sessionFile: string }).sessionFile).not.toBe((before.data as { sessionFile: string }).sessionFile);
		expect(client.events.some((event) => event.type === "extension_error")).toBe(false);
	}, 30_000);
});