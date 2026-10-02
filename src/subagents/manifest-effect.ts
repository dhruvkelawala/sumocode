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

const manifest = Effect.fn("collectCompletionManifest")(function* (collection: ManifestCollection) {
	const controller = new AbortController();
	const reads: Promise<string | undefined>[] = [];
	const work = Effect.callback<CompletionManifestEvidence>((resume) => {
		if (collection.options.signal?.aborted) { resume(Effect.succeed(collection.fallback)); return; }
		try {
			void collection.build({ ...collection.options, signal: controller.signal, onGitRead: (closed) => { reads.push(closed); } }).then(
				(result) => resume(Effect.succeed(result)),
				() => { if (!controller.signal.aborted) reportFailure(collection); resume(Effect.succeed(collection.fallback)); },
			);
		} catch {
			reportFailure(collection);
			resume(Effect.succeed(collection.fallback));
		}
	}).pipe(Effect.ensuring(Effect.promise(async () => {
		// Join only Git close receipts, not an uncooperative builder's late result.
		controller.abort();
		await Promise.all(reads);
	})));
	return yield* Effect.raceFirst(work, Effect.sleep(collection.timeoutMs).pipe(Effect.as(collection.fallback)));
});

/** One collection owns one runtime; interruption kills and drains its Git reads. */
export async function collectManifestWithin(collection: ManifestCollection, clock?: Clock.Clock): Promise<CompletionManifestEvidence> {
	if (collection.options.signal?.aborted || collection.timeoutMs <= 0) return collection.fallback;
	const runtime = ManagedRuntime.make(clock ? Layer.succeed(Clock.Clock, clock) : Layer.empty);
	let evidence = collection.fallback;
	try {
		evidence = await runtime.runPromise(manifest(collection), { signal: collection.options.signal });
	} catch {
		if (!collection.options.signal?.aborted) reportFailure(collection);
	} finally {
		await runtime.dispose();
	}
	return collection.options.signal?.aborted ? collection.fallback : evidence;
}
