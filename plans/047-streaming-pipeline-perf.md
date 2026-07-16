# Plan 047: Make the streaming token path O(1) and bound live-session pager memory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/043-transcript-replace-semantics..HEAD -- src/sumo-tui/transcript/controller.ts src/sumo-tui/widgets/chat-pager.ts`
> Your base branch is `advisor/043-transcript-replace-semantics` (this plan
> builds on 043's replace semantics and tests). On excerpt mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/043-transcript-replace-semantics.md
- **Category**: perf
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Two residual costs after the B9 incremental sink:

1. **Per-token prefix scan.** Every `message_update` publishes a full
   view-model array copy, then `planChatDiff` proves "only the last message
   changed" by re-serializing EVERY prefix message with
   `JSON.stringify([id, role, blocks])`. Streaming cost grows with transcript
   length — long resumed sessions feel slower per token.
2. **Unbounded live-session memory.** The full-hydration path caps rendered
   messages (archives become a virtual COUNT), but the incremental append
   path shifts overflow `ChatMessage` objects into a retained
   `archivedMessages` array — Yoga nodes, render caches and all — for the
   session lifetime.

## Current state

- `src/sumo-tui/transcript/controller.ts:426-430` — every live event returns
  `this.publish(this.viewModel())`; `viewModel()` copies the committed array
  (`[...this.ensureCommittedViewModels()]`) before appending the draft.
- `src/sumo-tui/transcript/controller.ts:583-603` — `diffAndApplyToChat`
  computes `planChatDiff(previous, next)` per publish; falls back to
  `chat.replaceViewModels(next)` when `undefined` (history rewritten) or when
  no previous.
- `src/sumo-tui/transcript/controller.ts:616-665` — `planChatDiff` +
  `sameContentExceptLast` + `messageContentKey`:

```ts
function messageContentKey(message: ChatMessageViewModel | undefined): string {
	if (!message) return "";
	return JSON.stringify([message.id, message.role, message.blocks]);
}
```

  `sameContentExceptLast` loops every prefix index calling this per element —
  per streamed token.
- NOTE: plan 043 may have added a timestamp component to this key — read the
  live code in your base branch first; your memoization must key whatever the
  final serialized shape is.
- `src/sumo-tui/widgets/chat-pager.ts:109-130` (`replaceViewModels`, the
  BOUNDED pattern): windowed render, `this.archivedMessages = [];
  this.virtualArchivedCount = Math.max(0, acceptedMessages -
  renderedWindow.length);`
- `src/sumo-tui/widgets/chat-pager.ts:314-339` (`virtualizeIfNeeded`, the
  UNBOUNDED path): shifts overflow actives into `this.archivedMessages.push(archived)`
  and detaches from the scroll box — objects retained.
- `getLastMessage()` and placeholder logic read archived state — find every
  reader of `archivedMessages`/`getArchivedMessageCount()` before changing
  representation (`grep -n "archivedMessages\|ArchivedMessage" src/sumo-tui/widgets/chat-pager.ts`).
- Committed view-model cache exists (`ensureCommittedViewModels`), so block
  arrays are REUSED across publishes for committed messages — object identity
  of prefix elements is stable between consecutive publishes during a run.
  This is what makes a WeakMap memo effective.
- Tests: `src/sumo-tui/transcript/controller.test.ts` (~:192-330 decision
  matrix — these must keep passing UNWEAKENED), `src/sumo-tui/widgets/chat-pager.test.ts`.
- Conventions: tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/widgets/chat-pager.test.ts` | all pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/controller.ts`, `src/sumo-tui/widgets/chat-pager.ts`
- `src/sumo-tui/transcript/controller.test.ts`, `src/sumo-tui/widgets/chat-pager.test.ts`

**Out of scope**:
- `src/sumo-tui/rpc/**` (shell-adapter/runtime/host) — the sink contract
  (`replaceViewModels` / `addViewModel` / `replaceLastWithViewModel`) must not
  change shape.
- `chat-message.ts` (043 owns its mutators).
- Scroll/unread semantics — existing tests pin them.

## Git workflow

- Branch: `advisor/047-streaming-pipeline-perf` off
  `advisor/043-transcript-replace-semantics`
- Conventional commits (`perf(sumo-tui): ...`). Do NOT push.

## Steps

### Step 1: Memoize `messageContentKey` per view-model object

Add a module-level `WeakMap<ChatMessageViewModel, string>` cache inside
`controller.ts`; `messageContentKey` checks it first. Because committed
view models are cached and reused between publishes, prefix keys compute once
per message instead of once per token. (Draft/last messages get fresh objects
per event — they still recompute, which is correct.)

**Verify**: new controller.test.ts counting test — wrap/instrument
`JSON.stringify` via an injectable or count WeakMap misses through a test
seam (simplest honest approach: export `messageContentKey` for tests behind
the existing test-export conventions if the file has any, else assert
indirectly — publish a 50-message transcript, then deliver 10 message_update
events and assert the diff still yields replace-last ops while a
`performance.now()`-free structural assertion holds: the SAME prefix
view-model objects were not re-serialized — e.g. by asserting WeakMap size
via a test-only accessor). Choose ONE mechanism and state it in the report.

### Step 2: Skip the prefix scan when the event already knows its op

`handleAgentEvent` knows what changed: `message_update` mutates only the
draft (replace-last or append when a draft first appears), `message_end`
commits, `agent_end`/hydration rewrite history. Introduce a private hint
(e.g. `this.pendingChatOp: "incremental" | "rewrite" | undefined`) set at the
event site and consumed by `diffAndApplyToChat`:

- hint `"incremental"` AND `previous` defined AND
  `next.length - previous.length ∈ {0, 1}` → build ops directly comparing ONLY
  the boundary elements (last of previous vs same index of next via
  memoized keys) — no prefix loop;
- hint `"rewrite"` or missing/violated invariants → today's full
  `planChatDiff` path (which itself now benefits from Step 1's memo).

Keep `planChatDiff` exported/unchanged for the fallback and its tests.

**Verify**: the FULL existing decision-matrix suite passes unweakened; new
test: a `message_update` against a 200-message committed transcript performs
zero prefix-element key computations (assert via the Step 1 mechanism) and
still emits a replace-last op; an `agent_end` history rewrite still triggers
`replaceViewModels`.

### Step 3: Bound incremental archives like hydration does

In `virtualizeIfNeeded` (chat-pager.ts:314-339): instead of retaining shifted
messages, dispose each (`archived.dispose?.()` — find the disposal method
used by `disposeMessageNodes` at :124 and reuse it), increment
`virtualArchivedCount`, and stop pushing to `archivedMessages`. Update every
reader found in "Current state" grep:
- `getLastMessage()` fallback: only relevant when actives are empty — with
  virtualization only firing when actives EXCEED the cap, verify an
  empty-actives-with-archives state is impossible in the incremental path; if
  a reader genuinely needs the last archived object, STOP and report.
- placeholder text: uses counts — switch to `virtualArchivedCount` (the
  hydration path already does).

**Verify**: chat-pager.test.ts — append `maxRenderedMessages + 50` view
models: `activeMessages.length <= maxRenderedMessages`, retained archived
OBJECT count is 0 (or the placeholder shows the right archived COUNT), scroll
behavior tests still green; dispose called once per evicted message (spy).

## Test plan

Per steps; patterns from the existing matrix tests. No test may be weakened —
if one fails, the change is wrong, not the test.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0, matrix unweakened (`git diff` on the test
      file shows additions, no deleted assertions except renames noted in the
      report)
- [ ] O(1)-token test exists and passes (mechanism named in report)
- [ ] Bounded-archive test exists and passes with dispose verification
- [ ] `git status` — only the 4 in-scope files changed

## STOP conditions

- The sink contract would need a new method or changed signature.
- A reader of `archivedMessages` needs live objects (report which and why).
- Any decision-matrix test only passes weakened.
- 043's expansion/timestamp tests fail under the op-hint path (that means the
  hint skips their reapplication — the hint must not bypass 043's semantics).

## Maintenance notes

- The hint is an optimization; the full diff is the safety net. Reviewer:
  verify the hint resets on EVERY event type (a stale "incremental" hint
  across an `agent_end` would corrupt history).
- Future: if per-message (non-global) expansion state lands, revisit Step 3's
  dispose (expansion state on disposed nodes must live in the view model, not
  the node).
