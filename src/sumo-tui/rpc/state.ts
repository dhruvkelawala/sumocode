import type { AgentSessionEvent, RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import type { CompactionReason } from "../../compaction-state.js";
import { isRpcThinkingLevel, type RpcThinkingLevel } from "./thinking-level.js";

export interface RpcHostChromeState {
	readonly sessionId?: string;
	readonly sessionName?: string;
	/**
	 * Path to the current session's on-disk `.jsonl` file, as reported by Pi's
	 * `get_state` RPC response (`RpcSessionState.sessionFile`). Threaded through
	 * so host-side commands that need to read the session directory or the
	 * current file directly (`/resume`, `/tree`) don't have to re-derive it
	 * from `sessionId` -- Pi already resolves the real path (including the
	 * `parentSession`-aware default-dir lookup), so the host just carries it.
	 */
	readonly sessionFile?: string;
	readonly modelLabel?: string;
	readonly thinkingLevel?: RpcThinkingLevel;
	readonly steeringMode?: RpcSessionState["steeringMode"];
	readonly followUpMode?: RpcSessionState["followUpMode"];
	readonly autoCompactionEnabled?: boolean;
	/** True only after an authoritative get_state hydration, never for cache seeds. */
	readonly hydrated?: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly branchSummaryBusy?: boolean;
	readonly compactionReason?: CompactionReason;
	readonly messageCount: number;
	readonly pendingMessageCount: number;
	readonly promptDeliveryMode?: "steer" | "followUp";
	readonly hasMessages: boolean;
	readonly gitBranch?: string;
	readonly lastEventType?: string;
	readonly taskPartialCount: number;
	/** Compatibility composition; queue-kind rendering uses the fields below. */
	readonly queuedMessages?: readonly string[];
	readonly steeringMessages?: readonly string[];
	readonly followUpMessages?: readonly string[];
	readonly localQueuedMessages?: readonly string[];
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly costUsd: number;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ModelIdentityLike = { provider?: JsonValue; id?: JsonValue } | undefined;

function isString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return typeof value === "boolean";
}

function isQueueMode(value: JsonValue | undefined): value is RpcSessionState["steeringMode"] {
	return value === "all" || value === "one-at-a-time";
}

function isNonnegativeInteger(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelLabelFromModel(model: ModelIdentityLike): string | undefined {
	// SAFETY: model comes from RPC payloads of varying shape; every field read
	// below goes through shape-validating guards.
	const record = isJsonObject(model as JsonValue) ? (model as { [key: string]: JsonValue }) : undefined;
	if (!record) return undefined;
	const id = record["id"];
	const provider = record["provider"];
	if (!isString(id)) return undefined;
	return isString(provider) ? `${provider}/${id}` : id;
}

function modelLabelFrom(state: RpcSessionState): string | undefined {
	// SAFETY: RpcSessionState.model comes from Pi's own get_state payload and is
	// only read field-by-field behind isString validation below.
	return modelLabelFromModel(state.model as ModelIdentityLike);
}

function eventType(event: JsonValue): string | undefined {
	return isJsonObject(event) && isString(event["type"]) ? event["type"] : undefined;
}

function compactionReasonFromEvent(event: JsonValue): CompactionReason | undefined {
	const value = isJsonObject(event) ? event["reason"] : undefined;
	return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function isStringArray(value: JsonValue | undefined): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function invalidRpcState(field: string): never {
	throw new Error(`get_state failed: invalid data.${field}`);
}

/** Validates the state fields SumoCode projects while preserving additive Pi fields. */
function validateRpcSessionState(state: RpcSessionState): RpcSessionState {
	if (!state) invalidRpcState("state");
	const model = state.model;
	if (model !== undefined && model !== null && (!isString(model.provider) || !isString(model.id))) invalidRpcState("model");
	if (!isRpcThinkingLevel(state.thinkingLevel)) invalidRpcState("thinkingLevel");
	if (!isBoolean(state.isStreaming)) invalidRpcState("isStreaming");
	if (!isBoolean(state.isCompacting)) invalidRpcState("isCompacting");
	if (!isQueueMode(state.steeringMode)) invalidRpcState("steeringMode");
	if (!isQueueMode(state.followUpMode)) invalidRpcState("followUpMode");
	if (!isString(state.sessionId)) invalidRpcState("sessionId");
	if (state.sessionName !== undefined && state.sessionName !== null && !isString(state.sessionName)) invalidRpcState("sessionName");
	if (state.sessionFile !== undefined && state.sessionFile !== null && !isString(state.sessionFile)) invalidRpcState("sessionFile");
	if (!isBoolean(state.autoCompactionEnabled)) invalidRpcState("autoCompactionEnabled");
	if (!isNonnegativeInteger(state.messageCount)) invalidRpcState("messageCount");
	if (!isNonnegativeInteger(state.pendingMessageCount)) invalidRpcState("pendingMessageCount");
	return { ...state, model: model ?? undefined, sessionName: state.sessionName ?? undefined, sessionFile: state.sessionFile ?? undefined };
}

export class RpcHostStateStore {
	private hostQueuedMessages: readonly string[] = [];
	private steeringMessages: readonly string[] = [];
	private followUpMessages: readonly string[] = [];
	private state: RpcHostChromeState = {
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
		promptDeliveryMode: "steer",
		hasMessages: false,
		taskPartialCount: 0,
		costUsd: 0,
		queuedMessages: [],
		steeringMessages: [],
		followUpMessages: [],
		localQueuedMessages: [],
	};

	/**
	 * Seeds only startup chrome from the host-side last-known cache. This is an
	 * optimistic paint hint, not authoritative session hydration: it deliberately
	 * leaves `hydrated` and every other session field untouched.
	 */
	public seedChrome(chrome: { readonly modelLabel?: string; readonly thinkingLevel?: string }): RpcHostChromeState {
		const next = { ...this.state };
		if (chrome.modelLabel !== undefined) next.modelLabel = chrome.modelLabel;
		if (isRpcThinkingLevel(chrome.thinkingLevel)) next.thinkingLevel = chrome.thinkingLevel;
		this.state = next;
		return this.getSnapshot();
	}

	public hydrateFromRpcState(value: RpcSessionState, gitBranch = this.state.gitBranch): RpcHostChromeState {
		const rpcState = validateRpcSessionState(value);
		if (this.state.sessionId !== undefined && this.state.sessionId !== rpcState.sessionId) this.clearPiQueueProjection();
		const projectedQueueCount = this.steeringMessages.length + this.followUpMessages.length;
		const pendingMessageCount = Math.max(rpcState.pendingMessageCount, projectedQueueCount) + this.hostQueuedMessages.length;
		this.state = this.withComposedQueue({
			...this.state,
			sessionId: rpcState.sessionId,
			sessionName: rpcState.sessionName,
			sessionFile: rpcState.sessionFile,
			modelLabel: modelLabelFrom(rpcState),
			thinkingLevel: rpcState.thinkingLevel,
			steeringMode: rpcState.steeringMode,
			followUpMode: rpcState.followUpMode,
			autoCompactionEnabled: rpcState.autoCompactionEnabled,
			hydrated: true,
			isStreaming: rpcState.isStreaming,
			isCompacting: rpcState.isCompacting,
			branchSummaryBusy: this.state.branchSummaryBusy,
			compactionReason: rpcState.isCompacting ? this.state.compactionReason : undefined,
			messageCount: rpcState.messageCount,
			pendingMessageCount,
			hasMessages: rpcState.messageCount > 0,
			gitBranch,
			lastEventType: undefined,
			taskPartialCount: 0,
		});
		return this.getSnapshot();
	}

	public hydrateFromSessionStats(stats: SessionStats | undefined): RpcHostChromeState {
		const contextTokens = stats?.contextUsage?.tokens ?? stats?.tokens.total ?? this.state.contextTokens;
		const contextWindow = stats?.contextUsage?.contextWindow ?? this.state.contextWindow;
		const messageCount = stats?.totalMessages ?? this.state.messageCount;
		this.state = this.withComposedQueue({
			...this.state,
			messageCount,
			hasMessages: messageCount > 0,
			contextTokens,
			contextWindow,
			costUsd: stats?.cost ?? this.state.costUsd,
		});
		return this.getSnapshot();
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): RpcHostChromeState {
		// SAFETY: agent events arrive from the RPC socket and may be any shape;
		// every field below is read through shape-validating guards.
		const payload = event as JsonValue;
		const type = eventType(payload);
		switch (type) {
			case "agent_start":
				this.state = { ...this.state, isStreaming: true, lastEventType: type };
				break;
			case "agent_end":
				// Pi reports only this low-level run's suffix here and may immediately
				// retry, compact, or continue queued work. Totals stay hydration/stats-owned,
				// and ordinary activity ends only at agent_settled.
				this.state = { ...this.state, lastEventType: type };
				break;
			case "agent_settled":
				this.state = { ...this.state, isStreaming: false, lastEventType: type };
				break;
			case "compaction_start":
				this.state = { ...this.state, isCompacting: true, compactionReason: compactionReasonFromEvent(payload), lastEventType: type };
				break;
			case "compaction_end":
				this.state = { ...this.state, isCompacting: false, compactionReason: undefined, lastEventType: type };
				break;
			case "queue_update": {
				const steering = isJsonObject(payload) ? payload["steering"] : undefined;
				const followUp = isJsonObject(payload) ? payload["followUp"] : undefined;
				if (isStringArray(steering) && isStringArray(followUp)) {
					this.steeringMessages = [...steering];
					this.followUpMessages = [...followUp];
					this.state = this.withComposedQueue({
						...this.state,
						pendingMessageCount: this.hostQueuedMessages.length + steering.length + followUp.length,
						lastEventType: type,
					});
				} else {
					this.state = { ...this.state, lastEventType: type };
				}
				break;
			}
			case "session_info_changed":
				this.state = { ...this.state, sessionName: isJsonObject(payload) && isString(payload["name"]) ? payload["name"] : undefined, lastEventType: type };
				break;
			case "thinking_level_changed": {
				const level = isJsonObject(payload) ? payload["level"] : undefined;
				this.state = isRpcThinkingLevel(level)
					? { ...this.state, thinkingLevel: level, lastEventType: type }
					: { ...this.state, lastEventType: type };
				break;
			}
			case "tool_execution_update":
				if (isJsonObject(payload) && payload["toolName"] === "task" && "partialResult" in payload) {
					this.state = { ...this.state, taskPartialCount: this.state.taskPartialCount + 1, lastEventType: type };
				}
				break;
			default:
				if (type) this.state = { ...this.state, lastEventType: type };
		}
		return this.getSnapshot();
	}

	public clearPiQueueProjection(): RpcHostChromeState {
		this.steeringMessages = [];
		this.followUpMessages = [];
		this.state = this.withComposedQueue({ ...this.state, pendingMessageCount: this.hostQueuedMessages.length });
		return this.getSnapshot();
	}

	public setPromptDeliveryMode(promptDeliveryMode: "steer" | "followUp"): RpcHostChromeState {
		this.state = { ...this.state, promptDeliveryMode };
		return this.getSnapshot();
	}

	public setHostQueuedMessages(messages: readonly string[]): RpcHostChromeState {
		this.hostQueuedMessages = [...messages];
		this.state = this.withComposedQueue({
			...this.state,
			pendingMessageCount: this.hostQueuedMessages.length + this.steeringMessages.length + this.followUpMessages.length,
		});
		return this.getSnapshot();
	}

	public setGitBranch(gitBranch: string | undefined): RpcHostChromeState {
		this.state = { ...this.state, gitBranch };
		return this.getSnapshot();
	}

	/**
	 * Patches `modelLabel` (and optionally `thinkingLevel`) directly from a
	 * mutating RPC response's own inline payload -- `set_model`/`cycle_model`
	 * already return the resulting model (and `cycle_model` the resulting
	 * thinking level too), so callers can apply it here instead of issuing a
	 * second `get_state` round-trip just to read back what the first response
	 * already told them. Fixes a real perceived-latency bug: the footer used
	 * to sit on the stale value until a full extra RPC round-trip completed.
	 */
	public applyModelChange(model: ModelIdentityLike, thinkingLevel?: RpcThinkingLevel): RpcHostChromeState {
		const modelLabel = modelLabelFromModel(model);
		const next = { ...this.state };
		if (modelLabel !== undefined) next.modelLabel = modelLabel;
		if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;
		this.state = next;
		return this.getSnapshot();
	}

	/** Applies an effective level from hydration, an event, or cycle response. */
	public applyThinkingLevel(level: RpcThinkingLevel): RpcHostChromeState {
		this.state = { ...this.state, thinkingLevel: level };
		return this.getSnapshot();
	}

	public applySessionName(name: string): RpcHostChromeState {
		this.state = { ...this.state, sessionName: name };
		return this.getSnapshot();
	}

	public setBranchSummaryBusy(busy: boolean): RpcHostChromeState {
		this.state = { ...this.state, branchSummaryBusy: busy };
		return this.getSnapshot();
	}

	public getSnapshot(): RpcHostChromeState {
		return {
			...this.state,
			queuedMessages: [...(this.state.queuedMessages ?? [])],
			steeringMessages: [...(this.state.steeringMessages ?? [])],
			followUpMessages: [...(this.state.followUpMessages ?? [])],
			localQueuedMessages: [...(this.state.localQueuedMessages ?? [])],
		};
	}

	private withComposedQueue(state: RpcHostChromeState): RpcHostChromeState {
		return {
			...state,
			queuedMessages: [...this.steeringMessages, ...this.followUpMessages, ...this.hostQueuedMessages],
			steeringMessages: [...this.steeringMessages],
			followUpMessages: [...this.followUpMessages],
			localQueuedMessages: [...this.hostQueuedMessages],
		};
	}
}
