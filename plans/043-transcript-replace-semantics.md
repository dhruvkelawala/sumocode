# Plan 043: Make tool-expansion and timestamps survive incremental transcript replaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/widgets/chat-pager.ts src/sumo-tui/widgets/chat-message.ts src/sumo-tui/transcript/controller.ts`
> On drift, compare "Current state" excerpts; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Two presentation-state bugs in the B9 incremental chat sink:

1. **Tool expansion resets mid-stream.** Ctrl+O (`app.tools.expand`) calls
   `ChatPager.setToolExpansion`, which mutates only the currently rendered
   `ChatMessage` nodes. The next streaming delta goes through
   `replaceLastWithViewModel`, which overwrites the last message's blocks from
   the controller's view model — which knows nothing about the toggle — so the
   user's collapse/expand is silently undone while the agent streams.
2. **Timestamps are fabricated.** A draft `ChatMessage` created without a
   timestamp defaults to `new Date()` at node-creation time; the incremental
   replace path never adopts the authoritative timestamp from the final view
   model, and the diff key deliberately excludes timestamps — so the visible
   assistant time can be the moment the draft node happened to be created.

## Current state

- `src/sumo-tui/widgets/chat-pager.ts:181-189`:

```ts
public replaceLastWithViewModel(message: ChatMessageViewModel): void {
	const last = this.getLastMessage();
	if (!last) {
		this.addViewModel(message);
		return;
	}
	last.setRole(chatRoleFromViewModel(message));
	this.updateLast(last, () => last.setBlocks(message.blocks, chatMessageViewModelToPlainText(message)));
}
```

- `src/sumo-tui/widgets/chat-pager.ts:191-204` — `setToolExpansion(expanded)`
  loops `this.activeMessages` calling `message.setToolExpansion(expanded)`;
  the boolean is not retained anywhere on the pager.
- The toggle's only caller: `src/sumo-tui/rpc/host.ts:474` area — the
  `app.tools.expand` handler stores a host-local boolean and calls
  `runtime?.setToolExpansion(expanded)`; the semantic is a GLOBAL
  expand/collapse-all toggle, not per-message.
- `src/sumo-tui/widgets/chat-message.ts:351-379` — `ChatMessage` has
  `public readonly timestamp: Date` (:352), constructor default
  `timestamp = new Date()` (:371). `contentVersion`/`renderRowsCache`
  (:356-364) is the render memo; the doc comment warns: "A missed bump site
  means a stale frame, so if you add a new mutator that changes rendered
  output, bump this in it too."
- Timestamp IS rendered chrome: frame rendering includes the right-side time
  for assistant/sumo messages (around `chat-message.ts:198-211`).
- `src/sumo-tui/transcript/controller.ts:652-665` — `messageContentKey`
  excludes timestamp with this rationale: "Deliberately excludes
  `displayName`/`timestamp` since those are re-derived deterministically from
  `role`/the source message and are not meaningful signals of a content
  change on their own."
- `src/sumo-tui/transcript/controller.ts:583-641` — `diffAndApplyToChat` +
  `planChatDiff` decide replace-last/append/full-replace.
- Existing test patterns: `src/sumo-tui/widgets/chat-pager.test.ts`,
  `src/sumo-tui/widgets/chat-message.test.ts`,
  `src/sumo-tui/transcript/controller.test.ts` (B9 decision-matrix tests at
  ~:192-330). Tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts src/sumo-tui/widgets/chat-message.test.ts src/sumo-tui/transcript/controller.test.ts` | all pass |

Full `pnpm test` currently exits 1 from a known unrelated flake — not a gate.

## Scope

**In scope**:
- `src/sumo-tui/widgets/chat-pager.ts`, `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/transcript/controller.ts` (only `messageContentKey` and only
  if Step 0 proves it safe)
- Their three colocated test files

**Out of scope**:
- `src/sumo-tui/rpc/**` (the host handler already works; it calls the pager).
- The B9 diff algorithm structure (`planChatDiff` op kinds) — a separate plan
  optimizes it; keep the op shapes stable.
- Per-message (non-global) expansion UX — the global-toggle semantic stays.

## Git workflow

- Branch: `advisor/043-transcript-replace-semantics`
- Conventional commits (`fix(sumo-tui): ...`). Do NOT push.

## Steps

### Step 0: Verify timestamp provenance (decides Step 3's shape)

Find where `ChatMessageViewModel.timestamp` is produced (look in
`src/sumo-tui/transcript/view-model.ts`). Confirm the claim in
`messageContentKey`'s comment: timestamps are derived deterministically from
the SOURCE message (e.g. a persisted `timestamp` field), NOT from wall-clock
at view-model build time. Record the exact line in your report.

- If deterministic → proceed with Step 3 as written (include timestamp in the
  content key).
- If wall-clock-derived at build time → STOP condition: including it in the
  key would make every remap a replace. Report; implement only Steps 1–2 and
  the `replaceLastWithViewModel` timestamp adoption (which is still correct).

### Step 1: Make global expansion a retained pager policy

In `chat-pager.ts`:
- Add `private toolExpansionOverride: boolean | undefined;`
- `setToolExpansion(expanded)` sets it, then applies to active messages as
  today.
- `addViewModel` / `addPreparedMessage` / `replaceLastWithViewModel` apply the
  override to the incoming/updated message AFTER `setBlocks`:
  `if (this.toolExpansionOverride !== undefined) message.setToolExpansion(this.toolExpansionOverride);`
  (inside the same `updateLast` mutation callback for the replace path so
  height bookkeeping stays consistent).
- `replaceViewModels` (full hydration) also applies the override to each
  freshly created message — check where messages are constructed there and
  apply once per message.

**Verify**: `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts` — new
test: create pager, add a message with a collapsible tool block, call
`setToolExpansion(false)`, then `replaceLastWithViewModel` with an updated
view model containing the same tool block — assert the rendered rows keep the
collapsed representation (this must FAIL against the current code; note that
in a test comment).

### Step 2: Adopt the authoritative timestamp on replace

In `chat-message.ts`:
- Change `public readonly timestamp: Date` to a private field with a public
  getter, and add `setTimestamp(next: Date): void` that no-ops when the
  rendered minute representation is unchanged and otherwise updates +
  `invalidateRenderCache()` (the memo doc comment demands the bump).
- Keep `toSnapshot()` shape unchanged.

In `chat-pager.ts` `replaceLastWithViewModel`, when `message.timestamp` is
present, call `last.setTimestamp(message.timestamp)` inside the `updateLast`
callback.

**Verify**: chat-message.test.ts — `setTimestamp` with a different time
changes `renderRows` output (time chrome) and bumps the memo;
chat-pager.test.ts — replace-last adopts the view model's timestamp.

### Step 3: Include timestamp in the diff identity (only if Step 0 says deterministic)

In `controller.ts` `messageContentKey` (:662-665), include the timestamp's
epoch value in the serialized key and UPDATE the doc comment (it currently
documents the exclusion). Run the full controller decision-matrix suite; if
any existing matrix test breaks because fixtures omit timestamps, prefer
fixing the fixtures to carry stable timestamps over weakening assertions.

**Verify**: `pnpm vitest run src/sumo-tui/transcript/controller.test.ts` → all
pass.

## Test plan

- chat-pager.test.ts: expansion survives replace-last; expansion survives
  append; expansion applied on full hydration; timestamp adopted on replace.
- chat-message.test.ts: `setTimestamp` render + memo bump; unchanged-minute
  no-op.
- controller.test.ts: existing matrix green; if Step 3 taken, a case where
  only the timestamp differs produces a replace-last (not a no-op).
- Patterns: existing tests in the same files.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/widgets/chat-pager.test.ts src/sumo-tui/widgets/chat-message.test.ts src/sumo-tui/transcript/controller.test.ts` exits 0
- [ ] Expansion-survives-replace test exists and passes (and is documented to fail pre-change)
- [ ] Timestamp-adoption test exists and passes
- [ ] Step 0 provenance finding recorded in the report with file:line
- [ ] `git status` — only in-scope files changed

## STOP conditions

- Step 0 finds wall-clock-derived timestamps (do Steps 1–2 only; report).
- Applying the override in `replaceViewModels` requires restructuring the
  windowed hydration loop (report instead).
- Any controller decision-matrix test can only pass by weakening what it
  asserts.

## Maintenance notes

- Plan 047 (streaming perf) rewrites how diff ops are derived; it depends on
  this plan's semantics (override reapplication + timestamp adoption) and its
  tests. Land this first.
- Reviewer: check every new `ChatMessage` mutator bumps `contentVersion`
  (the memo comment's contract), and that `setToolExpansion`'s height
  accounting still flows through `updateLast`/`notifyContentChanged`.
