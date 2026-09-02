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

- [x] `pnpm vitest run scripts/test-wait-classification.test.mjs` proves every retained cited wait has a recognized causal classification; positive proxy sleeps are removed.
- [x] Intentional timing tests and negative-observation contracts remain explicit.
- [x] Targeted tests pass repeatedly without timeout inflation.
- [x] Failure messages show the unmet predicate/last output.
- [x] Full gates pass.
- [x] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [x] Plan 103's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- A positive state has no observable boundary without a production API redesign.
- A negative assertion has no causal completion boundary; retain/document its bounded observation window instead of weakening it.
- Replacement would busy-loop or remove a real timeout contract.
- A failure persists with state-based waits, indicating a product bug rather than test timing.

## Maintenance notes

New PTY tests should default to output/state predicates. A bare sleep requires a comment naming the timing behavior it intentionally tests.

`scripts/test-wait-classification.test.mjs` enforces this for the files listed
in its `CANDIDATE_FILES`. Add new timing-sensitive suites to that list. Every
retained real or fake timer in a listed file — `setTimeout`, `setInterval`,
`setImmediate`, `vi.advanceTimersByTime(Async)`, `vi.advanceTimersToNextTimer(Async)`,
`vi.runAllTimers(Async)`, `vi.runOnlyPendingTimers(Async)` — needs an adjacent
`// WAIT-CLASS: <negative-observation|clock-contract|fixture-delay|poll-interval> — <reason>`
marker; anything else must wait for observable state instead.

It also flags numeric-literal sleep helpers (`delay(50)`, `sleep(...)`,
`pause(...)`, `wait(...)`) whether directly awaited, promise-chained, used in a
combinator, or accidentally left unawaited. Classifying only a helper's
definition would leave every call site unchecked.

The gate parses each candidate with the repository's existing TypeScript
compiler dependency. Timer calls come from the AST; marker text and executable
line boundaries come from compiler-owned token and comment ranges. This avoids
maintaining a second JavaScript/TypeScript lexer and correctly handles strings,
regexes, template interpolation, generic calls, escaped lines, and comments
between a callee and its arguments. Text passed to `writeFile` or
`writeFileSync` is statically evaluated through source-ordered, symbol-resolved
local `=`/`+=` assignments, aliases, template interpolation, and string
concatenation, then parsed as one fixture module. Dynamic pieces become
non-joining placeholders; display/assertion values and arbitrary runtime string
construction remain opaque.

A marker must begin the normalized comment content (allowing the leading `*` in
a formatted block comment); prose that merely mentions `WAIT-CLASS` does not
classify anything. On the timer's own line a trailing marker is valid. Above
it, only a contiguous comment-only block counts: a marker sharing a line with
executable code annotates that statement rather than the timer below it. Split calls are
reported on the line holding their callee identifier.

This parser replaced a string-prefix matcher and then a hand-rolled tokenizer
after review repeatedly found valid syntax that bypassed them. The retained
regression cases remain as the gate's behavioral contract.

The check is AST-based but still intentionally file-scoped. It recognizes
direct timer calls, Vitest timer controls, and numeric-literal
`delay`/`sleep`/`pause`/`wait` calls. A wait reached through a differently named
helper or arbitrary indirection remains invisible; add that helper's module to
`CANDIDATE_FILES` so at least its definition is classified.

## Completion notes

- `flushIO()` (fixed 20ms) is replaced by `waitForInlineSelector(inlineSelectors, title)`, a `vi.waitFor` on the selector the command actually publishes. The title also disambiguates chained selector-to-selector transitions (`Session tree` → `Summarize branch?` → back), which `getActiveKind()` alone cannot.
- The two 100ms sleeps in the 6,001-entry `/tree` + `/fork` test became the same waiter.
- `rpc-activity-cards.test.ts`'s 100ms pre-typing pause and 10ms-per-character pacing became per-character waits on the inline selector's echoed search row.
- Everything else retained is a real contract: poll intervals inside bounded re-read loops, fixture-owned delays (`holdOpenMs`, the 8s provider hold), and the negative-observation windows in `rpc-queued-message-undo.test.ts`. None of the prohibited sends has a causal completion event to wait on — the bounded window IS the contract — so each is documented in place rather than weakened into an immediate read.

### Stale-state hazard

Escaping BACK to an already-open selector title is a degenerate predicate: had
the forward hop never happened, the waiter would resolve on its first poll and
assert nothing. Both back-hop sites therefore wait for `Summarize branch?`
*before* the Esc, so the return is proven. Red-checked by replacing the opening
Enter with a no-op key: the test now fails with
`inline selector "SUMMARIZE BRANCH?" never opened (active kind: select, rendered: "✦ SESSION TREE ✦ …")`
where it previously passed. `INLINE_SELECTOR_TIMEOUT_MS` is 4s, under Vitest's
5s default, so that diagnostic wins the race instead of a bare
`Test timed out in 5000ms`.

### Coverage against the plan's test list

| Case | Where |
|---|---|
| Successful state transition | every migrated `/resume` and `/tree` site |
| Transition just before timeout | Approximated by "resolves on a transition that lands after the wait has started". A true wall-clock near-timeout boundary would need fake timers, which `vi.waitFor` does not use; forcing one would only add a flake. |
| No transition | "times out naming the unmet predicate when no selector ever opens" |
| Stale output that must not satisfy a new wait | "is not satisfied by a stale selector that closed before the wait", plus the two forward-hop guards |
| Wrong state satisfying the wait | "times out naming the wrong selector when a different one stays open" |
| Child early exit / cleanup with pending waiter | N/A — no PTY waiter was added or changed; `spawnPiPty` already owns child-exit and cleanup semantics for `waitForOutput`/`waitForScreen` |

### Scope deviation: `src/sumo-tui/rpc/client.test.ts`

"keeps only the stderr tail up to 64 KiB" failed roughly 1 run in 3 under the
fully parallel `pnpm test`, and passed 30/30 in isolation every time. It is not
a cited file, but it is the exact failure mode this plan exists to remove, and
"Full gates pass" cannot be met while it flakes.

Cause: the waiter was `waitFor(() => client.stderr.length === 65536)` — a
count-only proxy for the state the test then asserts. stderr arrives in chunks
and the trimmed ring buffer transiently hits 64 KiB before the truncation
marker is prepended or the final `b` chunk lands, so the waiter resolved on an
intermediate state and the marker assertion failed.

Fix: wait for the full asserted state (byte count **and** leading marker **and**
trailing `b`). Strictly strengthening, test-only, one predicate. No production
code, no timeout constant, and no assertion changed. `client.test.ts` was NOT
added to `CANDIDATE_FILES` — its remaining timers have not been audited, and
listing it would assert a classification this plan did not perform.

After the fix it survived 7 consecutive fully parallel `pnpm test` runs, having
failed 2 of 4 before.

### Residual pre-existing flakes (not addressed)

Two load-sensitive tests in specs this plan does not touch still fail
occasionally under a fully parallel `pnpm test` (1 run in ~7 here), and each
passes in isolation — the same behaviour already recorded against Plan 096 in
`plans/README.md`:

- `src/background-tasks/task-manager.test.ts` — "does not cap terminal execution to the feed presentation budget" starts 257 real terminals against a 20s test timeout. It exceeds the budget because the work is heavy, not because a sleep stands in for state, and its subject IS a budget constant. Out of scope per "Product timeout/backoff constants" and "Tests whose subject is elapsed time".
- `src/sumo-tui/rpc/editor.test.ts` — "opens file mention autocomplete when the RPC host types @ without an explicit fd path".

Both predate this branch and neither is a cited candidate. Fixing them means
auditing two more files, which is a follow-up, not this plan.
