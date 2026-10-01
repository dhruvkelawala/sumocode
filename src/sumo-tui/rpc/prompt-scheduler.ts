export type RpcPromptDeliveryMode = "steer" | "followUp";

/** The host's selection: a Pi delivery, or `auto` to let Jev pick one per busy submission. */
export type RpcQueueMode = RpcPromptDeliveryMode | "auto";

/** Picks a delivery for a busy submission. Must resolve, never reject. */
export type RpcDeliveryDecider = (message: string, currentTask: string | undefined) => Promise<RpcPromptDeliveryMode>;

export interface RpcPromptDelivery {
	readonly streamingBehavior: RpcPromptDeliveryMode;
}

export interface LocalQueuedPrompt {
	readonly text: string;
	readonly delivery: RpcQueueMode;
}

interface DispatchedPrompt {
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
	submit(message: string, options: { readonly delivery: RpcQueueMode }): Promise<"sent" | "queued" | "ignored" | "handled">;
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
	/** Resolves `auto` submissions made while the agent is busy; without it they steer. */
	readonly decideDelivery?: RpcDeliveryDecider;
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

/**
 * Pi owns normal queues; this scheduler only holds prompts while Pi is
 * compacting, or while Jev picks the delivery of an `auto` submission.
 */
class DefaultRpcPromptScheduler implements RpcPromptScheduler {
	private queue: LocalQueuedPrompt[] = [];
	private sessionId: string | undefined;
	/** The prompt that started the current run: context for `auto` delivery. */
	private currentTask: string | undefined;
	private generation = 0;
	private lifecycleBusy = false;
	private dispatchCount = 0;
	private pausedAfterFailure = false;
	private flushing = false;

	public constructor(private readonly options: RpcPromptSchedulerOptions) {
		this.sessionId = options.sessionId;
	}

	public async submit(message: string, options: { readonly delivery: RpcQueueMode }): Promise<"sent" | "queued" | "ignored" | "handled"> {
		if (message.trim().length === 0) return "ignored";
		if (await this.options.handleHostCommand?.(message)) return "handled";
		const compacting = this.options.getCompacting?.() === true;
		const command = message.trimStart().startsWith("/");
		const busy = this.isBusy();
		if (!busy && !command) this.currentTask = message;
		if (compacting && command) {
			void this.dispatch({ text: message, delivery: options.delivery === "auto" ? "steer" : options.delivery }, this.generation, false);
			return "sent";
		}
		if (containsQueuedAttachment(message) && (compacting || this.options.getBusy?.() === true)) {
			this.options.onPreflightRejected?.(message, new RpcPromptPreflightRejection("attachments cannot be queued safely"));
			return "ignored";
		}
		// Only a busy, non-command submission has a delivery worth judging.
		const delivery = options.delivery === "auto" && (!busy || command) ? "steer" : options.delivery;
		// `auto` waits in the local queue while Jev decides, so later submissions keep their order.
		if (compacting || this.queue.length > 0 || delivery === "auto") {
			this.queue.push({ text: message, delivery });
			this.pausedAfterFailure = false;
			this.publishQueue();
			void this.flush(this.generation);
			return "queued";
		}
		void this.dispatch({ text: message, delivery }, this.generation, false);
		return "sent";
	}

	public handleAgentEvent(event: RpcSchedulerEvent): void {
		if (event.type === "agent_start") this.lifecycleBusy = true;
		if (event.type === "agent_settled") {
			this.lifecycleBusy = false;
			void this.flush(this.generation);
		}
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
		this.currentTask = undefined;
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
				const head = this.queue[0];
				if (!head) break;
				let delivery: RpcPromptDeliveryMode;
				if (head.delivery === "auto") {
					delivery = await this.decideDelivery(head.text);
					// While Jev decided, a restore may have replaced the queue or compaction may have started.
					if (generation !== this.generation || this.queue[0] !== head) break;
					if (this.options.getCompacting?.() === true) {
						this.queue[0] = { text: head.text, delivery };
						break;
					}
				} else {
					delivery = head.delivery;
				}
				this.queue.shift();
				this.publishQueue();
				if (!await this.dispatch({ text: head.text, delivery }, generation, true)) break;
			}
		} finally {
			this.flushing = false;
		}
	}

	private isBusy(): boolean {
		return this.lifecycleBusy || this.options.getBusy?.() === true;
	}

	private async decideDelivery(message: string): Promise<RpcPromptDeliveryMode> {
		// Idle by now (the run ended while the prompt waited): Pi ignores the delivery.
		if (!this.options.decideDelivery || !this.isBusy()) return "steer";
		return this.options.decideDelivery(message, this.currentTask).catch((): RpcPromptDeliveryMode => "steer");
	}

	private async dispatch(entry: DispatchedPrompt, generation: number, restoreOnFailure: boolean): Promise<boolean> {
		if (generation !== this.generation) return false;
		this.dispatchCount += 1;
		this.options.onDispatchStart?.(entry.text);
		try {
			await this.options.sendPrompt(entry.text, { streamingBehavior: entry.delivery });
			return generation === this.generation;
		} catch (error) {
			if (generation !== this.generation) {
				this.options.onDispatchFailure?.(entry.text, error);
				return false;
			}
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
