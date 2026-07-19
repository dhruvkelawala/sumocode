export interface DeliveryPayload {
	readonly id: string;
	readonly customType?: string;
	readonly title: string;
	readonly status: string;
	readonly content: string;
	readonly details: unknown;
}

export interface DeferredResultDelivery {
	defer(id: string, build: () => DeliveryPayload): void;
	consume(id: string): void;
	/**
	 * Drop CONSUMED tracking for an id whose subagent no longer exists
	 * (pruned). Deliberately leaves a still-pending payload queued: payloads
	 * are eagerly built and self-contained, so an undelivered result survives
	 * the manager's MAX_TRACKED prune and still flushes on the next idle /
	 * agent_end instead of being silently lost.
	 */
	forget(id: string): void;
	drain(): DeliveryPayload[];
	clear(): void;
	readonly size: number;
}

export function createDeferredResultDelivery(): DeferredResultDelivery {
	const pending = new Map<string, DeliveryPayload>();
	const consumed = new Set<string>();

	return {
		defer(id, build): void {
			if (consumed.has(id) || pending.has(id)) return;
			pending.set(id, build());
		},
		consume(id): void {
			consumed.add(id);
			pending.delete(id);
		},
		forget(id): void {
			consumed.delete(id);
		},
		drain(): DeliveryPayload[] {
			const payloads = [...pending.values()];
			pending.clear();
			return payloads;
		},
		clear(): void {
			pending.clear();
			consumed.clear();
		},
		get size(): number {
			return pending.size;
		},
	};
}
