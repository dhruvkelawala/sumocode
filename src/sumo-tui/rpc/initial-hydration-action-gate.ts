export type DeferredHydrationAction = () => void;

/**
 * Keeps child-dependent shortcuts inert while initial RPC hydration owns the
 * state/transcript event buffer. One latest intent per action key is replayed
 * after hydration; typing, interrupt, and exit routing stay outside this gate.
 */
export class InitialHydrationActionGate {
	private ready = false;
	private readonly pending = new Map<string, DeferredHydrationAction>();

	public constructor(initialHydration: Promise<void>) {
		void initialHydration.then(() => {
			this.ready = true;
			const pending = [...this.pending.values()];
			this.pending.clear();
			for (const action of pending) action();
		});
	}

	public run(key: string, action: DeferredHydrationAction): void {
		if (this.ready) {
			action();
			return;
		}
		this.pending.set(key, action);
	}
}
