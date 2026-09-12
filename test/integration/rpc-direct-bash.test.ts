import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

afterEach(async () => {
	for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
	for (const child of children.splice(0)) await child.terminate();
	for (const dir of fixtureDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function createContextProvider(): Promise<{ readonly extension: string; readonly evidence: string }> {
	const dir = await mkdtemp(`${tmpdir()}/sumocode-direct-bash-provider-`);
	fixtureDirs.push(dir);
	const extension = `${dir}/provider.mjs`;
	const evidence = `${dir}/context.json`;
	const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
	await writeFile(extension, `import { writeFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxProviderUrl)};
const evidence = ${JSON.stringify(evidence)};
const model = { id: "context", name: "Context", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
export default function install(pi) {
  const core = createFauxCore({ provider: "sumocode-direct-bash-test", api: "sumocode-direct-bash-api", models: [model] });
  core.setResponses([(context) => { writeFileSync(evidence, JSON.stringify(context)); return fauxAssistantMessage("done", { stopReason: "stop" }); }]);
  pi.registerProvider("sumocode-direct-bash-test", { name: "Direct bash test", baseUrl: "http://localhost:0", apiKey: "test", api: "sumocode-direct-bash-api", streamSimple: core.streamSimple, models: [model] });
}
`, "utf8");
	await chmod(extension, 0o755);
	return { extension, evidence };
}

function clientFor(command: string, args: readonly string[], env = buildSpawnEnv(process.env, undefined)): SumoRpcClient {
	const supervised = spawnSupervisedProcess(command, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
	children.push(supervised);
	// SAFETY: supervised process was spawned with all three stdio channels fixed to pipes.
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

describe("direct bash RPC fixture", () => {
	it("streams correlated output and cancels only through abort_bash", async () => {
		const fixture = await createRpcChildFixture("sumocode-direct-bash-", { directBashChunks: ["one", "two"], directBashDelayMs: 50 });
		fixtureDirs.push(dirname(fixture));
		const client = clientFor(fixture, []);
		const events: AgentSessionEvent[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();

		const request = client.sendWithWriteAck({ type: "bash", id: "fixture-bash", command: "sleep 60" }, null);
		await request.written;
		responseData(await client.send({ type: "abort_bash" }), "abort_bash");
		const result = responseData(await request.response, "bash");
		expect(result.cancelled).toBe(true);
		expect(events.filter((event) => event.type === "bash_execution_update").every((event) => event.id === "fixture-bash")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
	});
});

describe("installed Pi direct bash contract", () => {
	it("persists include/exclude semantics and never enters the LLM tool lifecycle", async () => {
		const provider = await createContextProvider();
		const client = clientFor(process.env.PI_BIN ?? "pi", [
			"--mode", "rpc", "--offline", "--no-session", "--extension", provider.extension,
			"--provider", "sumocode-direct-bash-test", "--model", "context",
		]);
		const events: AgentSessionEvent[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();

		for (const [id, excludeFromContext] of [["included", false], ["excluded", true]] as const) {
			const request = client.sendWithWriteAck({ type: "bash", id, command: `printf ${id}`, excludeFromContext }, null);
			await request.written;
			const result = responseData(await request.response, "bash");
			expect(result).toMatchObject({ output: id, exitCode: 0, cancelled: false, truncated: false });
		}

		// SAFETY: the real worker owns this additive message union; this test reads
		// only the three optional fields below to prove its bash persistence contract.
		const messages = responseData(await client.send({ type: "get_messages" }), "get_messages").messages as Array<{
			readonly role?: string;
			readonly command?: string;
			readonly excludeFromContext?: boolean;
		}>;
		const bashMessages = messages.filter((message) => message.role === "bashExecution");
		expect(bashMessages).toEqual(expect.arrayContaining([
			expect.objectContaining({ command: "printf included", excludeFromContext: false }),
			expect.objectContaining({ command: "printf excluded", excludeFromContext: true }),
		]));
		expect(events.filter((event) => event.type === "bash_execution_update").map((event) => event.id)).toEqual(expect.arrayContaining(["included", "excluded"]));
		expect(events.some((event) => event.type.startsWith("tool_execution_"))).toBe(false);

		responseData(await client.send({ type: "prompt", message: "inspect context" }), "prompt");
		const deadline = Date.now() + 10_000;
		while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const providerContext = await readFile(provider.evidence, "utf8");
		expect(providerContext).toContain("printf included");
		expect(providerContext).not.toContain("printf excluded");
	}, 30_000);
});
