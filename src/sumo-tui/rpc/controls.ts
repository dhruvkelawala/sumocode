import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { responseData, type RpcResponseData } from "./response.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";

export interface RpcCommandClient {
	send(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
}

export type RpcAvailableModel = RpcResponseData<"get_available_models">["models"][number];
export type RpcThinkingLevel = RpcSessionState["thinkingLevel"];
export type RpcSlashCommand = RpcResponseData<"get_commands">["commands"][number];
export type RpcForkMessage = RpcResponseData<"get_fork_messages">["messages"][number];
export type RpcSessionStats = RpcResponseData<"get_session_stats">;

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
const SESSION_COMMAND_TIMEOUT_MS = 60_000;

function modelLabel(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

function currentModelLabel(currentModel?: ModelIdentity | string): string | undefined {
	return typeof currentModel === "string" ? currentModel : currentModel ? modelLabel(currentModel) : undefined;
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
	public constructor(
		private readonly client: RpcCommandClient,
		private readonly stateStore: RpcHostStateStore = new RpcHostStateStore(),
	) {}

	public async refreshState(gitBranch?: string): Promise<RpcHostChromeState> {
		const state = responseData(await this.client.send({ type: "get_state" }), "get_state");
		return this.stateStore.hydrateFromRpcState(state, gitBranch);
	}

	public async getAvailableModels(): Promise<RpcModelOption[]> {
		const data = responseData(await this.client.send({ type: "get_available_models" }), "get_available_models");
		return modelOptionsFrom(data.models, this.stateStore.getSnapshot().modelLabel);
	}

	public async setModel(provider: string, modelId: string): Promise<RpcHostChromeState> {
		responseData(await this.client.send({ type: "set_model", provider, modelId }), "set_model");
		return await this.refreshState();
	}

	public async cycleModel(): Promise<RpcHostChromeState> {
		responseData(await this.client.send({ type: "cycle_model" }), "cycle_model");
		return await this.refreshState();
	}

	public async setThinkingLevel(level: RpcThinkingLevel): Promise<RpcHostChromeState> {
		responseData(await this.client.send({ type: "set_thinking_level", level }), "set_thinking_level");
		return await this.refreshState();
	}

	public async cycleThinkingLevel(): Promise<RpcHostChromeState> {
		responseData(await this.client.send({ type: "cycle_thinking_level" }), "cycle_thinking_level");
		return await this.refreshState();
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

	public async abort(): Promise<void> {
		responseData(await this.client.send({ type: "abort" }), "abort");
	}

	public async getForkMessages(): Promise<RpcForkMessage[]> {
		const data = responseData(await this.client.send({ type: "get_fork_messages" }), "get_fork_messages");
		return data.messages;
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

	public async setSessionName(name: string): Promise<void> {
		responseData(await this.client.send({ type: "set_session_name", name }), "set_session_name");
	}

	public async compact(customInstructions?: string): Promise<RpcResponseData<"compact">> {
		const command: RpcCommand = customInstructions === undefined ? { type: "compact" } : { type: "compact", customInstructions };
		return responseData(await this.client.send(command, COMPACT_TIMEOUT_MS), "compact");
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
