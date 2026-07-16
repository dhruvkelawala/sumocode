# Plan 066: Deliver settled subagent results as typed, deferred, consumed-tracked messages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/subagents/ src/sumo-tui/transcript/view-model.ts src/extension.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/065-subagents-core.md
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15

## Why this matters

Today, background completions reach the parent agent as **fake user prose**
(`pi.sendUserMessage(...)` in `src/background-tasks/task-manager.ts`
`finalizeTask`), which blurs the line between human input and runtime events,
or not at all (the model is told to poll). The decided contract
(`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`, P0 §2) is
**auto-delivery**: when a child settles, its result is buffered, then flushed
to the parent as a **typed custom message** when the parent is idle — with
consumed-tracking so a result collected via `subagent_wait` is never delivered
twice. This makes "spawn, keep working, results arrive" the default operating
mode instead of poll loops.

## Current state

- `src/subagents/manager.ts` (created by plan 065) — exposes
  `addChangeListener`, snapshots with `status`/`finalText`/`errorText`, and a
  `consumedIds: Set<string>` populated by `waitFor`/`cancel`. If plan 065 is
  not merged, STOP.
- Typed-message injection API (Pi extension API):
  `pi.sendMessage({ customType, content, display, details }, { deliverAs: "followUp", triggerTurn: true })`.
  A repo exemplar of `sendMessage` with a `customType` is
  `src/answer-tool.ts` (see its test asserting
  `customType: "answers"` at `src/answer-tool.test.ts:114-117`).
  `pi.registerMessageRenderer(customType, ...)` exists on the API (mocked in
  `src/extension.test.ts:67-68`).
- Parent-idle signal: `pi.on("agent_end", ...)` fires when the parent's turn
  settles — exemplar `src/task-mode.ts:247` (`pi.on("agent_end", (event, ctx) => …`).
- The prose-injection pattern to NOT copy (for contrast):

  ```ts
  // src/background-tasks/task-manager.ts:1005-1010 (approx)
  this.pi.sendUserMessage(message, { deliverAs: "followUp" });
  ```

- SumoTUI transcript mapping: custom/tool messages become `ChatBlock`s in
  `src/sumo-tui/transcript/view-model.ts` (block union at
  `src/sumo-tui/widgets/chat-message.ts:46-56`; `summaryBlockFromRecord` at
  `view-model.ts` is a good exemplar of mapping a labeled, expandable block).
- Conventions: tabs, strict TS, colocated vitest tests, model-facing strings
  in a `prompt.ts`.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                 | exit 0              |
| All tests | `pnpm test`                                      | all pass            |
| One file  | `pnpm vitest run src/subagents/delivery.test.ts` | all pass            |

## Scope

**In scope**:
- `src/subagents/delivery.ts` (create) + `src/subagents/delivery.test.ts`
- `src/subagents/prompt.ts` (extend: result-message builder)
- `src/subagents/index.ts` (wire delivery into `installSubagents`)
- `src/sumo-tui/transcript/view-model.ts` (map the custom message to a block)
- `src/sumo-tui/transcript/view-model.test.ts` (extend)

**Out of scope**:
- `src/background-tasks/**` — its `notifyOnExit` prose path is replaced in
  plan 067, not here.
- Any dashboard/takeover UI (plan 068).
- Changing Pi's RPC protocol or the transcript pump architecture — if the
  custom message does not flow through to the retained renderer, that is a
  STOP condition, not something to fix here.

## Git workflow

- Branch: `advisor/066-typed-deferred-result-delivery`
- Conventional commits, e.g. `feat(subagents): typed deferred result delivery`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Deferred delivery buffer (`src/subagents/delivery.ts`)

Pure module, fully unit-testable without Pi:

```ts
export interface DeferredResultDelivery {
    defer(id: string, build: () => DeliveryPayload): void;
    consume(id: string): void;           // drop without delivering
    drain(): DeliveryPayload[];          // returns & clears all pending
    clear(): void;
    readonly size: number;
}
export function createDeferredResultDelivery(): DeferredResultDelivery;
```

`DeliveryPayload = { id, title, status, content, details }`. `defer` on an
already-consumed id is a no-op. `consume` after `defer` removes the pending
entry.

**Verify**: `pnpm vitest run src/subagents/delivery.test.ts` → pass
(defer→drain, consume-before-defer, defer-then-consume, double-drain empty).

### Step 2: Result message builder (`src/subagents/prompt.ts`)

`buildSubagentResultMessage({ id, title, status, errorText?, output })` →
`` Subagent sa-N "title" finished|failed. `` + optional `Error:` line + output
truncated to **24KB / 600 lines** with a trailing pointer to the child session
file for the full transcript (`sessionFilePath` from the snapshot, when set).

**Verify**: `pnpm typecheck` → exit 0

### Step 3: Wire settle → defer → flush-on-idle (`src/subagents/index.ts`)

In `installSubagents(pi)`:

1. On manager change, for each newly settled child whose id is NOT in
   `consumedIds` and not yet deferred: `delivery.defer(id, buildPayload)`.
2. Flush = for each drained payload:

   ```ts
   pi.sendMessage(
       { customType: "subagent-result", content: payload.content, display: true,
         details: { id: payload.id, title: payload.title, status: payload.status } },
       { deliverAs: "followUp", triggerTurn: true },
   );
   ```

3. Flush triggers: immediately if the parent is idle; otherwise on the next
   `pi.on("agent_end", ...)`. Determine idleness the same way `task-manager`'s
   recovery guard avoids waking mid-turn — if no reliable idle probe exists on
   the extension API, flush ONLY from `agent_end` (never mid-turn) and note it.
4. `subagent_wait`/`subagent_cancel` must call `delivery.consume(id)` for each
   id they collect (in addition to the manager's consumed set), so a result
   already returned inline is never re-delivered.

**Verify**: `pnpm vitest run src/subagents/index.test.ts` (create if absent)
→ a fake-pi harness proves: settle-while-parent-busy defers, `agent_end`
flushes exactly once with `customType: "subagent-result"` and
`deliverAs: "followUp"`, waited results are not delivered.

### Step 4: Render the result card in SumoTUI

In `src/sumo-tui/transcript/view-model.ts`, map incoming records with
`customType === "subagent-result"` to a `summary`-style block:
label `[subagent] sa-N · <title> · finished|failed`, collapsed by default,
content = message text, expanded toggle reusing the existing `summary` block
machinery (`summaryBlockFromRecord` is the structural exemplar; add a sibling
`subagentResultBlockFromRecord`). Do not invent a new ChatBlock variant unless
the `summary` variant cannot carry it.

**Verify**: `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts` →
new test: a message record with `customType: "subagent-result"` produces one
block with the expected label and collapsed state.

### Step 5: Update spawn-result text

`subagent_spawn`'s return text (plan 065 said "use subagent_wait") now reads:
"Its result will be delivered to you automatically when it settles, or use
subagent_wait to block for it." Update `prompt.ts` and the tools test.

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `delivery.test.ts` — pure buffer semantics (4 cases listed in Step 1).
- `index.test.ts` — end-to-end fake-pi: defer→flush-on-agent_end exactly once;
  consumed-by-wait never flushes; failed child delivers with `status: "error"`.
- `view-model.test.ts` — custom-type mapping (Step 4).
- Structural exemplars: `src/answer-tool.test.ts` (sendMessage assertions),
  `src/sumo-tui/transcript/view-model.test.ts:87+` (block mapping tests).

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `rg -n "sendUserMessage" src/subagents/` returns no matches (typed only)
- [ ] `rg -n "subagent-result" src/subagents src/sumo-tui/transcript` shows the
      send site and the render mapping
- [ ] Delivered exactly once per settled, unconsumed child (test-proven)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Plan 065's manager/consumed-set does not exist or diverges from the shape
  described in Current state.
- `pi.sendMessage` with `customType` does not surface in the retained SumoTUI
  transcript (the RPC transcript pump drops custom messages) — report the drop
  point (file:line) instead of patching the pump.
- `triggerTurn: true` causes the parent to loop (delivered message triggers a
  turn which triggers delivery…) — report with a repro.
- There is no safe way to detect parent idleness AND `agent_end` never fires
  in some session mode you can demonstrate.

## Maintenance notes

- Plan 067 reuses `createDeferredResultDelivery` for terminal exits — keep the
  module generic (payload in, payload out; no subagent-specific imports).
- Plan 070 deletes the `sendUserMessage` prose path in bg_task once parity is
  proven; reviewers should confirm this plan did not touch it.
- If Pi later adds a first-class runtime-event channel, the flush site in
  `index.ts` is the only place to swap.
