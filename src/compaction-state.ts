/**
 * Tiny shared state for compaction reason.
 *
 * Pi fires `compaction_start` (with `reason: "manual" | "threshold" | "overflow"`)
 * BEFORE `session_before_compact`. By the time the extension event fires, the
 * reason is already stored here via `chat-viewport-controller.ts`'s handleEvent
 * intercept, so `compaction-indicator.ts` can read it for the correct label.
 *
 * Pinned on `globalThis` with a symbol key so jiti module-cache:false reloads
 * share the same value (same pattern as theme registry and active runtime).
 */

const COMPACTION_REASON_KEY = Symbol.for("sumocode.compactionReason");

export type CompactionReason = "manual" | "threshold" | "overflow";

function setGlobal(reason: CompactionReason | null): void {
	// SAFETY: the symbol key is module-private and only ever written with
	// CompactionReason | null values, so the global slot holds exactly that type.
	(globalThis as { [COMPACTION_REASON_KEY]?: CompactionReason | null })[COMPACTION_REASON_KEY] = reason;
}

export function setCompactionReason(reason: CompactionReason | null): void {
	setGlobal(reason);
}

export function getCompactionReason(): CompactionReason | null {
	// SAFETY: see setGlobal — this module owns the only writes to the symbol key.
	const stored = (globalThis as { [COMPACTION_REASON_KEY]?: CompactionReason | null })[COMPACTION_REASON_KEY];
	return stored ?? null;
}
