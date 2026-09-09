# Plan 107: Bound streaming transcript lookup/block work and live Activity rendering with history

> **Completed:** [PR #447](https://github.com/dhruvkelawala/sumocode/pull/447) at `a4228e73`; CI green and mergeable in the open stack. The execution contract below is retained for auditability.
>
> **Executor instructions**: Follow this plan step by step and run every verification command. Add performance characterization before changing retained rendering. Preserve message ordering, folding, scroll/read state, and live status visibility. Use headless behavioral coverage for the 100-card stress case and existing visual canon only; never add/promote a golden in this plan. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host src/sumo-tui/transcript/controller.ts src/sumo-tui/transcript/controller.test.ts src/sumo-tui/transcript/controller.perf.test.ts src/sumo-tui/transcript/activity-fold.ts src/sumo-tui/transcript/activity-fold.test.ts src/sumo-tui/transcript/view-model.ts src/sumo-tui/widgets/chat-pager.ts src/sumo-tui/widgets/chat-pager.test.ts src/sumo-tui/widgets/chat-pager.perf.test.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host src/sumo-tui/transcript/controller.ts src/sumo-tui/transcript/controller.test.ts src/sumo-tui/transcript/controller.perf.test.ts src/sumo-tui/transcript/activity-fold.ts src/sumo-tui/transcript/activity-fold.test.ts src/sumo-tui/transcript/view-model.ts src/sumo-tui/widgets/chat-pager.ts src/sumo-tui/widgets/chat-pager.test.ts src/sumo-tui/widgets/chat-pager.perf.test.ts`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state retained-rendering assumption, STOP and request plan reconciliation.
> **Read-only visual-canon preflight**: `git status --short -- docs/visual/parity docs/ui/bible`. If dirty, preserve it and STOP before claiming no visual-canon drift; this plan may only write ignored review output under `docs/visual/out/`.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/103-replace-timing-sleeps-with-state-waits.md`
- **Category**: perf
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/401

## Why this matters

Every agent event currently copies the complete committed view-model array, and each live tool fold scans/maps message history. Separately, `ChatPager` exempts every non-settled feed card from virtualization, so many concurrent live Activities keep an unbounded number of retained Yoga/message nodes. This plan removes history-wide lookup/remap/deep-copy work and bounds retained nodes. It explicitly retains one shallow O(history) array snapshot copy required by the current immutable `TranscriptViewModel.messages` contract; migrating that public representation and every consumer is a separate architectural change.

## Current state

`src/sumo-tui/transcript/controller.ts:534` starts `TranscriptController.viewModel()` with:

```ts
let messages = [...this.ensureCommittedViewModels()];
```

It then folds every live tool through `foldBlocksIntoMessages`, whose implementation repeatedly searches and maps message arrays. Cache invalidation remaps all committed source messages.

`src/sumo-tui/widgets/chat-pager.ts:1214-1215,1258` exempts `isLiveFeedCard(message)` from virtualization; every non-settled feed Activity is therefore retained. Activity bridge retains all running terminals and only caps settled entries.

Existing constraints:
- `TranscriptViewModelMapper` carries order-dependent `taskMetadata`; any structural committed-message change must still reset the mapper and replay from message 0 so later task-result enrichment remains correct;
- stable message/activity IDs own in-place updates;
- every returned `TranscriptViewModel.messages` is a readonly array snapshot, so replacing a historical entry while preserving prior snapshots requires one shallow O(history) array-envelope copy under the current API;
- full `replaceViewModels` is reserved for hydration/session replacement;
- cards must remain queryable/visible through the feed even when their render node is virtualized;
- visual changes require `pnpm visual:ci` and review evidence.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Transcript | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/transcript/activity-fold.test.ts` | pass |
| Pager | `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts` | pass |
| Perf (created Step 1) | `pnpm vitest run src/sumo-tui/transcript/controller.perf.test.ts src/sumo-tui/widgets/chat-pager.perf.test.ts` | operation-count/node-bound cases pass after implementation |
| Visual/full | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | exit 0 |

## Generated bundle policy

PR #439 superseded the original committed-bundle instruction: `dist/**` is generated and ignored. Verification may build private artifacts, but this plan must not commit bundle, source-map, or input-manifest output.

## Scope

**In scope**:
- `src/sumo-tui/transcript/controller.ts`
- `src/sumo-tui/transcript/activity-fold.ts`
- `src/sumo-tui/transcript/activity-fold.test.ts` (create).
- `src/sumo-tui/transcript/view-model.ts` only if a read-only mapper/index contract is required; do not change mapping semantics.
- `src/sumo-tui/widgets/chat-pager.ts`
- `src/sumo-tui/transcript/controller.perf.test.ts` and `src/sumo-tui/widgets/chat-pager.perf.test.ts` (create), plus small identity/index helpers and existing focused tests.

**Out of scope**:
- Visual scenario/Bible/crop/golden changes; use existing `fixture-completed-landscape` read-only as regression evidence.
- Changing transcript/user-visible message order.
- Dropping Activity status from the feed.
- Changing worker concurrency (Plan 114).
- Visual golden promotion.
- Terminal manager persistence (Plans 093/106).
- `src/activity/manager-bridge.ts` and its intentional retention of every running Activity identity; this plan bounds retained render nodes, not producer/feed truth.
- Replacing the readonly-array transcript snapshot with a persistent/chunked/delta representation or migrating its downstream consumers.

## Git workflow

- Branch: `advisor/107-bounded-retained-streaming`
- Commits: characterization, transcript indexing, live-card virtualization.
- Message: `perf(tui): bound streaming work with long history`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add operation-count characterizations

Create 100, 1,000, and 10,000-message fixtures with one draft and multiple live tools. Instrument message mapping, identity lookup, deep message/block copy/map work, the required shallow array-envelope copy, and node count. Add 100 live Activity fixtures with a small viewport.

Gate on operation growth/retained node count, not wall-clock milliseconds. Name transcript cases `characterizes live update operations:` and pager cases `characterizes live-card retention:`. Treat exactly one shallow messages-array copy proportional to history as the documented baseline, not a failure; history-wide identity scans, mapper replays, deep message/block copies, or multiple envelope copies must fail the desired assertions.

**Verify**: `pnpm vitest run src/sumo-tui/transcript/controller.perf.test.ts src/sumo-tui/widgets/chat-pager.perf.test.ts -t "characterizes live update operations:|characterizes live-card retention:"` → expected red before implementation for history-wide scans/remaps/deep copies and 100 retained live nodes, while the fixture separately reports the accepted shallow snapshot copy.

### Step 2: Index the live update boundary

Retain committed view-model objects by reference while unchanged. Maintain stable ID → message/block location indexes for foldable Activities/tools only while the committed view-model cache is structurally unchanged. On a live update, use constant indexed lookup, copy only the changed message/block path, and perform exactly one shallow O(history) `messages` array-envelope copy so prior immutable snapshots remain unchanged. On hydration, compaction insertion, committed append/replace, or any structural committed change, call the existing mapper reset and replay from message 0 before rebuilding indexes; never retain stale task-metadata enrichment by reference across that boundary.

Preserve append/fold ordering, stateful mapper semantics, and cache invalidation. Avoid an index that becomes a second source of truth.

**Verify**: `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/transcript/activity-fold.test.ts src/sumo-tui/transcript/controller.perf.test.ts -t "live update|structural committed change|task metadata"` → one live update has constant indexed lookup, copies only its changed message/block path plus one shallow messages-array envelope, and does no history-wide scan/remap; structural changes reset/replay mapper state and preserve task metadata; previously returned snapshots remain unchanged.

### Step 3: Virtualize off-screen live cards safely

Keep live Activity state in the existing feed/index (including ActivityManagerBridge's uncapped running identities) but allow off-screen message nodes to be disposed/reconstructed. Define a small protected set: viewport-visible live cards, focused/expanded card, and newest/high-priority cards. Placeholder/archive counts must remain truthful and status changes must rehydrate a card when it enters view.

Do not cap or discard the underlying running Activity identities.

**Verify**: `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts src/sumo-tui/widgets/chat-pager.perf.test.ts -t "100 live Activities|rehydrates live card|settles virtualized card"` → retained node count is viewport/protected-set bounded; programmatic scroll through all 100 IDs shows current status/output; settlement preserves order and unread state.

### Step 4: Prove existing visual canon is unchanged

The 100-card stress behavior belongs in the headless tests above; do **not** add a parity scenario because every scenario requires an approved Bible target/crop contract. Run the existing completed landscape fixture to prove viewport-visible composition is unchanged, then run the full visual gate. Inspect its styled-cell and geometry reports; do not promote anything.

**Verify**: `pnpm visual:review -- --scenario fixture-completed-landscape && pnpm visual:ci` → exit 0; `docs/visual/out/parity/fixture-completed-landscape/raw/styled-cell-diff.txt` and `geometry-audit.txt` are produced; `git status --short docs/visual/parity docs/ui/bible` shows no scenario/Bible/golden changes.

### Step 5: Run all gates

**Verify**: all command-table commands pass.

## Test plan

Cover long committed history, draft replacement, multiple live tools, unknown tool IDs, compaction insertion, full hydration rebuild, scroll while live cards update, focused/expanded off-screen card, settlement, and node disposal/reconstruction.

## Done criteria

- [x] A live update uses constant indexed lookup and bounded message/block copying, with only the documented single shallow O(history) messages-array snapshot copy.
- [x] Retained render node count is viewport/budget bounded even when many Activities run.
- [x] Underlying live Activity identities/status are never dropped.
- [x] Scroll, ordering, folding, expansion, and hydration behavior remain correct.
- [x] Named perf/headless tests prove bounded update operations, node count, identity retention, and rehydration.
- [x] Full unit/integration/visual gates pass with review evidence.
- [x] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping and ignored visual review output.
- [x] Plan 107's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a retained-rendering assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Existing visual canon cannot verify unchanged composition without a new scenario/Bible target; do not add one in this plan.
- Index drift can produce a wrong-message update, or retaining view models by reference would preserve stale order-dependent task metadata after a structural committed change.
- Virtualization hides a running task with no way to navigate/rehydrate it.
- Meeting the bound requires changing visual hierarchy without a reviewed fixture.
- Golden promotion appears necessary.

## Maintenance notes

Rebuild indexes at structural boundaries; do not incrementally patch through unknown changes. The shallow array-envelope copy is an explicit current-API cost, not evidence of a failed optimization; any persistent/chunked representation proposal needs a separate consumer-migration plan. Reviewers should inspect mutation tests that swap duplicate IDs/order, not only happy-path performance fixtures.
