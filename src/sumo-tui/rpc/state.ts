import type { AgentSessionEvent, RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import type { CompactionReason } from "../../compaction-state.js";

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
	readonly thinkingLevel?: string;
	/** True only after an authoritative get_state hydration, never for cache seeds. */
	readonly hydrated?: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly branchSummaryBusy?: boolean;
	readonly compactionReason?: CompactionReason;
	readonly messageCount: number;
	readonly pendingMessageCount: number;
	readonly hasMessages: boolean;
	readonly gitBranch?: string;
	readonly lastEventType?: string;
	readonly taskPartialCount: number;
	/**
	 * Display composition of SumoCode host-owned queued drafts plus any
	 * unexpected Pi-owned queue snapshots reported by `queue_update`. The host
	 * queue is the only undoable source; Pi-owned entries are shown truthfully
	 * but are not claimed by Alt+Up restore.
	 */
	readonly queuedMessages?: readonly string[];
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly costUsd: number;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ModelIdentityLike = { provider?: JsonValue; id?: JsonValue } | undefined;

function isString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
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

function stringEntries(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter(isString) : [];
}

export class RpcHostStateStore {
	private hostQueuedMessages: readonly string[] = [];
	private piQueuedMessages: readonly string[] = [];
	private state: RpcHostChromeState = {
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
		hasMessages: false,
		taskPartialCount: 0,
		costUsd: 0,
		queuedMessages: [],
	};

	/**
	 * Seeds only startup chrome from the host-side last-known cache. This is an
	 * optimistic paint hint, not authoritative session hydration: it deliberately
	 * leaves `hydrated` and every other session field untouched.
	 */
	public seedChrome(chrome: { readonly modelLabel?: string; readonly thinkingLevel?: string }): RpcHostChromeState {
		const next = { ...this.state };
		if (chrome.modelLabel !== undefined) next.modelLabel = chrome.modelLabel;
		if (chrome.thinkingLevel !== undefined) next.thinkingLevel = chrome.thinkingLevel;
		this.state = next;
		return this.getSnapshot();
	}

	public hydrateFromRpcState(rpcState: RpcSessionState, gitBranch = this.state.gitBranch): RpcHostChromeState {
		const pendingMessageCount = Math.max(rpcState.pendingMessageCount, this.piQueuedMessages.length) + this.hostQueuedMessages.length;
		this.state = this.withComposedQueue({
			...this.state,
			sessionId: rpcState.sessionId,
			sessionName: rpcState.sessionName,
			sessionFile: rpcState.sessionFile,
			modelLabel: modelLabelFrom(rpcState),
			thinkingLevel: rpcState.thinkingLevel,
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
			case "agent_end": {
				const messages = isJsonObject(payload) ? payload["messages"] : undefined;
				const messageCount = Array.isArray(messages) ? messages.length : this.state.messageCount;
				this.state = this.withComposedQueue({
					...this.state,
					isStreaming: false,
					messageCount,
					hasMessages: messageCount > 0,
					lastEventType: type,
				});
				break;
			}
			case "compaction_start":
				this.state = { ...this.state, isCompacting: true, compactionReason: compactionReasonFromEvent(payload), lastEventType: type };
				break;
			case "compaction_end":
				this.state = { ...this.state, isCompacting: false, compactionReason: undefined, lastEventType: type };
				break;
			case "queue_update": {
				const steering = isJsonObject(payload) ? payload["steering"] : undefined;
				const followUp = isJsonObject(payload) ? payload["followUp"] : undefined;
				this.piQueuedMessages = [...stringEntries(steering), ...stringEntries(followUp)];
				this.state = this.withComposedQueue({
					...this.state,
					pendingMessageCount: this.hostQueuedMessages.length + this.piQueuedMessages.length,
					lastEventType: type,
				});
				break;
			}
			case "session_info_changed":
				this.state = { ...this.state, sessionName: isJsonObject(payload) && isString(payload["name"]) ? payload["name"] : undefined, lastEventType: type };
				break;
			case "thinking_level_changed":
				this.state = { ...this.state, thinkingLevel: isJsonObject(payload) && isString(payload["level"]) ? payload["level"] : undefined, lastEventType: type };
				break;
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

	public setHostQueuedMessages(messages: readonly string[]): RpcHostChromeState {
		this.hostQueuedMessages = [...messages];
		this.state = this.withComposedQueue({
			...this.state,
			pendingMessageCount: this.hostQueuedMessages.length + this.piQueuedMessages.length,
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
	public applyModelChange(model: ModelIdentityLike, thinkingLevel?: string): RpcHostChromeState {
		const modelLabel = modelLabelFromModel(model);
		const next = { ...this.state };
		if (modelLabel !== undefined) next.modelLabel = modelLabel;
		if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;
		this.state = next;
		return this.getSnapshot();
	}

	/**
	 * Patches `thinkingLevel` directly -- used after `set_thinking_level`
	 * (whose response carries no data at all, so the level we asked for IS
	 * the result on success) and after `cycle_thinking_level` (whose response
	 * already includes the resulting level inline). Same round-trip-avoidance
	 * rationale as `applyModelChange`.
	 */
	public applyThinkingLevel(level: string): RpcHostChromeState {
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
		};
	}

	private withComposedQueue(state: RpcHostChromeState): RpcHostChromeState {
		return {
			...state,
			queuedMessages: [...this.piQueuedMessages, ...this.hostQueuedMessages],
		};
	}
}
