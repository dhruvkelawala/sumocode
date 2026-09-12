import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { RpcRequestHandle } from "./client.js";
import type { DirectBashResult } from "./direct-bash.js";
import { encodeRpcTreeNavigationPayload, type RpcTreeNavigationOutcome, type RpcTreeNavigationOutcomeBroker, type RpcTreeNavigationRequest } from "../pi-compat/tree-navigation-command.js";
import { responseData, type RpcResponseData } from "./response.js";
import { filterToEnabled, readEnabledModelPatterns } from "../../config/enabled-models.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";
import { isRpcThinkingLevel, type RpcThinkingLevel } from "./thinking-level.js";

export interface RpcCommandClient {
	send(command: RpcCommand, timeoutMs?: number | null): Promise<RpcResponse>;
	sendWithWriteAck?(command: RpcCommand, timeoutMs?: number | null): RpcRequestHandle;
}

export interface RpcHostControlsOptions {
	readonly onOptimisticChange?: (state: RpcHostChromeState) => void;
	readonly treeNavigationOutcomeBroker?: RpcTreeNavigationOutcomeBroker;
}

export type RpcAvailableModel = RpcResponseData<"get_available_models">["models"][number];
export type { RpcThinkingLevel } from "./thinking-level.js";
export type RpcAvailableThinkingLevels = RpcResponseData<"get_available_thinking_levels">["levels"];
export type RpcSlashCommand = RpcResponseData<"get_commands">["commands"][number];
export type RpcForkMessage = RpcResponseData<"get_fork_messages">["messages"][number];
export type RpcEntriesResponse = RpcResponseData<"get_entries">;
export type RpcSessionStats = RpcResponseData<"get_session_stats">;
export interface RpcClearedQueue {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

export interface RpcBashRequest {
	readonly id: string;
	readonly written: Promise<void>;
	readonly result: Promise<DirectBashResult>;
}

export interface RpcModelOption {
	readonly provider: string;
	readonly id: string;
	readonly label: string;
	readonly active: boolean;
}

type ModelIdentity = Pick<RpcAvailableModel, "provider" | "id">;

// SumoRpcClient#send defaults to a 30s timeout, which is fine for quick
// getters/setters but too short for commands that do real work on Pi's side:
// compact in particular waits for an LLM-driven summarization pass that can
// legitimately run well past 30s on a large session, and the client was
// timing the request out while Pi kept working -- the reply for a real
// compaction just never arrived within the default window. fork,
// switch_session, and new_session all touch disk/session state (loading or
// forking a whole session transcript) and can be slow for the same reason,
// so give them a longer, explicit budget too. Quick getters (get_state,
// get_commands, etc.) are intentionally left on the client's default.
const COMPACT_TIMEOUT_MS = 300_000;
// Pi device-code providers can allow up to 15 minutes for authentication;
// keep a 20-minute host budget so valid flows have cleanup headroom.
const LOGIN_TIMEOUT_MS = 1_200_000;
export const TREE_NAVIGATION_TIMEOUT_MS = 1_200_000;
const SESSION_COMMAND_TIMEOUT_MS = 60_000;

function validateBashResult(result: DirectBashResult): DirectBashResult {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untrusted RPC data at the control boundary.
	if (!result || typeof result.output !== "string" || typeof result.cancelled !== "boolean" || typeof result.truncated !== "boolean") {
		throw new Error("bash failed: invalid result");
	}
	if (result.exitCode !== undefined && (!Number.isInteger(result.exitCode))) throw new Error("bash failed: invalid result.exitCode");
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untrusted RPC data at the control boundary.
	if (result.fullOutputPath !== undefined && typeof result.fullOutputPath !== "string") throw new Error("bash failed: invalid result.fullOutputPath");
	return result;
}

function modelLabel(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

function isModelIdentityString(model: ModelIdentity | string): model is string {
	return typeof model === "string";
}

function currentModelLabel(currentModel?: ModelIdentity | string): string | undefined {
	if (currentModel === undefined) return undefined;
	return isModelIdentityString(currentModel) ? currentModel : modelLabel(currentModel);
}

export function modelOptionsFrom(models: readonly RpcAvailableModel[], currentModel?: ModelIdentity | string): RpcModelOption[] {
	const activeLabel = currentModelLabel(currentModel);
	return models.map((model) => {
		const label = modelLabel(model);
		return {
			provider: model.provider,
			id: model.id,
			label,
			active: label === activeLabel,
		};
	});
}

export class RpcHostControls {
	private availableModelsCache: readonly RpcAvailableModel[] | undefined;

	public constructor(
		private readonly client: RpcCommandClient,
		private readonly stateStore: RpcHostStateStore = new RpcHostStateStore(),
		private readonly options: RpcHostControlsOptions = {},
	) {}

	public async refreshState(gitBranch?: string): Promise<RpcHostChromeState> {
		this.availableModelsCache = undefined;
		const state = responseData(await this.client.send({ type: "get_state" }), "get_state");
		return this.stateStore.hydrateFromRpcState(state, gitBranch);
	}

	public async getAvailableModels(): Promise<RpcModelOption[]> {
		if (!this.availableModelsCache) {
			const data = responseData(await this.client.send({ type: "get_available_models" }), "get_available_models");
			this.availableModelsCache = data.models;
		}
		return modelOptionsFrom(this.availableModelsCache, this.stateStore.getSnapshot().modelLabel);
	}

	public async getEnabledModels(env: NodeJS.ProcessEnv = process.env): Promise<RpcModelOption[]> {
		return filterToEnabled(await this.getAvailableModels(), readEnabledModelPatterns(env));
	}

	private invalidateAvailableModelsIfMissing(model: ModelIdentity): void {
		const models = this.availableModelsCache;
		if (!models) return;
		if (!models.some((cached) => cached.provider === model.provider && cached.id === model.id)) {
			this.availableModelsCache = undefined;
		}
	}

	// set_model/cycle_model/cycle_thinking_level return their effective values.
	// set_thinking_level is the exception: its void success can hide clamping, so
	// that path must read back get_state before publishing authority.

	public async setModel(provider: string, modelId: string): Promise<RpcHostChromeState> {
		const optimisticState = this.stateStore.applyModelChange({ provider, id: modelId });
		this.options.onOptimisticChange?.(optimisticState);
		try {
			const model = responseData(await this.client.send({ type: "set_model", provider, modelId }), "set_model");
			this.invalidateAvailableModelsIfMissing(model);
			return this.stateStore.applyModelChange(model);
		} catch (error) {
			const rolledBackState = await this.refreshState();
			this.options.onOptimisticChange?.(rolledBackState);
			throw error;
		}
	}

	public async cycleModel(): Promise<RpcHostChromeState> {
		const data = responseData(await this.client.send({ type: "cycle_model" }), "cycle_model");
		if (!data) return this.stateStore.getSnapshot();
		this.invalidateAvailableModelsIfMissing(data.model);
		return this.stateStore.applyModelChange(data.model, data.thinkingLevel);
	}

	public async setThinkingLevel(level: RpcThinkingLevel): Promise<RpcHostChromeState> {
		const optimisticState = this.stateStore.applyThinkingLevel(level);
		this.options.onOptimisticChange?.(optimisticState);
		try {
			responseData(await this.client.send({ type: "set_thinking_level", level }), "set_thinking_level");
		} catch (error) {
			const rolledBackState = await this.refreshState();
			this.options.onOptimisticChange?.(rolledBackState);
			throw error;
		}
		return await this.refreshState();
	}

	public async cycleThinkingLevel(): Promise<RpcHostChromeState> {
		const data = responseData(await this.client.send({ type: "cycle_thinking_level" }), "cycle_thinking_level");
		if (data === null) return this.stateStore.getSnapshot();
		if (!data || !isRpcThinkingLevel(data.level)) throw new Error("cycle_thinking_level failed: invalid data.level");
		return this.stateStore.applyThinkingLevel(data.level);
	}

	public async getAvailableThinkingLevels(): Promise<RpcAvailableThinkingLevels> {
		const data = responseData(await this.client.send({ type: "get_available_thinking_levels" }), "get_available_thinking_levels");
		if (!data || !Array.isArray(data.levels) || !data.levels.every(isRpcThinkingLevel)) {
			throw new Error("get_available_thinking_levels failed: invalid data.levels");
		}
		return data.levels;
	}

	public async newSession(parentSession?: string): Promise<RpcResponseData<"new_session">> {
		const command: RpcCommand = parentSession === undefined ? { type: "new_session" } : { type: "new_session", parentSession };
		return responseData(await this.client.send(command, SESSION_COMMAND_TIMEOUT_MS), "new_session");
	}

	public async switchSession(sessionPath: string): Promise<RpcResponseData<"switch_session">> {
		return responseData(await this.client.send({ type: "switch_session", sessionPath }, SESSION_COMMAND_TIMEOUT_MS), "switch_session");
	}

	public async fork(entryId: string): Promise<RpcResponseData<"fork">> {
		return responseData(await this.client.send({ type: "fork", entryId }, SESSION_COMMAND_TIMEOUT_MS), "fork");
	}

	public async clone(): Promise<RpcResponseData<"clone">> {
		return responseData(await this.client.send({ type: "clone" }), "clone");
	}

	public async clearQueue(): Promise<RpcClearedQueue> {
		const data = responseData(await this.client.send({ type: "clear_queue" }), "clear_queue");
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untrusted RPC data at the control boundary.
		if (!data || !Array.isArray(data.steering) || !data.steering.every((item) => typeof item === "string")) {
			throw new Error("clear_queue failed: invalid data.steering");
		}
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untrusted RPC data at the control boundary.
		if (!Array.isArray(data.followUp) || !data.followUp.every((item) => typeof item === "string")) {
			throw new Error("clear_queue failed: invalid data.followUp");
		}
		return { steering: [...data.steering], followUp: [...data.followUp] };
	}

	public async abort(): Promise<void> {
		responseData(await this.client.send({ type: "abort" }), "abort");
	}

	public runBash(command: string, excludeFromContext: boolean, id: string): RpcBashRequest {
		if (!this.client.sendWithWriteAck) throw new Error("RPC client does not support staged writes");
		const request = this.client.sendWithWriteAck({ type: "bash", id, command, excludeFromContext }, null);
		return {
			id: request.id,
			written: request.written,
			result: request.response.then((response) => validateBashResult(responseData(response, "bash"))),
		};
	}

	public async abortBash(): Promise<void> {
		responseData(await this.client.send({ type: "abort_bash" }), "abort_bash");
	}

	public async getForkMessages(): Promise<RpcForkMessage[]> {
		const data = responseData(await this.client.send({ type: "get_fork_messages" }), "get_fork_messages");
		return data.messages;
	}

	public async getEntries(since?: string): Promise<RpcEntriesResponse> {
		const command: RpcCommand = since === undefined ? { type: "get_entries" } : { type: "get_entries", since };
		return responseData(await this.client.send(command), "get_entries");
	}

	public async getLastAssistantText(): Promise<string | null> {
		const data = responseData(await this.client.send({ type: "get_last_assistant_text" }), "get_last_assistant_text");
		return data.text;
	}

	public async getSessionStats(): Promise<RpcSessionStats> {
		return responseData(await this.client.send({ type: "get_session_stats" }), "get_session_stats");
	}

	public async exportHtml(outputPath?: string): Promise<RpcResponseData<"export_html">> {
		const command: RpcCommand = outputPath === undefined ? { type: "export_html" } : { type: "export_html", outputPath };
		return responseData(await this.client.send(command, SESSION_COMMAND_TIMEOUT_MS), "export_html");
	}

	public async setSessionName(name: string): Promise<RpcHostChromeState> {
		responseData(await this.client.send({ type: "set_session_name", name }), "set_session_name");
		return this.stateStore.applySessionName(name);
	}

	public async compact(customInstructions?: string): Promise<RpcResponseData<"compact">> {
		const command: RpcCommand = customInstructions === undefined ? { type: "compact" } : { type: "compact", customInstructions };
		return responseData(await this.client.send(command, COMPACT_TIMEOUT_MS), "compact");
	}

	/** Execute a child extension command outside the agent prompt scheduler. */
	public async executeExtensionCommand(message: string): Promise<void> {
		responseData(await this.client.send({ type: "prompt", message }, LOGIN_TIMEOUT_MS), "prompt");
		this.availableModelsCache = undefined;
	}

	public async navigateTree(request: RpcTreeNavigationRequest): Promise<RpcTreeNavigationOutcome> {
		// Encode/validate before touching the broker or child. This keeps malformed
		// host requests from creating a waiter that can only expire later.
		const encoded = encodeRpcTreeNavigationPayload(request);
		const broker = this.options.treeNavigationOutcomeBroker;
		if (!broker) throw new Error("tree navigation outcome broker is unavailable");
		const outcome = broker.register(request.requestId, TREE_NAVIGATION_TIMEOUT_MS);
		// Both promises receive rejection handlers in the same turn. A prompt
		// rejection must not leave the outcome timeout rejection detached, and an
		// outcome timeout must not leave a late prompt rejection unhandled. Starting
		// send in a microtask also covers clients that throw synchronously despite
		// implementing the Promise-returning interface.
		const prompt = Promise.resolve()
			.then(() => this.client.send({ type: "prompt", message: `/sumo:rpc-tree-navigate ${encoded}` }, TREE_NAVIGATION_TIMEOUT_MS))
			.then((response) => responseData(response, "prompt"));
		const observedPrompt = prompt.catch((error) => { throw error; });
		const observedOutcome = outcome.catch((error) => { throw error; });
		try {
			const [, navigationOutcome] = await Promise.all([observedPrompt, observedOutcome]);
			return navigationOutcome;
		} catch (error) {
			// A successful publish removes the waiter, while cancellation is a
			// no-op after a timeout/rejection. Either way this is deterministic.
			broker.cancel(request.requestId);
			throw error;
		}
	}

	public async cancelLogin(): Promise<void> {
		responseData(await this.client.send({ type: "prompt", message: "/sumo:login-cancel" }), "prompt");
	}

	public async setAutoCompaction(enabled: boolean): Promise<void> {
		responseData(await this.client.send({ type: "set_auto_compaction", enabled }), "set_auto_compaction");
	}

	public async setAutoRetry(enabled: boolean): Promise<void> {
		responseData(await this.client.send({ type: "set_auto_retry", enabled }), "set_auto_retry");
	}

	public async getCommands(): Promise<RpcSlashCommand[]> {
		const data = responseData(await this.client.send({ type: "get_commands" }), "get_commands");
		return data.commands;
	}
}
