# Plan 089: Retire the host prompt FIFO in favor of Pi's native steer/follow_up/clear_queue

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **GATE (check before anything else — this plan is version-gated)**:
>
> ```bash
> rg -n "clear_queue" node_modules/.pnpm/@earendil-works+pi-coding-agent*/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
> node -e "const t=require('@earendil-works/pi-coding-agent/package.json'); console.log(t.version)"
> ```
>
> The pinned Pi must document the `clear_queue` RPC command and its
> `RpcCommand` type union must include `{ type: "clear_queue" }`,
> `{ type: "steer", ... }`, and `{ type: "follow_up", ... }`. As of Pi 0.84.3
> `clear_queue` is **not released** (merged upstream 2026-08-25, issue
> earendil-works/pi#8432). If the check fails, STOP: this plan is blocked on a
> Pi version bump, which is an operator decision (AGENTS.md requires every Pi
> bump to re-verify the RPC contract). Do not vendor types or patch Pi.
>
> **Drift check (run second)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   src/sumo-tui/rpc/prompt-scheduler.ts src/sumo-tui/rpc/prompt-scheduler.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts \
>   src/sumo-tui/rpc/editor.ts src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/controls.test.ts \
>   src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/state.test.ts \
>   test/integration/rpc-child-fixture.ts test/integration/rpc-queued-message-undo.test.ts
> ```
>
> On drift, reconcile the "Current state" excerpts against live code; on a
> semantic mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: a Pi release containing RPC `clear_queue` (> 0.84.3) adopted
  into this repo; plan 088 is independent (different layer) but land 088 first
  to keep review load sane.
- **Category**: tech-debt / parity
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Supersedes**: plan 087 (BLOCKED force-send escape hatch) — mark it
  REJECTED/superseded in the index when this lands; also retires the
  host-owned FIFO introduced by plan 078.

## Why this matters

SumoCode maintains a host-owned prompt FIFO because, when it was built (plan
078), Pi's RPC queue was write-only: a queued message could never be reclaimed,
so Esc-restore and Alt+Up undo required host ownership. That FIFO now costs us:

- Busy Enter waits for the **entire agent run to settle** before sending — you
  cannot redirect a long multi-turn run (this is also why steering a visible
  subagent through its PTY is useless today).
- Plan 087 tried to bolt a force-send escape hatch onto the FIFO and got
  BLOCKED on an acceptance-ambiguity race; a partial implementation
  (`forceSendNext`, the `forceSteerState` barrier) now lives in
  `prompt-scheduler.ts` — ~150 lines of barrier logic guarding a race that
  native queueing simply does not have.

Upstream closed the gap: issue earendil-works/pi#8432 added RPC `clear_queue`,
which **returns and removes** queued steering/follow-up texts; the documented
recipe "send `clear_queue` before `abort`, then restore the returned text in
the client editor" is byte-for-byte the interactive Esc behavior. With `steer`,
`follow_up`, `queue_update`, and `clear_queue` all available over RPC, the host
FIFO, the force-steer barrier, and the Cmd+Enter escape hatch can be deleted,
and SumoCode inherits Pi's interactive semantics: **Enter while streaming =
steer (delivered between turns), Alt+Enter = follow-up, Esc = abort + restore
everything to the editor.**

## Current state

All paths relative to repo root; excerpts verified at `1ad967b`.

### `src/sumo-tui/rpc/prompt-scheduler.ts` (~400 lines) — the FIFO

- `private queue: string[]` holds busy submissions; `submit()` pushes when
  `isBusy()`; `drainOne()` sends one after `agent_settled` (and after
  `compaction_end`).
- `forceSendNext()` + `forceSteerState` (fields `startCountAtDispatch`,
  `turnEndCountAtDispatch`, `phase`, `ownership`, `lifecycleStarted`,
  `lifecycleSettled`) implement the plan-087 escape hatch: dispatch the FIFO
  head with `{ streamingBehavior: "steer" }` and hold the rest of the FIFO
  behind a lifecycle barrier because Pi 0.83 could not report whether an
  accepted prompt was queued, handled, or started a fresh lifecycle.
- `restoreAll(currentDraft)` / `rebindSession()` drain the host queue back into
  the editor draft (`combineDrafts` joins with `\n\n`).
- `handleAgentEvent` tracks `agent_start`, `message_start`, `queue_update`
  (steering-append detection for barrier ownership), `turn_end`,
  `compaction_end`, `agent_settled`.
- Failure handling: `RpcPromptPreflightRejection` → `queue.unshift(message)` +
  `pausedAfterFailure = true`; ambiguous failures → `onSteerAcceptanceUnknown`.

### `src/sumo-tui/rpc/host.ts` (1935 lines) — wiring

- `createRpcPromptScheduler({ getBusy, canForceSteer, handleHostCommand, sendPrompt, onQueueChange, ... })`
  at line ~1077. `onQueueChange` → `stateStore.setHostQueuedMessages(messages)`.
- `sendRpcPrompt` (line ~488–499) forwards `delivery?.streamingBehavior` onto
  the RPC `prompt` command.
- `handleRpcMessageFollowUp` (line ~527): Alt+Enter → `scheduler.submit(text, { forceQueue: true })`.
- `handleRpcMessageForceSend` (line ~556): Cmd+Enter → `scheduler.forceSendNext()`
  with three-way notification (`accepted`/`held`/`unknown`).
- `handleRpcMessageDequeue` (line ~573): Alt+Up → `scheduler.restoreAll(editor.getText())`;
  when Pi-owned entries remain it notifies `queued messages are owned by pi`.
- Escape/abort (line ~1383–1412): synchronously `scheduler.restoreAll(editorBefore, { discardInFlight: true })`
  **before** `controls.abort()`, then rehydrates from post-abort authoritative
  state. Session replacement/rebind paths call `scheduler.rebindSession(...)`.
- `DEFERRED_MESSAGE_QUEUE_ACTION_KEY` gates queue actions behind initial
  hydration.

### `src/sumo-tui/rpc/state.ts` — display model

Line ~269: the queue card renders `[...this.piQueuedMessages, ...this.hostQueuedMessages]`
— the display layer **already supports a Pi-owned queue** (`piQueuedMessages`
is fed from `queue_update` events). `shell-adapter.ts:498` renders
`state.queuedMessages` above the editor.

### `src/sumo-tui/rpc/controls.ts` / `client.ts` — RPC surface

`RpcCommandClient.send(command: RpcCommand)` where `RpcCommand` is imported
from `@earendil-works/pi-coding-agent`. Adding commands means using the union
members from the bumped Pi types — no local `.d.ts` exists to edit.

### `src/sumo-tui/rpc/editor.ts` — actions/keybindings

`app.message.followUp` (`alt+enter`), `app.message.dequeue` (`alt+up`),
`app.message.forceSend` (`super+enter`) registered via `this.editor.onAction`;
custom action ids use the narrow string-cast pattern. `renderHotkeysOverlay()`
in `host-actions.ts` documents them.

### Upstream contract (from Pi main `docs/rpc.md`, will ship in the bumped release)

- `{"type": "steer", "message": "..."}` — queue steering while running;
  delivered after the current assistant turn's tool calls, before the next LLM
  call. Extension commands not allowed (use `prompt`).
- `{"type": "follow_up", "message": "..."}` — delivered when the agent stops.
- `{"type": "clear_queue"}` → `{"data": {"steering": [...], "followUp": [...]}}`
  — removes and returns queued texts. "To implement interactive Esc behavior,
  send `clear_queue` before `abort`, then restore the returned text in the
  client editor. `abort` continues queued messages when they remain."
- `queue_update` events remain the authoritative queue snapshot for display.
- `set_steering_mode` default is `one-at-a-time`; do not change it in this plan.

## Target semantics (the contract to implement)

| Interaction | Today (FIFO) | After this plan |
|---|---|---|
| Enter while idle | `prompt` | `prompt` (unchanged) |
| Enter while streaming | host FIFO, sent after `agent_settled` | RPC `steer` — Pi-owned, delivered between turns |
| Alt+Enter | host FIFO (`forceQueue`) | RPC `follow_up` — Pi-owned |
| Cmd+Enter force-send | `forceSendNext` + barrier | **removed** (binding, action, overlay row, handler) |
| Queue card | host + pi merged lists | `queue_update`-fed `piQueuedMessages` only |
| Alt+Up | restore host FIFO to editor | `clear_queue` → restore returned steering+followUp texts to editor |
| Esc during streaming | restore host FIFO, then `abort` | `clear_queue`, restore returned texts, then `abort` (upstream recipe) |
| Session rebind/replace | restore host FIFO | `clear_queue` best-effort on the outgoing session; restore returned texts |
| Host `/commands` while busy | intercepted by `handleHostCommand` before queueing | unchanged — host commands are still intercepted at submit time and never sent as `steer` (RPC steer rejects extension commands) |
| Steer/prompt preflight rejection | unshift + `pausedAfterFailure` | restore the text into the editor draft + error notification; no pause state |

`RpcPromptScheduler`'s public interface shrinks: `forceSendNext`,
`RpcPromptForceSendResult`, `canForceSteer`, `onSteerAcceptanceUnknown`,
`onDispatchStateSync`, `pausedAfterFailure`, and the entire `forceSteerState`
machinery are deleted. `submit`/`handleAgentEvent`/`rebindSession`/`getSnapshot`
remain (snapshot's `queuedMessages` now mirrors the Pi queue for tests/UI).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused units | `pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/state.test.ts` | pass |
| Queue integration | `pnpm vitest run test/integration/rpc-queued-message-undo.test.ts --fileParallelism=false` | pass |
| **Lint (CI gate)** | `pnpm lint` | exit 0, `Found 0 warnings and 0 errors` |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm exec tsc --noEmit && pnpm build && pnpm visual:ci` | exit 0 |

`pnpm lint` runs anti-slop oxlint and **blocks CI**. It is strict about test doubles in
particular: no explicit anonymous object types on bindings (use a named type alias or
`satisfies`), every `as` assertion needs a `// SAFETY:` comment stating the checked
invariant immediately before it, no conditional spreads that hide property omission
(`...(cond ? { k: v } : {})`), and no bare `unknown` parameters (use a generic or a named
domain type). Run it after every step, not just at the end.

## Scope

**In scope**:

- `src/sumo-tui/rpc/prompt-scheduler.ts` (+test)
- `src/sumo-tui/rpc/host.ts` (+test)
- `src/sumo-tui/rpc/host-actions.ts` (+test)
- `src/sumo-tui/rpc/editor.ts` (+test)
- `src/sumo-tui/rpc/controls.ts` (+test)
- `src/sumo-tui/rpc/state.ts` (+test) — remove `hostQueuedMessages` merge
- `test/integration/rpc-child-fixture.ts`, `test/integration/rpc-queued-message-undo.test.ts`
- `plans/README.md` (status rows: 089, and mark 087 superseded)

**Out of scope**:

- The Pi version bump itself and its contract re-verification (operator-owned
  precondition; see GATE).
- `src/subagents/*`, `src/task-mode.ts` — plan 088's layer.
- `set_steering_mode` / `set_follow_up_mode` configuration UI.
- Queue-card geometry, visual tokens, golden promotion.
- Session tree navigation, compaction, replacement-mode semantics beyond the
  queue-restore call sites named above.

## Git workflow

- Branch: `advisor/089-native-pi-queue`
- Conventional commits, e.g. `refactor(rpc): replace host prompt FIFO with pi native queue`
- Do not push or open a PR unless the operator requests it.

## Steps

### Step 1: Add `steer`, `followUp`, and `clearQueue` to controls

In `src/sumo-tui/rpc/controls.ts`, alongside the existing `prompt` senders:

```ts
public async steer(message: string): Promise<void> {
	responseData(await this.client.send({ type: "steer", message }), "steer");
}
public async followUp(message: string): Promise<void> {
	responseData(await this.client.send({ type: "follow_up", message }), "follow_up");
}
public async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> { ... }
```

Match the surrounding `responseData` error-translation style exactly.
`clearQueue` must tolerate a missing/malformed `data` by returning empty arrays
(defensive, but log via the existing diagnostics path if one exists in this
file's patterns).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/controls.test.ts` → pass, with
new cases for all three commands including failure translation.

### Step 2: Rewrite the scheduler as a thin router (test-first)

Rewrite `prompt-scheduler.test.ts` to the target semantics table, then gut
`DefaultRpcPromptScheduler`:

- Delete: `queue`, `forceSendNext`, `forceSteerState`, `pausedAfterFailure`,
  `piSteeringQueue` append-detection, `drainOne`, the `turn_end`/`message_start`
  barrier tracking.
- `submit(message)`: empty → `ignored`; `handleHostCommand` → `handled`; idle →
  `sendPrompt` → `sent`; busy → `sendSteer(message)` → `queued`; explicit
  follow-up (`{ forceQueue: true }` becomes `{ delivery: "followUp" }` — rename
  the option and update the one caller) → `sendFollowUp` → `queued`.
- Rejection of any send restores the text via a new `onRestoreToEditor(text)`
  callback (host wires it to prepend into the editor draft using the existing
  `combineDrafts` join) and notifies via `onDispatchFailure`.
- `handleAgentEvent` keeps only `agent_start`/`agent_settled` busy tracking and
  `queue_update` mirroring into the snapshot.
- `restoreAll`/`rebindSession` no longer own texts; they become
  `async` seams that call an injected `clearQueue()` and return the joined
  restored text (keep the `RpcPromptRestoreResult` shape so call sites stay
  mechanical). When `clearQueue` fails (e.g. child already dead during
  replacement), return `count: 0` and let the caller proceed — texts still
  live in the dead session's queue, which no longer exists; never fabricate.

Scheduler options shrink to: `sendPrompt`, `sendSteer`, `sendFollowUp`,
`clearQueue`, `getBusy`, `handleHostCommand`, `onQueueChange` (now fed from
`queue_update`), `onDispatchStart`, `onDispatchFailure`, `onRestoreToEditor`.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts` → pass.

### Step 3: Rewire host.ts call sites

- Wire the new scheduler options from `controls` (step 1) at the
  `createRpcPromptScheduler` site (~1077).
- `handleRpcMessageFollowUp`: submit with the renamed follow-up option; drop
  the busy pre-check dance that existed for FIFO acceptance.
- Delete `handleRpcMessageForceSend` and its hydration-gate wiring
  (~1153–1155).
- `handleRpcMessageDequeue`: `await scheduler.restoreAll(...)` (now async);
  delete the `queued messages are owned by pi` notification — everything is
  reclaimable now.
- Escape/abort path (~1383–1412): replace the synchronous
  `scheduler.restoreAll(editorBefore, { discardInFlight: true })` with the
  async clear-then-abort sequence per the upstream recipe: `clear_queue` →
  merge returned texts into the editor draft → `abort`. Preserve the existing
  ordering guarantees this block documents (restore before the first fallible
  request; post-abort rehydration from authoritative state).
- Session rebind/replacement sites (~1286, ~1306): best-effort `clearQueue`
  on the outgoing session with the failure tolerance from step 2.
- `state.ts`: delete `setHostQueuedMessages` and the `hostQueuedMessages`
  merge; the queue card is `piQueuedMessages` only. Update `state.test.ts`.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/state.test.ts` → pass.

### Step 4: Remove the Cmd+Enter action and update docs surface

- `editor.ts`: remove `app.message.forceSend` registration + keybinding
  definition; keep `alt+enter` / `alt+up` bindings (their handlers changed,
  their keys did not). Update `editor.test.ts`.
- `host-actions.ts` `renderHotkeysOverlay()`: remove the Cmd+Enter row; update
  the Alt+Up row copy to "restore queued messages to editor" (it is now always
  true). Update colocated test.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts` → pass.

### Step 5: Integration proof

Extend `test/integration/rpc-child-fixture.ts` to implement `steer`,
`follow_up`, and `clear_queue` (return + drop queued texts, emit truthful
`queue_update`s). Rewrite `test/integration/rpc-queued-message-undo.test.ts`:

1. Busy A + Enter B → fixture log shows `{"type":"steer","message":"B"}` before
   A settles; queue card shows B (from `queue_update`).
2. Alt+Enter C → `{"type":"follow_up", ...}`.
3. Alt+Up → `clear_queue` sent; B and C restored into the editor in order
   steering-then-followUp; queue card empties.
4. Esc during streaming → `clear_queue` precedes `abort` in the command log;
   texts restored.
5. Idle Enter still sends plain `prompt` with no `streamingBehavior` field
   anywhere in the log.

If a real-Pi (non-fixture) seam exists in this suite and can run
credential-free, add one smoke: steer delivered before the next LLM call
boundary. If not feasible, note it in the plan status — the fixture proves the
wire contract; Pi's own tests own delivery semantics.

**Verify**: `pnpm vitest run test/integration/rpc-queued-message-undo.test.ts --fileParallelism=false` → pass.

### Step 6: Full gates and index

```bash
pnpm lint
pnpm test && pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
pnpm visual:ci
git status --short
```

Update `plans/README.md`: 089 → DONE; 087 → REJECTED (superseded by 089 —
native queue removes the FIFO the escape hatch existed for).

## Test plan

Covered per-step above. Structural patterns: existing
`prompt-scheduler.test.ts` (options-injection style), `controls.test.ts`
(responseData failure translation), `rpc-queued-message-undo.test.ts` (PTY
fixture command-log assertions).

## Done criteria

- [ ] GATE passed: pinned Pi documents `clear_queue` and types include it
- [ ] `grep -rn "forceSendNext\|forceSteerState\|pausedAfterFailure" src/` → no matches
- [ ] `grep -rn "app.message.forceSend" src/` → no matches
- [ ] `grep -rn "setHostQueuedMessages" src/` → no matches
- [ ] Busy Enter emits RPC `steer`; Alt+Enter emits `follow_up`; Esc emits
      `clear_queue` before `abort` (fixture log assertions exist and pass)
- [ ] `pnpm lint` exits 0
- [ ] All commands in "Full gates" exit 0; no golden promoted
- [ ] Only in-scope files modified; 089 and 087 index rows updated

## STOP conditions

- The GATE fails (Pi not bumped, or bumped Pi's `RpcCommand` lacks any of the
  three commands).
- `clear_queue` in the released Pi does not return the removed texts
  (`data.steering` / `data.followUp`) — undo parity is impossible; report.
- RPC `steer` rejects when the agent is idle in a way that breaks the
  busy-check race (submit decided "busy" but Pi became idle first) and no
  in-scope retry-as-`prompt` fallback resolves it cleanly. A single
  rejected-then-`prompt` retry in the scheduler is authorized; anything more
  elaborate is not.
- Esc restore requires changing replacement-mode, tree-navigation, or
  compaction semantics beyond the named call sites.
- Any queue text loss is observable in the integration tests (restored count
  mismatch) and cannot be fixed in scope.

## Maintenance notes

- This deletes plan 078's host FIFO and plan 087's escape hatch. If a future
  Pi regression breaks `clear_queue`, the fallback is a revert of this plan,
  not a partial resurrection of the FIFO.
- Reviewers should scrutinize the Esc path ordering (clear → restore → abort)
  and the rebind/replacement best-effort clears — those are the two places
  where texts could silently vanish.
- Behavior change to announce in release notes: busy Enter now *steers*
  (delivered between turns) instead of waiting for the run to settle; Alt+Enter
  is the "after it finishes" path. This matches interactive Pi.
- Visible-subagent bonus: once this lands, even PTY-typed input into a child
  pane steers mid-run; plan 088's control channel remains the ack'd,
  draft-safe path for orchestrators.
