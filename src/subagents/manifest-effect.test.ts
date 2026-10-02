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
	// WAIT-CLASS: clock-contract — completion must not time out before the existing deadline
	yield* TestClock.adjust(4999);
	expect(fiber.pollUnsafe()).toBeUndefined();
	expect(f.signal()?.aborted).toBe(false);
	// WAIT-CLASS: clock-contract — deadline ends the losing collection exactly once
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

it.effect("successful evidence cancels the deadline and drains the runtime", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.finish();
	expect(yield* Fiber.join(fiber)).toEqual(complete);
	f.assertDrained();
}));

it.effect("timeout awaits Git close receipts rather than just sending a signal", () => Effect.gen(function* () {
	const f = yield* fixture();
	let close: () => void = () => undefined;
	const closed = new Promise<undefined>((resolve) => { close = () => resolve(undefined); });
	f.build.mockImplementation((options) => {
		options.onGitRead?.(closed);
		return new Promise(() => undefined);
	});
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — timeout must await the adapter's real close receipt
	yield* TestClock.adjust(5000);
	expect(fiber.pollUnsafe()).toBeUndefined();
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

it.effect.each(["disposeAll", "prepareForReplacement"] as const)("%s drains an old manifest without consuming or mutating the next generation", (method) => Effect.gen(function* () {
	const clock = yield* Clock.Clock;
	const emitters = new Map<string, (event: SubagentEvent) => void>();
	const builders: Array<{ signal?: AbortSignal; resolve: (value: CompletionManifest) => void }> = [];
	const manager = new SubagentManager((task) => ({
		events: (emit) => { emitters.set(task.id, emit); emit({ kind: "run-started" }); },
		interrupt: () => undefined,
	}), {
		captureGitContext: async () => ({ baseRef: "base" }),
		buildCompletionManifest: (options) => new Promise((resolve) => { builders.push({ signal: options.signal, resolve }); }),
		collectCompletionManifest: (options, build, onFailure) => collectManifestWithin({ options, build: build ?? buildCompletionManifest, onFailure: onFailure ?? (() => undefined), timeoutMs: 5000,
			fallback: { exit: options.outcome.kind, durationMs: 1 } }, clock),
	});
	try {
		const old = yield* Effect.promise(() => manager.spawn({ cwd: "/repo", title: "old", prompt: "old" }));
		if (!("id" in old)) throw new Error("unexpected capacity refusal");
		emitters.get(old.id)!({ kind: "run-settled", outcome: { kind: "completed", finalText: "old" } });
		// WAIT-CLASS: clock-contract — enter the first generation's manifest wait
		yield* TestClock.adjust(0);
		manager[method]();
		const waiting = yield* Effect.forkChild(Effect.promise(() => manager.waitFor([old.id])));
		expect((yield* Fiber.join(waiting))[0].manifest).toEqual({ exit: "completed", durationMs: 1 });
		expect(builders[0].signal?.aborted).toBe(true);
		const next = yield* Effect.promise(() => manager.spawn({ cwd: "/repo", title: "new", prompt: "new" }));
		if (!("id" in next)) throw new Error("unexpected capacity refusal");
		emitters.get(next.id)!({ kind: "run-settled", outcome: { kind: "completed", finalText: "new" } });
		// WAIT-CLASS: clock-contract — the next generation owns an independent manifest deadline
		yield* TestClock.adjust(0);
		const before = manager.list();
		const notifications = vi.fn();
		const unsubscribe = manager.addChangeListener(notifications);
		builders[0].resolve({ ...complete, headRef: "stale" });
		// WAIT-CLASS: negative-observation — old completion cannot publish or consume the new result
		yield* TestClock.adjust(0);
		expect(manager.list()).toEqual(before);
		expect(notifications).not.toHaveBeenCalled();
		expect(manager.consumedIds.has(next.id)).toBe(false);
		expect(builders[1].signal?.aborted).toBe(false);
		builders[1].resolve(complete);
		const nextWait = yield* Effect.forkChild(Effect.promise(() => manager.waitFor([next.id])));
		expect((yield* Fiber.join(nextWait))[0]).toMatchObject({ status: "done", finalText: "new", manifest: complete });
		expect(notifications).toHaveBeenCalledOnce();
		unsubscribe();
	} finally { manager.disposeAll(); }
}));
