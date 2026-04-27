import { describe, expect, it, vi } from "vitest";
import { FrameScheduler } from "./frame-scheduler.js";

describe("FrameScheduler", () => {
	it("coalesces idle render requests onto the next tick", async () => {
		vi.useFakeTimers();
		const render = vi.fn();
		const scheduler = new FrameScheduler({ render });

		scheduler.requestRender();
		scheduler.requestRender();
		expect(scheduler.getQueueDepth()).toBe(2);
		await vi.runAllTimersAsync();

		expect(render).toHaveBeenCalledTimes(1);
		expect(scheduler.getQueueDepth()).toBe(0);
		scheduler.dispose();
		vi.useRealTimers();
	});

	it("drops oldest dirty tokens when backpressure queue exceeds max depth (EC-2.4)", () => {
		vi.useFakeTimers();
		const scheduler = new FrameScheduler({ render: () => undefined, maxQueueDepth: 3 });
		scheduler.enterStreamingMode();
		scheduler.requestRender();
		scheduler.requestRender();
		scheduler.requestRender();
		scheduler.requestRender();

		expect(scheduler.getQueueDepth()).toBe(3);
		scheduler.dispose();
		vi.useRealTimers();
	});

	it("renders at streaming cadence only when dirty", async () => {
		vi.useFakeTimers();
		const render = vi.fn();
		const scheduler = new FrameScheduler({ render, frameIntervalMs: 16 });

		scheduler.enterStreamingMode();
		await vi.advanceTimersByTimeAsync(16);
		expect(render).not.toHaveBeenCalled();
		scheduler.requestRender();
		await vi.advanceTimersByTimeAsync(16);
		expect(render).toHaveBeenCalledTimes(1);
		scheduler.exitStreamingMode();
		expect(scheduler.isStreamingMode()).toBe(false);
		scheduler.dispose();
		vi.useRealTimers();
	});
});
