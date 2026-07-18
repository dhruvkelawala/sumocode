import { describe, expect, it, vi } from "vitest";
import { createDeferredResultDelivery, type DeliveryPayload } from "./delivery.js";

const payload = (id: string): DeliveryPayload => ({
	id,
	title: `title ${id}`,
	status: "done",
	content: `result ${id}`,
	details: { id },
});

describe("deferred result delivery", () => {
	it("defers payloads until drain, then clears them", () => {
		const delivery = createDeferredResultDelivery();
		delivery.defer("sa-1", () => payload("sa-1"));
		delivery.defer("sa-2", () => payload("sa-2"));

		expect(delivery.size).toBe(2);
		expect(delivery.drain()).toEqual([payload("sa-1"), payload("sa-2")]);
		expect(delivery.size).toBe(0);
	});

	it("does not defer an id consumed before settlement", () => {
		const delivery = createDeferredResultDelivery();
		const build = vi.fn(() => payload("sa-1"));
		delivery.consume("sa-1");

		delivery.defer("sa-1", build);

		expect(build).not.toHaveBeenCalled();
		expect(delivery.drain()).toEqual([]);
	});

	it("removes a deferred payload when it is consumed", () => {
		const delivery = createDeferredResultDelivery();
		delivery.defer("sa-1", () => payload("sa-1"));

		delivery.consume("sa-1");

		expect(delivery.size).toBe(0);
		expect(delivery.drain()).toEqual([]);
	});

	it("returns an empty array when drained twice", () => {
		const delivery = createDeferredResultDelivery();
		delivery.defer("sa-1", () => payload("sa-1"));

		expect(delivery.drain()).toHaveLength(1);
		expect(delivery.drain()).toEqual([]);
	});

	it("forget drops both pending and consumed tracking for pruned ids", () => {
		const delivery = createDeferredResultDelivery();
		delivery.defer("sa-1", () => ({ id: "sa-1", title: "t", status: "done", content: "c", details: {} }));
		delivery.consume("sa-2");
		delivery.forget("sa-1");
		delivery.forget("sa-2");
		expect(delivery.size).toBe(0);
		// After forget, a fresh defer for the same id is accepted again.
		delivery.defer("sa-2", () => ({ id: "sa-2", title: "t", status: "done", content: "c", details: {} }));
		expect(delivery.size).toBe(1);
	});
});
