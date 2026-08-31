import { describe, expect, it, vi } from "vitest";
import { InitialHydrationActionGate } from "./initial-hydration-action-gate.js";

describe("InitialHydrationActionGate", () => {
	it("publishes readiness after the deferred drain and before submit waiters resume", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const order: string[] = [];
		let gate!: InitialHydrationActionGate;
		gate = new InitialHydrationActionGate(hydration, {
			onReady: () => {
				expect(gate.isReady).toBe(true);
				order.push("ready");
			},
		});
		expect(gate.isReady).toBe(false);
		gate.run("model", () => { order.push("deferred"); });
		const submitWaiter = gate.whenSettled().then(() => { order.push("submit"); });

		release();
		await submitWaiter;

		expect(order).toEqual(["deferred", "ready", "submit"]);
		expect(gate.isReady).toBe(true);
	});

	it("settles submit waiters when the ready observer throws", async () => {
		const gate = new InitialHydrationActionGate(Promise.resolve(), {
			onReady: () => { throw new Error("diagnostic observer failed"); },
		});

		await expect(gate.whenSettled()).resolves.toBeUndefined();
		expect(gate.isReady).toBe(true);
	});

	it("defers and coalesces child-dependent actions until hydration", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const gate = new InitialHydrationActionGate(hydration);
		const first = vi.fn();
		const latest = vi.fn();
		const other = vi.fn();

		gate.run("model", first);
		gate.run("model", latest);
		gate.run("palette", other);
		expect(first).not.toHaveBeenCalled();
		expect(latest).not.toHaveBeenCalled();
		expect(other).not.toHaveBeenCalled();

		release();
		await gate.whenSettled();
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledOnce();
		expect(other).toHaveBeenCalledOnce();
	});

	it("keeps only the latest inverse intent under a shared key", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const gate = new InitialHydrationActionGate(hydration);
		const followUp = vi.fn();
		const dequeue = vi.fn();

		gate.run("message-queue", followUp);
		gate.run("message-queue", dequeue);
		release();
		await gate.whenSettled();

		expect(followUp).not.toHaveBeenCalled();
		expect(dequeue).toHaveBeenCalledOnce();
	});

	it("only settles after an async deferred intent fully completes", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const gate = new InitialHydrationActionGate(hydration);

		let applied = false;
		let finishApply!: () => void;
		const applyDone = new Promise<void>((resolve) => { finishApply = resolve; });
		gate.run("model", async () => {
			await applyDone;
			applied = true;
		});

		release();
		let settled = false;
		const settledPromise = gate.whenSettled().then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(applied).toBe(false);

		finishApply();
		await settledPromise;
		expect(applied).toBe(true);
		expect(settled).toBe(true);
	});

	it("replays retained intents in insertion order", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const gate = new InitialHydrationActionGate(hydration);
		const order: string[] = [];

		gate.run("a", async () => { await Promise.resolve(); order.push("a"); });
		gate.run("b", async () => { order.push("b"); });
		release();
		await gate.whenSettled();

		expect(order).toEqual(["a", "b"]);
	});

	it("runs new actions immediately after hydration", async () => {
		const gate = new InitialHydrationActionGate(Promise.resolve());
		await gate.whenSettled();
		const action = vi.fn();
		gate.run("model", action);
		expect(action).toHaveBeenCalledOnce();
	});
});
