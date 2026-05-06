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

type Global = typeof globalThis & Record<symbol, CompactionReason | null>;

export function setCompactionReason(reason: CompactionReason | null): void {
	(globalThis as Global)[COMPACTION_REASON_KEY] = reason;
}

export function getCompactionReason(): CompactionReason | null {
	return (globalThis as Global)[COMPACTION_REASON_KEY] ?? null;
}
