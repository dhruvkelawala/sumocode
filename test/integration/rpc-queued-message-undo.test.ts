import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const ENTER = "\x1b[13u";
const SUPER_ENTER = "\x1b[13;9u";
const ALT_ENTER = "\x1b[13;3u";
const ALT_UP = "\x1b[1;3A";
const ESCAPE = "\x1b";
const COLS = 100;
const ROWS = 30;
let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

interface LoggedCommand {
	readonly type: string;
	readonly message?: string;
	readonly streamingBehavior?: string;
	readonly role?: string;
	readonly text?: string;
}

type EvidenceEvent = LoggedCommand;

async function commands(path: string): Promise<LoggedCommand[]> {
	try {
		// SAFETY: the isolated fixture writes one JSON command object per line.
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedCommand);
	} catch {
		return [];
	}
}

async function waitForCommands(path: string, predicate: (frames: readonly LoggedCommand[]) => boolean): Promise<LoggedCommand[]> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const frames = await commands(path);
		if (predicate(frames)) return frames;
		// WAIT-CLASS: poll-interval — bounded gap between command-log observations.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const frames = await commands(path);
	expect(predicate(frames)).toBe(true);
	return frames;
}

async function boot(prefix: string): Promise<{ logPath: string; app: SpawnedPiPty }> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const logPath = join(dir, "commands.jsonl");
	const piBin = await createRpcChildFixture(`${prefix}child-`, { promptDelayMs: 2_000 });
	const spawned = spawnSumocodePty({
		env: { PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), `${prefix}agent-`)), PI_BIN: piBin, SUMOCODE_RPC_FIXTURE_LOG: logPath },
		cols: COLS,
		rows: ROWS,
	});
	await spawned.waitForReady("app", 15_000);
	return { logPath, app: spawned };
}

async function waitForEvidence(path: string, predicate: (events: readonly EvidenceEvent[]) => boolean): Promise<EvidenceEvent[]> {
	return waitForCommands(path, predicate);
}

async function createNativeQueueProvider(root: string, evidencePath: string, releasePath: string): Promise<string> {
	const path = join(root, "native-queue-provider.mjs");
	const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
	await writeFile(path, `import { appendFileSync, existsSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxProviderUrl)};
const evidence = ${JSON.stringify(evidencePath)};
const release = ${JSON.stringify(releasePath)};
const model = { id: "native-queues", name: "Native queues", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const record = (type, event) => {
  const content = event?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : undefined;
  appendFileSync(evidence, JSON.stringify({ type, role: event?.message?.role, text }) + "\\n");
};
const waitForRelease = () => new Promise((resolve) => {
  // WAIT-CLASS: poll-interval — exits when the test writes the release marker.
  const poll = () => existsSync(release) ? resolve() : setTimeout(poll, 10);
  poll();
});
export default function install(pi) {
  for (const type of ["message_start", "agent_settled"]) pi.on(type, (event) => record(type, event));
  const core = createFauxCore({ provider: "sumocode-native-queue-test", api: "sumocode-native-queue-api", tokensPerSecond: 1000, models: [model] });
  core.setResponses([
    async () => { appendFileSync(evidence, '{"type":"assistant_request"}\\n'); await waitForRelease(); return fauxAssistantMessage("A completed", { stopReason: "stop" }); },
    ...["B completed", "C completed", "D completed"].map((text) => () => { appendFileSync(evidence, '{"type":"assistant_request"}\\n'); return fauxAssistantMessage(text, { stopReason: "stop" }); }),
  ]);
  pi.registerProvider("sumocode-native-queue-test", { name: "Native queue test", baseUrl: "http://localhost:0", apiKey: "test", api: "sumocode-native-queue-api", streamSimple: core.streamSimple, models: [model] });
}
`, "utf8");
	await chmod(path, 0o755);
	return path;
}

describe("RPC Pi-native prompt queues", () => {
	it("sends busy Enter directly as steering and Alt+Up clears/restores it", async () => {
		const booted = await boot("sumocode-native-steer-");
		app = booted.app;
		app.sendInput(`prompt A${ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("STEERING (1)") && screen.text.includes("prompt B"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });

		let frames = await waitForCommands(booted.logPath, (items) => items.filter((item) => item.type === "prompt").length === 2);
		expect(frames.filter((item) => item.type === "prompt")).toMatchObject([
			{ message: "prompt A", streamingBehavior: "steer" },
			{ message: "prompt B", streamingBehavior: "steer" },
		]);

		app.sendInput(ALT_UP);
		await waitForScreen(app, (screen) => screen.text.includes("prompt B") && !screen.text.includes("STEERING (1)"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
		frames = await waitForCommands(booted.logPath, (items) => items.some((item) => item.type === "clear_queue"));
		expect(frames.some((item) => item.type === "abort")).toBe(false);
	}, 30_000);

	it("toggles the visible default without submitting the draft; Alt+Enter stays one-shot follow-up", async () => {
		const booted = await boot("sumocode-native-followup-");
		app = booted.app;
		app.sendInput(`prompt A${ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput("draft B");
		app.sendInput(SUPER_ENTER);
		await waitForScreen(app, (screen) => screen.text.includes("FOLLOW-UP") && screen.text.includes("draft B"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
		expect((await commands(booted.logPath)).filter((item) => item.type === "prompt")).toHaveLength(1);

		app.sendInput(ENTER);
		app.sendInput(`one shot${ALT_ENTER}`);
		const prompts = (await waitForCommands(booted.logPath, (items) => items.filter((item) => item.type === "prompt").length === 3))
			.filter((item) => item.type === "prompt");
		expect(prompts.slice(1)).toMatchObject([
			{ message: "draft B", streamingBehavior: "followUp" },
			{ message: "one shot", streamingBehavior: "followUp" },
		]);
	}, 30_000);

	it("real Pi delivers two steering boundaries before a queued follow-up", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-real-native-queues-"));
		const evidencePath = join(root, "evidence.jsonl");
		const releasePath = join(root, "release");
		const providerPath = await createNativeQueueProvider(root, evidencePath, releasePath);
		app = spawnSumocodePty({
			env: { PI_CODING_AGENT_DIR: join(root, "agent") },
			args: ["--offline", "--no-extensions", "--no-session", "--approve", "-e", providerPath, "--model", "sumocode-native-queue-test/native-queues"],
			cols: COLS,
			rows: ROWS,
		});
		await app.waitForReady("app", 15_000);

		app.sendInput(`prompt A${ENTER}`);
		await waitForEvidence(evidencePath, (events) => events.some((event) => event.type === "assistant_request"));
		app.sendInput(`prompt B${ENTER}`);
		app.sendInput(`prompt C${ENTER}`);
		app.sendInput(SUPER_ENTER);
		app.sendInput(`prompt D${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("STEERING (2)") && screen.text.includes("FOLLOW-UP (1)"), {
			cols: COLS, rows: ROWS, timeoutMs: 5_000,
		});

		await writeFile(releasePath, "release\n", "utf8");
		await app.waitForOutput("D completed", 10_000);
		const evidence = await waitForEvidence(evidencePath, (events) => events.filter((event) => event.type === "assistant_request").length >= 4);
		expect(evidence.filter((event) => event.type === "message_start" && event.role === "user").map((event) => event.text)).toEqual([
			"prompt A", "prompt B", "prompt C", "prompt D",
		]);
	}, 30_000);

	it("Escape clears/restores before aborting", async () => {
		const booted = await boot("sumocode-native-escape-");
		app = booted.app;
		app.sendInput(`prompt A${ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${ENTER}`);
		await waitForScreen(app, (screen) => screen.text.includes("STEERING (1)"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
		app.sendInput(ESCAPE);
		const frames = await waitForCommands(booted.logPath, (items) => items.some((item) => item.type === "abort"));
		expect(frames.findIndex((item) => item.type === "clear_queue")).toBeLessThan(frames.findIndex((item) => item.type === "abort"));
		await waitForScreen(app, (screen) => screen.text.includes("prompt B") && !screen.text.includes("STEERING (1)"), { cols: COLS, rows: ROWS, timeoutMs: 5_000 });
	}, 30_000);
});
