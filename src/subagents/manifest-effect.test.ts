import { getEventListeners } from "node:events";
import { expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { buildCompletionManifest, type CompletionManifest } from "./manifest.js";
import { collectManifestWithin, type ManifestCollection } from "./manifest-effect.js";
import { SubagentManager } from "./manager.js";
import type { SubagentEvent } from "./domain.js";

const complete: CompletionManifest = { baseRef: "base", changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 };

const fixture = Effect.fn("manifestTest.fixture")(function* () {
	const clock = yield* Clock.Clock;
	const owner = new AbortController();
	let finish: (value: CompletionManifest) => void = () => undefined;
	let signal: AbortSignal | undefined;
	let sleeps = 0;
	const build = vi.fn<ManifestCollection["build"]>((options) => {
		signal = options.signal;
		return new Promise((resolve) => { finish = resolve; });
	});
	const onFailure = vi.fn();
	const collection: ManifestCollection = {
		options: { cwd: "/repo", baseRef: "base", outcome: { kind: "completed", finalText: "done" }, startedAt: 0, signal: owner.signal },
		build, timeoutMs: 5000, fallback: { exit: "completed", durationMs: 1 }, onFailure,
	};
	const trackedClock: Clock.Clock = { ...clock, sleep: (duration) => Effect.sync(() => { sleeps++; }).pipe(
		Effect.andThen(clock.sleep(duration)), Effect.ensuring(Effect.sync(() => { sleeps--; })),
	) };
	const start = Effect.fn("manifestTest.start")(function* () {
		const fiber = yield* Effect.forkChild(Effect.promise(() => collectManifestWithin(collection, trackedClock)));
		// WAIT-CLASS: clock-contract — enter the owned collection deadline without advancing time
		yield* TestClock.adjust(0);
		return fiber;
	});
	return { collection, start, owner, build, onFailure, finish: () => finish(complete), signal: () => signal,
		assertDrained: () => { expect(sleeps).toBe(0); expect(getEventListeners(owner.signal, "abort")).toHaveLength(0); } };
});

it.effect("the five-second deadline interrupts losing work and ignores its late result", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — evidence collection keeps 500ms of the deadline for cleanup
	yield* TestClock.adjust(4499);
	expect(fiber.pollUnsafe()).toBeUndefined();
	expect(f.signal()?.aborted).toBe(false);
	// WAIT-CLASS: clock-contract — early termination ends the losing collection exactly once
	yield* TestClock.adjust(1);
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	expect(f.signal()?.aborted).toBe(true);
	f.finish();
	// WAIT-CLASS: negative-observation — late builder completion cannot resurrect the wait
	yield* TestClock.adjust(10_000);
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	expect(f.build).toHaveBeenCalledOnce();
	f.assertDrained();
}));

it.effect("a failed late builder cannot diagnose or publish after timeout", () => Effect.gen(function* () {
	const f = yield* fixture();
	let reject: (error: Error) => void = () => undefined;
	f.build.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — end the collection before its late rejection
	yield* TestClock.adjust(5000);
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	reject(new Error("late failure"));
	// WAIT-CLASS: negative-observation — stale failure cannot emit new diagnostics after teardown
	yield* TestClock.adjust(0);
	expect(f.onFailure).not.toHaveBeenCalled();
	f.assertDrained();
}));

it.effect("successful evidence cancels the deadline and drains the runtime", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.finish();
	expect(yield* Fiber.join(fiber)).toEqual(complete);
	f.assertDrained();
}));

it.effect("the public deadline bounds delayed Git drain and freezes honest partial evidence", () => Effect.gen(function* () {
	const f = yield* fixture();
	let close: () => void = () => undefined;
	const closed = new Promise<undefined>((resolve) => { close = () => resolve(undefined); });
	f.build.mockImplementation((options) => {
		options.onGitRead?.(closed);
		return new Promise(() => undefined);
	});
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — termination reserves the last 500ms for drain
	yield* TestClock.adjust(4500);
	expect(f.build.mock.calls[0][0].signal?.aborted).toBe(true);
	expect(fiber.pollUnsafe()).toBeUndefined();
	// WAIT-CLASS: clock-contract — unavailable close receipts cannot extend the public deadline
	yield* TestClock.adjust(500);
	const evidence = yield* Fiber.join(fiber);
	expect(evidence).toEqual({ ...f.collection.fallback, cleanup: "unproven" });
	f.assertDrained();
	close();
	// WAIT-CLASS: negative-observation — late drain cannot revise published partial evidence
	yield* TestClock.adjust(0);
	expect(yield* Fiber.join(fiber)).toBe(evidence);
	expect(evidence).toEqual({ ...f.collection.fallback, cleanup: "unproven" });
}));

it.effect("drain proven inside the reserved budget returns partial evidence before the deadline", () => Effect.gen(function* () {
	const f = yield* fixture();
	let close: () => void = () => undefined;
	const closed = new Promise<undefined>((resolve) => { close = () => resolve(undefined); });
	f.build.mockImplementation((options) => {
		options.onGitRead?.(closed);
		return new Promise(() => undefined);
	});
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — termination begins with drain time left in the budget
	yield* TestClock.adjust(4750);
	close();
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	f.assertDrained();
}));

it.effect.each(["failure", "synchronous throw"])("%s reports once even if diagnostics throw", (mode) => Effect.gen(function* () {
	const f = yield* fixture();
	f.onFailure.mockImplementation(() => { throw new Error("broken sink"); });
	f.build.mockImplementation(() => {
		if (mode === "synchronous throw") throw new Error("broken builder");
		return Promise.reject(new Error("broken builder"));
	});
	const fiber = yield* f.start();
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	expect(f.onFailure).toHaveBeenCalledOnce();
	f.assertDrained();
}));

it.effect("an already disposed owner never starts Git work", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.owner.abort();
	const fiber = yield* f.start();
	expect(yield* Fiber.join(fiber)).toEqual(f.collection.fallback);
	expect(f.build).not.toHaveBeenCalled();
	f.assertDrained();
}));

it.effect.each(["deadline", "disposeAll", "prepareForReplacement"] as const)("%s drains an old manifest without consuming or mutating the next generation", (method) => Effect.gen(function* () {
	const clock = yield* Clock.Clock;
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const builders: Array<{ signal?: AbortSignal; close: () => void; resolve: (value: CompletionManifest) => void }> = [];
	const manager = new SubagentManager((task) => ({
		events: (emit) => { emitters.set(task.id, emit); emit({ kind: "run-started" }); },
		interrupt: () => undefined,
	}), {
		captureGitContext: async () => ({ baseRef: "base" }),
		buildCompletionManifest: (options) => new Promise((resolve) => {
			let close: () => void = () => undefined;
			options.onGitRead?.(new Promise<undefined>((closed) => { close = () => closed(undefined); }));
			builders.push({ signal: options.signal, close, resolve });
		}),
		collectCompletionManifest: (options, build, onFailure) => collectManifestWithin({ options, build: build ?? buildCompletionManifest, onFailure: onFailure ?? (() => undefined), timeoutMs: 5000,
			fallback: { exit: options.outcome.kind, durationMs: 1 } }, clock),
	});
	try {
		const old = yield* Effect.promise(() => manager.spawn({ cwd: "/repo", title: "old", prompt: "old" }));
		if (!("id" in old)) throw new Error("unexpected capacity refusal");
		emitters.get(old.id)!({ kind: "run-settled", outcome: { kind: "completed", finalText: "old" } });
		// WAIT-CLASS: clock-contract — enter the first generation's manifest wait
		yield* TestClock.adjust(0);
		if (method === "deadline") {
			// WAIT-CLASS: clock-contract — old completion is public by the original deadline despite missing drain
			yield* TestClock.adjust(5000);
		} else manager[method]();
		const waiting = yield* Effect.forkChild(Effect.promise(() => manager.waitFor([old.id])));
		expect((yield* Fiber.join(waiting))[0].manifest).toEqual({ exit: "completed", durationMs: 1, cleanup: "unproven" });
		expect(builders[0].signal?.aborted).toBe(true);
		const next = yield* Effect.promise(() => manager.spawn({ cwd: "/repo", title: "new", prompt: "new" }));
		if (!("id" in next)) throw new Error("unexpected capacity refusal");
		emitters.get(next.id)!({ kind: "run-settled", outcome: { kind: "completed", finalText: "new" } });
		// WAIT-CLASS: clock-contract — the next generation owns an independent manifest deadline
		yield* TestClock.adjust(0);
		const before = manager.list();
		const notifications = vi.fn();
		const unsubscribe = manager.addChangeListener(notifications);
		builders[0].close();
		builders[0].resolve({ ...complete, headRef: "stale" });
		// WAIT-CLASS: negative-observation — old completion cannot publish or consume the new result
		yield* TestClock.adjust(0);
		expect(manager.list()).toEqual(before);
		expect(notifications).not.toHaveBeenCalled();
		expect(manager.consumedIds.has(next.id)).toBe(false);
		expect(builders[1].signal?.aborted).toBe(false);
		builders[1].close();
		builders[1].resolve(complete);
		const nextWait = yield* Effect.forkChild(Effect.promise(() => manager.waitFor([next.id])));
		expect((yield* Fiber.join(nextWait))[0]).toMatchObject({ status: "done", finalText: "new", manifest: complete });
		expect(notifications).toHaveBeenCalledOnce();
		unsubscribe();
	} finally { manager.disposeAll(); }
}));
