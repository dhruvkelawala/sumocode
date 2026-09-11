import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SumoRpcClient } from "../../src/sumo-tui/rpc/client.js";
import { responseData } from "../../src/sumo-tui/rpc/response.js";
import { spawnSupervisedProcess, type SupervisedProcess } from "./harness-supervisor.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

/**
 * Additive wire frames from the 0.84.2+/0.84.3 audited deltas: cumulative
 * usage, tool-call identity, an unknown future field, and an unknown event.
 */
const ADDITIVE_EVENT_FRAMES = `
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
write({
  type: "message_update",
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", futureAdditiveField: { nested: true } },
});
write({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" } });
write({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
write({ type: "future_agent_event", additive: true });
`;

const ENRICHMENT_WORKER = `
${ADDITIVE_EVENT_FRAMES}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") write({ id: command.id, type: "response", command: "get_state", success: true, data: { thinkingLevel: "medium" } });
});
`;

const MALFORMED_WORKER = `
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") write({ id: command.id, type: "response", command: "get_state", success: "yes", data: {} });
  if (command.type === "clear_queue") write({ id: command.id, type: "response", command: "get_state", success: true, data: {} });
});
`;

const clients: SumoRpcClient[] = [];
const children: SupervisedProcess[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		try {
			await client.stop();
		} catch {
			// The supervisor already reaped the child; nothing else to release here.
		}
	}
	for (const child of children.splice(0)) await child.terminate();
});

function createClient(command: string, args: readonly string[], env: NodeJS.ProcessEnv): SumoRpcClient {
	const supervised = spawnSupervisedProcess(command, args, {
		cwd: process.cwd(),
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(supervised);
	// SAFETY: the stdio array above fixes all three channels to pipes, so Node
	// provides non-null streams.
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

async function waitForEvent(events: readonly AgentSessionEvent[], type: string, timeoutMs: number): Promise<AgentSessionEvent | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = events.find((event) => event.type === type);
		if (match !== undefined) return match;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return undefined;
}

describe("RPC client contract tolerance", () => {
	it("forwards additive and unknown event fields without protocol errors", async () => {
		const client = createClient(process.execPath, ["-e", ENRICHMENT_WORKER], buildSpawnEnv(process.env, undefined));
		const events: AgentSessionEvent[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();

		// The unknown frame is last; pipes preserve order, so its arrival proves
		// every earlier additive frame was already dispatched.
		const unknown = await waitForEvent(events, "future_agent_event", 10_000);
		expect(unknown).toBeDefined();
		const updates = events.filter((event) => event.type === "message_update");
		expect(updates).toHaveLength(3);
		expect(JSON.stringify(updates)).toContain("futureAdditiveField");
		expect(JSON.stringify(updates)).toContain('"toolName":"bash"');

		// Liveness: a protocol panic inside the listener loop would make this fail.
		const state = responseData(await client.send({ type: "get_state" }), "get_state");
		expect(state.thinkingLevel).toBe("medium");
	}, 20_000);

	it("rejects malformed known responses instead of casting them into domain state", async () => {
		const client = createClient(process.execPath, ["-e", MALFORMED_WORKER], buildSpawnEnv(process.env, undefined));
		await client.start();

		const malformedSuccess = await client.send({ type: "get_state" });
		expect(() => responseData(malformedSuccess, "get_state")).toThrow(/get_state failed/);

		const wrongCommand = await client.send({ type: "clear_queue" });
		expect(() => responseData(wrongCommand, "clear_queue")).toThrow(/unexpected response command get_state/);
	}, 20_000);
});
