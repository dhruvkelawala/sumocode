import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Bounded lifecycle waits do not own Node's lifetime. Each consumer owns its layer. */
export const nonOwningClock = Layer.effect(Clock.Clock, Effect.map(Clock.Clock, (clock): Clock.Clock => ({
	currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
	currentTimeMillis: clock.currentTimeMillis,
	currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
	currentTimeNanos: clock.currentTimeNanos,
	monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
	monotonicTimeNanos: clock.monotonicTimeNanos,
	sleep: (duration) => Effect.callback<void>((resume) => {
		const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
		timer.unref();
		return Effect.sync(() => clearTimeout(timer));
	}),
})));
