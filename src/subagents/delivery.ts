export interface DeliveryPayload {
	readonly id: string;
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
	/**
	 * Send pending payloads in FIFO order, acknowledging each only after send
	 * returns. A throw preserves that payload for at-least-once retry, so an
	 * ambiguous send failure may be observed again by the receiver.
	 */
	flush(send: (payload: DeliveryPayload) => void): void;
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
		flush(send): void {
			for (const [id, payload] of pending) {
				send(payload);
				// Map iteration safely advances after deleting the current entry. A
				// thrown send leaves this id and every later payload in FIFO order.
				pending.delete(id);
			}
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
