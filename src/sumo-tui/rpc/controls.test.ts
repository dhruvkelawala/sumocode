import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { modelOptionsFrom, RpcHostControls, type RpcAvailableModel, type RpcCommandClient } from "./controls.js";
import { RpcHostStateStore } from "./state.js";

class FakeClient implements RpcCommandClient {
	public readonly commands: RpcCommand[] = [];
	public readonly timeouts: Array<number | undefined> = [];
	private readonly responses: RpcResponse[];

	public constructor(...responses: RpcResponse[]) {
		this.responses = [...responses];
	}

	public async send(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		this.commands.push(command);
		this.timeouts.push(timeoutMs);
		const response = this.responses.shift();
		if (!response) throw new Error(`No fake response queued for ${command.type}`);
		return response;
	}
}

function model(provider: string, id: string): RpcAvailableModel {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
	} as RpcAvailableModel;
}

function rpcState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		model: model("openai", "gpt-5"),
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "session-1",
		sessionName: "Migration",
		autoCompactionEnabled: true,
		messageCount: 3,
		pendingMessageCount: 1,
		...overrides,
	};
}

function stateResponse(overrides: Partial<RpcSessionState> = {}): RpcResponse {
	return { type: "response", command: "get_state", success: true, data: rpcState(overrides) };
}

describe("RpcHostControls", () => {
	it("hydrates the supplied state store when refreshing state", async () => {
		const store = new RpcHostStateStore();
		const client = new FakeClient(stateResponse({ sessionId: "session-refresh", sessionName: "RPC controls" }));
		const controls = new RpcHostControls(client, store);

		await expect(controls.refreshState("advisor/003-rpc-controls-facade")).resolves.toMatchObject({
			sessionId: "session-refresh",
			sessionName: "RPC controls",
			modelLabel: "openai/gpt-5",
			thinkingLevel: "medium",
			messageCount: 3,
			pendingMessageCount: 1,
			gitBranch: "advisor/003-rpc-controls-facade",
		});

		expect(store.getSnapshot()).toMatchObject({
			sessionId: "session-refresh",
			sessionName: "RPC controls",
			modelLabel: "openai/gpt-5",
		});
		expect(client.commands).toEqual([{ type: "get_state" }]);
	});

	it("returns deterministic model option labels with provider and id", async () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("anthropic", "claude-opus-4-8") }));
		const client = new FakeClient({
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8")] },
		});
		const controls = new RpcHostControls(client, store);

		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
		]);
		expect(modelOptionsFrom([model("google", "gemini-3")], model("google", "gemini-3"))).toEqual([
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: true },
		]);
		expect(client.commands).toEqual([{ type: "get_available_models" }]);
	});

	it("sets the model and refreshes state after success", async () => {
		const client = new FakeClient(
			{ type: "response", command: "set_model", success: true, data: model("anthropic", "claude-opus-4-8") },
			stateResponse({ model: model("anthropic", "claude-opus-4-8") }),
		);
		const controls = new RpcHostControls(client);

		await expect(controls.setModel("anthropic", "claude-opus-4-8")).resolves.toMatchObject({
			modelLabel: "anthropic/claude-opus-4-8",
		});
		expect(client.commands).toEqual([
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "get_state" },
		]);
	});

	it("cycles models for null and non-null Pi responses and refreshes state", async () => {
		const client = new FakeClient(
			{ type: "response", command: "cycle_model", success: true, data: null },
			stateResponse(),
			{
				type: "response",
				command: "cycle_model",
				success: true,
				data: { model: model("google", "gemini-3"), thinkingLevel: "high", isScoped: false },
			},
			stateResponse({ model: model("google", "gemini-3"), thinkingLevel: "high" }),
		);
		const controls = new RpcHostControls(client);

		await expect(controls.cycleModel()).resolves.toMatchObject({ modelLabel: "openai/gpt-5" });
		await expect(controls.cycleModel()).resolves.toMatchObject({ modelLabel: "google/gemini-3", thinkingLevel: "high" });
		expect(client.commands).toEqual([
			{ type: "cycle_model" },
			{ type: "get_state" },
			{ type: "cycle_model" },
			{ type: "get_state" },
		]);
	});

	it("sets and cycles thinking level before refreshing state", async () => {
		const client = new FakeClient(
			{ type: "response", command: "set_thinking_level", success: true },
			stateResponse({ thinkingLevel: "high" }),
			{ type: "response", command: "cycle_thinking_level", success: true, data: { level: "minimal" } },
			stateResponse({ thinkingLevel: "minimal" }),
		);
		const controls = new RpcHostControls(client);

		await expect(controls.setThinkingLevel("high")).resolves.toMatchObject({ thinkingLevel: "high" });
		await expect(controls.cycleThinkingLevel()).resolves.toMatchObject({ thinkingLevel: "minimal" });
		expect(client.commands).toEqual([
			{ type: "set_thinking_level", level: "high" },
			{ type: "get_state" },
			{ type: "cycle_thinking_level" },
			{ type: "get_state" },
		]);
	});

	it("sends exact session control payloads and decodes their responses", async () => {
		const client = new FakeClient(
			{ type: "response", command: "new_session", success: true, data: { cancelled: false } },
			{ type: "response", command: "new_session", success: true, data: { cancelled: true } },
			{ type: "response", command: "switch_session", success: true, data: { cancelled: false } },
			{ type: "response", command: "fork", success: true, data: { text: "fork from here", cancelled: false } },
			{ type: "response", command: "clone", success: true, data: { cancelled: false } },
			{ type: "response", command: "get_fork_messages", success: true, data: { messages: [{ entryId: "entry-1", text: "hello" }] } },
			{ type: "response", command: "get_last_assistant_text", success: true, data: { text: "last answer" } },
			{ type: "response", command: "set_session_name", success: true },
		);
		const controls = new RpcHostControls(client);

		await expect(controls.newSession()).resolves.toEqual({ cancelled: false });
		await expect(controls.newSession("parent-session.jsonl")).resolves.toEqual({ cancelled: true });
		await expect(controls.switchSession("next-session.jsonl")).resolves.toEqual({ cancelled: false });
		await expect(controls.fork("entry-1")).resolves.toEqual({ text: "fork from here", cancelled: false });
		await expect(controls.clone()).resolves.toEqual({ cancelled: false });
		await expect(controls.getForkMessages()).resolves.toEqual([{ entryId: "entry-1", text: "hello" }]);
		await expect(controls.getLastAssistantText()).resolves.toBe("last answer");
		await expect(controls.setSessionName("renamed")).resolves.toBeUndefined();
		expect(client.commands).toEqual([
			{ type: "new_session" },
			{ type: "new_session", parentSession: "parent-session.jsonl" },
			{ type: "switch_session", sessionPath: "next-session.jsonl" },
			{ type: "fork", entryId: "entry-1" },
			{ type: "clone" },
			{ type: "get_fork_messages" },
			{ type: "get_last_assistant_text" },
			{ type: "set_session_name", name: "renamed" },
		]);
	});

	it("sends exact compaction, retry, and command-discovery payloads", async () => {
		const client = new FakeClient(
			{ type: "response", command: "compact", success: true, data: { summary: "done" } as never },
			{ type: "response", command: "set_auto_compaction", success: true },
			{ type: "response", command: "set_auto_retry", success: true },
			{ type: "response", command: "get_commands", success: true, data: { commands: [{ name: "doctor", source: "extension", sourceInfo: {} as never }] } },
		);
		const controls = new RpcHostControls(client);

		await expect(controls.compact("keep decisions")).resolves.toEqual({ summary: "done" });
		await expect(controls.setAutoCompaction(false)).resolves.toBeUndefined();
		await expect(controls.setAutoRetry(true)).resolves.toBeUndefined();
		await expect(controls.getCommands()).resolves.toEqual([{ name: "doctor", source: "extension", sourceInfo: {} }]);
		expect(client.commands).toEqual([
			{ type: "compact", customInstructions: "keep decisions" },
			{ type: "set_auto_compaction", enabled: false },
			{ type: "set_auto_retry", enabled: true },
			{ type: "get_commands" },
		]);
	});

	it("sends the abort control payload", async () => {
		const client = new FakeClient({ type: "response", command: "abort", success: true });
		const controls = new RpcHostControls(client);

		await expect(controls.abort()).resolves.toBeUndefined();
		expect(client.commands).toEqual([{ type: "abort" }]);
	});

	it("throws Pi error responses with the failed command and server text", async () => {
		const client = new FakeClient({
			type: "response",
			command: "set_model",
			success: false,
			error: "Model not found: missing/nope",
		});
		const controls = new RpcHostControls(client);

		await expect(controls.setModel("missing", "nope")).rejects.toThrow("set_model failed: Model not found: missing/nope");
		expect(client.commands).toEqual([{ type: "set_model", provider: "missing", modelId: "nope" }]);
	});

	it("passes a generous explicit timeout for compact instead of the client's 30s default", async () => {
		const client = new FakeClient({ type: "response", command: "compact", success: true, data: { summary: "done" } as never });
		const controls = new RpcHostControls(client);

		await controls.compact();

		expect(client.timeouts).toEqual([300_000]);
	});

	it("passes explicit long timeouts for fork, switch_session, and new_session", async () => {
		const client = new FakeClient(
			{ type: "response", command: "new_session", success: true, data: { cancelled: false } },
			{ type: "response", command: "switch_session", success: true, data: { cancelled: false } },
			{ type: "response", command: "fork", success: true, data: { text: "x", cancelled: false } },
		);
		const controls = new RpcHostControls(client);

		await controls.newSession();
		await controls.switchSession("session.jsonl");
		await controls.fork("entry-1");

		expect(client.timeouts).toEqual([60_000, 60_000, 60_000]);
	});

	it("leaves quick getters and setters on the client's default timeout", async () => {
		const client = new FakeClient(
			{ type: "response", command: "get_state", success: true, data: {} as never },
			{ type: "response", command: "abort", success: true },
		);
		const controls = new RpcHostControls(client);

		await controls.refreshState();
		await controls.abort();

		expect(client.timeouts).toEqual([undefined, undefined]);
	});
});
