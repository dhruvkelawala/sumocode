import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import type { buildCompletionManifest, BuildCompletionManifestOptions, CompletionManifestEvidence } from "./manifest.js";

logDiagnostic("subagent_manifest_effect_loaded");

export interface ManifestCollection {
	readonly options: BuildCompletionManifestOptions;
	readonly timeoutMs: number;
	readonly fallback: CompletionManifestEvidence;
	readonly build: typeof buildCompletionManifest;
	readonly onFailure: () => void;
}

function reportFailure(collection: ManifestCollection): void {
	try { collection.onFailure(); }
	catch { /* Diagnostics cannot strand settlement. */ }
}

/** The public deadline includes termination/drain; late cleanup never revises evidence. */
export async function collectManifestWithin(collection: ManifestCollection, clock?: Clock.Clock): Promise<CompletionManifestEvidence> {
	if (collection.options.signal?.aborted || collection.timeoutMs <= 0) return collection.fallback;
	const controller = new AbortController();
	const reads = new Set<Promise<boolean>>();
	let cleanupFailed = false;
	const partial = (): CompletionManifestEvidence => reads.size || cleanupFailed
		? { ...collection.fallback, cleanup: "unproven" } : collection.fallback;
	const work = Effect.callback<CompletionManifestEvidence>((resume) => {
		if (collection.options.signal?.aborted) { resume(Effect.succeed(partial())); return; }
		try {
			void collection.build({ ...collection.options, signal: controller.signal, onGitRead: (closed) => {
				reads.add(closed);
				void closed.then((proven) => { reads.delete(closed); if (!proven) cleanupFailed = true; }, () => { reads.delete(closed); cleanupFailed = true; });
			} }).then(
				(result) => { if (!controller.signal.aborted) resume(Effect.succeed(result)); },
				() => { if (!controller.signal.aborted) { reportFailure(collection); resume(Effect.succeed(partial())); } },
			);
		} catch {
			reportFailure(collection);
			resume(Effect.succeed(partial()));
		}
	}).pipe(Effect.ensuring(Effect.sync(() => { controller.abort(); })));
	const program = Effect.fn("collectCompletionManifest")(function* () {
		// Reserve 500ms inside the original budget. Drain is interruptible, never a finalizer.
		const evidence = yield* Effect.raceFirst(work, Effect.sleep(Math.max(0, collection.timeoutMs - 500)).pipe(Effect.as(collection.fallback)));
		yield* Effect.promise(() => Promise.allSettled(reads));
		return cleanupFailed ? partial() : evidence;
	});
	const runtime = ManagedRuntime.make(clock ? Layer.succeed(Clock.Clock, clock) : Layer.empty);
	let evidence = collection.fallback;
	try {
		evidence = await runtime.runPromise(Effect.raceFirst(program(), Effect.sleep(collection.timeoutMs).pipe(Effect.map(partial))), { signal: collection.options.signal });
	} catch {
		if (!collection.options.signal?.aborted) reportFailure(collection);
		evidence = partial();
	} finally {
		controller.abort();
		await runtime.dispose();
	}
	return collection.options.signal?.aborted ? partial() : evidence;
}
