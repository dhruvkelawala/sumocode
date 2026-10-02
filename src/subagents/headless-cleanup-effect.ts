import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import { terminateProcessTree, type ProcessTreeIdentity, type ProcessTreeOperations, type ProcessTreeVerification } from "../background-tasks/process-tree.js";
import { nonOwningClock } from "./non-owning-clock.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";

logDiagnostic("headless_cleanup_effect_loaded");

/** Authority and process identity remain synchronous Node adapters. */
export interface HeadlessCleanup {
	readonly operations: ProcessTreeOperations;
	readonly tree: () => { identity: ProcessTreeIdentity; verification: ProcessTreeVerification };
	readonly beforeSignal: (signal: "SIGTERM" | "SIGKILL") => void;
	readonly closed: () => boolean;
	readonly subscribeClose: (notify: () => void) => () => void;
	readonly release: () => void;
}

class HeadlessCleanupError extends Error {
	readonly _tag = "HeadlessCleanupError";
}

const waitEmpty = Effect.fn("headlessCleanup.waitEmpty")(function* (inspect: () => boolean, timeoutMs: number) {
	const started = yield* Clock.monotonicTimeNanos;
	const tick = Effect.try({ try: inspect, catch: () => new HeadlessCleanupError("headless tree inspection failed") }).pipe(
		Effect.flatMap((empty) => Effect.map(Clock.monotonicTimeNanos, (now) => ({
			empty, expired: Number(now - started) / 1_000_000 >= timeoutMs,
		}))),
	);
	const result = yield* tick.pipe(Effect.repeat({
		while: (result) => !result.empty && !result.expired,
		schedule: Schedule.spaced(25),
	}));
	return result.empty;
});

/** One termination owns its waits, drain subscription and release; never a process/platform owner. */
export async function cleanupHeadlessChild(options: HeadlessCleanup, clock?: Clock.Clock): Promise<void> {
	const runtime = ManagedRuntime.make(clock ? Layer.succeed(Clock.Clock, clock) : nonOwningClock);
	const cleanup = Effect.fn("headlessCleanup")(function* () {
		yield* Effect.addFinalizer(() => Effect.sync(options.release));
		const tree = yield* Effect.try({ try: options.tree, catch: () => new HeadlessCleanupError("headless signal authority unavailable") });
		const operations: ProcessTreeOperations = {
			...options.operations,
			captureTreeVerification: () => tree.verification,
			signalTree: (identity, signal, verification) => {
				options.beforeSignal(signal);
				return options.operations.signalTree(identity, signal, verification);
			},
			waitForTreeEmpty: (identity, timeoutMs, verification) => runtime.runPromise(waitEmpty(
				() => options.operations.isTreeEmpty(identity, verification), timeoutMs,
			)),
		};
		const terminated = yield* Effect.tryPromise({
			try: () => options.operations.isTreeEmpty(tree.identity, tree.verification)
				? Promise.resolve(true)
				: terminateProcessTree(operations, tree.identity, { termGraceMs: 5000, killGraceMs: 1000 }),
			catch: () => new HeadlessCleanupError("headless cleanup refused"),
		}).pipe(Effect.timeoutOrElse({ duration: 7000, orElse: () => Effect.fail(
			new HeadlessCleanupError("headless cleanup timed out"),
		) }));
		// A successful signal (including ESRCH) is not whole-tree-empty evidence.
		if (!terminated || !options.operations.isTreeEmpty(tree.identity, tree.verification)) {
			return yield* Effect.fail(new HeadlessCleanupError("headless cleanup could not be verified"));
		}
		let unsubscribe = (): void => undefined;
		const drain = Effect.callback<void>((resume) => {
			unsubscribe = options.subscribeClose(() => resume(Effect.void));
			if (options.closed()) resume(Effect.void);
		});
		yield* drain.pipe(
			Effect.timeoutOrElse({ duration: 1000, orElse: () => Effect.fail(
				new HeadlessCleanupError("headless pipes did not close after cleanup"),
			) }),
			// Also release after synchronous notification during subscription.
			Effect.ensuring(Effect.sync(() => unsubscribe())),
		);
	});
	try {
		await runtime.runPromise(cleanup().pipe(
			Effect.scoped,
			Effect.catchTag("HeadlessCleanupError", (error) => Effect.fail(new Error(error.message))),
		));
	} finally {
		await runtime.dispose();
	}
}
