import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";

logDiagnostic("visible_steering_effect_loaded");

type Observation = "pending" | "consumed" | Error;

/** Only in-memory wait ownership lives here; publication and fences stay with the backend. */
export interface SteeringAckWait {
	readonly pollMs: number;
	readonly timeoutMs: number;
	readonly terminalSignal: AbortSignal;
	readonly inspect: () => Observation;
	readonly timeout: () => "consumed" | Error;
	readonly onFailure: () => void;
}

function reportFailure(options: SteeringAckWait): void {
	try { options.onFailure(); }
	catch { /* Diagnostics cannot strand a control waiter. */ }
}

const steeringAck = Effect.fn("steeringAck")(function* (options: SteeringAckWait) {
	const started = yield* Clock.monotonicTimeNanos;
	const inspect = Effect.try({
		try: options.inspect,
		catch: (cause) => {
			reportFailure(options);
			return cause instanceof Error ? cause : new Error("visible steering inspection failed");
		},
	});
	const tick = Effect.gen(function* () {
		let observation = yield* inspect;
		if (observation === "pending" && Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000 >= options.timeoutMs) {
			observation = yield* Effect.try({ try: options.timeout, catch: (cause) => {
				reportFailure(options);
				return cause instanceof Error ? cause : new Error("visible steering timeout inspection failed");
			} });
		}
		if (observation instanceof Error) return yield* Effect.fail(observation);
		return observation;
	});
	// One cancellable sleep per waiter, with the original first-poll cadence.
	const polling = tick.pipe(
		Effect.repeat({ while: (observation) => observation === "pending", schedule: Schedule.spaced(options.pollMs) }),
		Effect.delay(options.pollMs),
	);
	const terminal = Effect.callback<"consumed", Error>((resume) => {
		const finish = (): void => {
			// callback's returned cleanup runs on interruption, not normal completion.
			options.terminalSignal.removeEventListener("abort", finish);
			resume(inspect.pipe(Effect.flatMap((observation) => observation === "consumed"
				? Effect.succeed(observation)
				: Effect.fail(observation instanceof Error ? observation : new Error("visible steering owner stopped")))));
		};
		if (options.terminalSignal.aborted) finish();
		else options.terminalSignal.addEventListener("abort", finish, { once: true });
		return Effect.sync(() => options.terminalSignal.removeEventListener("abort", finish));
	});
	return yield* Effect.raceFirst(polling, terminal).pipe(
		Effect.asVoid,
		Effect.tapDefect(() => Effect.sync(() => reportFailure(options))),
	);
});

/** A waiter owns its runtime; the public Promise never settles ahead of teardown. */
export async function waitForSteeringAck(options: SteeringAckWait, clock?: Clock.Clock): Promise<void> {
	const runtime = ManagedRuntime.make(clock ? Layer.succeed(Clock.Clock, clock) : Layer.empty);
	try {
		await runtime.runPromise(steeringAck(options).pipe(Effect.scoped));
	} finally {
		await runtime.dispose();
	}
}
