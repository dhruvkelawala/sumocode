# Plan 087: Force-send the next host-queued message as Pi steering

> **Renumbering note**: this plan was provisionally numbered 084 and became 087 after
> upstream plans 083–085 landed for unrelated roles/subagent work. The historical
> `advisor/084-*` branch name keeps its original identifier.
>
> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If a
> STOP condition occurs, stop and report evidence; do not replace the host FIFO,
> patch Pi, add a second queue protocol, or broaden this into full Pi queue parity.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 6f5be80..HEAD -- \
>   src/sumo-tui/rpc/prompt-scheduler.ts \
>   src/sumo-tui/rpc/prompt-scheduler.test.ts \
>   src/sumo-tui/rpc/editor.ts \
>   src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/host.ts \
>   src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/host-actions.ts \
>   src/sumo-tui/rpc/host-actions.test.ts \
>   test/integration/rpc-child-fixture.ts \
>   test/integration/rpc-queued-message-undo.test.ts
> git diff --stat -- \
>   src/sumo-tui/rpc/prompt-scheduler.ts \
>   src/sumo-tui/rpc/prompt-scheduler.test.ts \
>   src/sumo-tui/rpc/editor.ts \
>   src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/host.ts \
>   src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/host-actions.ts \
>   src/sumo-tui/rpc/host-actions.test.ts \
>   test/integration/rpc-child-fixture.ts \
>   test/integration/rpc-queued-message-undo.test.ts
> git diff --cached --stat -- <same paths>
> ```
>
> The second and third commands must also be clean at execution start. Plan 087
> was authored after the fast-mode/command-feedback fix landed at `6f5be80`; that
> implementation is part of the baseline and must be preserved. For committed
> drift, compare the live implementation with this plan's excerpts and reconcile
> only compatible changes.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 078's host-owned RPC prompt queue (DONE)
- **Category**: feature / parity
- **Planned at**: commit `6f5be80`, 2026-08-12
- **Execution status**: REJECTED — `clear_queue` does not resolve the handled-input versus idle-start disposition race. Release-gated Plan 090 replaces the two-owner architecture with direct `prompt.streamingBehavior` delivery, so this force-send algorithm must not resume.

## Outcome

SumoCode keeps its existing undoable host FIFO. While an agent turn is actively
streaming, pressing **Command+Enter** (`super+enter` in `pi-tui` key syntax)
removes only the oldest host-owned FIFO message and submits it through Pi RPC as:

```json
{"type":"prompt","message":"<oldest queued message>","streamingBehavior":"steer"}
```

Pi then delivers that message after the current assistant/tool turn and before
the next LLM call. Remaining FIFO entries keep their order and continue to wait
for `agent_settled`. If Pi rejects the steering submission before acceptance,
the removed message returns to the FIFO head. Once accepted by Pi, the message
is Pi-owned and Alt+Up cannot reclaim it; existing UI must continue to state
that fact truthfully. A transport timeout is an ambiguous outcome, not proof of
preflight rejection: the host must not silently requeue in that case.

## Why this matters

Busy Enter currently adds messages to an undoable SumoCode FIFO and the scheduler
sends one only after `agent_settled`. This is safe but cannot redirect a long
multi-turn agent run. Pi RPC already accepts `prompt.streamingBehavior: "steer"`,
so a user-requested escape hatch can advance one chosen FIFO entry without
replacing the queue architecture or requiring an unavailable RPC `clear_queue`.
The trade-off is explicit and bounded: only the force-sent entry loses host undo.

## Current state

### Host FIFO owns ordinary busy submissions

`src/sumo-tui/rpc/prompt-scheduler.ts` stores plain strings and drains one after
`agent_settled`:

```ts
private queue: string[] = [];

public async submit(message: string, options: { forceQueue?: boolean } = {}) {
	// ...
	if (forceQueue || this.isBusy()) {
		this.queue.push(message);
		this.publishQueue();
		return "queued";
	}
	void this.dispatch(message, this.generation, { requeueOnFailure: true });
	return "sent";
}

case "agent_settled":
	this.busy = false;
	this.drainOne(this.generation);
	break;
```

The scheduler already has the important failure behavior this feature must
reuse: `dispatch()` restores a preflight-rejected message with
`this.queue.unshift(message)`, pauses automatic draining, and ignores stale
failures after a session-generation change.

### The host sends ordinary prompts without streaming behavior

`src/sumo-tui/rpc/host.ts` currently wires:

```ts
sendPrompt: async (message) => {
	responseData(await client.send({ type: "prompt", message }), "prompt");
},
```

Do not change normal idle or FIFO-drain commands. Only the explicit force-send
path may add `streamingBehavior: "steer"`.

### Existing queue actions and keybindings

`src/sumo-tui/rpc/editor.ts` already routes manager-owned message actions:

```ts
if (options.onMessageFollowUp) this.editor.onAction("app.message.followUp", options.onMessageFollowUp);
if (options.onMessageDequeue) this.editor.onAction("app.message.dequeue", options.onMessageDequeue);
```

and declares:

```ts
"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
"app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
```

Add a sibling action. Use `super+enter`, which is the public `pi-tui` key name
for Command+Enter. **Do not bind Shift+Enter**: Pi reserves Shift+Enter and
Ctrl+J for multiline input, and SumoCode's Cathedral editor has compatibility
logic for terminals that encode modified Enter ambiguously. The action remains
remappable through `keybindings.json` like the existing message actions.

### Pi contract and blocking ambiguity

Pi 0.83 RPC accepts `prompt` with `streamingBehavior: "steer"`. If Pi is still
streaming, the message enters Pi's steering queue and emits `queue_update` before
the successful RPC response. If an input extension handles the prompt, Pi also
returns success but emits no queue or lifecycle event. Critically, when the
host's streaming state is stale and Pi becomes idle before processing the same
command, Pi starts a normal lifecycle and also returns success without a prior
`queue_update`.

Those latter two outcomes are indistinguishable at acknowledgement time but need
opposite FIFO barriers: handled input may release C after A settles, while a
normal B lifecycle must keep C queued. Executor commit `1857f8d` classified the
absence of `queue_update` as handled; final review proved that can prematurely
send C before B's `agent_start`, causing `Agent is already processing` and a
paused FIFO. No timeout heuristic is authorized. Resume only if Pi exposes an
atomic disposition/result or another public ordered event distinguishes these
outcomes. Pi RPC still cannot clear an accepted native queue entry.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused unit tests | `pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/editor.test.ts` | all tests pass |
| Queue integration | `pnpm vitest run test/integration/rpc-queued-message-undo.test.ts --fileParallelism=false` | all tests pass |
| Full unit suite | `pnpm test` | all tests pass |
| Full integration suite | `pnpm test:integration` | all tests pass |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |
| Visual gate | `pnpm visual:ci` | exit 0, or STOP if baseline assets are missing |

## Scope

**In scope** (the only production/test files to modify):

- `src/sumo-tui/rpc/prompt-scheduler.ts`
- `src/sumo-tui/rpc/prompt-scheduler.test.ts`
- `src/sumo-tui/rpc/editor.ts`
- `src/sumo-tui/rpc/editor.test.ts`
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/host.test.ts`
- `src/sumo-tui/rpc/host-actions.ts`
- `src/sumo-tui/rpc/host-actions.test.ts`
- `test/integration/rpc-child-fixture.ts`
- `test/integration/rpc-queued-message-undo.test.ts`
- `plans/README.md` (status only)

**Out of scope**:

- Replacing or retyping the FIFO as steering/follow-up entries.
- Sending every busy Enter directly to Pi.
- Changing Alt+Enter, Alt+Up, Escape, or ordinary Enter semantics.
- Binding Shift+Enter or removing multiline input.
- Adding a Pi patch, custom child extension queue, or new RPC command.
- Making Pi-owned messages reclaimable.
- Changing queue-card geometry, visual tokens, or approved goldens.
- Refactoring session replacement, compaction, tree navigation, or prompt-template expansion.

## Git workflow

- Branch: `advisor/084-force-send-next-queued-message`
- Use tabs in TypeScript and match nearby naming/error-handling patterns.
- Commit subject: `feat: force-send queued messages as steering`
- Do not push or open a PR unless the operator separately requests it.

## Steps

### Step 1: Add a scheduler operation that force-sends only the FIFO head

Start with failing tests in `src/sumo-tui/rpc/prompt-scheduler.test.ts`, then add
a public scheduler method with a narrow name such as `forceSendNext()`.

Required contract:

1. It acts only when the host FIFO is non-empty, no scheduler dispatch is in
   flight, the queue is not paused after failure, and a caller-supplied
   `canForceSteer()` predicate says an agent turn is actively steerable.
2. It removes exactly `queue[0]`, publishes the shortened host queue, and calls
   the existing serialized dispatch path with `streamingBehavior: "steer"`.
3. It leaves every later FIFO item untouched and ordered.
4. A correlated Pi `success: false` preflight rejection restores the same
   message at the FIFO head and preserves paused-after-failure behavior.
5. A transport timeout, child exit, malformed/mismatched response, or other
   outcome where acceptance is unknown must not be treated as a safe rejection.
   Keep the entry removed, pause automatic draining, notify that steering
   acceptance is unknown, and require explicit user recovery; never duplicate it.
6. Empty, idle/non-steerable, paused, or dispatch-in-flight calls return
   `"ignored"` without changing queue or sending RPC.
7. Normal `submit()` and `agent_settled` drains continue sending commands with
   no `streamingBehavior` field.
8. While force-send acceptance is in flight, an `agent_settled` from A must not
   release C. After acceptance, C stays queued until B's resulting lifecycle
   settles. Add explicit state/barrier logic rather than relying on event order.
9. If session rebind, tree replacement, or Escape invalidates the scheduler
   generation while B's acceptance is pending, keep the current discard policy
   for stale outcomes and surface the existing restored host entries. Do not
   claim B was restored; its acceptance is unknown after ownership changes.

Evolve `RpcPromptSchedulerOptions.sendPrompt` narrowly, for example:

```ts
type RpcPromptDelivery = { readonly streamingBehavior?: "steer" };

readonly sendPrompt: (message: string, delivery?: RpcPromptDelivery) => Promise<void>;
readonly canForceSteer?: () => boolean;
```

Do not create a second dispatcher. Extend the existing `dispatch()` so normal,
forced, failure, generation, and requeue behavior share one implementation.

Tests must prove:

- busy A + FIFO `[B, C]` force-sends B as steer and leaves `[C]`;
- explicit Pi preflight rejection restores `[B, C]` in that order;
- ambiguous timeout does not requeue B or drain C and emits the distinct
  unknown-acceptance failure callback;
- A settling before B's force-send acknowledgement does not drain C;
- after B's accepted lifecycle settles, normal drain sends C without delivery
  options;
- all ignored-state guards send nothing;
- repeated force-send cannot overlap an outstanding acceptance dispatch;
- generation invalidation during acceptance never falsely reports B restored.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts
```

Expected: all scheduler tests pass, including the new force-send cases.

### Step 2: Wire the exact Pi RPC payload and active-turn gate

In `src/sumo-tui/rpc/host.ts`, pass scheduler delivery options into the existing
`client.send()` call:

```ts
const command = delivery?.streamingBehavior === "steer"
	? { type: "prompt", message, streamingBehavior: "steer" as const }
	: { type: "prompt", message };
responseData(await client.send(command), "prompt");
```

Do not include `streamingBehavior` on ordinary sends.

Supply `canForceSteer()` from authoritative host state. It must return true only
when all of these hold:

- `stateStore.getSnapshot().isStreaming === true`;
- `stateStore.getSnapshot().isCompacting === false`;
- tree navigation/branch summarization is not busy.

Add an exported, unit-testable host handler (parallel to
`handleRpcMessageFollowUp`) that invokes `scheduler.forceSendNext()` through
`notifyOnError`. Define its result terms precisely: `"accepted"` means the
correlated Pi success response arrived; `"ignored"` means no command was sent;
`"unknown"` means transport failed after dispatch and acceptance cannot be
proved. Notify `queued message sent as steering` only for `"accepted"`; remain
silent for `"ignored"`; warn `steering acceptance unknown; message not requeued`
for `"unknown"`. The handler must not read, clear, history-add, or otherwise
alter the current editor draft.

Wire the handler through `InitialHydrationActionGate` in `runRpcHost`, using a
dedicated action key. This preserves the existing rule that child-dependent
intents cannot race initial session ownership.

Tests in `src/sumo-tui/rpc/host.test.ts` must prove:

- success calls `forceSendNext()` once and shows the notification;
- ignored calls are silent;
- thrown RPC errors become the existing warning notification;
- the active editor draft is not part of the handler contract.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/prompt-scheduler.test.ts
```

Expected: all tests pass.

### Step 3: Add the remappable Command+Enter action without breaking multiline input

In `src/sumo-tui/rpc/editor.ts`:

1. Add `onMessageForceSend?: () => void` to `RpcHostEditorControllerOptions`.
2. Register it through `this.editor.onAction("app.message.forceSend", ...)` beside
   follow-up and dequeue.
3. Register the custom action with the same narrow string-cast pattern already
   used for `app.theme.cycle`; Pi's closed `AppKeybinding` union does not include
   SumoCode custom action IDs.
4. Add this keybinding definition:

```ts
"app.message.forceSend": {
	defaultKeys: "super+enter",
	description: "Send next queued message as steering",
},
```

Use `super`, not `cmd`, `command`, or `meta`; this is `pi-tui`'s documented key
identifier. Do not touch `tui.input.newLine` or Cathedral modified-Enter
normalization.

Update `renderHotkeysOverlay()` in `src/sumo-tui/rpc/host-actions.ts` to list
`Cmd+Enter` as `Send next queued message as steering`, and update its colocated
test. Keep this as documentation only; dispatch remains in the editor/host.

In `src/sumo-tui/rpc/editor.test.ts`, follow the existing follow-up/dequeue tests:

- feed a real CSI-u Super+Enter sequence and assert one callback;
- create a temporary `keybindings.json` that remaps
  `app.message.forceSend` to an unambiguous test chord and assert the default no
  longer fires while the remap does;
- assert Shift+Enter still reaches multiline input and never invokes force-send.

If the installed `pi-tui` decoder does not recognize the expected Super+Enter
CSI-u sequence in the existing test harness, STOP and report the terminal input
evidence rather than binding Shift+Enter as a fallback.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/editor.test.ts
```

Expected: all editor tests pass, including default, remap, and multiline guards.

### Step 4: Prove the force-send payload before settlement in PTY integration

Extend `test/integration/rpc-child-fixture.ts` only enough to acknowledge and
log a busy `prompt` carrying `streamingBehavior: "steer"`. It must not emit a
second independent `agent_start` for that accepted steering command. Emit a
truthful `queue_update` steering snapshot if needed for the retained queue card;
do not attempt to recreate all of Pi's agent loop.

This fake-child test proves host timing, FIFO ownership, and exact wire payload
only. It does **not** prove Pi's next-turn delivery semantics. Add a second
integration test using a real Pi RPC child plus the repository's deterministic
faux-provider/tool fixture: hold a tool call open, force-send B, and assert B's
user `message_start` lands after the current `turn_end` and before the next
assistant request, with no intervening `agent_settled`. If no existing real-Pi
fixture can expose those boundaries without credentials, STOP and report the
missing test seam rather than claiming semantic steering proof from the fake
child.

Add a case to `test/integration/rpc-queued-message-undo.test.ts`:

1. Start prompt A and wait for `MEDITATING`.
2. Queue B and C with ordinary Enter; assert FIFO order is visible.
3. Send Super+Enter.
4. Before A's delayed `agent_settled`, inspect the fixture command log and assert:
   - B was sent exactly once;
   - B carries `streamingBehavior: "steer"`;
   - A and ordinary later drains do not carry `streamingBehavior`;
   - C remains host queued.
5. Press Alt+Up and assert C returns to the editor while B is not claimed as
   host-restorable. If the fixture publishes B as Pi-owned, the existing
   `queued messages are owned by pi` behavior may remain.

Retain the existing integration tests proving ordinary FIFO entries wait for
`agent_settled` and never carry `streamingBehavior` unless force-send is used.

**Verify**:

```bash
pnpm vitest run test/integration/rpc-queued-message-undo.test.ts --fileParallelism=false
```

Expected: all queue integration tests pass.

### Step 5: Run repository gates and inspect scope

Run:

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
pnpm visual:ci
git diff --check
git status --short
```

Expected:

- unit, integration, typecheck, and build exit 0;
- visual CI exits 0 without golden promotion;
- no whitespace errors;
- only files listed in Scope plus the plan status row are modified.

If committed visual assets required by the current branch are already missing,
record the exact missing paths and STOP; do not generate or promote unrelated
goldens.

## Test plan

- **Scheduler unit tests** in `src/sumo-tui/rpc/prompt-scheduler.test.ts`:
  FIFO-head selection, remaining order, steer payload, rejection requeue,
  no-overlap, empty/idle/paused guards, and unchanged ordinary drain payload.
- **Host unit tests** in `src/sumo-tui/rpc/host.test.ts`:
  handler success, silent ignore, error notification, and no editor-draft touch.
- **Editor unit tests** in `src/sumo-tui/rpc/editor.test.ts`:
  Super+Enter default, user remap, and Shift+Enter multiline non-regression.
- **PTY integration** in `test/integration/rpc-queued-message-undo.test.ts`:
  fake-child wire/ownership proof plus a real-Pi deterministic turn-boundary
  proof; force-send B before A settles, retain C, and preserve honest Alt+Up
  ownership.
- Use the existing scheduler dispatch/requeue tests and existing
  follow-up/dequeue keybinding tests as structural patterns.

## Done criteria

- [ ] Busy ordinary Enter still appends to the host FIFO.
- [ ] Super+Enter sends only the oldest FIFO entry with
      `streamingBehavior: "steer"` while an agent turn is actively streaming.
- [ ] The remaining FIFO preserves exact order.
- [ ] An explicit Pi preflight rejection restores the entry at the FIFO head;
      ambiguous transport failure never requeues it.
- [ ] A settling-before-acknowledgement race cannot prematurely drain the next
      FIFO entry.
- [ ] Idle, compacting, tree-navigation, empty, paused, and overlapping-dispatch
      states do not force-send.
- [ ] Ordinary idle and post-`agent_settled` prompt payloads contain no
      `streamingBehavior` field.
- [ ] Shift+Enter remains multiline input.
- [ ] Alt+Up restores host-owned entries only and never claims an accepted
      Pi-owned steering entry.
- [ ] Focused tests, `pnpm test`, `pnpm test:integration`, typecheck, build, and
      visual CI pass.
- [ ] No visual golden is promoted.
- [ ] No files outside Scope are modified.
- [ ] Plan 087's row in `plans/README.md` is updated.

## STOP conditions

Stop and report rather than improvising if:

- Pi's current `RpcCommand` type no longer accepts
  `prompt.streamingBehavior: "steer"`.
- Pi cannot atomically distinguish input-handler `handled` from the
  streaming-to-idle race where the same command starts a normal lifecycle. This
  STOP condition was reached at executor commit `1857f8d`; do not resume with
  absence-of-`queue_update` inference or timeout heuristics.
- Super+Enter cannot be distinguished through the installed `pi-tui` decoder
  and current RPC terminal path.
- No credential-free real-Pi integration seam can prove steering at the
  turn/tool boundary.
- The client cannot distinguish explicit `success: false` rejection from an
  ambiguous timeout/exit without changing files outside Scope.
- Implementing the shortcut would require taking Shift+Enter away from
  multiline input.
- Force-send requires changing ordinary FIFO drain, Alt+Up, Escape, compaction,
  tree-navigation, or session-rebind semantics.
- A failure cannot restore the force-sent entry before later FIFO entries.
- The implementation needs a Pi patch, hidden extension protocol, or new RPC
  command.
- A step's focused verification fails twice after a reasonable in-scope fix.
- Visual CI is blocked by missing baseline assets unrelated to this feature.

## Maintenance notes

- `super+enter` depends on terminal enhanced-keyboard support. Keep the action
  remappable and do not add ambiguous legacy-byte fallbacks.
- Reviewers should scrutinize the ownership boundary: remove the FIFO entry
  before sending, restore it only on preflight rejection, and never restore it
  after Pi accepts the command.
- Pi may emit `queue_update` for the accepted steering entry. That entry is
  display-only in SumoCode and remains non-undoable under Pi 0.83 RPC.
- If Pi later exposes atomic queue clearing, evaluate that as a separate parity
  plan; do not silently change this feature's bounded contract.
