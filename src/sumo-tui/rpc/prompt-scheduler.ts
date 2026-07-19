export interface RpcPromptSchedulerSnapshot {
	readonly busy: boolean;
	readonly queuedMessages: readonly string[];
	readonly sessionId?: string;
	readonly pausedAfterFailure: boolean;
}

export interface RpcPromptScheduler {
	submit(message: string, options?: { forceQueue?: boolean }): Promise<"sent" | "queued" | "ignored">;
	handleAgentEvent(event: unknown): void;
	restoreAll(currentDraft: string): { count: number; text: string };
	rebindSession(sessionId: string | undefined, currentDraft: string): { count: number; text: string };
	getSnapshot(): RpcPromptSchedulerSnapshot;
}

export interface RpcPromptSchedulerOptions {
	readonly sessionId?: string;
	readonly sendPrompt: (message: string) => Promise<void>;
	readonly getBusy?: () => boolean;
	readonly handleHostCommand?: (message: string) => boolean | Promise<boolean>;
	readonly onQueueChange?: (messages: readonly string[]) => void;
	readonly onDispatchStart?: (message: string) => void;
	readonly onDispatchFailure?: (error: unknown) => void;
}

type AgentEventLike = { type?: unknown };

function eventType(event: unknown): string | undefined {
	const type = (event as AgentEventLike).type;
	return typeof type === "string" ? type : undefined;
}

function combineDrafts(restored: readonly string[], currentDraft: string): string {
	if (restored.length === 0) return currentDraft;
	const restoredText = restored.join("\n\n");
	return currentDraft.length > 0 ? `${restoredText}\n\n${currentDraft}` : restoredText;
}

export function createRpcPromptScheduler(options: RpcPromptSchedulerOptions): RpcPromptScheduler {
	return new DefaultRpcPromptScheduler(options);
}

class DefaultRpcPromptScheduler implements RpcPromptScheduler {
	private queue: string[] = [];
	private busy = false;
	private dispatching = false;
	private pausedAfterFailure = false;
	private sessionId: string | undefined;
	private generation = 0;

	public constructor(private readonly options: RpcPromptSchedulerOptions) {
		this.sessionId = options.sessionId;
	}

	public async submit(message: string, options: { forceQueue?: boolean } = {}): Promise<"sent" | "queued" | "ignored"> {
		if (message.trim().length === 0) return "ignored";
		if (await this.options.handleHostCommand?.(message)) return "ignored";
		this.pausedAfterFailure = false;
		if (options.forceQueue || this.isBusy()) {
			this.queue.push(message);
			this.publishQueue();
			return "queued";
		}
		void this.dispatch(message, this.generation, { requeueOnFailure: true });
		return "sent";
	}

	public handleAgentEvent(event: unknown): void {
		switch (eventType(event)) {
			case "agent_start":
				this.busy = true;
				break;
			case "agent_settled":
				this.busy = false;
				this.drainOne(this.generation);
				break;
			default:
				break;
		}
	}

	public restoreAll(currentDraft: string): { count: number; text: string } {
		const restored = this.queue;
		this.queue = [];
		this.pausedAfterFailure = false;
		this.publishQueue();
		return { count: restored.length, text: combineDrafts(restored, currentDraft) };
	}

	public rebindSession(sessionId: string | undefined, currentDraft: string): { count: number; text: string } {
		const restored = this.restoreAll(currentDraft);
		this.sessionId = sessionId;
		this.generation += 1;
		this.busy = false;
		this.dispatching = false;
		this.pausedAfterFailure = false;
		return restored;
	}

	public getSnapshot(): RpcPromptSchedulerSnapshot {
		return {
			busy: this.isBusy(),
			queuedMessages: [...this.queue],
			sessionId: this.sessionId,
			pausedAfterFailure: this.pausedAfterFailure,
		};
	}

	private drainOne(generation: number): void {
		if (this.pausedAfterFailure || this.dispatching || this.busy || this.options.getBusy?.() === true) return;
		const message = this.queue.shift();
		if (message === undefined) return;
		this.publishQueue();
		void this.dispatch(message, generation, { requeueOnFailure: true });
	}

	private isBusy(): boolean {
		return this.busy || this.dispatching || this.options.getBusy?.() === true;
	}

	private async dispatch(message: string, generation: number, options: { requeueOnFailure: boolean }): Promise<void> {
		if (generation !== this.generation) return;
		this.dispatching = true;
		this.busy = true;
		this.options.onDispatchStart?.(message);
		try {
			await this.options.sendPrompt(message);
		} catch (error) {
			if (generation === this.generation) {
				if (options.requeueOnFailure) {
					this.queue.unshift(message);
					this.pausedAfterFailure = true;
					this.publishQueue();
				}
				this.busy = false;
				this.options.onDispatchFailure?.(error);
			}
		} finally {
			if (generation === this.generation) this.dispatching = false;
		}
	}

	private publishQueue(): void {
		this.options.onQueueChange?.([...this.queue]);
	}
}
