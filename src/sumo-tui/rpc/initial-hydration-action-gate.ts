export type DeferredHydrationAction = () => void | Promise<void>;
export type DeferredHydrationConditionalAction = () => boolean | Promise<boolean>;

export interface InitialHydrationActionGateOptions {
	readonly onReady?: () => void;
}

/**
 * Keeps child-dependent shortcuts inert while initial RPC hydration owns the
 * state/transcript event buffer. The latest intent per action key is retained;
 * a conditional intent also keeps the presses it superseded, and replays them
 * newest-first when it cannot act on hydrated state. On hydration the retained
 * intents replay serially, and `whenSettled()` only resolves once every
 * replayed intent has fully completed. Submissions gate on
 * `whenSettled()` so a prompt cannot dispatch under a model/thinking level that
 * a deferred cycle is still applying. Typing, interrupt, and exit routing stay
 * outside this gate.
 */
export class InitialHydrationActionGate {
	private ready = false;
	private readonly pending = new Map<string, DeferredHydrationAction>();
	private readonly settled: Promise<void>;

	public constructor(initialHydration: Promise<void>, options: InitialHydrationActionGateOptions = {}) {
		this.settled = initialHydration.then(async () => {
			// Re-drain anything queued while an earlier intent awaited so a late
			// pre-ready shortcut is never dropped, then open the immediate path.
			while (this.pending.size > 0) {
				const actions = [...this.pending.values()];
				this.pending.clear();
				for (const action of actions) {
					try {
						await action();
					} catch {
						// Individual handlers own their own error reporting.
					}
				}
			}
			this.ready = true;
			try {
				options.onReady?.();
			} catch {
				// Readiness observers are advisory. A failed diagnostic must not
				// reject submit waiters after hydration has already settled.
			}
		});
	}

	/** True only after hydration and every retained action have settled. */
	public get isReady(): boolean {
		return this.ready;
	}

	public run(key: string, action: DeferredHydrationAction): void {
		if (this.ready) {
			void action();
			return;
		}
		this.pending.set(key, action);
	}

	/**
	 * Retain `action` as the key's latest intent; when it cannot act on hydrated
	 * state it falls back to the intents it superseded, newest first, so a
	 * pre-hydration press is never silently dropped.
	 */
	public runWithFallback(key: string, action: DeferredHydrationConditionalAction): void {
		if (this.ready) {
			void action();
			return;
		}
		const fallback = this.pending.get(key);
		this.pending.set(key, async () => {
			if (!(await action())) await fallback?.();
		});
	}

	/** Resolves after hydration commits and every deferred intent has drained. */
	public whenSettled(): Promise<void> {
		return this.settled;
	}
}
