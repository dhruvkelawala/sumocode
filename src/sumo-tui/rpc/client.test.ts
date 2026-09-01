import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CHILD_JSON_FRAME_MAX_BYTES, TRUNCATED_HEAD_MARKER } from "../../child-protocol.js";
import { RpcChildExitError, SumoRpcClient, type SumoRpcClientOptions } from "./client.js";

function nodeRpcClient(script: string, options: Partial<Omit<SumoRpcClientOptions, "command" | "args">> = {}): SumoRpcClient {
	return new SumoRpcClient({
		command: process.execPath,
		args: ["-e", script],
		requestTimeoutMs: 2_000,
		...options,
	});
}

function asPreSpawnedChild(child: FakeRpcChild): ChildProcessWithoutNullStreams {
	// SAFETY: FakeRpcChild implements the stdin/stdout/stderr surface the
	// client consumes; remaining ChildProcess members are never exercised.
	return child as ChildProcessWithoutNullStreams & FakeRpcChild;
}

function clientChild(client: SumoRpcClient): ChildProcessWithoutNullStreams {
	const child = client.adoptedChild;
	// SAFETY: every call site awaits start() first, so the child exists.
	return child!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition was not met");
}

class FakeStream extends EventEmitter {
	public writable = true;
	public readonly setEncoding = vi.fn();
	public readonly end = vi.fn(() => { this.writable = false; });
	public readonly write = vi.fn((_data: string, callback?: (error?: Error) => void) => {
		callback?.();
		return true;
	});
}

class FakeRpcChild extends EventEmitter {
	public readonly pid = 1234;
	public exitCode: number | null = null;
	public signalCode: NodeJS.Signals | null = null;
	public readonly stdin = new FakeStream();
	public readonly stdout = new FakeStream();
	public readonly stderr = new FakeStream();
	public readonly kill = vi.fn(() => {
		queueMicrotask(() => {
			this.signalCode = "SIGTERM";
			this.emit("exit", null, "SIGTERM");
			this.emit("close", null, "SIGTERM");
		});
		return true;
	});
}

describe("SumoRpcClient", () => {
	it("start() resolves without a fixed sleep when the child process exists", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeRpcChild();
			// SAFETY: FakeRpcChild implements the stdin/stdout/stderr surface the
			// client consumes; the remaining ChildProcess members are unused.
			const client = new SumoRpcClient({
				command: "unused",
				args: [],
				preSpawnedChild: asPreSpawnedChild(child),
			});
			// Under fake timers the old fixed 50ms sleep would hang forever here;
			// the pid fast-path must resolve without any timer advancing.
			await client.start();
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a pre-spawned child without calling spawn again", async () => {
		const child = new FakeRpcChild();
		const spawnSpy = vi.fn(() => {
			throw new Error("spawn must not be called when a pre-spawned child is supplied");
		});
		// SAFETY: same FakeRpcChild surface contract as the pre-spawn test above.
		const client = new SumoRpcClient({
			command: "unused",
			args: [],
			preSpawnedChild: asPreSpawnedChild(child),
			spawnFn: spawnSpy,
		});

		await client.start();

		expect(spawnSpy).not.toHaveBeenCalled();
		expect(client.pid).toBe(child.pid);
		await client.stop();
	});

	it("does not resolve deliberate stop until child stdio closes", async () => {
		const child = new FakeRpcChild();
		child.kill.mockImplementation(() => {
			queueMicrotask(() => {
				child.signalCode = "SIGTERM";
				child.emit("exit", null, "SIGTERM");
			});
			return true;
		});
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		await client.start();

		let stopped = false;
		const stopping = client.stop().then(() => { stopped = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopped).toBe(false);
		child.emit("close", null, "SIGTERM");
		await stopping;
		expect(stopped).toBe(true);
	});

	it("delivers a buffered success response between deliberate exit and stdio close", async () => {
		const child = new FakeRpcChild();
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		await client.start();
		const response = client.send({ type: "get_state" });
		// SAFETY: the client writes single-line JSON requests over stdin.
		const request: { id: string } = JSON.parse(String(child.stdin.write.mock.calls.at(-1)?.[0]));
		child.kill.mockImplementation(() => {
			queueMicrotask(() => {
				child.signalCode = "SIGTERM";
				child.emit("exit", null, "SIGTERM");
				child.stdout.emit("data", `${JSON.stringify({
					type: "response",
					id: request.id,
					command: "get_state",
					success: true,
					data: { sessionId: "final-session" },
				})}\n`);
				child.emit("close", null, "SIGTERM");
			});
			return true;
		});

		const stopping = client.stop();
		await expect(response).resolves.toMatchObject({ success: true, data: { sessionId: "final-session" } });
		await stopping;
	});

	it("transfers ownership after lifecycle listeners attach but before startup grace resolves", async () => {
		const child = new FakeRpcChild();
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		const onAdopted = vi.fn(() => ({
			exitListeners: child.listenerCount("exit"),
			errorListeners: child.listenerCount("error"),
		}));

		let resolved = false;
		const started = client.start(onAdopted).then(() => { resolved = true; });
		expect(onAdopted).toHaveBeenCalledOnce();
		expect(onAdopted.mock.results[0]?.value).toEqual({ exitListeners: 1, errorListeners: 1 });
		expect(resolved).toBe(false);
		await started;
		await client.stop();
	});

	it("reports a pre-spawn error captured before host adoption", async () => {
		const child = new FakeRpcChild();
		// The Symbol.for channel is shared with client.ts; stamping mirrors what
		// the entry file does before handing the child over.
		Object.assign(child, { [Symbol.for("sumocode.rpc.preSpawnError")]: new Error("pi executable disappeared") });
		const client = new SumoRpcClient({
			command: "unused",
			args: [],
			preSpawnedChild: asPreSpawnedChild(child),
		});

		await expect(client.start()).rejects.toThrow("pi executable disappeared");
		expect(client.pid).toBeUndefined();
	});

	it("reports a pre-spawned child that exited before host adoption", async () => {
		const child = new FakeRpcChild();
		child.exitCode = 2;
		const client = new SumoRpcClient({
			command: "unused",
			args: [],
			preSpawnedChild: asPreSpawnedChild(child),
		});

		await expect(client.start()).rejects.toMatchObject({
			message: expect.stringContaining("before host adoption code=2"),
			code: 2,
		});
		expect(client.pid).toBeUndefined();
	});

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

	it("logs handler failures while cancelling the extension UI request", async () => {
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			let pendingState;
			rl.on("line", (line) => {
				const parsed = JSON.parse(line);
				if (parsed.type === "get_state") {
					pendingState = parsed;
					process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-throw", method: "select", title: "Pick", options: ["A"] }) + "\\n");
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
						sessionId: "session-throwing-ui-handler",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0
					} }) + "\\n");
				}
			});
		`;
		const client = nodeRpcClient(script);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		client.setUiRequestHandler(() => {
			throw new Error("handler boom");
		});
		try {
			await client.start();
			const state = await client.send({ type: "get_state" });
			expect(state.success).toBe(true);
			expect(events).toContainEqual({
				type: "ui_response_seen",
				response: { type: "extension_ui_response", id: "ui-throw", cancelled: true },
			});
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[sumocode-rpc] extension_ui handler failed for method "select": handler boom'));
		} finally {
			consoleError.mockRestore();
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

	it("reports a size-only malformed-frame summary with a safe parse reason", async () => {
		const protocolErrors: Array<{ summary: string; message: string }> = [];
		const script = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const command = JSON.parse(line);
				if (command.type !== "get_state") return;
				process.stdout.write("\\n");
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
			onProtocolError: (frameSummary, error) => protocolErrors.push({ summary: frameSummary, message: error.message }),
		});
		try {
			await client.start();
			const response = await client.send({ type: "get_state" });

			expect(response).toMatchObject({ command: "get_state", success: true });
			expect(protocolErrors).toHaveLength(1);
			expect(protocolErrors[0]?.summary).toBe("[invalid protocol frame: 21 bytes]");
			expect(protocolErrors[0]?.summary).not.toContain("stray extension noise");
			expect(protocolErrors[0]?.message).toBe("Invalid JSON protocol frame: Unexpected token in JSON");
			expect(protocolErrors[0]?.message).not.toContain("stray extension noise");
		} finally {
			await client.stop();
		}
	});

	it("bounds the JSON parse reason retained in protocol errors", async () => {
		const child = new FakeRpcChild();
		const errors: Error[] = [];
		const client = new SumoRpcClient({
			command: "unused",
			args: [],
			preSpawnedChild: asPreSpawnedChild(child),
			onProtocolError: (_frameSummary, error) => errors.push(error),
		});
		await client.start();
		const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw new SyntaxError(`synthetic reason ${"x".repeat(1_000)}`);
		});
		try {
			child.stdout.emit("data", "malformed\n");
		} finally {
			parse.mockRestore();
		}

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain(TRUNCATED_HEAD_MARKER);
		expect(Buffer.byteLength(errors[0]?.message ?? "", "utf8")).toBeLessThanOrEqual(
			Buffer.byteLength("Invalid JSON protocol frame: ", "utf8") + 500,
		);
		await client.stop();
	});

	it("never echoes malformed producer content in protocol diagnostics", async () => {
		const child = new FakeRpcChild();
		const protocolErrors: Array<{ summary: string; message: string }> = [];
		const client = new SumoRpcClient({
			command: "unused",
			args: [],
			preSpawnedChild: asPreSpawnedChild(child),
			onProtocolError: (frameSummary, error) => protocolErrors.push({ summary: frameSummary, message: error.message }),
		});
		await client.start();

		child.stdout.emit("data", "TOP_SECRET_payload_is_not_json\n");

		expect(protocolErrors).toEqual([{
			summary: "[invalid protocol frame: 30 bytes]",
			message: "Invalid JSON protocol frame: Unexpected token in JSON",
		}]);
		expect(JSON.stringify(protocolErrors)).not.toContain("TOP_SECRET");
		await client.stop();
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

		await expect(client.send({ type: "get_state" })).rejects.toThrow(
			"Failed to parse 3 consecutive RPC lines. [invalid protocol frame: 9 bytes]. Invalid JSON protocol frame: Unexpected token in JSON",
		);
		expect(killSpy).toHaveBeenCalledWith("SIGTERM");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
	});

	it("fails the producer on an oversized JSON frame without echoing or parsing it", async () => {
		const child = new FakeRpcChild();
		const exits: Error[] = [];
		const events: unknown[] = [];
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		client.onExit((error) => exits.push(error));
		client.onEvent((event) => events.push(event));
		await client.start();
		const response = client.send({ type: "get_state" });

		child.stdout.emit("data", Buffer.concat([
			Buffer.alloc(CHILD_JSON_FRAME_MAX_BYTES + 1, 0x78),
			Buffer.from("\n"),
		]));

		await expect(response).rejects.toThrow(`exceeded ${CHILD_JSON_FRAME_MAX_BYTES} bytes`);
		expect(events).toEqual([]);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.message).not.toContain("xxxx");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("drains a final response between unexpected exit and stdio close", async () => {
		const child = new FakeRpcChild();
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		await client.start();
		const response = client.send({ type: "get_state" });
		// SAFETY: the client writes one JSON command per line.
		const request = JSON.parse(String(child.stdin.write.mock.calls.at(-1)?.[0])) as { id: string };
		child.exitCode = 0;
		child.emit("exit", 0, null);
		child.stdout.emit("data", JSON.stringify({
			type: "response",
			id: request.id,
			command: "get_state",
			success: true,
			data: { sessionId: "final-partial" },
		}));
		child.emit("close", 0, null);

		await expect(response).resolves.toMatchObject({ success: true, data: { sessionId: "final-partial" } });
	});

	it("includes stderr drained between exit and close in the exit error", async () => {
		const child = new FakeRpcChild();
		const exits: Error[] = [];
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		client.onExit((error) => exits.push(error));
		await client.start();

		child.exitCode = 1;
		child.emit("exit", 1, null);
		child.stderr.emit("data", "final diagnostic");
		child.emit("close", 1, null);

		expect(exits).toHaveLength(1);
		expect(exits[0]).toMatchObject({ code: 1, signal: null });
		expect(exits[0]?.message).toContain("final diagnostic");
	});

	it("bounds an unexpected exit when stdio close never arrives", async () => {
		vi.useFakeTimers();
		const child = new FakeRpcChild();
		const exits: Error[] = [];
		const client = new SumoRpcClient({ command: "unused", args: [], preSpawnedChild: asPreSpawnedChild(child) });
		client.onExit((error) => exits.push(error));
		try {
			await client.start();
			child.exitCode = 1;
			child.emit("exit", 1, null);
			await vi.advanceTimersByTimeAsync(1_000);

			expect(exits).toHaveLength(1);
			expect(exits[0]).toBeInstanceOf(RpcChildExitError);
			expect(child.stdout.listenerCount("data")).toBe(0);
		} finally {
			child.emit("close", 1, null);
			vi.useRealTimers();
		}
	});

	it("keeps only the stderr tail up to 64 KiB", async () => {
		const client = nodeRpcClient(`
			process.stderr.write("a".repeat(1000));
			process.stderr.write("b".repeat(70000));
			setInterval(() => undefined, 1000);
		`);
		try {
			await client.start();
			// Wait for the whole asserted state, not just the byte count: stderr
			// arrives in chunks, and the trimmed buffer transiently reaches 64 KiB
			// before the truncation marker is prepended or the last `b` chunk lands.
			// A count-only predicate is satisfied by that intermediate state.
			await waitFor(() => (
				Buffer.byteLength(client.stderr) === 65536
				&& client.stderr.startsWith("[earlier output truncated]\n")
				&& client.stderr.endsWith("b")
			));

			expect(Buffer.byteLength(client.stderr)).toBe(65536);
			expect(client.stderr).toMatch(/^\[earlier output truncated\]\n/);
			expect(client.stderr).toMatch(/b+$/);
		} finally {
			await client.stop();
		}
	});

	it("surfaces an immediate post-spawn failure through onExit with its stderr", async () => {
		const client = nodeRpcClient("throw new Error('fast startup failure');");
		const errors: Error[] = [];
		client.onExit((error) => errors.push(error));
		await client.start().catch(() => undefined);
		await waitFor(() => errors.length > 0);

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("RPC child exited");
		expect(client.stderr).toContain("fast startup failure");
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

	it("exposes the child's exit code/signal structurally on the onExit error (not just in the message)", async () => {
		const client = nodeRpcClient("setTimeout(() => process.exit(1), 100);");
		const errors: Error[] = [];
		client.onEvent(() => undefined);
		client.onExit((error) => errors.push(error));
		await client.start();
		await waitFor(() => errors.length > 0);

		const error = errors[0];
		expect(error).toBeInstanceOf(RpcChildExitError);
		/* SAFETY: onExit errors are constructed as RpcChildExitError by the host exit path under test. */
		expect((error as RpcChildExitError).code).toBe(1);
		/* SAFETY: same RpcChildExitError contract as the assertion above. */
		expect((error as RpcChildExitError).signal).toBeNull();
	});

	it("surfaces exit code 100 (the /reload signal) structurally, distinguishable from a crash", async () => {
		// SUMOCODE_RELOAD_EXIT_CODE (src/commands/reload.ts): the RPC child
		// process.exit(100)s on a deliberate /reload. The host's onExit
		// handler must be able to tell this apart from an actual crash without
		// parsing error.message -- see createRpcExitHandler in host.ts.
		const client = nodeRpcClient("setTimeout(() => process.exit(100), 100);");
		const errors: Error[] = [];
		client.onEvent(() => undefined);
		client.onExit((error) => errors.push(error));
		await client.start();
		await waitFor(() => errors.length > 0);

		const error = errors[0];
		expect(error).toBeInstanceOf(RpcChildExitError);
		// SAFETY: same RpcChildExitError contract as the crash-shape test above.
		expect((error as RpcChildExitError).code).toBe(100);
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
