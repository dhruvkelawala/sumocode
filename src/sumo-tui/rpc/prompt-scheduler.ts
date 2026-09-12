export type RpcPromptDeliveryMode = "steer" | "followUp";

export interface RpcPromptDelivery {
	readonly streamingBehavior: RpcPromptDeliveryMode;
}

export interface LocalQueuedPrompt {
	readonly text: string;
	readonly delivery: RpcPromptDeliveryMode;
}

export interface RpcPromptSchedulerSnapshot {
	readonly busy: boolean;
	readonly dispatching: boolean;
	readonly queuedMessages: readonly string[];
	readonly localQueue: readonly LocalQueuedPrompt[];
	readonly sessionId?: string;
	readonly pausedAfterFailure: boolean;
}

export class RpcPromptPreflightRejection extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "RpcPromptPreflightRejection";
	}
}

export interface RpcPromptRestoreResult {
	readonly count: number;
	readonly text: string;
}

export interface RpcSchedulerEvent {
	readonly type?: string;
}

export interface RpcPromptScheduler {
	submit(message: string, options: { readonly delivery: RpcPromptDeliveryMode }): Promise<"sent" | "queued" | "ignored" | "handled">;
	handleAgentEvent(event: RpcSchedulerEvent): void;
	restoreAll(currentDraft: string): RpcPromptRestoreResult;
	rebindSession(sessionId: string | undefined, currentDraft: string): RpcPromptRestoreResult;
	getSnapshot(): RpcPromptSchedulerSnapshot;
}

export interface RpcPromptSchedulerOptions {
	readonly sessionId?: string;
	readonly sendPrompt: (message: string, delivery: RpcPromptDelivery) => Promise<void>;
	readonly getBusy?: () => boolean;
	readonly getCompacting?: () => boolean;
	readonly handleHostCommand?: (message: string) => boolean | Promise<boolean>;
	readonly onQueueChange?: (messages: readonly string[]) => void;
	readonly onDispatchStart?: (message: string) => void;
	readonly onPreflightRejected?: (message: string, cause: unknown) => void;
	readonly onDispatchFailure?: (message: string, cause: unknown) => void;
}

function combineDrafts(restored: readonly string[], currentDraft: string): string {
	const parts = [...restored];
	if (currentDraft.length > 0) parts.push(currentDraft);
	return parts.join("\n\n");
}

function containsQueuedAttachment(message: string): boolean {
	return /pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp)/i.test(message);
}

export function createRpcPromptScheduler(options: RpcPromptSchedulerOptions): RpcPromptScheduler {
	return new DefaultRpcPromptScheduler(options);
}

/** Pi owns normal queues; this scheduler only holds prompts while Pi is compacting. */
class DefaultRpcPromptScheduler implements RpcPromptScheduler {
	private queue: LocalQueuedPrompt[] = [];
	private sessionId: string | undefined;
	private generation = 0;
	private lifecycleBusy = false;
	private dispatchCount = 0;
	private pausedAfterFailure = false;
	private flushing = false;

	public constructor(private readonly options: RpcPromptSchedulerOptions) {
		this.sessionId = options.sessionId;
	}

	public async submit(message: string, options: { readonly delivery: RpcPromptDeliveryMode }): Promise<"sent" | "queued" | "ignored" | "handled"> {
		if (message.trim().length === 0) return "ignored";
		if (await this.options.handleHostCommand?.(message)) return "handled";
		const compacting = this.options.getCompacting?.() === true;
		if (compacting && message.trimStart().startsWith("/")) {
			void this.dispatch({ text: message, delivery: options.delivery }, this.generation, false);
			return "sent";
		}
		if (containsQueuedAttachment(message) && (compacting || this.options.getBusy?.() === true)) {
			this.options.onPreflightRejected?.(message, new RpcPromptPreflightRejection("attachments cannot be queued safely"));
			return "ignored";
		}
		if (compacting || this.queue.length > 0) {
			this.queue.push({ text: message, delivery: options.delivery });
			this.pausedAfterFailure = false;
			this.publishQueue();
			return "queued";
		}
		void this.dispatch({ text: message, delivery: options.delivery }, this.generation, false);
		return "sent";
	}

	public handleAgentEvent(event: RpcSchedulerEvent): void {
		if (event.type === "agent_start") this.lifecycleBusy = true;
		if (event.type === "agent_settled") this.lifecycleBusy = false;
		if (event.type === "compaction_end") void this.flush(this.generation);
	}

	public restoreAll(currentDraft: string): RpcPromptRestoreResult {
		const restored = this.queue.map((entry) => entry.text);
		this.queue = [];
		this.pausedAfterFailure = false;
		this.generation += 1;
		this.publishQueue();
		return { count: restored.length, text: combineDrafts(restored, currentDraft) };
	}

	public rebindSession(sessionId: string | undefined, currentDraft: string): RpcPromptRestoreResult {
		const restored = this.restoreAll(currentDraft);
		this.sessionId = sessionId;
		this.lifecycleBusy = false;
		return restored;
	}

	public getSnapshot(): RpcPromptSchedulerSnapshot {
		return {
			busy: this.lifecycleBusy || this.dispatchCount > 0 || this.options.getBusy?.() === true,
			dispatching: this.dispatchCount > 0,
			queuedMessages: this.queue.map((entry) => entry.text),
			localQueue: this.queue.map((entry) => ({ ...entry })),
			sessionId: this.sessionId,
			pausedAfterFailure: this.pausedAfterFailure,
		};
	}

	private async flush(generation: number): Promise<void> {
		if (this.flushing || this.pausedAfterFailure || this.options.getCompacting?.() === true) return;
		this.flushing = true;
		try {
			while (generation === this.generation && this.queue.length > 0) {
				const entry = this.queue.shift();
				if (!entry) break;
				this.publishQueue();
				if (!await this.dispatch(entry, generation, true)) break;
			}
		} finally {
			this.flushing = false;
		}
	}

	private async dispatch(entry: LocalQueuedPrompt, generation: number, restoreOnFailure: boolean): Promise<boolean> {
		if (generation !== this.generation) return false;
		this.dispatchCount += 1;
		this.options.onDispatchStart?.(entry.text);
		try {
			await this.options.sendPrompt(entry.text, { streamingBehavior: entry.delivery });
			return generation === this.generation;
		} catch (error) {
			if (generation !== this.generation) return false;
			if (restoreOnFailure) {
				this.queue.unshift(entry);
				this.pausedAfterFailure = true;
				this.publishQueue();
			}
			if (error instanceof RpcPromptPreflightRejection && !restoreOnFailure) this.options.onPreflightRejected?.(entry.text, error);
			else this.options.onDispatchFailure?.(entry.text, error);
			return false;
		} finally {
			this.dispatchCount = Math.max(0, this.dispatchCount - 1);
		}
	}

	private publishQueue(): void {
		this.options.onQueueChange?.(this.queue.map((entry) => entry.text));
	}
}
