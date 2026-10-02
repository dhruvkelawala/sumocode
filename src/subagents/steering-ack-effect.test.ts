import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { waitForSteeringAck, type SteeringAckWait } from "./steering-ack-effect.js";

it.each(["first sleep", "scheduled poll"])("an active wait exits naturally during %s", (phase) => {
	const modulePath = fileURLToPath(new URL("./steering-ack-effect.ts", import.meta.url));
	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createJiti } from "jiti";
const { waitForSteeringAck } = await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});
const repeat = ${JSON.stringify(phase === "scheduled poll")};
const keeper = repeat ? setInterval(() => {}, 1000) : undefined;
let inspections = 0;
let settled = false;
const controller = new AbortController();
void waitForSteeringAck({
	pollMs: 250, timeoutMs: 30_000, terminalSignal: controller.signal,
	inspect: () => { inspections++; clearInterval(keeper); return "pending"; },
	timeout: () => new Error("acknowledgement budget expired"),
	onFailure: () => { throw new Error("unexpected wait failure"); },
}).then(() => { settled = true; }, () => { settled = true; });
process.on("beforeExit", () => {
	assert.equal(inspections, repeat ? 1 : 0);
	assert.equal(settled, false);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	console.log("active wait exited naturally");
});
`], {
		encoding: "utf8", timeout: 5000,
		env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
	});
	expect(stdout).toContain("active wait exited naturally");
}, 10_000);

const fixture = Effect.fn("steeringAckTest.fixture")(function* () {
	const clock = yield* Clock.Clock;
	const controller = new AbortController();
	const onFailure = vi.fn();
	const removeListener = vi.spyOn(controller.signal, "removeEventListener");
	let observation: ReturnType<SteeringAckWait["inspect"]> = "pending";
	let sleepers = 0;
	let completions = 0;
	const trackedClock: Clock.Clock = {
		...clock,
		sleep: (duration) => Effect.sync(() => { sleepers++; }).pipe(
			Effect.andThen(clock.sleep(duration)),
			Effect.ensuring(Effect.sync(() => { sleepers--; })),
		),
	};
	const inspect = vi.fn<SteeringAckWait["inspect"]>(() => observation);
	const timeout = vi.fn<SteeringAckWait["timeout"]>(() => new Error("unconfirmed timeout; file retained"));
	const options: SteeringAckWait = {
		pollMs: 250, timeoutMs: 1000, terminalSignal: controller.signal,
		inspect,
		timeout,
		onFailure,
	};
	const start = Effect.fn("steeringAckTest.start")(function* () {
		const fiber = yield* Effect.forkChild(Effect.exit(Effect.tryPromise({
			try: () => waitForSteeringAck(options, trackedClock).finally(() => { completions++; }),
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		})));
		// WAIT-CLASS: clock-contract — let the owned runtime enter its first poll sleep without advancing the deadline
		yield* TestClock.adjust(0);
		expect(sleepers).toBe(1);
		return fiber;
	});
	return {
		start, onFailure, inspect, timeout,
		terminal: (outcome: "consumed" | Error) => { observation = outcome; controller.abort(); },
		consume: () => { observation = "consumed"; },
		assertDrained: () => {
			expect(sleepers).toBe(0);
			expect(completions).toBe(1);
			expect(removeListener).toHaveBeenCalledOnce();
		},
	};
});

it.effect("consumed control wins settlement before the next poll and awaits teardown", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.terminal("consumed");
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	f.terminal(new Error("later settlement"));
	f.assertDrained();
	expect(fiber.pollUnsafe()).toBeDefined();
	expect(f.onFailure).not.toHaveBeenCalled();
}));

it.effect("poll consumption cancels the losing terminal subscription", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.consume();
	// WAIT-CLASS: clock-contract — consumption is observed at the unchanged 250ms cadence
	yield* TestClock.adjust(250);
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	f.assertDrained();
}));

it.effect("unconsumed control times out once, without retry or a surviving poller", () => Effect.gen(function* () {
	const f = yield* fixture();
	const { timeout, inspect } = f;
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — no timeout before the 1000ms consumption budget
	yield* TestClock.adjust(999);
	expect(timeout).not.toHaveBeenCalled();
	// WAIT-CLASS: clock-contract — the fourth poll reaches the budget
	yield* TestClock.adjust(1);
	const exit = yield* Fiber.join(fiber);
	expect(Exit.isFailure(exit)).toBe(true);
	expect(timeout).toHaveBeenCalledOnce();
	const reads = inspect.mock.calls.length;
	// WAIT-CLASS: negative-observation — advancing past terminal teardown cannot run a poll or retry
	yield* TestClock.adjust(10_000);
	expect(inspect).toHaveBeenCalledTimes(reads);
	f.assertDrained();
}));

it.effect.each(["child settlement", "authority loss", "owner shutdown"])("%s rejects immediately and drains its wait", (reason) => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.terminal(new Error(reason));
	const exit = yield* Fiber.join(fiber);
	expect(Exit.isFailure(exit)).toBe(true);
	f.assertDrained();
	expect(fiber.pollUnsafe()).toBeDefined();
	expect(f.onFailure).not.toHaveBeenCalled();
}));

it.effect("concurrent waits have independent outcomes and teardown", () => Effect.gen(function* () {
	const consumed = yield* fixture();
	const rejected = yield* fixture();
	const first = yield* consumed.start();
	const second = yield* rejected.start();
	consumed.terminal("consumed");
	expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true);
	consumed.assertDrained();
	expect(second.pollUnsafe()).toBeUndefined();
	rejected.terminal(new Error("authority lost"));
	expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true);
	rejected.assertDrained();
}));

it.effect("consumption at the final timeout inspection still succeeds", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.timeout.mockImplementation(() => "consumed");
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — consumption wins the last fenced check at the budget boundary
	yield* TestClock.adjust(1000);
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	expect(f.timeout).toHaveBeenCalledOnce();
	f.assertDrained();
}));

it.effect("inspection failure reaches diagnostics and drains even when diagnostics throw", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.inspect.mockImplementation(() => { throw new Error("inspection failed"); });
	f.onFailure.mockImplementation(() => { throw new Error("diagnostic sink failed"); });
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — fail the first inspection at its scheduled poll
	yield* TestClock.adjust(250);
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	expect(f.onFailure).toHaveBeenCalledOnce();
	f.assertDrained();
}));
