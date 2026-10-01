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
	readonly message?: RpcSchedulerMessage;
}

/** The part of a Pi message the scheduler reads: which user message opened a turn. */
interface RpcSchedulerMessage {
	readonly role?: string;
	readonly content?: string | RpcSchedulerContentBlock[];
}

interface RpcSchedulerContentBlock {
	readonly type?: string;
	readonly text?: string;
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
	/** Resolves with Pi's prompt disposition when the response carries one. */
	readonly sendPrompt: (message: string, delivery: RpcPromptDelivery) => Promise<string | void>;
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

function userMessageText(message: RpcSchedulerMessage | undefined): string | undefined {
	if (message?.role !== "user" || message.content === undefined) return undefined;
	if (!Array.isArray(message.content)) return message.content;
	return message.content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n");
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
	/** The user message that started the current run: context for `auto` delivery. */
	private currentTask: string | undefined;
	/** Pi's next user message opens the run that just started: it becomes the task. */
	private runTaskPending = false;
	private generation = 0;
	private lifecycleBusy = false;
	/** An idle prompt was sent and Pi's `agent_start` for it has not arrived yet. */
	private awaitingRunStart = false;
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
		// Only a busy (or compaction-held) non-command submission has a delivery worth judging; any
		// other `auto` steers. A held one is judged after compaction, if the agent is still busy then.
		// An attachment can't wait in the host queue, so it is never held for a judgement.
		const judge = options.delivery === "auto" && !command && !containsQueuedAttachment(message) && (compacting || this.isBusy());
		const fixed: RpcPromptDeliveryMode = options.delivery === "auto" ? "steer" : options.delivery;
		if (compacting && command) {
			void this.dispatch({ text: message, delivery: fixed }, this.generation, false);
			return "sent";
		}
		if (containsQueuedAttachment(message) && (compacting || this.options.getBusy?.() === true)) {
			this.options.onPreflightRejected?.(message, new RpcPromptPreflightRejection("attachments cannot be queued safely"));
			return "ignored";
		}
		// `auto` waits in the local queue while Jev decides, so later submissions keep their order.
		if (compacting || this.queue.length > 0 || judge) {
			this.queue.push({ text: message, delivery: judge ? "auto" : fixed });
			this.pausedAfterFailure = false;
			this.publishQueue();
			void this.flush(this.generation);
			return "queued";
		}
		void this.dispatch({ text: message, delivery: fixed }, this.generation, false);
		return "sent";
	}

	public handleAgentEvent(event: RpcSchedulerEvent): void {
		if (event.type === "agent_start" || event.type === "agent_settled") this.awaitingRunStart = false;
		if (event.type === "agent_start") {
			this.lifecycleBusy = true;
			this.runTaskPending = true;
		}
		if (event.type === "message_start" && this.runTaskPending) {
			// Pi emits the run's prompt (after skill and template expansion) right after agent_start;
			// follow-ups continue the same run, and a run that restarts emits agent_start again.
			const task = userMessageText(event.message);
			if (task !== undefined) {
				// An opener without text (an image alone) leaves the task unknown rather than empty.
				this.currentTask = task.length > 0 ? task : undefined;
				this.runTaskPending = false;
			}
		}
		if (event.type === "agent_settled") {
			this.lifecycleBusy = false;
			this.runTaskPending = false;
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
		this.awaitingRunStart = false;
		this.runTaskPending = false;
		this.currentTask = undefined;
		return restored;
	}

	public getSnapshot(): RpcPromptSchedulerSnapshot {
		return {
			busy: this.lifecycleBusy || this.awaitingRunStart || this.dispatchCount > 0 || this.options.getBusy?.() === true,
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
		// A restore while this flush awaited Jev bumped the generation: drain what was queued since.
		if (generation !== this.generation && this.queue.length > 0) void this.flush(this.generation);
	}

	private isBusy(): boolean {
		return this.lifecycleBusy || this.awaitingRunStart || this.options.getBusy?.() === true;
	}

	private async decideDelivery(message: string): Promise<RpcPromptDeliveryMode> {
		// Idle by now (the run ended while the prompt waited): Pi ignores the delivery.
		if (!this.options.decideDelivery || !this.isBusy()) return "steer";
		return this.options.decideDelivery(message, this.currentTask).catch((): RpcPromptDeliveryMode => "steer");
	}

	private async dispatch(entry: DispatchedPrompt, generation: number, restoreOnFailure: boolean): Promise<boolean> {
		if (generation !== this.generation) return false;
		if (!this.isBusy()) {
			// This send starts a run. The UI paints it as started now, so count it busy and make it
			// the task before Pi's agent_start arrives: a message typed in between is still judged.
			this.currentTask = entry.text;
			if (!entry.text.trimStart().startsWith("/")) this.awaitingRunStart = true;
		}
		this.dispatchCount += 1;
		this.options.onDispatchStart?.(entry.text);
		try {
			const disposition = await this.options.sendPrompt(entry.text, { streamingBehavior: entry.delivery });
			// Only a started prompt brings an agent_start; for any other disposition (an input hook
			// handled it, or Pi had already queued it) nothing else would clear the latch.
			if (disposition !== undefined && disposition !== "started") this.awaitingRunStart = false;
			return generation === this.generation;
		} catch (error) {
			// A failed send started no run, or its agent_start will say otherwise.
			this.awaitingRunStart = false;
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
