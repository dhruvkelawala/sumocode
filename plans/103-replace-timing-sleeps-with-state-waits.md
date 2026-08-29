# Plan 103: Replace timing-sensitive test sleeps with observable-state waits

> **Executor instructions**: Follow this plan step by step and run every verification command. Replace only sleeps that stand in for an observable event. Preserve intentional timeout/backoff and negative-observation windows unless a causal boundary can replace them. Prove each new waiter fails when state never changes. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- src/sumo-tui/rpc/host-actions.test.ts test/integration/*.test.ts src/activity/*.test.ts src/background-tasks/*.test.ts scripts/test-wait-classification.test.mjs`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host src/sumo-tui/rpc/host-actions.test.ts test/integration/*.test.ts src/activity/*.test.ts src/background-tasks/*.test.ts scripts/test-wait-classification.test.mjs`. If this reports pre-existing work, STOP and preserve it.
> If the drift check reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/issues/092.md` (sanitized public dependency)
- **Category**: tests
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/397

## Why this matters

Several tests wait a fixed number of milliseconds for filesystem, worker, RPC, or retained-renderer state. Under concurrent audit load these waits produced failures even when the target behavior was correct. Fixed delays both waste fast runs and fail slow ones; tests should wait for the state they assert.

## Current state

- `src/sumo-tui/rpc/host-actions.test.ts:279-290` defines `flushIO()` as a fixed 20ms delay because `/resume` reads several async filesystem layers:

```ts
function flushIO(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}
```
- `test/integration/rpc-session-switch.test.ts:17-31` is already a good bounded-poll exemplar: `waitForChromeCacheWrite()` polls a parsed `savedAt` value and throws a diagnostic timeout. Its internal 20ms poll interval is not a candidate for removal.
- `test/integration/rpc-queued-message-undo.test.ts:263,295,344,352,433,473,512` uses short windows before absence assertions. These are not ordinary positive-state waits: an immediate false predicate proves nothing. Replace one only when a later causal marker (for example a processed lifecycle/queue event) defines when the prohibited send would have happened; otherwise retain it with a comment naming the bounded observation contract.
- `test/integration/rpc-activity-cards.test.ts:115` places an 8s delay inside a fake child. Treat fixture delays and product timeout/backoff/escalation tests as timing behavior, not wait helpers.
- Existing positive-state patterns: `spawnPiPty.waitForOutput(pattern, timeout)`, `waitForChromeCacheWrite()`, and Vitest `vi.waitFor` provide bounded diagnostics.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Wait classification | `pnpm vitest run scripts/test-wait-classification.test.mjs` | every retained wait has a recognized adjacent `WAIT-CLASS` marker |
| Host actions | `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts` | pass repeatedly |
| Integration subset | `pnpm vitest run test/integration/rpc-session-switch.test.ts test/integration/rpc-queued-message-undo.test.ts test/integration/rpc-activity-cards.test.ts --fileParallelism=false` | pass repeatedly |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration` | exit 0 |

## Committed bundle freshness

Prefer test-only changes. If a production observability seam under the RPC host is unavoidable, add it explicitly to Scope, run `pnpm build:host` before `pnpm test`, and keep `dist/host/**` generated changes. Otherwise committed bundles must remain byte-identical.

## Scope

**In scope**:
- `dist/host/**` only when an approved production host observability seam changes.
- Tests where a fixed sleep merely waits for observable state.
- `scripts/test-wait-classification.test.mjs` (create) for the named-file retention policy.
- Small test-only helper APIs needed to observe completion.
- Production test seams only when they expose an existing event without changing runtime behavior.

**Out of scope**:
- Product timeout/backoff constants.
- Tests whose subject is elapsed time.
- Global timeout inflation.
- Rewriting the complete integration harness.

## Git workflow

- Branch: `advisor/103-state-based-test-waits`
- Commit: `test: wait for observable runtime state`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Inventory and classify fixed waits

For every candidate sleep, record the event it is approximating and classify it as: positive observable wait; negative-observation window; intentional clock contract; or child-fixture delay. Change only positive waits and negative windows with a real causal boundary. Start with the cited files; do not mechanically replace every `setTimeout`.

Add `scripts/test-wait-classification.test.mjs`. For the named candidate files, it must require every retained real/fake-timer wait to have an immediately adjacent `// WAIT-CLASS: negative-observation|clock-contract|fixture-delay|poll-interval — <causal reason>` marker. It must also fail unknown class names and empty reasons. Positive proxy waits should disappear rather than receive a marker.

**Verify**: `pnpm vitest run scripts/test-wait-classification.test.mjs` → pass; a fixture with a bare wait and a fixture with an unknown class both fail for the asserted reason.

### Step 2: Replace in-process sleeps

Use `vi.waitFor` with a bounded timeout, fake timers, or an explicit completion Promise from the test double. For `/resume`, wait until overlay/session rows or the specific async loader call becomes observable instead of sleeping 20ms.

Add one negative test proving the waiter times out with a useful message if state never changes.

**Verify**: `for i in $(seq 1 10); do pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts || exit 1; done` → ten passes; the new no-transition waiter test fails with the asserted unmet-predicate message when run against its forced-timeout fixture.

### Step 3: Replace PTY positive waits without weakening absence assertions

Use `waitForOutput`, marker files with bounded polling, RPC acknowledgements, or terminal-state predicates. After navigation/rerender, wait for the new stable marker rather than a guessed delay. For a negative assertion, first wait for the causal event after which the prohibited action would necessarily have occurred, then inspect the log/state once. Never replace a bounded absence window with an immediate read or `vi.waitFor(() => expect(absent).toBe(true))`. If no causal event exists, retain the bounded window and document why. Retain fake-child delays when the delay is fixture behavior.

**Verify**: `for i in 1 2 3 4 5; do pnpm vitest run test/integration/rpc-queued-message-undo.test.ts test/integration/rpc-activity-cards.test.ts --fileParallelism=false || exit 1; done` → five passes with unchanged assertion coverage and no increased timeout constants.

### Step 4: Run full gates

Compare runtime before/after; this is evidence, not a strict budget. Ensure no global timeout was increased to mask a race.

**Verify**: all command-table gates pass.

## Test plan

Cover successful state transition, transition just before timeout, no transition, child early exit, stale output that must not satisfy a new wait, and cleanup with pending waiter.

## Done criteria

- [ ] `pnpm vitest run scripts/test-wait-classification.test.mjs` proves every retained cited wait has a recognized causal classification; positive proxy sleeps are removed.
- [ ] Intentional timing tests and negative-observation contracts remain explicit.
- [ ] Targeted tests pass repeatedly without timeout inflation.
- [ ] Failure messages show the unmet predicate/last output.
- [ ] Full gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 103's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- A positive state has no observable boundary without a production API redesign.
- A negative assertion has no causal completion boundary; retain/document its bounded observation window instead of weakening it.
- Replacement would busy-loop or remove a real timeout contract.
- A failure persists with state-based waits, indicating a product bug rather than test timing.

## Maintenance notes

New PTY tests should default to output/state predicates. A bare sleep requires a comment naming the timing behavior it intentionally tests.
