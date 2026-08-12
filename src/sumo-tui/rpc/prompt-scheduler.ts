export interface RpcPromptSchedulerSnapshot {
	readonly busy: boolean;
	readonly dispatching?: boolean;
	readonly queuedMessages: readonly string[];
	readonly sessionId?: string;
	readonly pausedAfterFailure: boolean;
}

export interface RpcPromptSchedulerRestoreOptions {
	readonly discardInFlight?: boolean;
}

export interface RpcPromptDelivery {
	readonly streamingBehavior?: "steer";
}

export type RpcPromptForceSendResult = "accepted" | "held" | "ignored" | "unknown";

export class RpcPromptPreflightRejection extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "RpcPromptPreflightRejection";
	}
}

export interface RpcPromptScheduler {
	submit(message: string, options?: { forceQueue?: boolean }): Promise<"sent" | "queued" | "ignored" | "handled">;
	forceSendNext(): Promise<RpcPromptForceSendResult>;
	handleAgentEvent(event: unknown): void;
	restoreAll(currentDraft: string, options?: RpcPromptSchedulerRestoreOptions): { count: number; text: string };
	rebindSession(sessionId: string | undefined, currentDraft: string): { count: number; text: string };
	getSnapshot(): RpcPromptSchedulerSnapshot;
}

export interface RpcPromptSchedulerOptions {
	readonly sessionId?: string;
	readonly sendPrompt: (message: string, delivery?: RpcPromptDelivery) => Promise<void>;
	readonly getBusy?: () => boolean;
	readonly canForceSteer?: () => boolean;
	readonly handleHostCommand?: (message: string) => boolean | Promise<boolean>;
	readonly onQueueChange?: (messages: readonly string[]) => void;
	readonly onDispatchStart?: (message: string) => void;
	readonly onDispatchFailure?: (error: unknown) => void;
	/**
	 * Repaint optimistic dispatch state from the host's authoritative state when
	 * a force-send fails without a follow-up agent event.
	 */
	readonly onDispatchStateSync?: () => void;
	readonly onSteerAcceptanceUnknown?: (message: string, error: unknown) => void;
}

type AgentEventLike = {
	type?: unknown;
	message?: { role?: unknown };
	steering?: unknown;
};

function eventType(event: unknown): string | undefined {
	const type = (event as AgentEventLike).type;
	return typeof type === "string" ? type : undefined;
}

function isUserMessageStart(event: unknown): boolean {
	return (event as AgentEventLike).message?.role === "user";
}

function steeringQueue(event: unknown): readonly string[] | undefined {
	const steering = (event as AgentEventLike).steering;
	return Array.isArray(steering) && steering.every((message) => typeof message === "string") ? steering : undefined;
}

function isSteeringQueueAppend(previous: readonly string[] | undefined, current: readonly string[]): boolean {
	if (previous === undefined) return current.length > 0;
	return current.length === previous.length + 1 && previous.every((message, index) => current[index] === message);
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
	private agentStartCount = 0;
	private agentSettledCount = 0;
	private turnEndCount = 0;
	private piSteeringQueue: readonly string[] | undefined;
	private forceSteerState: {
		readonly startCountAtDispatch: number;
		readonly turnEndCountAtDispatch: number;
		phase: "pending" | "accepted";
		ownership: "unresolved" | "pi-queued";
		lifecycleStarted: boolean;
		settledCountAtStart?: number;
		lifecycleSettled: boolean;
	} | undefined;

	public constructor(private readonly options: RpcPromptSchedulerOptions) {
		this.sessionId = options.sessionId;
	}

	public async submit(message: string, options: { forceQueue?: boolean } = {}): Promise<"sent" | "queued" | "ignored" | "handled"> {
		if (message.trim().length === 0) return "ignored";
		if (await this.options.handleHostCommand?.(message)) return "handled";
		const forceQueue = options.forceQueue === true;
		const forceSteerBarrier = this.forceSteerState !== undefined;
		if (forceQueue && ((!this.isBusy() && !forceSteerBarrier) || this.pausedAfterFailure)) return "ignored";
		if (this.queue.length > 0) {
			this.pausedAfterFailure = false;
			this.queue.push(message);
			this.publishQueue();
			this.drainOne(this.generation);
			return "queued";
		}
		this.pausedAfterFailure = false;
		if (forceQueue || this.isBusy() || forceSteerBarrier) {
			this.queue.push(message);
			this.publishQueue();
			return "queued";
		}
		void this.dispatch(message, this.generation, { requeueOnFailure: true });
		return "sent";
	}

	public async forceSendNext(): Promise<RpcPromptForceSendResult> {
		const previousBarrier = this.forceSteerState;
		if (
			this.queue.length === 0 ||
			this.dispatching ||
			this.pausedAfterFailure ||
			(this.options.canForceSteer?.() !== true && previousBarrier?.phase !== "accepted")
		) return "ignored";

		const message = this.queue.shift();
		if (message === undefined) return "ignored";
		this.publishQueue();
		this.forceSteerState = {
			startCountAtDispatch: this.agentStartCount,
			turnEndCountAtDispatch: this.turnEndCount,
			phase: "pending",
			ownership: "unresolved",
			lifecycleStarted: false,
			lifecycleSettled: false,
		};
		let outcome: "accepted" | "rejected" | "unknown" | "stale";
		try {
			outcome = await this.dispatch(message, this.generation, {
				requeueOnFailure: false,
				delivery: { streamingBehavior: "steer" },
				forceSteer: true,
			});
		} catch (error) {
			// An explicit rejection restores this message. Keep the older barrier
			// too, because Pi's disposition for the prior force-send is unchanged.
			if (this.forceSteerState === undefined) this.forceSteerState = previousBarrier;
			throw error;
		}
		if (outcome === "stale") {
			this.options.onSteerAcceptanceUnknown?.(message, new Error("steering acceptance invalidated by session recovery"));
			return "unknown";
		}
		if (outcome !== "accepted") return "unknown";
		return this.forceSteerState?.ownership === "pi-queued" ? "accepted" : "held";
	}

	public handleAgentEvent(event: unknown): void {
		switch (eventType(event)) {
			case "agent_start":
				this.busy = true;
				this.agentStartCount += 1;
				this.markForceSteerLifecycleStarted(this.canStartForceSteerLifecycleFromAgentStart());
				break;
			case "message_start":
				// Pi may transform the submitted text before it emits the user
				// message_start. The event's position after the current turn boundary,
				// not its rendered text, is the authoritative steering boundary.
				if (isUserMessageStart(event)) this.markForceSteerLifecycleStarted(this.canStartForceSteerLifecycleFromUserMessage());
				break;
			case "queue_update": {
				// Pi 0.83 emits queue_update synchronously when _queueSteer appends
				// the message, before the RPC prompt response. Its absence is not a
				// safe disposition signal: an input extension may handle the message,
				// or Pi may have become idle and started it as a normal prompt.
				const steering = steeringQueue(event);
				if (steering !== undefined) {
					const forceSteer = this.forceSteerState;
					if (forceSteer?.ownership === "unresolved" && isSteeringQueueAppend(this.piSteeringQueue, steering)) {
						forceSteer.ownership = "pi-queued";
					}
					this.piSteeringQueue = [...steering];
				}
				break;
			}
			case "turn_end":
				this.turnEndCount += 1;
				break;
			case "compaction_end":
				// The RPC host delivers events here after updating RpcHostStateStore, so
				// getBusy() observes manual compaction as idle while agent_start-owned
				// auto-compaction remains protected by this.busy until agent_settled.
				this.drainOne(this.generation);
				break;
			case "agent_settled":
				this.busy = false;
				this.agentSettledCount += 1;
				this.updateForceSteerLifecycle();
				this.drainOne(this.generation);
				break;
			default:
				break;
		}
	}

	public restoreAll(currentDraft: string, options: RpcPromptSchedulerRestoreOptions = {}): { count: number; text: string } {
		const restored = this.queue;
		this.queue = [];
		this.pausedAfterFailure = false;
		if (options.discardInFlight) {
			this.generation += 1;
			this.busy = false;
			this.dispatching = false;
			this.forceSteerState = undefined;
			this.piSteeringQueue = undefined;
		}
		this.publishQueue();
		return { count: restored.length, text: combineDrafts(restored, currentDraft) };
	}

	public rebindSession(sessionId: string | undefined, currentDraft: string): { count: number; text: string } {
		const restored = this.restoreAll(currentDraft);
		this.sessionId = sessionId;
		this.generation += 1;
		this.busy = false;
		this.dispatching = false;
		this.forceSteerState = undefined;
		this.piSteeringQueue = undefined;
		this.pausedAfterFailure = false;
		return restored;
	}

	public getSnapshot(): RpcPromptSchedulerSnapshot {
		return {
			busy: this.isBusy(),
			dispatching: this.dispatching,
			queuedMessages: [...this.queue],
			sessionId: this.sessionId,
			pausedAfterFailure: this.pausedAfterFailure,
		};
	}

	private drainOne(generation: number): void {
		if (
			this.pausedAfterFailure ||
			this.dispatching ||
			this.busy ||
			this.options.getBusy?.() === true ||
			(this.forceSteerState?.phase === "accepted" && !this.forceSteerState.lifecycleSettled)
		) return;
		if (this.forceSteerState?.phase === "accepted" && this.forceSteerState.lifecycleSettled) {
			this.forceSteerState = undefined;
		}
		const message = this.queue.shift();
		if (message === undefined) return;
		this.publishQueue();
		void this.dispatch(message, generation, { requeueOnFailure: true });
	}

	private isBusy(): boolean {
		return this.busy || this.dispatching || this.options.getBusy?.() === true;
	}

	private canStartForceSteerLifecycleFromAgentStart(): boolean {
		const forceSteer = this.forceSteerState;
		if (!forceSteer) return false;
		return this.agentStartCount > forceSteer.startCountAtDispatch;
	}

	private canStartForceSteerLifecycleFromUserMessage(): boolean {
		const forceSteer = this.forceSteerState;
		if (!forceSteer || (forceSteer.phase !== "accepted" && forceSteer.ownership !== "pi-queued")) return false;
		return this.turnEndCount > forceSteer.turnEndCountAtDispatch;
	}

	private markForceSteerLifecycleStarted(started: boolean): void {
		const forceSteer = this.forceSteerState;
		if (!forceSteer || !started || forceSteer.lifecycleStarted) return;
		forceSteer.lifecycleStarted = true;
		forceSteer.settledCountAtStart = this.agentSettledCount;
		this.updateForceSteerLifecycle();
	}

	private updateForceSteerLifecycle(): void {
		const forceSteer = this.forceSteerState;
		if (!forceSteer || forceSteer.phase !== "accepted" || !forceSteer.lifecycleStarted) return;
		if (forceSteer.settledCountAtStart !== undefined && this.agentSettledCount > forceSteer.settledCountAtStart) {
			forceSteer.lifecycleSettled = true;
		}
	}

	private async dispatch(
		message: string,
		generation: number,
		options: {
			readonly requeueOnFailure: boolean;
			readonly delivery?: RpcPromptDelivery;
			readonly forceSteer?: boolean;
		},
	): Promise<"accepted" | "rejected" | "unknown" | "stale"> {
		if (generation !== this.generation) return "stale";
		this.dispatching = true;
		this.busy = true;
		const dispatchAgentStartCount = this.agentStartCount;
		let outcome: "accepted" | "rejected" | "unknown" = "accepted";
		let rejection: unknown;
		this.options.onDispatchStart?.(message);
		try {
			if (options.delivery) await this.options.sendPrompt(message, options.delivery);
			else await this.options.sendPrompt(message);
			if (generation !== this.generation) return "stale";
			if (options.forceSteer && this.forceSteerState) {
				// A successful prompt response confirms acceptance, but Pi 0.83 does
				// not report whether an absent queue_update means "handled" or
				// "started normally after becoming idle". Keep the remaining host
				// FIFO behind this barrier until an authoritative lifecycle settles.
				this.forceSteerState.phase = "accepted";
				this.updateForceSteerLifecycle();
			}
		} catch (error) {
			if (generation !== this.generation) return "stale";
			let syncDispatchState = false;
			if (options.forceSteer) {
				syncDispatchState = true;
				if (error instanceof RpcPromptPreflightRejection) {
					this.queue.unshift(message);
					this.pausedAfterFailure = true;
					this.publishQueue();
					this.forceSteerState = undefined;
					outcome = "rejected";
					rejection = error;
				} else {
					this.pausedAfterFailure = true;
					this.publishQueue();
					if (this.forceSteerState) this.forceSteerState.phase = "accepted";
					outcome = "unknown";
					this.options.onSteerAcceptanceUnknown?.(message, error);
				}
			} else {
				if (options.requeueOnFailure) {
					this.queue.unshift(message);
					this.pausedAfterFailure = true;
					this.publishQueue();
				}
				this.options.onDispatchFailure?.(error);
			}
			this.busy = this.agentStartCount !== dispatchAgentStartCount || this.options.getBusy?.() === true;
			if (syncDispatchState) this.options.onDispatchStateSync?.();
		} finally {
			if (generation === this.generation) {
				this.dispatching = false;
				if (!this.busy && !this.pausedAfterFailure) this.drainOne(generation);
			}
		}
		if (rejection !== undefined) throw rejection;
		return outcome;
	}

	private publishQueue(): void {
		this.options.onQueueChange?.([...this.queue]);
	}
}
