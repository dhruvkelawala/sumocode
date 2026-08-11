export type DeferredHydrationAction = () => void | Promise<void>;

/**
 * Keeps child-dependent shortcuts inert while initial RPC hydration owns the
 * state/transcript event buffer. One latest intent per action key is retained;
 * on hydration the retained intents replay serially, and `whenSettled()` only
 * resolves once every replayed intent has fully completed. Submissions gate on
 * `whenSettled()` so a prompt cannot dispatch under a model/thinking level that
 * a deferred cycle is still applying. Typing, interrupt, and exit routing stay
 * outside this gate.
 */
export class InitialHydrationActionGate {
	private ready = false;
	private readonly pending = new Map<string, DeferredHydrationAction>();
	private readonly settled: Promise<void>;

	public constructor(initialHydration: Promise<void>) {
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
		});
	}

	public run(key: string, action: DeferredHydrationAction): void {
		if (this.ready) {
			void action();
			return;
		}
		this.pending.set(key, action);
	}

	/** Resolves after hydration commits and every deferred intent has drained. */
	public whenSettled(): Promise<void> {
		return this.settled;
	}
}
