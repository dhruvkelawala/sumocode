# Plan 055: Investigate, then fix, agent_end dropping interleaved run-suffix messages

> **Executor instructions**: This is an INVESTIGATE-FIRST plan. Step 0 decides
> whether any code change happens at all. Follow it step by step; run every
> verification command. If a STOP condition occurs, stop and report. SKIP
> updating `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/047-streaming-pipeline-perf..HEAD -- src/sumo-tui/transcript/controller.ts`
> Your base branch is `advisor/047-streaming-pipeline-perf` (the controller
> was reworked there; reconcile logic must build on it). On excerpt mismatch,
> STOP.

## Status

- **Priority**: P2
- **Effort**: M (S if Step 0 says by-design)
- **Risk**: MED
- **Depends on**: plans/047-streaming-pipeline-perf.md
- **Category**: bug (confidence MED — investigate)
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

On `agent_end`, the transcript controller replaces the whole run suffix of
`committedMessages` with `event.messages` (the run's final list). Messages
committed incrementally via `message_end` DURING the run — notably user
follow-up/steering messages, which the host submits with
`streamingBehavior: "followUp"` while a run is active — would be silently
dropped at run end if Pi's `agent_end.messages` does not carry them. Whether
Pi carries them is the open question; the local reconciliation is not robust
to a valid-looking interleaving either way.

## Current state

- `src/sumo-tui/transcript/controller.ts:391-410` (line numbers from
  `86e5062`; RE-LOCATE in your base branch — plan 047 may have moved them):

```ts
case "agent_end": {
	const messages = eventMessages(record);
	if (messages) {
		// `agent_end.messages` carries only the CURRENT RUN's messages, ...
		// Reconcile by replacing just the suffix that belongs to this run —
		// everything committed before the run started must survive. ...
		const runStart = this.currentRunStartIndex ?? this.committedMessages.length;
		this.committedMessages = [...this.committedMessages.slice(0, runStart), ...messages];
		this.invalidateCommittedCache();
	}
	...
}
```

- `src/sumo-tui/rpc/host.ts:~176` — while streaming, submitted prompts use
  `streamingBehavior: "followUp"` (this is what makes mid-run user commits
  possible).
- The authoritative oracle is Pi's agent loop:
  `node_modules/@earendil-works/pi-coding-agent/` and its agent-core
  dependency — find where `agent_end` is emitted and what populates its
  `messages` array (search the dist for `agent_end`), and specifically
  whether a follow-up/steer message enqueued mid-run is appended to that
  array.
- Tests: `src/sumo-tui/transcript/controller.test.ts` (agent_end reconcile
  cases from batch B7 + plan 047's changes),
  `src/sumo-tui/rpc/transcript-pump.test.ts`.
- Conventions: tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/transcript/controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts` | all pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/controller.ts` (agent_end branch only)
- `src/sumo-tui/transcript/controller.test.ts`,
  `src/sumo-tui/rpc/transcript-pump.test.ts`

**Out of scope**:
- host.ts submit path, pump structure, chat sink, pager.
- Any change when Step 0 proves the drop cannot happen (then this plan ends
  as a report + one pinning test).

## Git workflow

- Branch: `advisor/055-agent-end-suffix-reconcile` off
  `advisor/047-streaming-pipeline-perf`
- Conventional commits (`fix(sumo-tui): ...`). Do NOT push.

## Steps

### Step 0: Determine Pi's agent_end accounting (evidence, not vibes)

Read the pinned Pi dist (paths in "Current state"). Answer with file:line
evidence: does a message submitted mid-run with `streamingBehavior:
"followUp"` appear in `agent_end.messages`?

- **Always appears** → the drop cannot happen. Write ONE pinning test
  documenting the assumption (an agent_end carrying the follow-up reproduces
  identical committedMessages), record the Pi evidence in a code comment on
  the agent_end branch, and finish — report "by-design, pinned".
- **Can be absent** (or indeterminate) → proceed to Step 1.

### Step 1: Identity-aware suffix reconcile

Replace the wholesale suffix splice with a reconcile over the run suffix:

- Index `agent_end.messages` by stable message identity (the same id the
  view-model/diff layer uses — find how `messageContentKey`/view-model ids
  are derived and reuse that identity source).
- Result = for each existing suffix message: the authoritative final copy
  when its id is in the event list; kept as-is when absent (the interleaved
  follow-up case). Then append event-list messages not already represented,
  in the event list's order.
- Duplicate protection: a message present in both must appear ONCE (the
  existing B7 tests assert no double-render — keep them green).

**Verify**: new controller tests: (a) mid-run follow-up committed via
message_end + agent_end WITHOUT it → follow-up survives, order sane;
(b) agent_end WITH it → exactly one copy, final content wins; (c) aborted-run
case (agent_end carrying messages a message_end never delivered) → they
appear (the comment's original motivation, preserved).

### Step 2: Pump-level regression

Mirror case (a) at the pump level in `transcript-pump.test.ts` (events in,
view-model out), the layer the original B7 fix was tested at.

**Verify**: targeted suites green.

## Test plan

Per steps; patterns from the existing agent_end tests. Never weaken B7's
prior-history-survives assertions.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0
- [ ] Step 0 evidence (Pi file:line) in the report AND as a code comment
- [ ] If Step 1 taken: follow-up-survives + no-duplicate + aborted-run tests
      exist and pass
- [ ] `git status` — only in-scope files changed

## STOP conditions

- Pi's dist shows agent_end semantics that contradict BOTH branches above
  (e.g. messages can be partial in other ways) — report; the fix may belong
  upstream.
- The identity source for messages is unstable across message_end/agent_end
  copies (ids differ for the same logical message) — report; reconcile by id
  would be wrong.

## Maintenance notes

- This branch of code answers "which messages belong on screen" — the same
  question B7 fixed. Reviewer: check order stability and the aborted-run
  case, and confirm no assertion from B7's tests was weakened.
