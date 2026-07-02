import type { AgentSessionEvent, RpcSessionState } from "@earendil-works/pi-coding-agent";

export interface RpcHostChromeState {
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly modelLabel?: string;
	readonly thinkingLevel?: string;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly messageCount: number;
	readonly pendingMessageCount: number;
	readonly hasMessages: boolean;
	readonly gitBranch?: string;
	readonly lastEventType?: string;
	readonly taskPartialCount: number;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly costUsd: number;
}

function modelLabelFrom(state: RpcSessionState): string | undefined {
	const model = state.model as { provider?: unknown; id?: unknown } | undefined;
	if (!model || typeof model.id !== "string") return undefined;
	return typeof model.provider === "string" ? `${model.provider}/${model.id}` : model.id;
}

function eventType(event: unknown): string | undefined {
	return typeof (event as { type?: unknown }).type === "string" ? (event as { type: string }).type : undefined;
}

export class RpcHostStateStore {
	private state: RpcHostChromeState = {
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
		hasMessages: false,
		taskPartialCount: 0,
		costUsd: 0,
	};

	public hydrateFromRpcState(rpcState: RpcSessionState, gitBranch = this.state.gitBranch): RpcHostChromeState {
		this.state = {
			...this.state,
			sessionId: rpcState.sessionId,
			sessionName: rpcState.sessionName,
			modelLabel: modelLabelFrom(rpcState),
			thinkingLevel: rpcState.thinkingLevel,
			isStreaming: rpcState.isStreaming,
			isCompacting: rpcState.isCompacting,
			messageCount: rpcState.messageCount,
			pendingMessageCount: rpcState.pendingMessageCount,
			hasMessages: rpcState.messageCount > 0,
			gitBranch,
		};
		return this.getSnapshot();
	}

	public hydrateFromSessionStats(stats: unknown): RpcHostChromeState {
		const record = typeof stats === "object" && stats !== null ? stats as Record<string, unknown> : {};
		const tokens = typeof record.tokens === "object" && record.tokens !== null ? record.tokens as Record<string, unknown> : {};
		const contextUsage = typeof record.contextUsage === "object" && record.contextUsage !== null
			? record.contextUsage as Record<string, unknown>
			: undefined;
		const contextTokens = typeof contextUsage?.tokens === "number"
			? contextUsage.tokens
			: typeof tokens.total === "number"
				? tokens.total
				: this.state.contextTokens;
		const contextWindow = typeof contextUsage?.contextWindow === "number"
			? contextUsage.contextWindow
			: this.state.contextWindow;
		const messageCount = typeof record.totalMessages === "number" ? record.totalMessages : this.state.messageCount;
		this.state = {
			...this.state,
			messageCount,
			hasMessages: messageCount > 0,
			contextTokens,
			contextWindow,
			costUsd: typeof record.cost === "number" ? record.cost : this.state.costUsd,
		};
		return this.getSnapshot();
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): RpcHostChromeState {
		const type = eventType(event);
		switch (type) {
			case "agent_start":
				this.state = { ...this.state, isStreaming: true, lastEventType: type };
				break;
			case "agent_end": {
				const messages = (event as { messages?: unknown }).messages;
				const messageCount = Array.isArray(messages) ? messages.length : this.state.messageCount;
				this.state = {
					...this.state,
					isStreaming: false,
					messageCount,
					hasMessages: messageCount > 0,
					lastEventType: type,
				};
				break;
			}
			case "compaction_start":
				this.state = { ...this.state, isCompacting: true, lastEventType: type };
				break;
			case "compaction_end":
				this.state = { ...this.state, isCompacting: false, lastEventType: type };
				break;
			case "session_info_changed":
				this.state = { ...this.state, sessionName: (event as { name?: string }).name, lastEventType: type };
				break;
			case "thinking_level_changed":
				this.state = { ...this.state, thinkingLevel: (event as { level?: string }).level, lastEventType: type };
				break;
			case "tool_execution_update":
				if ((event as { toolName?: unknown }).toolName === "task" && "partialResult" in (event as Record<string, unknown>)) {
					this.state = { ...this.state, taskPartialCount: this.state.taskPartialCount + 1, lastEventType: type };
				}
				break;
			default:
				if (type) this.state = { ...this.state, lastEventType: type };
		}
		return this.getSnapshot();
	}

	public setGitBranch(gitBranch: string | undefined): RpcHostChromeState {
		this.state = { ...this.state, gitBranch };
		return this.getSnapshot();
	}

	public getSnapshot(): RpcHostChromeState {
		return { ...this.state };
	}
}
