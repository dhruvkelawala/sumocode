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
