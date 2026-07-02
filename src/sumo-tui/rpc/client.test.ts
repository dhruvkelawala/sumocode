import { describe, expect, it } from "vitest";
import { SumoRpcClient } from "./client.js";

function nodeRpcClient(script: string): SumoRpcClient {
	return new SumoRpcClient({
		command: process.execPath,
		args: ["-e", script],
		requestTimeoutMs: 2_000,
	});
}

describe("SumoRpcClient", () => {
	it("correlates JSONL responses by request id while streaming events", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const command = JSON.parse(line);
				if (command.type === "get_state") {
					process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
					setTimeout(() => {
						process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: {
							thinkingLevel: "high",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							sessionId: "session-a",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0
						} }) + "\\n");
					}, 20);
				}
				if (command.type === "get_commands") {
					process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_commands", success: true, data: { commands: [] } }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const events: string[] = [];
		client.onEvent((event) => events.push(event.type));
		try {
			await client.start();
			const statePromise = client.send({ type: "get_state" });
			const commandsPromise = client.send({ type: "get_commands" });
			const [state, commands] = await Promise.all([statePromise, commandsPromise]);
			expect(state.command).toBe("get_state");
			expect(commands.command).toBe("get_commands");
			expect(events).toEqual(["agent_start"]);
		} finally {
			await client.stop();
		}
	});

	it("auto-cancels blocking extension UI requests when no responder is installed", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			let pendingCommand;
			rl.on("line", (line) => {
				const parsed = JSON.parse(line);
				if (parsed.type === "get_state") {
					pendingCommand = parsed;
					process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["A"] }) + "\\n");
					return;
				}
				if (parsed.type === "extension_ui_response" && parsed.id === "ui-1" && parsed.cancelled === true) {
					process.stdout.write(JSON.stringify({ type: "response", id: pendingCommand.id, command: "get_state", success: true, data: {
						thinkingLevel: "minimal",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						sessionId: "session-b",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0
					} }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		try {
			await client.start();
			const response = await client.send({ type: "get_state" });
			expect(response.success).toBe(true);
			expect(response.command).toBe("get_state");
		} finally {
			await client.stop();
		}
	});

	it("stops the child process on shutdown", async () => {
		const client = nodeRpcClient("setInterval(() => undefined, 1000);");
		await client.start();
		const pid = client.pid;
		expect(pid).toBeTypeOf("number");
		await client.stop();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(() => process.kill(pid!, 0)).toThrow();
	});
});
