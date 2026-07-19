# Plan 078: Host-owned RPC prompt queue and queued-message undo

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a **STOP condition** occurs, stop and report instead of improvising. Keep the implementation in an isolated worktree. Do not push, merge, or open a PR unless the operator separately requests `/apr`.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat ca3b199..origin/main -- \
>   src/sumo-tui/rpc/editor.ts \
>   src/sumo-tui/rpc/host.ts \
>   src/sumo-tui/rpc/host-actions.ts \
>   src/sumo-tui/rpc/interrupt.ts \
>   src/sumo-tui/rpc/state.ts \
>   src/sumo-tui/rpc/shell-adapter.ts \
>   src/sumo-tui/rpc/runtime.test.ts \
>   test/integration/rpc-child-fixture.ts \
>   test/integration/rpc-host-shell.test.ts
> git status --short
> ```
>
> Reconcile any drift against live `origin/main` before editing. In particular, preserve Plan 077's merged compaction reason/status row and any concurrent RunCat working-indicator changes. Never use `git reset --hard` or `git clean`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Category**: correctness / RPC UX
- **Depends on**: PR #325 / Plan 077 (merged before this plan was written)
- **Planned at**: `origin/main` commit `ca3b199`, 2026-07-19
- **Supersedes**: the blocked Pi `clear_queue` design recorded against [`earendil-works/pi#5606`](https://github.com/earendil-works/pi/issues/5606)

## Decision

SumoCode will own the queue for prompts submitted through its retained RPC editor.

While Pi is active, SumoCode must **not send a `prompt`, `steer`, or `follow_up` RPC command** for ordinary editor text. It stores the text in a host-local, session-bound queue. Once Pi emits the authoritative `agent_settled` event, SumoCode sends exactly one queued entry as a normal idle `prompt`. Alt+Up atomically removes all still-host-owned entries and restores them before the current editor draft.

This removes the upstream `clear_queue` dependency because there is no Pi queue to clear for SumoCode-owned user submissions.

## Product semantics

1. **Idle Enter** sends immediately as a normal `{ type: "prompt", message }` command.
2. **Busy Enter** appends the text to SumoCode's follow-up queue and clears the editor. It does not call Pi.
3. **Busy Alt+Enter** explicitly queues the current editor text through the same host queue. Idle Alt+Enter leaves the draft unchanged, matching Pi's follow-up-only intent.
4. **Alt+Up** restores every still-host-owned queued message, in FIFO order, before the current draft, separated by blank lines.
5. **`agent_settled`** dispatches at most one queued message. The next entry waits for the next `agent_settled`, preserving one-at-a-time conversation semantics.
6. **`agent_end` is not an idle signal.** Pi may retry, compact, or run extension continuations after it. Never drain on `agent_end`.
7. **Abort** restores queued host messages before sending `abort`, matching classic Pi's safe interrupt behavior.
8. **Session replacement** (new, switch, clone, fork) restores old-session queued messages into the editor and invalidates the old scheduler generation before the new session can drain them.
9. **Send failure** never loses text. A queued entry whose RPC preflight fails returns to the head of the queue and automatic draining pauses until a new explicit trigger or restore.
10. **Host-owned slash commands** continue to execute immediately through `RpcHostActions`. Other child/extension commands entered while busy are queued and delegated only once Pi is idle; this is an intentional safety change from Pi's immediate streaming command execution.
11. **True steering is out of scope.** Delaying a message until idle cannot preserve steer semantics. Current SumoCode RPC already treats streaming Enter as `followUp`, so this plan does not remove an existing host steering path.

## Core invariants

- A message has exactly one owner: editor draft, host queue, dispatch-in-flight, or Pi. Never two.
- The scheduler marks a dispatch in flight synchronously before awaiting RPC I/O.
- Once an RPC send has begun, Alt+Up cannot claim that entry back; only entries still in the host queue are restorable.
- A successful prompt preflight transfers ownership to Pi exactly once.
- A failed prompt preflight restores ownership to the host queue exactly once.
- Queue state is tagged with the active session generation; stale settle events cannot deliver into a replacement session.
- Polling `get_state` must not overwrite the host queue count with Pi's zero pending count.
- Unexpected Pi `queue_update` messages remain separate from the undoable host queue.

## Verified current state

### Submission currently transfers ownership to Pi immediately

`src/sumo-tui/rpc/host.ts` currently does:

```ts
const state = options.stateStore.getSnapshot();
options.onBeforeSend?.(message);
const response = state.isStreaming
	? await options.client.send({ type: "prompt", message, streamingBehavior: "followUp" })
	: await options.client.send({ type: "prompt", message });
responseData(response, "prompt");
```

That streaming branch creates Pi-owned queue state, which SumoCode cannot clear through RPC.

### The host receives the correct idle event

Pi RPC forwards all `AgentSessionEvent` values, including `agent_settled`. Pi's `AgentSession` emits `agent_settled` only after retries, auto-compaction, extension `agent_end` handlers, and queued continuations are complete. This is the scheduler's drain signal.

### The editor declares but does not wire queue actions

`src/sumo-tui/rpc/editor.ts` declares:

```ts
"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
"app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
```

`RpcHostEditorControllerOptions` and its `editor.onAction(...)` registrations expose neither action, so both bindings currently fall through without host behavior.

### State currently treats Pi as queue source of truth

`src/sumo-tui/rpc/state.ts` mirrors `queue_update.steering` plus `queue_update.followUp` into `queuedMessages` and lets `hydrateFromRpcState()` overwrite `pendingMessageCount`. This must become a composition of host-owned and unexpected Pi-owned queue snapshots.

### Banner geometry already exists

`RpcShellAdapter.renderQueuedMessages()` paints the existing bordered `QUEUED (N)` card from `state.queuedMessages`. Preserve its geometry, colors, image-path collapsing, row order, and placement. This plan changes queue ownership, not visual design.

### Abort currently ignores queued drafts

`createRpcHostInterruptHandler()` calls `controls.abort()` directly for the streaming abort decision. It must restore host-owned queued text before aborting.

### Session replacement has a shared post-success seam

`RpcHostActions` calls `controls.refreshState()` and `rehydrateTranscript()` after successful new/switch/clone/fork operations. Extend that shared seam so the scheduler rebinds to the new session and restores any old-generation queue before transcript hydration completes. Do not duplicate queue logic across four commands.

## Target module

Create `src/sumo-tui/rpc/prompt-scheduler.ts` with tests beside it.

The exact names may adapt to repository conventions, but the external interface should stay small and behavior-rich:

```ts
export interface RpcPromptSchedulerSnapshot {
	readonly busy: boolean;
	readonly queuedMessages: readonly string[];
	readonly sessionId?: string;
	readonly pausedAfterFailure: boolean;
}

export interface RpcPromptScheduler {
	submit(message: string, options?: { forceQueue?: boolean }): Promise<"sent" | "queued" | "ignored">;
	handleAgentEvent(event: unknown): void;
	restoreAll(currentDraft: string): { count: number; text: string };
	rebindSession(sessionId: string | undefined, currentDraft: string): { count: number; text: string };
	getSnapshot(): RpcPromptSchedulerSnapshot;
}
```

Inject these implementation dependencies rather than importing global runtime state:

- `sendPrompt(message)` — sends only a normal idle RPC prompt and validates preflight response;
- `handleHostCommand(message)` — returns whether `RpcHostActions` consumed it;
- `getSessionId()` or explicit session ID at construction/rebind;
- `onQueueChange(messages)` — publishes immutable queue snapshots into `RpcHostStateStore`;
- `onDispatchStart(message)` — preserves the current synthetic streaming paint/interrupt window;
- `onDispatchFailure(error)` — terse notification and runtime rollback.

Internal implementation may use a promise chain or explicit `dispatching` flag, but it must serialize all mutations. Do not expose array mutation to callers.

## Scope

### In scope

- `src/sumo-tui/rpc/prompt-scheduler.ts` (new)
- `src/sumo-tui/rpc/prompt-scheduler.test.ts` (new)
- `src/sumo-tui/rpc/editor.ts`
- `src/sumo-tui/rpc/editor.test.ts`
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/host.test.ts`
- `src/sumo-tui/rpc/host-actions.ts` and test only for the shared session-rebind callback
- `src/sumo-tui/rpc/state.ts`
- `src/sumo-tui/rpc/state.test.ts`
- `src/sumo-tui/rpc/shell-adapter.ts` comments/composition only; preserve rendering
- `src/sumo-tui/rpc/shell-adapter.test.ts`
- `src/sumo-tui/rpc/runtime.test.ts`
- `test/integration/rpc-child-fixture.ts`
- `test/integration/rpc-host-shell.test.ts` or a dedicated `test/integration/rpc-queued-message-undo.test.ts`
- `plans/README.md` status only at closeout

### Out of scope

- Patching Pi or `node_modules`.
- Adding `clear_queue`, `steer`, or `follow_up` commands to Pi RPC.
- Changing launcher selection, `bin/sumocode.sh`, or `sumo-rpc-host.js`.
- Implementing true steering.
- Persisting queued drafts across host-process crashes/restarts.
- Redesigning the queued-message card.
- Changing compaction labels/status rows from Plan 077.
- Changing working-indicator frames, cadence, RunCat capability, or theme resolution from issue #331.
- Promoting visual goldens.

## Steps

### Step 1: Characterize event and editor semantics

Add failing tests before implementation:

- `app.message.followUp` default and remapped chords invoke a callback exactly once;
- `app.message.dequeue` default and remapped chords invoke a callback exactly once;
- plain Up/Enter behavior remains unchanged;
- `agent_end` does not drain;
- `agent_settled` is observable through the host event path;
- an RPC prompt send resolves on preflight, not turn completion.

Use the existing generic `editor.onAction(...)` tests and `submitInFlight` tests as patterns.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/runtime.test.ts -t "message|settled|prompt"
```

Expected: new tests fail before implementation for missing action/scheduler wiring and pass afterward.

### Step 2: Implement the scheduler test-first

Cover at least:

- idle submit sends immediately without `streamingBehavior`;
- busy submit enqueues without invoking `sendPrompt`;
- multiple queued entries remain FIFO;
- `agent_end`, `compaction_end`, and unrelated events do not drain;
- one `agent_settled` dispatches one entry only;
- dispatch marks busy before awaiting the send;
- a second settle dispatches the next entry;
- Alt+Up restore combines queue then current draft with `"\n\n"`;
- restore on an empty queue leaves draft unchanged;
- send failure reinserts the entry at the head and pauses automatic drain;
- restore during another entry's dispatch excludes the already-transferred entry;
- duplicate/stale settle events cannot double-send;
- session rebind restores old-generation entries and prevents stale delivery;
- host commands are consumed before queueing; unhandled text follows normal queue rules.

Do not mock internal arrays. Test through the scheduler interface and emitted snapshots.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts
```

Expected: all scheduler ownership/race tests pass.

### Step 3: Wire editor actions

Add `onMessageFollowUp` and `onMessageDequeue` options to `RpcHostEditorControllerOptions`, with generic `editor.onAction(...)` registrations.

Host behavior:

- follow-up callback reads the editor draft;
- if blank, no-op;
- if scheduler is idle, leave draft untouched and notify nothing;
- if busy, queue it, add it to editor history using the existing editor convention, then clear the editor;
- dequeue synchronously calls `scheduler.restoreAll(editor.getText())`, sets returned text, and updates queue state/render;
- if only unexpected Pi-owned messages exist, do not pretend they were restored; notify tersely.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host.test.ts -t "followUp|dequeue|queued"
```

### Step 4: Replace streaming prompt forwarding

Refactor `submitRpcPrompt`/`submitFromEditor` so:

1. blank and visual-fixture behavior remains unchanged;
2. `RpcHostActions.handleSubmittedText()` still gets first refusal;
3. ordinary text goes through the scheduler;
4. scheduler `sendPrompt` always emits `{ type: "prompt", message }` with no `streamingBehavior`;
5. synthetic streaming paint and `submitInFlight` begin only for a real dispatch, not for enqueue;
6. prompt preflight failure resets runtime state and retains queued text;
7. `SUMOCODE_INITIAL_PROMPT` uses the same scheduler path.

Delete the old state-snapshot branch that sends `streamingBehavior: "followUp"`.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/host.test.ts -t "prompt|queue|submit"
```

### Step 5: Drain only on `agent_settled`

In `client.onEvent`:

- continue feeding transcript/state stores first;
- pass all events to the scheduler;
- on `agent_start`, clear the dispatch-window compatibility flag as today;
- on `agent_settled`, scheduler atomically marks idle and optionally starts one dispatch;
- do not clear scheduler busy on `agent_end`;
- do not await scheduler delivery inside the event emitter callback if that would block RPC event consumption; launch through the scheduler's own serialized async path and route errors through its callback.

Interrupt gating should consult scheduler busy/dispatching in addition to chrome `isStreaming`, replacing the narrow `submitInFlight` boolean if the scheduler can own that fact cleanly.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/prompt-scheduler.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/host.test.ts -t "agent_settled|interrupt|dispatch"
```

### Step 6: Make queue state compositional

Refactor `RpcHostStateStore` to maintain separate snapshots:

- host-owned queued messages from scheduler;
- unexpected Pi-owned steering/follow-up messages from `queue_update`.

Expose the existing `queuedMessages` field as the immutable display composition so `RpcShellAdapter` can remain visually unchanged. `pendingMessageCount` must include both sources and must survive `get_state`/stats hydration while host messages remain queued.

Add a narrow method such as `setHostQueuedMessages(messages)` rather than faking a Pi event. Do not let callers mutate stored arrays.

Tests must prove:

- host queue survives Pi hydration reporting zero pending;
- empty Pi queue updates do not erase host messages;
- non-empty Pi queue entries remain visible but are not returned by host restore;
- clearing host queue leaves Pi-owned display entries intact;
- queue order/count are deterministic;
- Plan 077 compaction state/reason tests remain unchanged.

Update `RpcShellAdapter` comments from "Pi is source of truth" to the composed ownership model. Do not alter card geometry.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/shell-adapter.test.ts
```

### Step 7: Restore on abort and session replacement

Extend `createRpcHostInterruptHandler` with a small injected restore callback. For the abort decision:

1. synchronously restore host queue into the current editor draft;
2. publish/render the empty host queue snapshot;
3. then call `controls.abort()`.

For successful new/switch/clone/fork operations, extend the existing shared post-success callback so it:

1. refreshes state and obtains the new session ID;
2. rebinds scheduler generation;
3. restores old-generation queued messages into the editor;
4. rehydrates the transcript;
5. cannot drain old entries on a late old-session settle event.

Do not copy this sequence into four command methods.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts -t "abort|session|queue|restore"
```

### Step 8: Add real PTY/RPC regressions

Extend the fixture to:

- keep an initial prompt active;
- record every received `prompt` command and its `streamingBehavior` field;
- emit `agent_end` separately from a delayed `agent_settled`;
- support two consecutive prompt turns;
- expose deterministic sent-message evidence without using Pi queue emulation.

PTY acceptance sequence:

1. submit prompt A and wait for streaming;
2. submit B while A is active;
3. assert `QUEUED (1)` and B are visible;
4. assert fixture has received only A and no command with `streamingBehavior`;
5. press Alt+Up;
6. assert banner disappears and B returns to editor;
7. let A settle and prove B was not delivered;
8. resubmit B and prove it is delivered exactly once.

Add a second integration case for natural drain:

1. queue B and C behind A;
2. `agent_end` alone sends neither;
3. first `agent_settled` sends B only;
4. next `agent_settled` sends C only;
5. all commands omit `streamingBehavior`.

If PTY key bytes are unreliable, first prove the exact Alt+Up sequence in the editor unit test and reuse those bytes. Do not bypass the real keybinding path by calling a private handler from integration.

**Verify**:

```bash
pnpm vitest run test/integration/rpc-queued-message-undo.test.ts
```

### Step 9: Canonical verification

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm render:bible
pnpm visual:ci
```

Expected: all exit 0. Review the generated parity pack; do not promote goldens.

Search the final production diff:

```bash
rg -n 'streamingBehavior:\s*"followUp"|type:\s*"follow_up"|type:\s*"steer"' src/sumo-tui/rpc
```

Expected: no editor submission path sends Pi-owned queue commands. Any remaining occurrence must be test data or an explicitly documented unrelated control.

## Done criteria

- [ ] SumoCode owns all ordinary RPC editor messages submitted while Pi is active.
- [ ] Busy submissions do not send any RPC command until `agent_settled`.
- [ ] One settle dispatches at most one normal prompt.
- [ ] No scheduler dispatch includes `streamingBehavior`.
- [ ] Alt+Enter queues through the host-owned queue while busy.
- [ ] Alt+Up restores all still-host-owned messages before the current draft and clears their banner rows.
- [ ] Already-dispatched messages cannot be restored or duplicated.
- [ ] Prompt failure retains text and pauses automatic drain.
- [ ] Abort restores queued text before aborting.
- [ ] New/switch/clone/fork cannot deliver old-session queue entries into the new session.
- [ ] Host and unexpected Pi queue snapshots remain distinct and compose truthfully for display.
- [ ] `get_state` polling cannot erase host queue count/banner.
- [ ] Existing compaction progress and queued-card geometry remain intact.
- [ ] Focused scheduler/editor/host/state tests pass.
- [ ] PTY undo and natural-drain regressions pass.
- [ ] Typecheck/build, full unit, integration, Bible, and visual gates pass.
- [ ] No upstream Pi patch, `node_modules` edit, launcher edit, or golden promotion exists.

## STOP conditions

Stop and report if:

- Product requirements demand true steer semantics for an undoable message; that still requires Pi queue cancellation.
- Pi RPC in the selected version does not emit `agent_settled` after all retry/compaction continuation work.
- A host command must be both immediate and undoable while Pi is active.
- Session replacement can occur without any observable success/rebind seam, making stale delivery prevention impossible.
- Correctness requires persisting queue state across host crashes; durable drafts are a separate plan.
- A message can contain structured image content not recoverable from the editor's current string representation.
- Passing tests requires changing queued-card geometry, weakening visual checks, or promoting a golden.
- Issue #331 has landed overlapping `shell-adapter.ts` changes and they cannot be reconciled while preserving both the RunCat resolver and queued-card behavior.
- A canonical command fails twice after a reasonable scoped correction.

## Risks and mitigations

1. **Event race double-sends a message.** Scheduler synchronously transfers each entry through one ownership state and tests duplicate/stale settles.
2. **`agent_end` appears idle too early.** Drain exclusively on `agent_settled`; tests delay settle after end.
3. **Session switch sends old text to a new session.** Tag queue by generation and restore on the shared successful rebind seam.
4. **Prompt preflight failure loses text.** Reinsert at queue head before notifying; require an explicit next trigger.
5. **Abort unexpectedly continues queued work.** Restore before abort and clear host queue.
6. **Pi extension creates its own queue.** Keep Pi queue snapshots separate and never claim Alt+Up cleared them.
7. **RunCat work conflicts in the shell adapter.** Restrict this plan to queue composition/comments around the existing card; preserve issue #331's indicator resolver changes during reconciliation.
8. **Behavior diverges from Pi follow-up internals.** Document intentional one-prompt-per-settle semantics and test the user-visible transcript lifecycle.

## Maintenance notes

- `RpcPromptScheduler` is the ownership seam. Editor, interrupts, state painting, and session actions should call its small interface rather than manipulating queue arrays.
- If Pi later exposes `clear_queue`, do not automatically move ownership back. Compare crash persistence, steer semantics, and interface depth first.
- A future durable-draft feature can persist scheduler snapshots keyed by session ID without changing editor callers.
- A future true-steer feature must be explicitly non-undoable or paired with an upstream cancellation primitive.
- Keep `agent_settled` in fixture contracts whenever Pi is upgraded; it is now a critical RPC lifecycle event.
