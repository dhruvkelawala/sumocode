# Plan 089: Project Pi's authoritative RPC state truthfully

> **Executor instructions**: Do not execute this plan until Plan 088 is DONE.
> Follow the steps and verification gates in order. Treat `agent_end` as a
> low-level run boundary and `agent_settled` as the only ordinary idle boundary.
> Treat `get_available_thinking_levels` and the effective state after a
> thinking-level mutation as authoritative; a successful `set_thinking_level`
> response does not prove that Pi accepted the requested level without
> clamping it.
> If the published Pi event shapes differ from the excerpts below, stop and
> amend the plan rather than guessing.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 42e6eec..HEAD -- \
>   src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/state.test.ts \
>   src/sumo-tui/rpc/shell-adapter.ts src/sumo-tui/rpc/shell-adapter.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/controls.test.ts \
>   src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts \
>   src/sumo-tui/rpc/editor.ts src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/initial-hydration-action-gate.ts \
>   src/sumo-tui/rpc/initial-hydration-action-gate.test.ts \
>   src/sumo-tui/transcript/controller.ts src/sumo-tui/transcript/controller.test.ts \
>   src/sumo-tui/rpc/transcript-pump.ts src/sumo-tui/rpc/transcript-pump.test.ts \
>   test/integration/rpc-child-fixture.ts test/integration/rpc-activity-cards.test.ts \
>   test/integration/rpc-compaction-ux.test.ts \
>   test/integration/rpc-host-shell.test.ts \
>   test/integration/extension-instance-lifecycle.test.ts \
>   docs/visual/parity/scenarios.json \
>   docs/research/SUMOCODE_PI_RPC_AUDIT_2026.md
> ```
>
> Compare any drift with the live RPC types pinned by Plan 088. Do not preserve
> a stale test expectation merely because it predates this audit.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 088
- **Category**: bug / tests
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Deep-audit revision**: commit `42e6eec`, 2026-08-28
- **Issue**: [#376](https://github.com/dhruvkelawala/sumocode/issues/376)
- **Execution status**: BLOCKED — wait for Plan 088 and the published Pi release containing `clear_queue`

## Outcome

The retained chrome stays active from `agent_start` through the final
`agent_settled`, including auto-retry, summarization retry, compaction retry, and
queued continuation. It never replaces total session message count with the
current run's suffix. Retry, compaction failure, extension error, and active tool
state become visible in bounded SumoCode presentation. Hydration retains Pi's
actual steering, follow-up, and auto-compaction policy fields. New additive
usage/tool-call fields improve live feedback while final messages and stats
remain authoritative. Thinking controls offer only Pi-reported capabilities,
fail closed when none are returned, and reconcile a successful setter to Pi's
effective level rather than leaving the requested value in chrome. Session-only
model/thinking changes are not presented as saved defaults; save UX exists only
if the qualified release provides an official RPC persistence capability.

## Why this matters

The scheduler already waits for `agent_settled`, but chrome clears at
`agent_end`. Between those events SumoCode can say READY, stop its working
indicator, undercount the session, and make interrupt/navigation decisions from
false idle state while Pi is retrying or continuing. Other RPC events already
carry the truth, but several are reduced to an unhelpful `lastEventType` string
or ignored entirely.

The same truthfulness bug exists in thinking-level mutation. Pi's setter can
clamp an unsupported request to the nearest level. Its RPC success response has
no effective-level payload, and Pi emits `thinking_level_changed` only when the
effective level differs from the previous one. Therefore this trace is valid:

```text
current high -> request xhigh -> optimistic chrome xhigh
Pi clamps xhigh to high -> no change event -> success with no data
SumoCode remains on the impossible xhigh value
```

The normal selector usually prevents that trace, but the controls layer claims
a false invariant and the empty-capability fallback can manufacture precisely
such an unsupported request. Tests must lock the protocol invariant at the
controls boundary, not rely on today's UI path to make it unreachable.

## Current state

`src/sumo-tui/rpc/state.ts:156-169` currently does this:

```ts
case "agent_start":
	this.state = { ...this.state, isStreaming: true, lastEventType: type };
	break;
case "agent_end": {
	const messages = isJsonObject(payload) ? payload["messages"] : undefined;
	const messageCount = Array.isArray(messages) ? messages.length : this.state.messageCount;
	this.state = { ...this.state, isStreaming: false, messageCount, ... };
}
```

That is wrong for two independent reasons:

1. `agent_end.messages` is the current run suffix, not the full session.
2. Pi may retry, compact, or deliver queued work before `agent_settled`.

Additional gaps:

- `state.ts:111-131` discards `steeringMode`, `followUpMode`, and
  `autoCompactionEnabled` from `get_state`.
- `state.ts:194-200` has no explicit tool start/end, retry, summarization retry,
  or `extension_error` semantics.
- `shell-adapter.ts:608-612` checks the nonexistent event name `tool_call`; a
  tool with no partial update can remain visually “thinking.”
- `transcript/controller.ts:501-513` presents only successful compaction
  summaries; error, abort, `willRetry`, and summarizer usage disappear.
- `host-actions.ts:1377-1380` awaits `/compact`, discards its result, then says
  only `compaction requested`.
- `host.ts:1624-1636` polls stats every five seconds. Target Pi also supplies
  cumulative `message_update.usage`, which can update chrome immediately.
- `test/integration/rpc-child-fixture.ts:120-127` incorrectly emits all session
  messages at `agent_end`; target Pi emits only the current run suffix.
- The fixture's message updates are synthetic cumulative messages rather than
  exact indexed assistant deltas, so it can mask wire-shape regressions.
- `controls.ts:111-118,141-152` says the level requested is the result and
  leaves the optimistic value in place after a void successful
  `set_thinking_level` response. That is false when Pi clamps back to the
  already-effective level and therefore emits no event.
- `host-actions.ts:145-150,1345-1348` uses a closed static thinking-level list
  and substitutes every known level when Pi returns an empty capability list.
  The selector must fail closed instead of offering levels the active model did
  not advertise.
- `state.ts:17,237-245` and `shell-adapter.ts:111,604-612` weaken Pi's typed
  thinking-level union to `string` and maintain separate closed-world guards.
  An additive Pi level can silently disappear into the `medium` fallback.
- The focused fake client/child tests do not exercise clamp-without-event,
  empty capability lists, malformed level events, or model-driven thinking
  changes. A green suite currently cannot detect this stale-state bug.
- `initial-hydration-action-gate.ts:36-42` stops tracking actions after boot,
  while Pi starts every RPC line handler concurrently. Rapid cycles can compute
  from the same snapshot, a prompt can overtake an authenticating model change,
  and a late response from session A can patch session B's shared chrome.
- `controls.ts:127-130,147-150` awaits rollback hydration inside the mutation
  catch. If both requests fail, the secondary `get_state` error replaces the
  original cause and the unverified optimistic value remains presented.
- `controls.ts:220-224` treats a forwarded extension command as changing only
  the model-list cache. Pi extensions may replace the session or mutate
  model/thinking/name through the runtime host, so the retained transcript and
  chrome can remain bound to the previous ownership epoch.
- `editor.ts:597` advertises `app.models.save`, but the retained host has no
  handler. Pi `0.84.3` made persistence opt-in and RPC model/thinking setters do
  not expose `persist`; advertising classic Ctrl+S parity would be false.

State vocabulary must remain Cathedral-consistent: uppercase state labels come
from existing voice/tokens; ordinary notices are lowercase and terse. Do not
add raw ANSI; use retained typed primitives and existing notification/transcript
patterns.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused state | `pnpm vitest run src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host-actions.test.ts` | lifecycle and thinking reconciliation traces pass |
| Transcript | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts` | all pass |
| Host | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |
| Mutation ordering | `pnpm vitest run src/sumo-tui/rpc/initial-hydration-action-gate.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host.test.ts` | ordered intents, prompt barrier, session epochs, and double-failure traces pass |
| Installed RPC contract | `pnpm vitest run test/integration/rpc-contract.test.ts --fileParallelism=false` | target thinking and lifecycle shapes match Plan 088's qualification record |
| Integration | `pnpm vitest run test/integration/rpc-activity-cards.test.ts test/integration/rpc-compaction-ux.test.ts --fileParallelism=false` | all pass |
| Extension ownership | `pnpm vitest run test/integration/extension-instance-lifecycle.test.ts test/integration/rpc-host-shell.test.ts --fileParallelism=false` | forwarded same-session mutation and replacement-session hydration pass |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- `src/sumo-tui/rpc/state.ts` and `state.test.ts`
- `src/sumo-tui/rpc/shell-adapter.ts` and `shell-adapter.test.ts`
- `src/sumo-tui/rpc/host.ts` and `host.test.ts`
- `src/sumo-tui/rpc/controls.ts` and `controls.test.ts`
- `src/sumo-tui/rpc/host-actions.ts` and `host-actions.test.ts`
- `src/sumo-tui/rpc/editor.ts` and `editor.test.ts` for honest save-action
  availability/keybinding copy
- `src/sumo-tui/rpc/initial-hydration-action-gate.ts` and its tests, or a
  clearly named replacement mutation coordinator
- `src/sumo-tui/transcript/controller.ts` and `controller.test.ts`
- `src/sumo-tui/rpc/transcript-pump.ts` and `transcript-pump.test.ts`
- `test/integration/rpc-child-fixture.ts`
- focused lifecycle/compaction integration tests
- `test/integration/rpc-host-shell.test.ts`
- `test/integration/extension-instance-lifecycle.test.ts` or one new focused
  retained-host extension-command ownership test
- visual scenario declarations/captures for new user-visible states
- `docs/research/SUMOCODE_PI_RPC_AUDIT_2026.md` corrections for the thinking
  command verdict and implemented behavior
- `plans/README.md` status row

**Out of scope**:

- Replacing the host prompt scheduler or adding `clear_queue` behavior (Plan 090).
- Direct bash or image transport (Plans 091 and 092).
- Claiming authoritative auto-retry state; target `get_state` does not expose it.
- Replacing `get_entries` with `get_tree`; flat entries remain required for
  cursors, abandoned history, and navigation recovery.
- New RPC commands for compaction/branch-summary abort; they do not exist.
- Golden promotion without Dhruv's explicit approval.

## Git workflow

- Branch: `advisor/089-correct-rpc-lifecycle-and-projection`
- Commit subject: `fix: project the full Pi RPC lifecycle`
- Prefer TDD: correct the fixture and write failing event-trace tests first.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Correct the fixture before trusting it

Update `test/integration/rpc-child-fixture.ts` to mirror the target wire:

- `message_update` carries the target's indexed `assistantMessageEvent` delta
  and optional top-level cumulative `usage`; it does not invent a cumulative
  `message` or nested `partial`. `message_end.message` supplies the final
  authoritative assistant object;
- `agent_end.messages` contains only messages from that low-level run;
- `agent_settled` is delayed and independently observable;
- fixtures can emit auto-retry start/end, summarization-retry start/end,
  failed/aborted compaction, `extension_error`, usage, and tool start/end without
  a partial update.
- `pendingMessageCount` means steering plus follow-up queue length, never merely
  “currently streaming”;
- `set_model.data` is the model object returned by the installed target, not a
  fixture-only `{model: ...}` wrapper;
- line framing splits on LF exactly and preserves valid U+2028/U+2029 inside a
  JSON string instead of delegating to Node `readline`;
- unknown/unimplemented commands return an unknown-command error rather than a
  permissive success;
- thinking fixtures can clamp with a change event before the response or clamp
  to the current level with no event.

Keep all delays bounded and deterministic. Do not use the user's real session or
credentials.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/transcript-pump.test.ts test/integration/rpc-activity-cards.test.ts --fileParallelism=false
```

Expected: corrected fixture traces pass; old all-session `agent_end` assumptions
are removed.

### Step 2: Make settled state explicit

Evolve `RpcHostChromeState` so `isStreaming` (or a clearer compatible activity
field) means the Pi session can still continue automatically. Required rules:

1. `agent_start` marks active.
2. `agent_end` finalizes the current run but does not mark idle.
3. retry/summarization/compaction events preserve active state.
4. only `agent_settled` marks ordinary processing idle.
5. session replacement/hydration and child exit remain authoritative escape
   hatches.
6. total `messageCount` comes from hydration, stats, or committed full-session
   accounting—never `agent_end.messages.length`.

Update host navigation/interrupt guards to read the same authoritative activity
state; do not introduce a second busy boolean beside scheduler and chrome.

**Verify**: focused state/host tests cover `agent_end → retry → agent_start →
agent_end → agent_settled`, compaction continuation, and queued continuation.

### Step 3: Model tool, retry, compaction, and extension-error semantics

Track active tools from `tool_execution_start`/`tool_execution_end`; use a count
or stable IDs so overlapping tools and end-without-update are correct. Derive the
tool preattentive state from this model, not `lastEventType === "tool_call"`.

Add bounded state/presentation for:

- auto-retry delay and terminal retry failure;
- summarization retry and terminal failure;
- compaction abort/failure, `errorMessage`, `willRetry`, and usage;
- `extension_error` with safe extension/path/action context already supplied by
  the event, truncated through existing notification helpers.

Do not render stack traces, prompt contents, secrets, or unbounded payloads.

**Verify**: state, transcript, shell, and host-action tests assert every start,
retry, finish, abort, failure, and settled transition.

### Step 4: Hydrate policy fields and opportunistic enrichments

Add `steeringMode`, `followUpMode`, and `autoCompactionEnabled` to host state.
Hydrate them from `get_state`, update them after successful setters, and show
current values in existing settings selectors. If auto-retry has no authoritative
field, do not show a false current marker; label any local value as last-known or
omit it.

Feature-detect cumulative `message_update.usage` and optional
`toolcall_start.id/toolName`. Apply them optimistically, but retain five-second
stats, final message/tool events, and hydration as reconciliation authorities.
Older/absent optional fields must remain valid.

**Verify**: tests cover non-default hydrated modes, successful mutations,
absent/null enrichments, present-zero usage, present-nonzero usage, and later
authoritative replacement.

### Step 5: Order state mutations and bind their results to a session epoch

Replace the post-hydration fire-and-forget action path with a narrow mutation
coordinator for model/thinking changes. Preserve the existing pre-hydration
coalescing behavior, then enforce these rules:

1. State-changing model/thinking intents commit in user-input order. A later
   cycle computes its target after the earlier mutation settles, so two rapid
   forward presses advance twice rather than choosing the same cached target.
2. Prompt submission awaits the current mutation tail. Pi currently dispatches
   input lines concurrently, so write order alone does not prove that an async
   authenticated `set_model` applied before the prompt started.
3. Stamp every mutation with the current authoritative session epoch. Session
   new/switch/fork/clone and full replacement hydration advance that epoch. A
   response or rollback from an older epoch must not patch current chrome or
   persist a cache entry; reconcile the current epoch instead.
4. Do not serialize independent read-only stats/transcript work behind a slow
   authentication request. This is a state-intent lane, not a global RPC mutex.
5. If a mutation and its authoritative rollback both fail, preserve the
   original operation error and attach/report the bounded recovery failure as
   secondary context. Mark model/thinking chrome unverified (using the existing
   pending vocabulary or one explicit authority field), invalidate related
   cache state, and retry only through a bounded lifecycle-owned refresh. Never
   restore the pre-change snapshot as child truth after an ambiguous timeout.

Treat forwarded extension commands as potentially stateful. Establish an
identity/event baseline before dispatch, read authoritative state after the
command, and compare session ID/file:

- if ownership changed, run the same fail-closed transcript/chrome/scheduler
  replacement hydration used by host-owned session changes;
- if ownership is unchanged, hydrate mutable model/thinking/name/policy fields
  and replay only the safe buffered suffix;
- if reconciliation fails after an ambiguous command result, do not mix the
  buffered events into the old transcript or claim the old identity is current.

Reuse the existing session-change event buffer and hydration hooks rather than
creating a second replacement state machine.

**Verify**: deferred-response tests cover two and three rapid cycles,
forward-then-backward, selector/hotkey followed immediately by Enter, reverse
response order, a response crossing a session switch, mutation plus rollback
failure, a same-session extension mutation, and an extension command that calls
`ctx.newSession()`.

### Step 6: Make thinking capabilities and mutations authoritative

First compare the installed target behavior with the qualification record from
Plan 088. Preserve the fast optimistic paint, but stop treating a void success
as proof that the optimistic value became effective:

1. If the target `set_thinking_level` response now includes the effective
   level, apply that typed payload. Otherwise, after the successful void
   response, issue an authoritative `get_state` readback and publish its
   `thinkingLevel` to the store/runtime/cache before returning. Correctness is
   more important than retaining Plan 041's one-round-trip optimization. Do not
   infer acceptance from the absence of `thinking_level_changed`.
2. Keep error rollback authoritative. Keep `cycle_thinking_level`
   response-authoritative; it already returns the effective level and must not
   pay an unnecessary readback.
3. Keep model changes event-aware. Pi may adjust thinking level while changing
   models and emits that level event before the model response. Cover both the
   changed and unchanged cases so a later response/readback cannot restore an
   older optimistic value.
4. Remove `FALLBACK_THINKING_LEVELS`. An empty
   `get_available_thinking_levels` result means there is no selectable
   capability: do not open an empty selector, do not send a setter, and show one
   terse warning. A one-item `['off']` result remains valid for a non-reasoning
   model.
5. For `/thinking <value>`, match the normalized input directly against the
   typed levels returned by Pi. Do not reject it first through a duplicated
   closed-world list. After setting, any notification must show the effective
   level from the returned state, not the requested text.
6. Use Pi's `RpcSessionState['thinkingLevel']` (or its exported equivalent) for
   chrome/state APIs. Centralize runtime validation needed for raw events and
   persisted cache input. Make the literal registry compile-exhaustive with
   `satisfies Record<RpcThinkingLevel, ...>` so an additive target-Pi level
   fails the upgrade build until handled, rather than silently becoming
   `medium` in the shell.
7. A malformed `thinking_level_changed` event must preserve the last
   authoritative level and record only the event type; it must not erase or
   fabricate state. Before authoritative hydration, use the existing neutral
   `thinking`/pending presentation instead of claiming a model level.
8. Apply Plan 088's persistence finding. If the target exposes an official RPC
   persist operation, give `app.models.save` an explicit tested handler and
   distinguish session mutation from saved defaults in copy. If it does not,
   keep the save action unbound/disabled and remove misleading discoverability;
   never write Pi's private settings files or pretend ordinary setters persist.

Correct the RPC audit note and the supersession note in Plan 041 so neither
tells future maintainers that a successful void setter makes the requested
thinking level authoritative.

**Verify**: add deterministic controls/state/host-action tests for all of these
traces:

- unsupported request clamps to the already-current level and emits no event;
- unsupported request clamps to a different level and the event precedes the
  success response;
- valid setter, failure rollback, cycle result, and model-driven level change;
- empty capabilities, `['off']`, and a supported high-end capability;
- malformed/unknown event input preserves prior state;
- user-visible success text, where retained, uses the effective state.
- restart/new-session behavior proves whether model/thinking is session-only;
  save is either official and effective or unavailable and not advertised.

The clamp-without-event test must fail against the current optimistic-only
implementation. Do not weaken it into a fixture that always emits a change.

### Step 7: Capture and run the complete gate

Add deterministic fixture/visual states for retry, compaction failure, extension
error, and tool execution without partial output. Review styled-cell and geometry
reports before PNGs. No golden promotion is authorized.

Run every command in the table. Manually exercise a real Pi retry/settle trace
and confirm READY appears only after `agent_settled`.

## Test plan

- Run-local `agent_end` never lowers total message count.
- Chrome remains active through retry and queued continuation.
- `agent_settled` is the normal idle edge.
- Tool state appears at start even without update and clears after all ends.
- Compaction success, abort, retry, and terminal failure are distinct.
- Extension errors are visible, bounded, and redacted.
- Non-default queue/auto-compaction settings survive hydration and mutation.
- Usage/tool-call enrichments are optional and reconciled by final sources.
- A successful void thinking setter is reconciled to Pi's effective state,
  including clamp-without-event.
- Empty thinking capabilities fail closed; `['off']` remains selectable.
- Thinking state uses Pi's typed union across controls, state, raw-event
  validation, and shell presentation without duplicated silent fallbacks.
- Model/thinking save affordances match the official RPC persistence capability
  exactly; current session state is never described as a saved default.
- Rapid model/thinking actions commit in intent order and a following prompt
  cannot overtake them.
- Late mutation/rollback responses cannot cross a session ownership epoch.
- Forwarded extension commands reconcile session replacement and mutable chrome
  instead of assuming the session stayed unchanged.
- Child exit and session replacement still clear stale activity safely.

## Done criteria

- [ ] No production path marks ordinary idle from `agent_end`.
- [ ] No total count is derived from `agent_end.messages.length`.
- [ ] Retry, summarization, compaction failure, extension error, and tool activity have tests and visible presentation.
- [ ] Pi policy fields exposed by `get_state` are hydrated truthfully.
- [ ] Optional event enrichments work when present and absent.
- [ ] No comment or control path claims the requested thinking level is the
  result of a void successful setter.
- [ ] Clamp-without-event finishes on Pi's effective thinking level.
- [ ] No fallback manufactures thinking capabilities when Pi returns none.
- [ ] Additive thinking-level type drift fails loudly at the Pi upgrade seam.
- [ ] `app.models.save` is implemented through official RPC or is not advertised
  as a working retained-host action.
- [ ] Model/thinking mutations are serialized narrowly and prompt submission
  awaits their committed tail.
- [ ] Old-session and double-failure responses cannot leave verified-looking
  optimistic chrome.
- [ ] Forwarded extension commands prove same-session refresh and changed-session
  full hydration paths.
- [ ] Unit, integration, visual CI, lint, typecheck, and build pass.
- [ ] Review captures exist; no golden was promoted.
- [ ] Plan 089 and the index are updated.

## STOP conditions

- Plan 088 is not DONE or the installed worker does not pass its contract gate.
- The published event order contradicts `agent_settled` as the idle boundary.
- Correct totals require treating a run suffix as a full session.
- Presentation would expose unbounded/raw extension errors or user secrets.
- Auto-retry truth requires inventing a field not present in the RPC state.
- The target release changes thinking setter/clamp/event semantics from Plan
  088's qualification record; amend this plan before choosing a new authority.
- Saved-default parity would require direct writes to Pi settings/private APIs;
  leave save disabled and document the upstream capability gap instead.
- Correct reconciliation would require an untyped cast, private Pi import, or
  silently maintained closed-world level list.
- The coordinator would require globally serializing read-only/event work or
  changing Pi; narrow host-side intent ordering must remain possible.
- Extension-command ownership cannot reuse the existing event buffer and
  replacement hydration safely; stop and amend before adding a parallel seam.
- The work expands into queue ownership, bash, images, or an upstream Pi patch.

## Maintenance notes

- Keep final sources authoritative: stats/hydration for totals and cost,
  `message_end.message` for assistant messages, `toolcall_end.toolCall` plus
  `tool_execution_*` for tool execution.
- `entry_appended`, `session_info_changed`, and `thinking_level_changed` are
  source-emitted even where `rpc.md` lags; preserve unknown events defensively.
- `get_available_thinking_levels` is a capability response, not a suggestion.
  Never expand an empty or narrow result locally.
- Event silence after `set_thinking_level` means only that Pi emitted no
  effective change. It does not confirm the requested value.
- Keep one compile-exhaustive runtime boundary for untrusted cache/event data;
  selectors and setters should otherwise consume Pi's typed response directly.
- Re-qualify session mutation separately from default persistence. Do not infer
  Ctrl+S/classic persistence from `set_model` or `set_thinking_level` success.
- Pi's JSONL reader dispatches requests concurrently. Preserve a host mutation
  tail plus session epoch unless a future qualified release explicitly changes
  that contract and the regression suite proves equivalent ordering.
- Extension commands are an RPC preflight surface, not necessarily pure prompt
  text. Reconcile identity and mutable state after they run.
- Any future state field used for interrupt or navigation must follow the same
  settled boundary rather than reviving a parallel notion of idle.
