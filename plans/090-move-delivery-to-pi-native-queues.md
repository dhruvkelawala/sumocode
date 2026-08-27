# Plan 090: Move prompt delivery to Pi queues with a steer-default toggle

> **Executor instructions**: Do not execute until Plans 088 and 089 are DONE.
> This is one atomic ownership migration: native enqueue, truthful display,
> clear/restore, interrupt ordering, and removal of the force-send behavior must
> land together. Follow every verification gate. Do not recreate a second
> general-purpose queue or emulate single-entry promotion with clear-and-requeue.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   src/cathedral/input-frame.ts src/cathedral/input-frame.test.ts \
>   src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/controls.test.ts \
>   src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/state.test.ts \
>   src/sumo-tui/rpc/prompt-scheduler.ts src/sumo-tui/rpc/prompt-scheduler.test.ts \
>   src/sumo-tui/rpc/editor.ts src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/interrupt.ts src/sumo-tui/rpc/interrupt.test.ts \
>   src/sumo-tui/rpc/shell-adapter.ts src/sumo-tui/rpc/shell-adapter.test.ts \
>   test/integration/rpc-child-fixture.ts \
>   test/integration/rpc-queued-message-undo.test.ts \
>   test/integration/rpc-compaction-ux.test.ts \
>   docs/visual/parity/scenarios.json
> ```
>
> Reconcile Plan 089's settled-state model first. If `clear_queue` is absent from
> the installed worker or returns a different shape, STOP.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 088 and 089
- **Category**: migration / feature / parity
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Issue**: [#377](https://github.com/dhruvkelawala/sumocode/issues/377)
- **Execution status**: BLOCKED — wait for the published Pi release containing `clear_queue`, then Plans 088 and 089

## Outcome

Pi becomes the sole authority for ordinary steering and follow-up delivery.
SumoCode provides a visible process-local **STEER / FOLLOW-UP** delivery toggle,
defaulting to **STEER** on every launch. While busy, Enter sends through
`prompt(..., {streamingBehavior: selectedMode})`; while idle the same command
starts normally. Alt+Enter remains a one-shot follow-up. Super+Enter toggles the
default busy-submit mode and never submits or reclassifies an existing message.

`queue_update` is the authoritative display snapshot. Alt+Up awaits
`clear_queue` and restores steering text before follow-up text. Escape performs
the same clear-and-restore transaction before `abort`. Only the narrow local
queue required during Pi compaction/summarization remains host-owned.

## Why this matters

Today normal busy Enter waits in SumoCode's FIFO, so it behaves like a deferred
follow-up instead of classic Pi's default steering. Pi simultaneously owns its
own steering and follow-up queues, producing two delivery authorities and a
large force-send race workaround. The published `clear_queue` command provides
the missing recovery boundary needed to remove that duplication safely.

## Locked behavior

| State/action | Required behavior |
|---|---|
| Launch | delivery mode is `steer`; preference is process-local, not written to public repo or private config |
| Toggle (`super+enter`) | switch `steer ↔ followUp`; update visible badge; do not submit the draft |
| Idle Enter | `prompt(message, streamingBehavior:selected)`; Pi ignores the option while idle |
| Busy Enter, default | `prompt(message, streamingBehavior:"steer")` |
| Busy Enter, toggled | `prompt(message, streamingBehavior:"followUp")` |
| Alt+Enter | `prompt(message, streamingBehavior:"followUp")` in both idle and busy states |
| Alt+Up | `clear_queue`; restore steering then follow-up text; do not abort |
| Busy Escape | `clear_queue`; restore text; then `abort` |
| Compaction/summarization submit | hold typed `{text, delivery}` locally; flush with original modes after completion |
| Queue display | distinct `STEERING (n)` and `FOLLOW-UP (n)` groups from `queue_update` |

Use RPC `prompt + streamingBehavior`, not direct `steer`/`follow_up`, because
`AgentSession.prompt()` preserves extension-command execution, input hooks,
skill expansion, and prompt-template expansion before it queues. The lower-level
commands reject extension commands and bypass the input event.

The delivery toggle is not Pi's queue drain mode. The toggle selects the queue
that receives Enter. Pi's independent `steeringMode`/`followUpMode` selects
`one-at-a-time` versus `all` within that queue; Plan 089 hydrates those values.

## Current state

- `prompt-scheduler.ts:97-143` puts every ordinary busy submission into a host
  `string[]`; Pi sees nothing until a later `agent_settled` drain.
- `prompt-scheduler.ts:145-183` uses native steering only to force the FIFO head.
- `host.ts:471-484` types `streamingBehavior` as only `"steer"`.
- `host.ts:532-552` sends Alt+Enter into the same host queue and ignores it when
  the host looks idle.
- `host.ts:573-587` can restore only host-owned entries and tells the user Pi
  entries are unrecoverable.
- `host.ts:1698-1705` restores the local queue synchronously before abort; this
  cannot preserve ordering with asynchronous `clear_queue`.
- `state.ts:177-185` flattens Pi steering and follow-up arrays into one list.
- `shell-adapter.ts:497-533` labels all messages generically `QUEUED`.
- `editor.ts:580-582` exposes Alt+Enter follow-up, Super+Enter force-send, and
  Alt+Up dequeue; no mode toggle exists.
- Plan 087's force-send algorithm is blocked by a handled-input/idle-start race.
  `clear_queue` does not solve that disposition ambiguity; native direct delivery
  makes the algorithm unnecessary.

Pi limitations that must remain visible:

- `clear_queue` returns only `string[]`, with no stable IDs or images.
- No command can atomically remove/promote/reclassify one queue item.
- RPC generic `abort` does not cancel compaction or branch summarization.
- Classic Pi itself restores queue text only; this plan does not claim lossless
  queued-image recovery.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Controls/state | `pnpm vitest run src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/state.test.ts` | all pass |
| Scheduler/host | `pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/interrupt.test.ts` | all pass |
| Editor/render | `pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/shell-adapter.test.ts src/cathedral/input-frame.test.ts` | all pass |
| Queue integration | `pnpm vitest run test/integration/rpc-queued-message-undo.test.ts test/integration/rpc-compaction-ux.test.ts --fileParallelism=false` | all pass |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- RPC controls, state, prompt scheduler, editor, host, interrupt, and shell adapter with colocated tests
- `src/cathedral/input-frame.ts` and tests for the optional active delivery badge
- exact-wire fixture support for native queues and `clear_queue`
- queue undo/compaction integration tests
- component, fixture, and runtime visual scenarios for both modes and both queue groups
- `plans/README.md` status updates for 078, 087, and 090

**Out of scope**:

- Persisting the delivery toggle across process launches.
- Changing Pi's `one-at-a-time`/`all` defaults.
- Calling direct RPC `steer` or `follow_up` for editor submissions.
- Moving, deleting, or promoting an individual Pi-owned queue item.
- Lossless queued-image restoration (Plan 092 records the capability gate).
- Implementing unavailable compaction/branch-summary cancellation.
- Removing the `prompt-scheduler.ts` file; refactor it to the narrow compaction
  client queue so repository file deletion is not required.
- Golden promotion without explicit human approval.

## Git workflow

- Branch: `advisor/090-move-delivery-to-pi-native-queues`
- Commit subject: `feat: use Pi-native steer and follow-up queues`
- Land as one reviewed migration; do not ship an intermediate state that sends
  natively without clear/restore safety.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Lock the wire and typed queue state with failing tests

Add `RpcHostControls.clearQueue()` using the published command/response types.
It must return separate immutable steering and follow-up arrays. Extend the
fixture to enqueue by `prompt.streamingBehavior`, emit full `queue_update`
snapshots, deliver at deterministic boundaries, and answer `clear_queue` by
atomically returning and emptying both arrays.

Change chrome state to preserve `steeringMessages` and `followUpMessages`
separately. `pendingMessageCount` derives from those snapshots plus only the
narrow compaction-local queue. Malformed elements are ignored defensively; an
absent queue is not invented from message count.

**Verify**: controls/state tests prove exact request shape, restoration order,
separate snapshots, malformed payload behavior, and clearing.

### Step 2: Replace force-send with the process-local delivery toggle

Introduce a small `RpcPromptDeliveryMode = "steer" | "followUp"` host/editor
state. Initialize it to `"steer"` at host start and preserve it across session
switches within that process. Do not write it to config.

Replace `app.message.forceSend` with `app.message.toggleDelivery`, retaining
`super+enter` as the default remappable binding. Remove the force-send callback,
result types, acceptance barriers, notifications, tests, and hotkey copy.
Toggle only the mode; leave the editor draft unchanged.

Expose a concise STEER/FOLLOW-UP badge in the active input hint. At ordinary
widths, it precedes optional project/branch text; project context truncates or
drops before the delivery badge. Queue cards themselves must label each queue
kind. Use shared typed rendering primitives; do not add hand-built ANSI.

**Verify**: editor/input-frame/shell tests cover default, toggle twice, remapped
binding, unchanged draft, landscape, 60-column portrait, and narrow truncation.

### Step 3: Send every ordinary submission through Pi's policy seam

After SumoCode handles built-in slash and direct host commands, send:

```ts
{ type: "prompt", message, streamingBehavior: selectedMode }
```

Do so whether host state says idle or busy; Pi decides atomically. Alt+Enter
uses `followUp` explicitly and also works while idle. Preserve raw editor history
and token expansion behavior. A correlated preflight rejection restores the
draft. An ambiguous transport timeout must not duplicate the prompt: notify that
acceptance is unknown and preserve a safe recovery path without automatic resend.

Remove general FIFO drain-on-`agent_settled`; Pi now owns normal delivery. A
successful prompt response needs no synthetic lifecycle barrier: handled input,
idle start, and native enqueue are all valid terminal dispositions for that one
request.

**Verify**: host/scheduler tests prove default steering, toggled follow-up,
Alt+Enter, idle races, extension command/input interception, expansion, failure,
timeout ambiguity, and rapid multiple submissions.

### Step 4: Make clear-and-restore an ordered transaction

Create one async transaction used by Alt+Up, Escape, tree navigation, and session
replacement paths:

1. reject/coalesce a second concurrent clear transaction;
2. call `clear_queue` for the currently bound Pi session;
3. drain the local compaction queue;
4. restore all steering text first, then all follow-up text, then the existing
   editor draft, separated by blank lines;
5. update queue state from the returned emptying operation;
6. for Escape only, call `abort` after restore succeeds.

If `clear_queue` fails or times out, do not claim restoration and do not issue
the later abort/session mutation as though queues were cleared. Notify a bounded
error and leave authoritative queue state visible. Session identity must be
captured before the request; a response from an old generation must never be
applied to the new session's editor.

**Verify**: unit and PTY tests assert exact command order, duplicate-keypress
serialization, current-draft composition, session-generation protection,
failure behavior, and no queued continuation after a successful Escape.

### Step 5: Retain only classic Pi's narrow compaction client queue

Refactor `prompt-scheduler.ts` into a compaction/summarization-only queue of:

```ts
type LocalQueuedPrompt = {
	readonly text: string;
	readonly delivery: "steer" | "followUp";
};
```

Host built-in/extension commands that are allowed during compaction execute in
the same ordering as classic Pi. Ordinary messages preserve their selected mode,
flush after `compaction_end`, and restore on dispatch failure. This local queue
must never hold ordinary busy-streaming submissions.

Branch-summary cancellation remains unavailable; keep the current block/notice
honest. Do not map generic `abort` to compaction cancellation.

**Verify**: compaction tests prove mixed-mode ordering, command preflight,
failure restoration, manual/automatic cases, and zero local queue entries for an
ordinary active agent turn.

### Step 6: Reconcile visuals and run all gates

Update component/fixture/runtime scenarios for default STEER, toggled FOLLOW-UP,
separate queue groups, dequeue restore, and Escape restore-before-abort. Inspect
styled-cell and geometry reports, then PNGs. Run the real-Pi faux-provider test
through at least two steering boundaries and one follow-up completion.

Do not promote runtime goldens without Dhruv's approval.

## Test plan

- Default and toggled Enter command shapes in idle and streaming states.
- Alt+Enter one-shot follow-up without changing the selected mode.
- Toggle binding changes state but never submits/clears the draft.
- Multiple steering messages obey Pi's one-at-a-time/all policy, not a host FIFO.
- `queue_update` preserves queue kinds and delivery order.
- Alt+Up restores steering then follow-up then current draft.
- Escape restores before abort; failed clear never reports cancellation.
- Session replacement/tree navigation cannot apply stale clear results.
- Compaction-local messages retain delivery mode and flush safely.
- Handled extension input requires no force-send disposition heuristic.

## Done criteria

- [ ] Pi is the only general-purpose busy-delivery authority.
- [ ] Launch default is STEER; the visible toggle selects FOLLOW-UP and back.
- [ ] Enter uses `prompt + streamingBehavior`; Alt+Enter always uses follow-up.
- [ ] Alt+Up and Escape use the ordered `clear_queue` transaction.
- [ ] Queue kinds are separately visible and correctly counted.
- [ ] The old force-send action/barrier has no production references.
- [ ] The local scheduler holds only compaction/summarization submissions.
- [ ] Unit, integration, real-Pi, visual CI, lint, typecheck, and build pass.
- [ ] No golden was promoted without approval.
- [ ] Plan 087 is REJECTED as superseded; Plan 078 remains historical DONE with a supersession note.

## STOP conditions

- Plans 088 or 089 are not DONE.
- The installed `clear_queue` contract is absent or non-atomic.
- Clear/restore cannot be ordered before abort/session mutation.
- A proposed solution reintroduces a general host FIFO or direct queue command for normal editor input.
- The only way to recover one item is clear-and-requeue promotion.
- Busy native image recovery is silently lossy.
- Exact Escape behavior requires pretending generic abort cancels compaction/branch summary.

## Maintenance notes

- Keep delivery selection and queue drain mode named distinctly in types, copy,
  and settings. “Follow-up mode” is otherwise ambiguous.
- `queue_update` is a full snapshot, not an append event.
- Classic-equivalent steering happens after the current assistant response and
  its tool calls; it does not preempt an executing tool.
- Future structured queue IDs/images may allow lossless attachment recovery, but
  do not retrofit single-entry manipulation without an upstream atomic API.
