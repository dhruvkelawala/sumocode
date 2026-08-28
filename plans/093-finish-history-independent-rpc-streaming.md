# Plan 093: Finish history-independent RPC event streaming

> **Executor instructions**: Do not execute until Plans 088 and 089 are DONE.
> Preserve transcript/pager correctness and the raw-snapshot contract while
> removing history-sized work from the common streaming and transcript-neutral
> event paths. Prove complexity structurally; do not use a flaky wall-clock
> threshold as the only acceptance gate. If a fast path cannot preserve folded
> Activity updates, hydration rewrites, or sink ownership, stop and amend the
> plan rather than mutating shared arrays past consumers.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 42e6eec..HEAD -- \
>   src/sumo-tui/transcript/controller.ts \
>   src/sumo-tui/transcript/controller.test.ts \
>   src/sumo-tui/rpc/transcript-pump.ts \
>   src/sumo-tui/rpc/transcript-pump.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/runtime.ts src/sumo-tui/rpc/runtime.test.ts \
>   src/sumo-tui/rpc/shell-adapter.ts \
>   src/sumo-tui/rpc/shell-adapter.test.ts \
>   src/sumo-tui/widgets/chat-pager.ts \
>   src/sumo-tui/widgets/chat-pager.test.ts
> ```
>
> Reconcile Plan 089's final event vocabulary and wire-faithful fixture first.
> Do not restore assumptions from completed Plan 047; its O(1) claim was only
> true for diff-key computation, not total per-event allocation.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 088 and 089
- **Category**: performance / architecture / tests
- **Planned at**: commit `42e6eec`, 2026-08-28
- **Issue**: [#383](https://github.com/dhruvkelawala/sumocode/issues/383)
- **Execution status**: BLOCKED — coordinated next-Pi release gate, then Plans 088 and 089

## Outcome

A plain assistant `message_update` performs work independent of committed
history length: it maps/folds only the changed live boundary and applies one
retained-sink operation. Transcript-neutral RPC events return the existing
snapshot without cloning, refolding, revision bumps, or pager work. Full
history reconstruction remains available and authoritative at hydration,
commit, compaction/rewrite, explicit snapshot, and fallback boundaries.

The optimization is observable through deterministic counters over large
synthetic histories. Existing expansion, folding, scroll/unread, rewrite, and
resume behavior stays unchanged.

## Why this matters

Plan 047 removed repeated prefix serialization and bounded retained pager
objects, but every recognized event still executes:

```ts
const transcript = this.publish(this.viewModel());
```

`viewModel()` starts with:

```ts
let messages = [...this.ensureCommittedViewModels()];
```

It then refolds every live tool. With `H` committed messages and `D` deltas,
the common stream still allocates/copies `O(H × D)` array slots. Queue, settled,
policy, retry, extension, and unknown additive events can pay the same cost even
when they change no transcript content. This synchronous work runs inside the
RPC child's stdout callback, where long resumed sessions can delay later event
and input processing.

## Current state

- `controller.ts:379-517` classifies/mutates events, but unconditionally calls
  `publish(viewModel())` after the switch for every recognized event.
- `controller.ts:533-548` copies the full committed array and folds every live
  tool each time `viewModel()` is called.
- `controller.ts:671-758` can apply a hinted last-message sink operation in
  O(1), but only after the full `next` array was already built.
- `host.ts:1235-1239` sends every Pi event through transcript ingestion before
  updating runtime chrome.
- `controller.test.ts` proves zero prefix content-key misses, not zero committed
  array reconstruction. The existing “O(1)” test therefore cannot catch this
  allocation regression.
- Completed Plan 047 and `plans/README.md` overstate the result. Its WeakMap,
  diff hint, fallback planner, bounded pager disposal, and tests remain useful;
  only the total-complexity claim is superseded.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Controller | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts` | structural complexity and transcript semantics pass |
| Host/runtime | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/shell-adapter.test.ts` | sink/snapshot ownership remains correct |
| Pager | `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts` | scroll, unread, expansion, and bounded memory pass |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- transcript controller/pump, host/runtime/shell integration, and colocated tests
- chat pager only if a minimal existing sink operation is needed
- deterministic structural counters/bench fixture under the existing test tree
- Plan 047 supersession note and `plans/README.md` status/index text

**Out of scope**:

- Changing Pi's RPC protocol or buffering stdout outside the current client.
- Rewriting the transcript view-model mapper or Activity domain.
- Weakening full replacement for hydration, compaction, session replacement,
  changed source IDs, or genuine history rewrites.
- Mutable arrays/objects escaping through `TranscriptViewModel`.
- A wall-clock microbenchmark as the sole CI gate.
- Queue ownership, thinking reconciliation, or lifecycle semantics from Plans
  089 and 090.
- Golden promotion without explicit human approval.

## Git workflow

- Branch: `advisor/093-finish-history-independent-rpc-streaming`
- Commit subject: `perf: remove history work from RPC streaming`
- Prefer structural tests first, then the narrowest controller seam.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Add a structural regression harness before optimizing

Create a deterministic fixture with thousands of committed messages, a plain
assistant draft, hundreds of indexed deltas, and transcript-neutral events.
Add test-only counters around:

- committed-array materializations/copies;
- committed-message mapping;
- live-tool fold passes;
- full diff/replacement fallbacks;
- incremental sink operations.

Assert current output semantics first, then write failing complexity assertions:

- after the initial hydration, plain deltas perform zero committed-prefix copies
  and zero committed remaps;
- neutral events perform no transcript publish, revision bump, fold, or sink op;
- message commit/rewrite/hydration may perform bounded explicit O(H) work.

A timing sample may be reported for evidence, but CI passes on operation counts
and ownership assertions, not machine speed.

### Step 2: Make transcript dirtiness explicit

Have event ingestion distinguish at least:

1. transcript-neutral lifecycle/policy/queue/unknown events;
2. streaming-boundary changes (`message_start`/plain `message_update`);
3. live-tool/foldable Activity changes that may touch earlier cards;
4. commit/rewrite/hydration boundaries.

Neutral events may still update external chrome, scheduler, or streaming
begin/end hooks, but return `lastTranscript` unchanged and do not call
`publish(viewModel())`. Keep forward-compatible unknown events neutral unless a
normalized payload is explicitly transcript-affecting.

Do not conflate `taskPartials`/live-tool bookkeeping with transcript dirtiness:
set dirtiness only when the visible projection actually changes.

**Verify**: one table-driven test covers every Plan 089 event family and asserts
the appropriate transcript revision/sink behavior.

### Step 3: Apply plain assistant deltas without rebuilding history

For the common non-foldable assistant stream:

1. fold the indexed `assistantMessageEvent` into the running draft;
2. map only that draft boundary;
3. compare/apply one append or replace-last operation to the retained chat sink;
4. advance the sink-owned revision and schedule one coalesced render;
5. retain enough source/draft state to materialize a full immutable
   `TranscriptViewModel` later, without copying the committed prefix now.

The raw `TranscriptViewModel` returned to host/runtime may reuse the last
materialized snapshot while the sink already owns the live boundary, but only
if every consumer is audited and keyed to the controller revision. Add an
explicit lazy `snapshot()`/materialization boundary if needed; do not mutate a
previously returned readonly array.

If the draft contains foldable Activity/tool blocks or a live tool can modify
canonical cards earlier in history, fall back to the existing complete targeted
planner. Preserve `messageContentKey`, `planChatDiff`, and full replacement as
safety nets.

**Verify**: a 5,000-message prefix plus 500 plain deltas performs 500 boundary
operations with zero prefix copies; foldable tool updates still replace every
required earlier card in stable order.

### Step 4: Materialize only at authoritative boundaries

Rebuild/fold a complete immutable snapshot when:

- `message_end` commits the draft;
- `agent_end` reconciles the run suffix;
- compaction inserts/rewrites a summary;
- session hydration/replacement supplies a complete context;
- a genuine snapshot consumer explicitly requests materialized messages;
- a fast-path invariant fails.

Keep `lastTranscript`, controller revision, `lastPublishedToChat`, shell adapter
revision, and pager state coherent across lazy and materialized transitions.
Beginning/ending the streaming indicator must not depend on a full transcript
publish. Session replacement clears any lazy draft/operation state before new
ownership is exposed.

**Verify**: existing hydration, expansion, task folding, compaction, agent-end
suffix, selection, scroll/unread, and resume tests remain unweakened. Add a
fast-path-to-rewrite trace proving no duplicate/missing message or stale draft.

### Step 5: Profile, document, and run the complete gate

Run the structural harness at small and large history sizes and record the
operation counts in the implementation report. Optionally capture a local CPU/
allocation profile to confirm the removed work, but do not commit large traces.

Update comments/docs that claim every event produces a fresh snapshot, and mark
Plan 047 as partial/superseded without erasing its historical result. Run every
command in the table. Visual output should be unchanged; review generated
evidence and do not promote goldens.

## Test plan

- Plain streaming delta cost is independent of committed history length.
- Transcript-neutral events do not publish, refold, revise, or touch the pager.
- First draft append and later replace-last remain ordered and coalesced.
- Tool/Activity updates affecting older cards use the safe targeted fallback.
- Message commit, agent-end suffix, compaction, hydration, and session replacement
  materialize exact authoritative snapshots.
- Fast-path → rewrite → next stream has no stale hint, duplicate, or missing row.
- Scroll/unread/expansion/selection and bounded pager ownership are unchanged.
- Unknown additive Pi events are tolerated without history-sized work.

## Done criteria

- [ ] A structural test proves zero committed-prefix copies/remaps for plain
  deltas after hydration.
- [ ] Transcript-neutral events keep transcript revision and sink state stable.
- [ ] Full snapshots remain exact at every authoritative boundary.
- [ ] Foldable Activity/tool updates retain correct earlier-card behavior.
- [ ] Existing Plan 047 diff/pager tests pass without weakened assertions.
- [ ] Unit, integration, visual CI, lint, typecheck, and build pass.
- [ ] Plan 047 and the index describe its partial historical result honestly.
- [ ] Plan 093 and the index move from BLOCKED to DONE only after dependencies.

## STOP conditions

- Plans 088 or 089 are not DONE.
- The target event shapes differ from Plan 089's wire-faithful fixture.
- A fast path requires mutating an array/object already returned to a consumer.
- Runtime/shell has an unversioned consumer that requires a fresh full transcript
  on every delta and cannot be given an explicit snapshot boundary safely.
- Foldable Activity correctness, message ordering, expansion, or scroll/unread
  semantics regress.
- The only passing performance assertion is a wall-clock threshold.

## Maintenance notes

- “O(1) streaming” means independent of committed history for the plain delta
  path; token parsing/mapping can still scale with the changed draft content.
- Keep event dirtiness and sink ownership explicit. An unknown event is not a
  reason to rebuild the transcript.
- Full materialization is the correctness escape hatch. Optimize its frequency,
  never delete it.
- Re-run the structural fixture after any mapper, Activity-fold, or transcript
  sink contract change.
