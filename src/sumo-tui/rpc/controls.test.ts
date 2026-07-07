import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelOptionsFrom, RpcHostControls, type RpcAvailableModel, type RpcCommandClient } from "./controls.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";

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

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class DeferredFakeClient implements RpcCommandClient {
	public readonly commands: RpcCommand[] = [];
	public readonly timeouts: Array<number | undefined> = [];
	private readonly responses: Array<Deferred<RpcResponse>>;

	public constructor(...responses: Array<Deferred<RpcResponse>>) {
		this.responses = [...responses];
	}

	public send(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		this.commands.push(command);
		this.timeouts.push(timeoutMs);
		const response = this.responses.shift();
		if (!response) return Promise.reject(new Error(`No fake response queued for ${command.type}`));
		return response.promise;
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

function writeAgentSettings(content: Record<string, unknown>): { dir: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-controls-enabled-models-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(content));
	return { dir, env: { PI_CODING_AGENT_DIR: dir } };
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

	it("returns enabled models in settings order while preserving the active model and reusing the available-model cache", async () => {
		const settings = writeAgentSettings({ enabledModels: ["google/gemini-3", "openai/gpt-5"] });
		try {
			const store = new RpcHostStateStore();
			store.hydrateFromRpcState(rpcState({ model: model("google", "gemini-3") }));
			const client = new FakeClient({
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8"), model("google", "gemini-3")] },
			});
			const controls = new RpcHostControls(client, store);

			await expect(controls.getEnabledModels(settings.env)).resolves.toEqual([
				{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: true },
				{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			]);
			await expect(controls.getEnabledModels(settings.env)).resolves.toEqual([
				{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: true },
				{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			]);
			expect(client.commands).toEqual([{ type: "get_available_models" }]);
		} finally {
			rmSync(settings.dir, { recursive: true, force: true });
		}
	});

	it("falls back to the full available list when settings has no enabled models", async () => {
		const settings = writeAgentSettings({ enabledModels: [] });
		try {
			const store = new RpcHostStateStore();
			store.hydrateFromRpcState(rpcState({ model: model("anthropic", "claude-opus-4-8") }));
			const client = new FakeClient({
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8")] },
			});
			const controls = new RpcHostControls(client, store);

			await expect(controls.getEnabledModels(settings.env)).resolves.toEqual([
				{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
				{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			]);
			expect(client.commands).toEqual([{ type: "get_available_models" }]);
		} finally {
			rmSync(settings.dir, { recursive: true, force: true });
		}
	});

	it("caches available models until refreshState invalidates the cache", async () => {
		const client = new FakeClient(
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8")] },
			},
			stateResponse({ model: model("anthropic", "claude-opus-4-8") }),
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("anthropic", "claude-opus-4-8"), model("google", "gemini-3")] },
			},
		);
		const controls = new RpcHostControls(client);

		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: false },
		]);
		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: false },
		]);
		await expect(controls.refreshState()).resolves.toMatchObject({ modelLabel: "anthropic/claude-opus-4-8" });
		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
		]);
		expect(client.commands).toEqual([
			{ type: "get_available_models" },
			{ type: "get_state" },
			{ type: "get_available_models" },
		]);
	});

	it("sets the model by patching state locally from the response, with no follow-up get_state round-trip", async () => {
		const client = new FakeClient(
			{ type: "response", command: "set_model", success: true, data: model("anthropic", "claude-opus-4-8") },
		);
		const controls = new RpcHostControls(client);

		await expect(controls.setModel("anthropic", "claude-opus-4-8")).resolves.toMatchObject({
			modelLabel: "anthropic/claude-opus-4-8",
		});
		expect(client.commands).toEqual([{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" }]);
	});

	it("optimistically patches setModel before the RPC response, then reconciles from the response payload", async () => {
		const setModelResponse = deferred<RpcResponse>();
		const client = new DeferredFakeClient(setModelResponse);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("openai", "gpt-5") }));
		const optimisticStates: RpcHostChromeState[] = [];
		const controls = new RpcHostControls(client, store, {
			onOptimisticChange: (state) => optimisticStates.push(state),
		});

		const result = controls.setModel("anthropic", "claude-opus-4-8");

		expect(client.commands).toEqual([{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" }]);
		expect(store.getSnapshot()).toMatchObject({ modelLabel: "anthropic/claude-opus-4-8" });
		expect(optimisticStates[0]).toMatchObject({ modelLabel: "anthropic/claude-opus-4-8" });

		setModelResponse.resolve({
			type: "response",
			command: "set_model",
			success: true,
			data: model("google", "gemini-3"),
		});

		await expect(result).resolves.toMatchObject({ modelLabel: "google/gemini-3" });
		expect(store.getSnapshot()).toMatchObject({ modelLabel: "google/gemini-3" });
	});

	it("invalidates cached models when setModel reconciles to a model missing from the cached list", async () => {
		const client = new FakeClient(
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8")] },
			},
			{ type: "response", command: "set_model", success: true, data: model("google", "gemini-3") },
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8"), model("google", "gemini-3")] },
			},
		);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("openai", "gpt-5") }));
		const controls = new RpcHostControls(client, store);

		await controls.getAvailableModels();
		await expect(controls.setModel("anthropic", "claude-opus-4-8")).resolves.toMatchObject({ modelLabel: "google/gemini-3" });
		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: false },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: true },
		]);
		expect(client.commands).toEqual([
			{ type: "get_available_models" },
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "get_available_models" },
		]);
	});

	it("refreshes state and propagates the original error when setModel fails after the optimistic patch", async () => {
		const setModelResponse = deferred<RpcResponse>();
		const refreshResponse = deferred<RpcResponse>();
		const client = new DeferredFakeClient(setModelResponse, refreshResponse);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("openai", "gpt-5") }));
		const controls = new RpcHostControls(client, store);
		const originalError = new Error("set_model failed");

		const result = controls.setModel("anthropic", "claude-opus-4-8");

		expect(client.commands).toEqual([{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" }]);
		expect(store.getSnapshot()).toMatchObject({ modelLabel: "anthropic/claude-opus-4-8" });

		setModelResponse.reject(originalError);
		await Promise.resolve();

		expect(client.commands).toEqual([
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "get_state" },
		]);

		refreshResponse.resolve(stateResponse({ model: model("openai", "gpt-5") }));

		await expect(result).rejects.toBe(originalError);
		expect(store.getSnapshot()).toMatchObject({ modelLabel: "openai/gpt-5" });
	});

	it("pushes the rolled-back state through onOptimisticChange when setModel fails", async () => {
		const setModelResponse = deferred<RpcResponse>();
		const refreshResponse = deferred<RpcResponse>();
		const client = new DeferredFakeClient(setModelResponse, refreshResponse);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("openai", "gpt-5") }));
		const optimisticStates: RpcHostChromeState[] = [];
		const controls = new RpcHostControls(client, store, {
			onOptimisticChange: (state) => optimisticStates.push(state),
		});
		const originalError = new Error("set_model failed");

		const result = controls.setModel("anthropic", "claude-opus-4-8");

		expect(optimisticStates).toHaveLength(1);
		expect(optimisticStates[0]).toMatchObject({ modelLabel: "anthropic/claude-opus-4-8" });

		setModelResponse.reject(originalError);
		await Promise.resolve();

		expect(client.commands).toEqual([
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
			{ type: "get_state" },
		]);

		refreshResponse.resolve(stateResponse({ model: model("openai", "gpt-5") }));

		await expect(result).rejects.toBe(originalError);
		expect(optimisticStates).toHaveLength(2);
		expect(optimisticStates[1]).toMatchObject({ modelLabel: "openai/gpt-5" });
		expect(store.getSnapshot()).toMatchObject({ modelLabel: "openai/gpt-5" });
	});

	it("cycles models for null and non-null Pi responses by patching state locally, with no follow-up get_state round-trip", async () => {
		const client = new FakeClient(
			{ type: "response", command: "cycle_model", success: true, data: null },
			{
				type: "response",
				command: "cycle_model",
				success: true,
				data: { model: model("google", "gemini-3"), thinkingLevel: "high", isScoped: false },
			},
		);
		const controls = new RpcHostControls(client);

		// null (nothing to cycle to) leaves the store's existing snapshot untouched -- no RPC round-trip at all beyond cycle_model itself.
		await expect(controls.cycleModel()).resolves.not.toHaveProperty("modelLabel");
		await expect(controls.cycleModel()).resolves.toMatchObject({ modelLabel: "google/gemini-3", thinkingLevel: "high" });
		expect(client.commands).toEqual([{ type: "cycle_model" }, { type: "cycle_model" }]);
	});

	it("invalidates cached models when cycleModel returns a model missing from the cached list", async () => {
		const client = new FakeClient(
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8")] },
			},
			{
				type: "response",
				command: "cycle_model",
				success: true,
				data: { model: model("google", "gemini-3"), thinkingLevel: "high", isScoped: false },
			},
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model("openai", "gpt-5"), model("anthropic", "claude-opus-4-8"), model("google", "gemini-3")] },
			},
		);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ model: model("openai", "gpt-5") }));
		const controls = new RpcHostControls(client, store);

		await controls.getAvailableModels();
		await expect(controls.cycleModel()).resolves.toMatchObject({ modelLabel: "google/gemini-3", thinkingLevel: "high" });
		await expect(controls.getAvailableModels()).resolves.toEqual([
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: false },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: true },
		]);
		expect(client.commands).toEqual([
			{ type: "get_available_models" },
			{ type: "cycle_model" },
			{ type: "get_available_models" },
		]);
	});

	it("sets and cycles thinking level by patching state locally, with no follow-up get_state round-trip", async () => {
		const client = new FakeClient(
			{ type: "response", command: "set_thinking_level", success: true },
			{ type: "response", command: "cycle_thinking_level", success: true, data: { level: "minimal" } },
		);
		const controls = new RpcHostControls(client);

		await expect(controls.setThinkingLevel("high")).resolves.toMatchObject({ thinkingLevel: "high" });
		await expect(controls.cycleThinkingLevel()).resolves.toMatchObject({ thinkingLevel: "minimal" });
		expect(client.commands).toEqual([
			{ type: "set_thinking_level", level: "high" },
			{ type: "cycle_thinking_level" },
		]);
	});

	it("optimistically patches setThinkingLevel before the RPC response", async () => {
		const setThinkingLevelResponse = deferred<RpcResponse>();
		const client = new DeferredFakeClient(setThinkingLevelResponse);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ thinkingLevel: "medium" }));
		const optimisticStates: RpcHostChromeState[] = [];
		const controls = new RpcHostControls(client, store, {
			onOptimisticChange: (state) => optimisticStates.push(state),
		});

		const result = controls.setThinkingLevel("high");

		expect(client.commands).toEqual([{ type: "set_thinking_level", level: "high" }]);
		expect(store.getSnapshot()).toMatchObject({ thinkingLevel: "high" });
		expect(optimisticStates[0]).toMatchObject({ thinkingLevel: "high" });

		setThinkingLevelResponse.resolve({ type: "response", command: "set_thinking_level", success: true });

		await expect(result).resolves.toMatchObject({ thinkingLevel: "high" });
	});

	it("pushes the rolled-back state through onOptimisticChange when setThinkingLevel fails", async () => {
		const setThinkingLevelResponse = deferred<RpcResponse>();
		const refreshResponse = deferred<RpcResponse>();
		const client = new DeferredFakeClient(setThinkingLevelResponse, refreshResponse);
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ thinkingLevel: "medium" }));
		const optimisticStates: RpcHostChromeState[] = [];
		const controls = new RpcHostControls(client, store, {
			onOptimisticChange: (state) => optimisticStates.push(state),
		});
		const originalError = new Error("set_thinking_level failed");

		const result = controls.setThinkingLevel("high");

		expect(optimisticStates).toHaveLength(1);
		expect(optimisticStates[0]).toMatchObject({ thinkingLevel: "high" });

		setThinkingLevelResponse.reject(originalError);
		await Promise.resolve();

		expect(client.commands).toEqual([
			{ type: "set_thinking_level", level: "high" },
			{ type: "get_state" },
		]);

		refreshResponse.resolve(stateResponse({ thinkingLevel: "medium" }));

		await expect(result).rejects.toBe(originalError);
		expect(optimisticStates).toHaveLength(2);
		expect(optimisticStates[1]).toMatchObject({ thinkingLevel: "medium" });
		expect(store.getSnapshot()).toMatchObject({ thinkingLevel: "medium" });
	});

	it("cycle_thinking_level's null response (nothing to cycle to) leaves state untouched with no follow-up round-trip", async () => {
		const client = new FakeClient({ type: "response", command: "cycle_thinking_level", success: true, data: null });
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ thinkingLevel: "medium" }));
		const controls = new RpcHostControls(client, store);

		await expect(controls.cycleThinkingLevel()).resolves.toMatchObject({ thinkingLevel: "medium" });
		expect(client.commands).toEqual([{ type: "cycle_thinking_level" }]);
	});

	it("sets session name by patching state locally, with no follow-up get_state round-trip", async () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(rpcState({ sessionId: "session-rename", sessionName: "Migration" }));
		const client = new FakeClient({ type: "response", command: "set_session_name", success: true });
		const controls = new RpcHostControls(client, store);

		await expect(controls.setSessionName("Plan 041")).resolves.toMatchObject({
			sessionId: "session-rename",
			sessionName: "Plan 041",
			modelLabel: "openai/gpt-5",
		});
		expect(store.getSnapshot()).toMatchObject({ sessionId: "session-rename", sessionName: "Plan 041" });
		expect(client.commands).toEqual([{ type: "set_session_name", name: "Plan 041" }]);
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
		await expect(controls.setSessionName("renamed")).resolves.toMatchObject({ sessionName: "renamed" });
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

	it("sends exact export_html payloads and decodes the returned path", async () => {
		const client = new FakeClient(
			{ type: "response", command: "export_html", success: true, data: { path: "/tmp/session.html" } },
			{ type: "response", command: "export_html", success: true, data: { path: "/tmp/custom.html" } },
		);
		const controls = new RpcHostControls(client);

		await expect(controls.exportHtml()).resolves.toEqual({ path: "/tmp/session.html" });
		await expect(controls.exportHtml("/tmp/custom.html")).resolves.toEqual({ path: "/tmp/custom.html" });
		expect(client.commands).toEqual([
			{ type: "export_html" },
			{ type: "export_html", outputPath: "/tmp/custom.html" },
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
		const client = new FakeClient(
			{
				type: "response",
				command: "set_model",
				success: false,
				error: "Model not found: missing/nope",
			},
			stateResponse(),
		);
		const controls = new RpcHostControls(client);

		await expect(controls.setModel("missing", "nope")).rejects.toThrow("set_model failed: Model not found: missing/nope");
		expect(client.commands).toEqual([{ type: "set_model", provider: "missing", modelId: "nope" }, { type: "get_state" }]);
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
