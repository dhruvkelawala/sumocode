# Plan 091: Add Pi-native direct bash to the RPC host

> **Executor instructions**: Do not execute until Plan 088 is DONE. Read Pi's
> shipped `bash`, `bash_execution_update`, and `abort_bash` types before editing.
> Implement direct bash as its own user-initiated activity lifecycle; do not route
> it through the LLM `tool_call` lifecycle or disguise it as an agent prompt.
> Stop on any contract or security-boundary mismatch.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 42e6eec..HEAD -- \
>   src/sumo-tui/rpc/client.ts src/sumo-tui/rpc/client.test.ts \
>   src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/controls.test.ts \
>   src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/interrupt.ts src/sumo-tui/rpc/interrupt.test.ts \
>   src/sumo-tui/transcript src/activity \
>   test/integration/rpc-child-fixture.ts docs/visual/parity/scenarios.json
> ```
>
> Reconcile compatible drift from Plans 089/090. Direct bash must remain distinct
> from agent/tool activity and native prompt queues.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 088; may execute in parallel with Plan 089 after rebasing compatible lifecycle state
- **Category**: feature / parity
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Deep-audit revision**: commit `42e6eec`, 2026-08-28
- **Issue**: [#378](https://github.com/dhruvkelawala/sumocode/issues/378)
- **Execution status**: BLOCKED — wait for the published Pi release containing `clear_queue` and Plan 088, per the coordinated release gate

## Outcome

Typing `!command` into ordinary Enter executes Pi's direct RPC bash immediately;
`!!command` sets `excludeFromContext:true`. All `bash_execution_update.delta`
chunks stream into one retained activity correlated by the command id. The final
`BashResult` records success, nonzero exit, cancellation, truncation, and the
optional full-output path. Escape while direct bash is active calls
`abort_bash`, not generic agent `abort`.

The command may run longer than the client's ordinary 30-second request timeout.
Its result continues to use Pi's session semantics: unless excluded, Pi converts
the stored `BashExecutionMessage` into user context on the next prompt.

## Why this matters

The RPC host currently sends `!command` to the model as ordinary text, losing a
core Pi interactive workflow. RPC already supplies the complete direct-bash
surface, including streaming output, targeted cancellation, context inclusion,
and persisted session history. SumoCode needs to project that surface, not run a
second local shell process.

## Current state

- `host-actions.ts:527-534` recognizes only `/...` host commands; `!` falls
  through.
- `host.ts:471-484` exposes only prompt delivery.
- `controls.ts:182-184` exposes agent `abort`, but no `bash` or `abortBash`.
- `interrupt.ts:11-37` knows modal, draft, and agent streaming state, but not a
  direct-bash operation.
- `client.ts:292-300` assigns every request a default 30-second timeout.
- No production handler consumes `bash_execution_update`.
- `src/sumo-tui/transcript/view-model.ts:615-619` already understands finalized
  `role:"bashExecution"` records.
- Existing activity/tool renderers already provide bounded terminal command and
  output presentation. Reuse that semantic model; do not import the classic
  `pi-compat/BashExecutionComponent` mirror into the RPC host.

Target wire contract:

```text
request:  {type:"bash", id, command, excludeFromContext?}
event:    {type:"bash_execution_update", id?, delta}
response: {type:"response", command:"bash", id, success:true, data:BashResult}
abort:    {type:"abort_bash"}
```

`BashResult` contains full final output plus optional exit code, cancelled and
truncated flags, and optional full-output path. Streaming events carry every
delta even when the final result is truncated. Only the bash update event has
command-id correlation; ignore updates that do not match the active operation
unless the shipped worker omits id, in which case accept them only while exactly
one direct bash is active.

Classic input ordering to preserve:

- ordinary Enter on `!`/`!!` executes direct bash even while an agent streams;
- idle Alt+Enter delegates to ordinary submit and therefore executes direct bash;
- busy Alt+Enter remains a prompt follow-up string and does not execute shell;
- an empty `!`/`!!` does not start an operation;
- direct user bash is explicit local execution and is not an LLM tool call, so
  it must never emit/enter the LLM `tool_call` seam. SumoCode intentionally does
  not gate Pi's built-in bash tool either; this plan must preserve that existing
  architecture rather than assert a dormant approval boundary.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Client/controls | `pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/controls.test.ts` | all pass |
| Host/interrupt | `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/interrupt.test.ts` | all pass |
| Direct bash integration | `pnpm vitest run test/integration/rpc-direct-bash.test.ts --fileParallelism=false` | all fixture and real-worker smokes pass |
| Tool-boundary regression | `pnpm vitest run src/extension.test.ts -t "does not block dangerous bash tool calls during full extension install"` | built-in bash remains ungated and direct bash has separate RPC lifecycle tests |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- `src/sumo-tui/rpc/direct-bash.ts` and `direct-bash.test.ts` (create)
- RPC client, controls, host-actions, host, and interrupt with colocated tests
- existing transcript/activity domain and renderer files only where a reusable
  direct-bash projection needs a small generic extension
- `test/integration/rpc-child-fixture.ts`
- `test/integration/rpc-direct-bash.test.ts` (create)
- component/fixture/runtime visual scenarios for running, success, failure,
  cancellation, and truncation
- `plans/README.md` status row

**Out of scope**:

- Spawning `/bin/bash`, a PTY, or a terminal task directly from SumoCode.
- Reusing or changing the LLM `bash` tool execution pipeline as the owner.
- Routing explicit `!` user commands through `tool_call` or any dormant approval
  modal.
- Changing native prompt queue behavior from Plan 090.
- Adding shell history expansion, aliases, or a persistent subshell.
- Rendering unbounded output or embedding full-output file contents automatically.
- Golden promotion without explicit human approval.

## Git workflow

- Branch: `advisor/091-add-pi-native-direct-bash`
- Commit subject: `feat: add Pi-native direct bash`
- Use a new bounded controller rather than expanding `host.ts` with mutable
  correlation/output logic.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Add an explicit no-timeout client option

Evolve `SumoRpcClient.send` compatibly so ordinary calls retain the current
30-second default and a direct-bash caller can explicitly disable its response
timer (for example `timeoutMs: null`). Pending-map cleanup, child exit rejection,
stdin write failure, and explicit host shutdown must still settle the promise.

Expose a narrow local-write acknowledgement for this staged submission (for
example a request handle with `written` and `response` promises). Pi's `bash`
RPC response arrives only after execution completes, so do not call it a
preflight/acceptance response. The write acknowledgement proves only that bytes
entered the child pipe; child exit afterward remains acceptance-unknown.

Do not use an arbitrary multi-hour timeout. Direct commands such as a build or
server may validly exceed it; cancellation comes from `abort_bash` or child exit.

**Verify**: client tests prove default timeout, custom timeout, no-timeout pending
request, write success/failure, response cleanup, child-exit cleanup, and stop
cleanup without leaked timers/listeners.

### Step 2: Create the direct-bash domain/controller

Create `direct-bash.ts` with one active-operation record containing generated
command id, command text, inclusion mode, accumulated output, status, and final
metadata. Required invariants:

1. only one direct bash owns the Pi session at a time;
2. output deltas append in arrival order and are bounded for live rendering;
3. final response is authoritative and can refer to a full-output path;
4. cancellation request does not mark cancelled until Pi confirms/finalizes;
5. stale/mismatched ids never mutate the active operation;
6. reset/session replacement cannot let a late update enter a new session;
7. diagnostics record sizes/status only, never unbounded command output.

Project the operation through the existing Activity presentation shapes with a
distinct stable id such as `rpc-bash:<request-id>`. Final Pi session hydration
may replace the live activity with the durable `bashExecution` message without
duplicating it.

**Verify**: controller tests cover chunking (including split Unicode), bounded
display tail, missing/mismatched ids, success, nonzero exit, cancellation,
truncation/full path, reset, and response-before/after-last-update ordering.

### Step 3: Route `!` and `!!` with classic ordering

Add a small parser that recognizes only a leading `!` at the beginning of the
submitted draft:

- `!command` → included in next-prompt context;
- `!!command` → `excludeFromContext:true`;
- strip only the syntax marker and one optional following space; preserve the
  command body exactly otherwise;
- empty bodies are ignored with a terse notice.

Apply the parser in ordinary submit after built-in slash routing and before
agent/queue dispatch. Preserve the busy Alt+Enter exception from the locked
behavior table. Define the editor transition exactly:

- before local write acknowledgement, keep draft and history unchanged;
- after write acknowledgement, add history, clear the visible draft, and retain
  a controller-owned recovery copy while status is running;
- on synchronous write failure, leave the draft untouched;
- on child exit/timeout before a final response, report acceptance unknown and
  offer the retained text for manual recovery without automatic resend.

Do not wait for command completion to clear the editor, and do not label the
local write as Pi acceptance.

Use `RpcHostControls.runBash(command, excludeFromContext, id)` to send the command
with no response timeout. Do not call any OS shell API.

**Verify**: host/action tests cover include/exclude parsing, whitespace, empty
input, streaming Enter, idle/busy Alt+Enter, overlapping rejection, synchronous
write failure, and ambiguous child exit before/after local write acknowledgement.

### Step 4: Stream events and route Escape to `abort_bash`

Subscribe the direct-bash controller to `bash_execution_update` before generic
transcript processing. Update the retained activity and request a coalesced
render for each bounded change.

Add direct-bash activity to interrupt classification ahead of agent abort. When
active, Escape sends `abort_bash`; it must not also clear Pi prompt queues or call
generic `abort`. Ctrl+C retains SumoCode's existing editor clear/quit semantics
unless the accepted product keymap explicitly says otherwise.

If `abort_bash` fails, keep the activity active and show a bounded error. A
second Escape may retry; do not mark completion speculatively.

**Verify**: exact command-order tests and a long-running real-worker smoke prove
that Escape cancels bash and leaves an independently streaming agent untouched.

### Step 5: Reconcile completion and durable session history

On the final response, render exit/cancel/truncation metadata and the
full-output path without reading that file into memory. Confirm included results
appear in the next prompt's context/session conversion and excluded results do
not. On resume/hydration, finalized `bashExecution` messages render once through
the existing view-model.

Avoid a second `get_messages` round trip if the final response/session event
already provides enough authoritative data; if the worker persists without an
event, perform one bounded reconciliation after completion.

**Verify**: integration tests cover success, nonzero exit, output longer than
final truncation, cancellation, exclude-from-context, next-prompt conversion,
and resume without duplicate cards.

### Step 6: Add visual evidence and run all gates

Capture direct bash running, completed, failed, cancelled, and truncated states
through the canonical component/fixture/runtime pipeline. Reuse typed terminal
activity rendering; no hand-built ANSI. Review text reports before PNGs.

Run every gate in the command table. Do not promote goldens.

## Test plan

- `!`/`!!` parser and classic state/action ordering.
- Command-id correlation, no-timeout response, and bounded streaming output.
- Success, nonzero exit, cancelled, truncated, and full-output-path results.
- Escape routes only to `abort_bash` while direct bash is active.
- Included result becomes next-prompt context; excluded result does not.
- Resume renders one durable bash execution.
- Direct bash never routes through `tool_call`; the existing intentional
  non-gating behavior for Pi's built-in bash remains unchanged.

## Done criteria

- [ ] `!` and `!!` use Pi RPC `bash`, never an agent prompt or local spawn.
- [ ] All output deltas correlate to one bounded retained activity.
- [ ] Long-running commands do not hit the ordinary 30-second timeout.
- [ ] Escape calls `abort_bash` and final state comes from Pi.
- [ ] Context inclusion/exclusion and resume behavior are integration-tested.
- [ ] The full-install built-in-tool boundary remains ungated, and direct bash
  has no `tool_call` event/approval dependency.
- [ ] Unit, integration, visual CI, lint, typecheck, and build pass.
- [ ] No golden was promoted without approval.
- [ ] Plan 091 and the index are updated.

## STOP conditions

- Plan 088 is not DONE or the shipped bash event/result shape differs materially.
- Correct operation would require a local shell spawn or private Pi import.
- The client cannot disable only this request's timeout without weakening other requests.
- Output cannot be bounded without losing the authoritative final/full-output reference.
- Interrupt routing would abort both bash and the agent unintentionally.
- Context exclusion cannot be proven against the real worker.

## Maintenance notes

- Direct user bash and LLM tool bash share rendering concepts, not authorization
  or lifecycle ownership.
- Retain id correlation even if only one bash is allowed; it protects session
  replacement and late-event races.
- Future upstream support for concurrent direct commands would require an
  explicit product decision and keyed controller map, not silent relaxation.
