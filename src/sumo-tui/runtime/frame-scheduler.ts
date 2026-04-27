export type FrameRenderCallback = () => void | Promise<void>;

export interface FrameSchedulerOptions {
	readonly render: FrameRenderCallback;
	readonly frameIntervalMs?: number;
	readonly maxQueueDepth?: number;
	readonly setTimeout?: typeof setTimeout;
	readonly clearTimeout?: typeof clearTimeout;
}

/** Adaptive renderer scheduler: event-driven when idle, 60fps coalescing while streaming. */
export class FrameScheduler {
	private readonly renderCallback: FrameRenderCallback;
	private readonly frameIntervalMs: number;
	private readonly maxQueueDepth: number;
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private queue: number[] = [];
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private streamingTimer: ReturnType<typeof setTimeout> | undefined;
	private streaming = false;
	private inFlight = false;
	private sequence = 0;

	public constructor(options: FrameSchedulerOptions) {
		this.renderCallback = options.render;
		this.frameIntervalMs = options.frameIntervalMs ?? 16;
		this.maxQueueDepth = options.maxQueueDepth ?? 3;
		this.setTimer = options.setTimeout ?? setTimeout;
		this.clearTimer = options.clearTimeout ?? clearTimeout;
	}

	public requestRender(): void {
		this.enqueueDirtyFrame();
		if (this.streaming) {
			this.ensureStreamingTimer();
			return;
		}
		this.ensureIdleTimer();
	}

	public enterStreamingMode(): void {
		if (this.streaming) return;
		this.streaming = true;
		if (this.idleTimer) {
			this.clearTimer(this.idleTimer);
			this.idleTimer = undefined;
		}
		this.ensureStreamingTimer();
	}

	public exitStreamingMode(): void {
		if (!this.streaming) return;
		this.streaming = false;
		if (this.streamingTimer) {
			this.clearTimer(this.streamingTimer);
			this.streamingTimer = undefined;
		}
		if (this.queue.length > 0) this.ensureIdleTimer();
	}

	public isStreamingMode(): boolean {
		return this.streaming;
	}

	public getQueueDepth(): number {
		return this.queue.length;
	}

	public dispose(): void {
		if (this.idleTimer) this.clearTimer(this.idleTimer);
		if (this.streamingTimer) this.clearTimer(this.streamingTimer);
		this.idleTimer = undefined;
		this.streamingTimer = undefined;
		this.queue = [];
	}

	private enqueueDirtyFrame(): void {
		this.sequence += 1;
		if (this.queue.length >= this.maxQueueDepth) this.queue.shift();
		this.queue.push(this.sequence);
	}

	private ensureIdleTimer(): void {
		if (this.idleTimer) return;
		this.idleTimer = this.setTimer(() => {
			this.idleTimer = undefined;
			void this.flushOnce();
		}, 0);
	}

	private ensureStreamingTimer(): void {
		if (!this.streaming || this.streamingTimer) return;
		this.streamingTimer = this.setTimer(() => {
			this.streamingTimer = undefined;
			void this.flushStreamingTick();
		}, this.frameIntervalMs);
	}

	private async flushStreamingTick(): Promise<void> {
		if (this.queue.length > 0) await this.flushOnce();
		if (this.streaming) this.ensureStreamingTimer();
	}

	private async flushOnce(): Promise<void> {
		if (this.inFlight || this.queue.length === 0) return;
		this.inFlight = true;
		// Coalesce all queued invalidations into the newest frame. The bounded queue
		// still gives us Edge Case 2.4 backpressure semantics: newest state wins and
		// old dirty tokens are dropped before memory can grow.
		this.queue = [];
		try {
			await this.renderCallback();
		} finally {
			this.inFlight = false;
		}
		if (!this.streaming && this.queue.length > 0) this.ensureIdleTimer();
	}
}
