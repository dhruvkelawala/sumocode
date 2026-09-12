import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SumoRpcClient } from "../../src/sumo-tui/rpc/client.js";
import { responseData } from "../../src/sumo-tui/rpc/response.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSupervisedProcess, type SupervisedProcess } from "./harness-supervisor.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

const clients: SumoRpcClient[] = [];
const children: SupervisedProcess[] = [];
const fixtureDirs: string[] = [];
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };

afterEach(async () => {
	for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
	for (const child of children.splice(0)) await child.terminate();
	for (const dir of fixtureDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function clientFor(command: string, args: readonly string[], env: NodeJS.ProcessEnv): SumoRpcClient {
	const supervised = spawnSupervisedProcess(command, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
	children.push(supervised);
	// SAFETY: the supervisor was spawned with all three stdio channels fixed to pipes.
	const child = supervised.child as ChildProcessWithoutNullStreams;
	const client = new SumoRpcClient({
		command,
		args: [],
		preSpawnedChild: child,
		requestTimeoutMs: 10_000,
	});
	clients.push(client);
	return client;
}

function waitForSettled(events: readonly AgentSessionEvent[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 10_000;
		const poll = () => {
			if (events.some((event) => event.type === "agent_settled")) resolve();
			else if (Date.now() >= deadline) reject(new Error("agent did not settle"));
			else setTimeout(poll, 25);
		};
		poll();
	});
}

interface FixturePromptLog {
	readonly type?: string;
	readonly message?: string;
	readonly images?: readonly {
		readonly type?: string;
		readonly mimeType?: string;
		readonly byteCount?: number;
		readonly sha256?: string;
	}[];
}

describe("native RPC images", () => {
	it("captures exact fixture image metadata without retaining base64", async () => {
		const fixture = await createRpcChildFixture("sumocode-native-image-");
		const dir = dirname(fixture);
		fixtureDirs.push(dir);
		const logPath = join(dir, "commands.jsonl");
		const client = clientFor(fixture, [], buildSpawnEnv(process.env, { SUMOCODE_RPC_FIXTURE_LOG: logPath }));
		await client.start();

		responseData(await client.send({ type: "prompt", message: "inspect [Image 1]", images: [image] }), "prompt");
		const log = await readFile(logPath, "utf8");
		// SAFETY: the owned fixture writes one JSON object per line; this test reads only its declared prompt fields.
		const frames = log.trim().split("\n").map((line) => JSON.parse(line) as FixturePromptLog);
		const prompt = frames.find((frame) => frame.type === "prompt");
		expect(prompt).toMatchObject({
			message: "inspect [Image 1]",
			images: [{ type: "image", mimeType: "image/png", byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
		});
		expect(log).not.toContain(image.data);
	});

	it.each([["text and image", "inspect [Image 1]"], ["image only", ""]] as const)("Pi 0.85.1 accepts %s prompts", async (_case, message) => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-native-image-provider-"));
		fixtureDirs.push(dir);
		const extension = join(dir, "provider.mjs");
		const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
		await writeFile(extension, `import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxProviderUrl)};
const model = { id: "images", name: "Images", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
export default function install(pi) {
  const core = createFauxCore({ provider: "sumocode-native-image-test", api: "sumocode-native-image-api", models: [model] });
  core.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
  pi.registerProvider("sumocode-native-image-test", { name: "Native image test", baseUrl: "http://localhost:0", apiKey: "test", api: "sumocode-native-image-api", streamSimple: core.streamSimple, models: [model] });
}
`, "utf8");
		await chmod(extension, 0o755);
		const client = clientFor(process.env.PI_BIN ?? "pi", [
			"--mode", "rpc", "--offline", "--no-session", "--extension", extension,
			"--provider", "sumocode-native-image-test", "--model", "images",
		], buildSpawnEnv(process.env, undefined));
		const events: AgentSessionEvent[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();

		responseData(await client.send({ type: "prompt", message, images: [image] }), "prompt");
		await waitForSettled(events);
		// SAFETY: Pi owns this additive message union; the test reads only role and content.
		const messages = responseData(await client.send({ type: "get_messages" }), "get_messages").messages as Array<{ role?: string; content?: unknown }>;
		const user = messages.find((entry) => entry.role === "user");
		expect(user?.content).toEqual(expect.arrayContaining([image]));
	}, 30_000);
});
