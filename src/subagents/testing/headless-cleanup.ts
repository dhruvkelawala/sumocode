import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { cleanupHeadlessChild } from "../headless-cleanup-effect.js";
import type { HeadlessCleanup } from "../headless-cleanup-effect.js";

const liveClock = Effect.runSync(Clock.Clock);
// Vitest advances Date, not performance.now; keep monotonic deadlines and sleeps
// on its single clock so tests exercise the production scope without OS waits.
const clock: Clock.Clock = {
	currentTimeMillisUnsafe: () => Date.now(), currentTimeMillis: Effect.sync(() => Date.now()),
	currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n, currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
	monotonicTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n, monotonicTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
	sleep: (duration) => liveClock.sleep(duration),
};

export const cleanupWithTestClock = (options: HeadlessCleanup): Promise<void> => cleanupHeadlessChild(options, clock);
