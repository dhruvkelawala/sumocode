import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SumoRpcClient, type SumoRpcClientOptions } from "./client.js";

function nodeRpcClient(script: string, options: Partial<Omit<SumoRpcClientOptions, "command" | "args">> = {}): SumoRpcClient {
	return new SumoRpcClient({
		command: process.execPath,
		args: ["-e", script],
		requestTimeoutMs: 2_000,
		...options,
	});
}

function clientChild(client: SumoRpcClient): ChildProcessWithoutNullStreams {
	return (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition was not met");
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

	it("writes custom extension UI responses without breaking command id correlation", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			let pendingState;
			rl.on("line", (line) => {
				const parsed = JSON.parse(line);
				if (parsed.type === "get_state") {
					pendingState = parsed;
					process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-custom", method: "select", title: "Pick", options: ["alpha", "beta"] }) + "\\n");
					return;
				}
				if (parsed.type === "get_commands") {
					process.stdout.write(JSON.stringify({ type: "response", id: parsed.id, command: "get_commands", success: true, data: { commands: [{ name: "doctor", source: "extension", sourceInfo: {} }] } }) + "\\n");
					return;
				}
				if (parsed.type === "extension_ui_response") {
					process.stdout.write(JSON.stringify({ type: "ui_response_seen", response: parsed }) + "\\n");
					process.stdout.write(JSON.stringify({ type: "response", id: pendingState.id, command: "get_state", success: true, data: {
						thinkingLevel: "high",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						sessionId: "session-custom-ui",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0
					} }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		client.setUiRequestHandler((request) => ({ type: "extension_ui_response", id: request.id, value: "beta" }));
		try {
			await client.start();
			const statePromise = client.send({ type: "get_state", id: "state-request" });
			const commandsPromise = client.send({ type: "get_commands", id: "commands-request" });
			const [commands, state] = await Promise.all([commandsPromise, statePromise]);
			expect(commands).toMatchObject({ id: "commands-request", command: "get_commands", success: true });
			expect(state).toMatchObject({ id: "state-request", command: "get_state", success: true });
			expect(events).toContainEqual({
				type: "ui_response_seen",
				response: { type: "extension_ui_response", id: "ui-custom", value: "beta" },
			});
		} finally {
			await client.stop();
		}
	});

	it("cancels an unknown extension UI method instead of wedging the child forever", async () => {
		// Simulates a handler (like RpcExtensionUiResponder) that has no case for a future/unknown
		// Pi extension_ui method and resolves void. The client must still answer with a cancelled
		// response so Pi's rpc-mode.js pendingExtensionRequests entry settles instead of hanging.
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			let pendingState;
			rl.on("line", (line) => {
				const parsed = JSON.parse(line);
				if (parsed.type === "get_state") {
					pendingState = parsed;
					process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-unknown", method: "future_method", title: "New" }) + "\\n");
					return;
				}
				if (parsed.type === "extension_ui_response") {
					process.stdout.write(JSON.stringify({ type: "ui_response_seen", response: parsed }) + "\\n");
					process.stdout.write(JSON.stringify({ type: "response", id: pendingState.id, command: "get_state", success: true, data: {
						thinkingLevel: "high",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						sessionId: "session-unknown-method",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0
					} }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		// Handler mimics RpcExtensionUiResponder.handle: known methods get responses, unknown
		// methods fall through the switch and resolve void.
		client.setUiRequestHandler((request) => {
			if (request.method === "select") return { type: "extension_ui_response", id: request.id, value: "n/a" };
			return undefined;
		});
		try {
			await client.start();
			const state = await client.send({ type: "get_state" });
			expect(state.success).toBe(true);
			expect(events).toContainEqual({
				type: "ui_response_seen",
				response: { type: "extension_ui_response", id: "ui-unknown", cancelled: true },
			});
		} finally {
			await client.stop();
		}
	});

	it("still sends a cancelled response for fire-and-forget methods the responder handles (harmless per rpc-mode.js)", async () => {
		// notify/setStatus/setWidget/setTitle/set_editor_text handlers deliberately resolve void.
		// Verified against rpc-mode.js: pendingExtensionRequests.get(id) is undefined for these
		// (their ids are never registered as pending), so the child's extension_ui_response branch
		// just no-ops (`if (pending) {...}` guards the resolve) and returns without logging or
		// crashing. Sending the unconditional cancel here is therefore safe.
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			let pendingState;
			rl.on("line", (line) => {
				const parsed = JSON.parse(line);
				if (parsed.type === "get_state") {
					pendingState = parsed;
					process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-notify", method: "notify", message: "hi", notifyType: "info" }) + "\\n");
					return;
				}
				if (parsed.type === "extension_ui_response") {
					process.stdout.write(JSON.stringify({ type: "ui_response_seen", response: parsed }) + "\\n");
					// Fire-and-forget ids are not pending in rpc-mode.js; it never awaits this
					// response to unblock get_state, so respond to get_state independently.
					process.stdout.write(JSON.stringify({ type: "response", id: pendingState.id, command: "get_state", success: true, data: {
						thinkingLevel: "high",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						sessionId: "session-fire-and-forget",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0
					} }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		const notify = vi.fn();
		client.setUiRequestHandler((request) => {
			if (request.method === "notify") {
				notify(request.message);
				return undefined;
			}
			return undefined;
		});
		try {
			await client.start();
			const state = await client.send({ type: "get_state" });
			expect(state.success).toBe(true);
			expect(notify).toHaveBeenCalledWith("hi");
			expect(events).toContainEqual({
				type: "ui_response_seen",
				response: { type: "extension_ui_response", id: "ui-notify", cancelled: true },
			});
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

	it("tolerates one malformed protocol line between valid responses", async () => {
		const protocolErrors: Array<{ line: string; message: string }> = [];
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const command = JSON.parse(line);
				if (command.type !== "get_state") return;
				process.stdout.write("stray extension noise\\n");
				process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: {
					thinkingLevel: "minimal",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					sessionId: "session-protocol-noise",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0
				} }) + "\\n");
			});
		`;
		const client = nodeRpcClient(script, {
			onProtocolError: (line, error) => protocolErrors.push({ line, message: error.message }),
		});
		try {
			await client.start();
			const response = await client.send({ type: "get_state" });

			expect(response).toMatchObject({ command: "get_state", success: true });
			expect(protocolErrors).toHaveLength(1);
			expect(protocolErrors[0]?.line).toBe("stray extension noise");
			expect(protocolErrors[0]?.message).toContain("Unexpected token");
		} finally {
			await client.stop();
		}
	});

	it("kills the child after three consecutive malformed protocol lines", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", () => {
				process.stdout.write("bad one\\n");
				process.stdout.write("bad two\\n");
				process.stdout.write("bad three\\n");
			});
			setInterval(() => undefined, 1000);
		`;
		const client = nodeRpcClient(script);
		await client.start();
		const child = clientChild(client);
		const killSpy = vi.spyOn(child, "kill");

		await expect(client.send({ type: "get_state" })).rejects.toThrow("Failed to parse 3 consecutive RPC lines");
		expect(killSpy).toHaveBeenCalledWith("SIGTERM");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
	});

	it("keeps only the stderr tail up to 64 KiB", async () => {
		const client = nodeRpcClient(`
			process.stderr.write("a".repeat(1000));
			process.stderr.write("b".repeat(70000));
			setInterval(() => undefined, 1000);
		`);
		try {
			await client.start();
			await waitFor(() => client.stderr.length === 65536);

			expect(client.stderr).toHaveLength(65536);
			expect(client.stderr).toBe("b".repeat(65536));
		} finally {
			await client.stop();
		}
	});

	it("fires onExit exactly once when the child crashes while idle", async () => {
		const client = nodeRpcClient("setTimeout(() => process.exit(1), 100);");
		const errors: Error[] = [];
		client.onEvent(() => undefined); // idle: no pending request to reject
		client.onExit((error) => errors.push(error));
		await client.start();
		await waitFor(() => errors.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("RPC child exited");
	});

	it("does not fire onExit for a deliberate stop()", async () => {
		const client = nodeRpcClient("setInterval(() => undefined, 1000);");
		const errors: Error[] = [];
		client.onExit((error) => errors.push(error));
		await client.start();
		await client.stop();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(errors).toHaveLength(0);
	});

	it("unsubscribes onExit listeners via the returned disposer", async () => {
		const client = nodeRpcClient("setTimeout(() => process.exit(1), 100);");
		const errors: Error[] = [];
		const unsubscribe = client.onExit((error) => errors.push(error));
		unsubscribe();
		await client.start();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(errors).toHaveLength(0);
	});

	it("does not throw when sendUiResponse is called after the child's stdin is destroyed", async () => {
		const client = nodeRpcClient("setInterval(() => undefined, 1000);");
		await client.start();
		const child = clientChild(client);
		child.stdin.destroy();
		await waitFor(() => !child.stdin.writable);

		expect(() => client.sendUiResponse({ type: "extension_ui_response", id: "x", cancelled: true })).not.toThrow();
		await client.stop();
	});

	it("attaches an error listener to child.stdin at start()", async () => {
		const client = nodeRpcClient("setInterval(() => undefined, 1000);");
		await client.start();
		const child = clientChild(client);

		expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
		await client.stop();
	});

	it("a throwing event listener does not prevent later listeners or later events", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const command = JSON.parse(line);
				if (command.type === "abort") {
					process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
					process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
					process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "abort", success: true }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const seenByFirst: string[] = [];
		const seenBySecond: string[] = [];
		client.onEvent((event) => {
			seenByFirst.push(event.type);
			throw new Error("listener boom");
		});
		client.onEvent((event) => seenBySecond.push(event.type));
		try {
			await client.start();
			await client.send({ type: "abort" });

			// Both events reached the second listener even though the first
			// listener threw on every single one -- a poisoned event never
			// stops the remaining listeners in its own dispatch, nor any event
			// that comes after it.
			expect(seenByFirst).toEqual(["agent_start", "agent_end"]);
			expect(seenBySecond).toEqual(["agent_start", "agent_end"]);
			expect(consoleError).toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
			await client.stop();
		}
	});
});
