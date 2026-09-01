import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";
const SUPER_ENTER = "\x1b[13;9u";
const ALT_UP = "\x1b[1;3A";
const COLS = 100;
const ROWS = 30;

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

interface PromptCommand {
	readonly type: string;
	readonly message?: string;
	readonly streamingBehavior?: string;
}

interface EvidenceEvent {
	readonly type: string;
	readonly toolNames?: readonly string[];
	readonly role?: string;
	readonly text?: string;
}

async function readPromptCommands(path: string): Promise<PromptCommand[]> {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) =>
			// SAFETY: the log is written by the RPC child fixture as JSON lines;
			// only frames carrying a prompt type are kept by the filter below.
			JSON.parse(line) as PromptCommand,
		)
		.filter((command) => command.type === "prompt");
}

async function waitForPromptMessages(path: string, expected: readonly string[], timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const prompts = await readPromptCommands(path);
		if (JSON.stringify(prompts.map((command) => command.message)) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const prompts = await readPromptCommands(path);
	expect(prompts.map((command) => command.message)).toEqual(expected);
}

async function waitForPromptPrefix(path: string, expected: readonly string[], timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const prompts = await readPromptCommands(path);
		if (JSON.stringify(prompts.slice(0, expected.length).map((command) => command.message)) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const prompts = await readPromptCommands(path);
	expect(prompts.slice(0, expected.length).map((command) => command.message)).toEqual(expected);
}

async function bootRpcHost(prefix: string, piBin: string, logPath: string): Promise<SpawnedPiPty> {
	const agentDir = await mkdtemp(join(tmpdir(), prefix));
	const spawned = spawnSumocodePty({
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			PI_BIN: piBin,
			SUMOCODE_RPC_FIXTURE_LOG: logPath,
		},
		cols: COLS,
		rows: ROWS,
	});
	await spawned.waitForReady("app", 15_000);
	return spawned;
}

async function createRealRpcCommandLogger(root: string, commandLogPath: string): Promise<string> {
	const wrapperPath = join(root, "real-pi-rpc-command-logger.mjs");
	const piBin = join(process.cwd(), "node_modules/.bin/pi");
	const source = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const target = ${JSON.stringify(piBin)};
const logPath = ${JSON.stringify(commandLogPath)};
const child = spawn(target, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try { appendFileSync(logPath, JSON.stringify(JSON.parse(line)) + "\\n"); } catch {}
    child.stdin.write(line + "\\n");
  }
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.pipe(process.stdout);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.on("SIGTERM", () => child.kill("SIGTERM"));
`;
	await writeFile(wrapperPath, source, "utf8");
	await chmod(wrapperPath, 0o755);
	return wrapperPath;
}

async function createRealSteeringBoundaryProvider(root: string, evidencePath: string, releaseBPath: string): Promise<string> {
	const providerPath = join(root, "steering-boundary-provider.mjs");
	const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
	const source = `import { appendFileSync, existsSync } from "node:fs";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxProviderUrl)};

const provider = "sumocode-steering-test";
const modelId = "steering-boundary";
const api = "sumocode-steering-test-api";
const evidence = ${JSON.stringify(evidencePath)};
const releaseB = ${JSON.stringify(releaseBPath)};
const holdOpenMs = 1_000;

function record(type, event) {
  const message = event?.message;
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : undefined;
  const toolNames = Array.isArray(content) ? content.map((part) => part?.name ?? "").filter(Boolean) : undefined;
  appendFileSync(evidence, JSON.stringify({ type, role: message?.role, text, toolName: event?.toolName, toolNames }) + "\\n");
}

function waitForRelease() {
  return new Promise((resolve) => {
    const poll = () => existsSync(releaseB) ? resolve() : setTimeout(poll, 10);
    poll();
  });
}

export default function install(pi) {
  for (const type of ["message_start", "turn_end", "agent_settled", "tool_execution_start", "tool_execution_end"]) {
    pi.on(type, (event) => record(type, event));
  }
  pi.registerTool({
    name: "hold_open",
    label: "hold open",
    description: "Hold the current turn open for the steering boundary test.",
    parameters: Type.Object({}),
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, holdOpenMs));
      return { content: [{ type: "text", text: "held open" }] };
    },
  });
  const core = createFauxCore({
    provider,
    api,
    tokensPerSecond: 1000,
    models: [{ id: modelId, name: "Steering boundary", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  core.setResponses([
    () => {
      appendFileSync(evidence, JSON.stringify({ type: "assistant_request" }) + "\\n");
      return fauxAssistantMessage(fauxToolCall("hold_open", {}, { id: "hold-open-call" }), { stopReason: "toolUse" });
    },
    async () => {
      appendFileSync(evidence, JSON.stringify({ type: "assistant_request" }) + "\\n");
      await waitForRelease();
      return fauxAssistantMessage("B completed", { stopReason: "stop" });
    },
    () => {
      appendFileSync(evidence, JSON.stringify({ type: "assistant_request" }) + "\\n");
      return fauxAssistantMessage("C completed", { stopReason: "stop" });
    },
  ]);
  pi.registerProvider(provider, {
    name: "SumoCode steering test",
    baseUrl: "http://localhost:0",
    apiKey: "non-secret-test-key",
    api,
    streamSimple: core.streamSimple,
    models: [{ id: modelId, name: "Steering boundary", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
}
`;
	await writeFile(providerPath, source, "utf8");
	await chmod(providerPath, 0o755);
	return providerPath;
}

async function readEvidence(path: string): Promise<EvidenceEvent[]> {
	try {
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) =>
			// SAFETY: the evidence file is written by the fixture provider as JSON
			// lines carrying the event fields asserted below.
			JSON.parse(line) as EvidenceEvent,
		);
	} catch {
		return [];
	}
}

async function waitForEvidence(path: string, predicate: (events: readonly EvidenceEvent[]) => boolean, timeoutMs = 10_000): Promise<EvidenceEvent[]> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const events = await readEvidence(path);
		if (predicate(events)) return events;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const events = await readEvidence(path);
	expect(predicate(events)).toBe(true);
	return events;
}

describe("RPC queued message undo", () => {
	it("queues a busy submit in the host, restores it with Alt+Up, and never sends streamingBehavior", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-queue-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-queue-child-", {
			promptDelayMs: 2_000,
			settleDelayMs: 100,
		});
		app = await bootRpcHost("sumocode-rpc-queue-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt B"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);

		app.sendInput(ALT_UP);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("prompt B") && !screen.text.includes("QUEUED (1)"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(` edited${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt B edited"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);

		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		await app.waitForOutput("fixture response complete: prompt B edited", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B edited"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);
	}, 30_000);

	it("force-sends only the oldest queued prompt as steer and leaves the later FIFO entry undoable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-force-queue-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-force-queue-child-", {
			promptDelayMs: 2_000,
			settleDelayMs: 100,
		});
		app = await bootRpcHost("sumocode-rpc-force-queue-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(SUPER_ENTER);
		await waitForPromptMessages(logPath, ["prompt A", "prompt B"]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);
		expect(prompts[0]).not.toHaveProperty("streamingBehavior");
		expect(prompts[1]).toMatchObject({ streamingBehavior: "steer" });

		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
		app.sendInput(ALT_UP);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("prompt C") && !screen.text.includes("QUEUED (1)"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);
	}, 30_000);

	it("holds the host FIFO when accepted steering has no authoritative Pi lifecycle", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-force-handled-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-force-handled-child-", {
			promptDelayMs: 2_000,
			settleDelayMs: 100,
		});
		app = await bootRpcHost("sumocode-rpc-force-handled-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(SUPER_ENTER);
		await waitForPromptMessages(logPath, ["prompt A", "prompt B"]);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);
		expect(prompts[1]).toMatchObject({ message: "prompt B", streamingBehavior: "steer" });

		// No queue_update or B lifecycle means Pi's disposition is unclear.
		// A settling must not cause the host to guess and send C.
		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(ALT_UP);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("prompt C") && !screen.text.includes("QUEUED (1)"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
	}, 30_000);

	it("real Pi places a steered user message after the current turn and before the next assistant request", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-rpc-real-steering-"));
		const agentDir = join(root, "agent");
		const evidencePath = join(root, "events.jsonl");
		const commandLogPath = join(root, "rpc-commands.jsonl");
		const releaseBPath = join(root, "release-b");
		const providerPath = await createRealSteeringBoundaryProvider(root, evidencePath, releaseBPath);
		const commandLoggerPath = await createRealRpcCommandLogger(root, commandLogPath);
		app = spawnSumocodePty({
			env: { PI_CODING_AGENT_DIR: agentDir, PI_BIN: commandLoggerPath },
			args: [
				"--offline",
				"--no-extensions",
				"--no-session",
				"--approve",
				"-e", providerPath,
				"--model", "sumocode-steering-test/steering-boundary",
			],
			cols: COLS,
			rows: ROWS,
		});
		await app.waitForReady("app", 15_000);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await waitForEvidence(evidencePath, (events) => events.some((event) => event.type === "tool_execution_start"));
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(SUPER_ENTER);
		const events = await waitForEvidence(evidencePath, (current) => {
			const aToolTurnEndIndex = current.findIndex(
				(event) => event.type === "turn_end" && Array.isArray(event.toolNames) && event.toolNames.includes("hold_open"),
			);
			const bIndex = current.findIndex((event) => event.type === "message_start" && event.role === "user" && event.text === "prompt B");
			const bAssistantRequestIndex = current.findIndex((event, index) => index > bIndex && event.type === "assistant_request");
			return aToolTurnEndIndex >= 0 && bIndex > aToolTurnEndIndex && bAssistantRequestIndex > bIndex;
		});
		const aToolTurnEndIndex = events.findIndex(
			(event) => event.type === "turn_end" && Array.isArray(event.toolNames) && event.toolNames.includes("hold_open"),
		);
		const bIndex = events.findIndex((event) => event.type === "message_start" && event.role === "user" && event.text === "prompt B");
		const bAssistantRequestIndex = events.findIndex((event, index) => index > bIndex && event.type === "assistant_request");
		expect(aToolTurnEndIndex).toBeGreaterThanOrEqual(0);
		expect(aToolTurnEndIndex).toBeLessThan(bIndex);
		expect(bIndex).toBeLessThan(bAssistantRequestIndex);
		const betweenToolTurnAndB = events.slice(aToolTurnEndIndex + 1, bIndex);
		// A follow-up implementation would make A's second assistant request
		// land here, after the tool turn but before B. Steering must not.
		expect(betweenToolTurnAndB.some((event) => event.type === "assistant_request")).toBe(false);
		expect(betweenToolTurnAndB.some((event) => event.type === "agent_settled")).toBe(false);

		await waitForPromptPrefix(commandLogPath, ["prompt A", "prompt B"]);
		let realPrompts = await readPromptCommands(commandLogPath);
		expect(realPrompts).toHaveLength(2);
		expect(realPrompts[1]).toMatchObject({ message: "prompt B", streamingBehavior: "steer" });
		// B's provider request is held open. C must remain host-owned until the
		// steered B lifecycle emits agent_settled.
		await new Promise((resolve) => setTimeout(resolve, 300));
		realPrompts = await readPromptCommands(commandLogPath);
		expect(realPrompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		await writeFile(releaseBPath, "release\n", "utf8");
		await waitForEvidence(evidencePath, (current) => {
			const bIndexNow = current.findIndex((event) => event.type === "message_start" && event.role === "user" && event.text === "prompt B");
			return bIndexNow >= 0 && current.some((event, index) => index > bIndexNow && event.type === "agent_settled");
		});
		await waitForPromptMessages(commandLogPath, ["prompt A", "prompt B", "prompt C"]);
		realPrompts = await readPromptCommands(commandLogPath);
		expect(realPrompts[2]).toMatchObject({ message: "prompt C" });
		expect(realPrompts[2]).not.toHaveProperty("streamingBehavior");
	}, 30_000);

	it("drains one queued prompt per agent_settled and ignores agent_end alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-drain-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-drain-child-", {
			promptDelayMs: 300,
			settleDelayMs: 700,
		});
		app = await bootRpcHost("sumocode-rpc-drain-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		await new Promise((resolve) => setTimeout(resolve, 250));
		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);

		await app.waitForOutput("fixture response complete: prompt B", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);

		await app.waitForOutput("fixture response complete: prompt C", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B", "prompt C"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);
	}, 30_000);

	it("drains exactly one prompt queued during manual compaction when compaction_end lands", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-compact-drain-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-compact-drain-child-", {
			compactDelayMs: 500,
			promptDelayMs: 2_500,
			settleDelayMs: 1_000,
		});
		app = await bootRpcHost("sumocode-rpc-compact-drain-agent-", piBin, logPath);

		app.sendInput(`/compact${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("Compacting"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		await waitForPromptMessages(logPath, ["prompt B"]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt B"]);

		await app.waitForOutput("fixture response complete: prompt B", 6_000);
		await app.waitForOutput("fixture response complete: prompt C", 6_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt B", "prompt C"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);
	}, 30_000);
});
