# Plan 089: Make SumoCode project Pi's lifecycle and policy state truthfully

> **Executor instructions**: Do not execute this plan until Plan 088 is DONE.
> Follow the steps and verification gates in order. Treat `agent_end` as a
> low-level run boundary and `agent_settled` as the only ordinary idle boundary.
> If the published Pi event shapes differ from the excerpts below, stop and
> amend the plan rather than guessing.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/state.test.ts \
>   src/sumo-tui/rpc/shell-adapter.ts src/sumo-tui/rpc/shell-adapter.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/controls.test.ts \
>   src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts \
>   src/sumo-tui/transcript/controller.ts src/sumo-tui/transcript/controller.test.ts \
>   src/sumo-tui/rpc/transcript-pump.ts src/sumo-tui/rpc/transcript-pump.test.ts \
>   test/integration/rpc-child-fixture.ts test/integration/rpc-activity-cards.test.ts \
>   test/integration/rpc-compaction-ux.test.ts docs/visual/parity/scenarios.json
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
remain authoritative.

## Why this matters

The scheduler already waits for `agent_settled`, but chrome clears at
`agent_end`. Between those events SumoCode can say READY, stop its working
indicator, undercount the session, and make interrupt/navigation decisions from
false idle state while Pi is retrying or continuing. Other RPC events already
carry the truth, but several are reduced to an unhelpful `lastEventType` string
or ignored entirely.

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

State vocabulary must remain Cathedral-consistent: uppercase state labels come
from existing voice/tokens; ordinary notices are lowercase and terse. Do not
add raw ANSI; use retained typed primitives and existing notification/transcript
patterns.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused state | `pnpm vitest run src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/shell-adapter.test.ts` | all lifecycle traces pass |
| Transcript | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts` | all pass |
| Host | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |
| Controls | `pnpm vitest run src/sumo-tui/rpc/controls.test.ts` | policy setters and state reconciliation pass |
| Integration | `pnpm vitest run test/integration/rpc-activity-cards.test.ts test/integration/rpc-compaction-ux.test.ts --fileParallelism=false` | all pass |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- `src/sumo-tui/rpc/state.ts` and `state.test.ts`
- `src/sumo-tui/rpc/shell-adapter.ts` and `shell-adapter.test.ts`
- `src/sumo-tui/rpc/host.ts` and `host.test.ts`
- `src/sumo-tui/rpc/controls.ts` and `controls.test.ts`
- `src/sumo-tui/rpc/host-actions.ts` and `host-actions.test.ts`
- `src/sumo-tui/transcript/controller.ts` and `controller.test.ts`
- `src/sumo-tui/rpc/transcript-pump.ts` and `transcript-pump.test.ts`
- `test/integration/rpc-child-fixture.ts`
- focused lifecycle/compaction integration tests
- visual scenario declarations/captures for new user-visible states
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

- `message_update` carries an indexed `assistantMessageEvent` delta and the
  cumulative current assistant message shape expected by the published type;
- `agent_end.messages` contains only messages from that low-level run;
- `agent_settled` is delayed and independently observable;
- fixtures can emit auto-retry start/end, summarization-retry start/end,
  failed/aborted compaction, `extension_error`, usage, and tool start/end without
  a partial update.

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

### Step 5: Capture and run the complete gate

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
- Child exit and session replacement still clear stale activity safely.

## Done criteria

- [ ] No production path marks ordinary idle from `agent_end`.
- [ ] No total count is derived from `agent_end.messages.length`.
- [ ] Retry, summarization, compaction failure, extension error, and tool activity have tests and visible presentation.
- [ ] Pi policy fields exposed by `get_state` are hydrated truthfully.
- [ ] Optional event enrichments work when present and absent.
- [ ] Unit, integration, visual CI, lint, typecheck, and build pass.
- [ ] Review captures exist; no golden was promoted.
- [ ] Plan 089 and the index are updated.

## STOP conditions

- Plan 088 is not DONE or the installed worker does not pass its contract gate.
- The published event order contradicts `agent_settled` as the idle boundary.
- Correct totals require treating a run suffix as a full session.
- Presentation would expose unbounded/raw extension errors or user secrets.
- Auto-retry truth requires inventing a field not present in the RPC state.
- The work expands into queue ownership, bash, images, or an upstream Pi patch.

## Maintenance notes

- Keep final sources authoritative: stats/hydration for totals and cost,
  `message_end.message` for assistant messages, `toolcall_end.toolCall` plus
  `tool_execution_*` for tool execution.
- `entry_appended`, `session_info_changed`, and `thinking_level_changed` are
  source-emitted even where `rpc.md` lags; preserve unknown events defensively.
- Any future state field used for interrupt or navigation must follow the same
  settled boundary rather than reviving a parallel notion of idle.
