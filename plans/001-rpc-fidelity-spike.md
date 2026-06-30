# 001 — Phase 0: RPC fidelity spike + go/no-go gate

**Written against commit:** `ae03bc0`
**Size:** M (~1 week) · **Depends on:** none · **Blocks:** 002–006
**Issue:** [#289](https://github.com/dhruvkelawala/sumocode/issues/289)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

Before committing 6–9 weeks to the RPC migration, three load-bearing claims must be
*proven live* (static reading is not enough). If any fails, the migration is **no-go** as
specified. This is a throwaway spike — it produces fixtures, a perf number, and a written
go/no-go verdict, **not** shippable code. Do not touch `src/` production code or
`bin/sumocode.sh` in this phase.

The three claims to falsify or confirm:

1. **Transcript fidelity** — Pi's RPC `get_messages` + `onEvent` stream carry enough to
   rebuild SumoCode's transcript view-model losslessly (including thinking, aborted, image,
   and task-partialResult turns).
2. **Approval round-trip (SECURITY)** — an in-Pi `tool_call` handler can return
   `{block:true}` to veto a dangerous command *and* round-trip a host-answered
   `select`/`confirm` decision, with the dangerous command provably blocked.
3. **answer-tool over RPC** — `answer-tool`'s `complete()` (LLM extraction) runs when lifted
   out of the `ctx.ui.custom()` closure.

Plus a perf bench: the per-delta full-`partial` snapshot serialization + agent-loop
backpressure must not regress streaming responsiveness on a long message.

## Background facts (verified — do not re-derive)

- Pi's RPC server: `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`.
  `ctx.ui.custom()` there is `async custom() { return undefined; }` (~line 151) — a no-op.
  Unknown command types are rejected (~line 529).
- Pi RPC protocol types:
  `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`.
  Commands include `prompt`, `get_messages`, `get_state`, `bash`, `new_session`, etc.
  Events stream as `AgentEvent`/`AgentSessionEvent`. Extension UI flows via
  `extension_ui_request` (methods: `select`/`confirm`/`input`/`editor`/`notify`/`setStatus`/
  `setWidget`/`setTitle`/`set_editor_text`) answered by `extension_ui_response`.
- Reference host implementation to copy: Pi's experimental orchestrator
  `packages/orchestrator/src/rpc-process.ts` (class `RpcProcessInstance`) in
  `github.com/earendil-works/pi` — spawns `pi --mode rpc`, JSONL framing, id-correlated
  request/response, event streaming, and `setUiRequestHandler(...)`. **Not on npm** — read it
  on GitHub and copy the pattern into the spike; do not add it as a dependency.
- SumoCode's current transcript view-model: `src/sumo-tui/transcript/view-model.ts` (consumes
  plain records, feature-detects fields — e.g. `imageBlockFromRecord`).
- The current approval gate uses `ctx.ui.custom<ApprovalChoice>(...)` at
  `src/approval-modal.ts:265`; answer-tool's extraction is nested in `custom()` at
  `src/answer-tool.ts:338`. These are the patterns the spike must prove replaceable.
- Pi is pinned at 0.79.1 (`package.json`). Bumping to 0.80.x is allowed *for the spike scratch
  dir only*; do not change the repo's pin in this phase.

## Scope

**In scope:** a throwaway spike harness under `scratch/rpc-spike/` (create it; it is
git-ignored — verify with `git check-ignore scratch/rpc-spike` or add to `.gitignore`),
plus a written verdict committed to `plans/001-VERDICT.md`.

**Out of scope (do NOT touch):** anything under `src/`, `bin/sumocode.sh`, `package.json`
dependency pins, `patches/`, any committed fixture goldens. No production wiring.

## Steps

1. **Stand up a minimal RPC host.** In `scratch/rpc-spike/host.mjs`, spawn the locally
   installed Pi in RPC mode: `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js
   --mode rpc -e src/extension.ts` (cwd = repo root). Implement LF-only JSONL framing on
   stdout (split on `\n` only — see Pi's `jsonl.d.ts` note about U+2028/U+2029), id-correlated
   request/response, and an event listener. Mirror `RpcProcessInstance`'s structure.
   - **Verify:** send `{"type":"get_state","id":"1"}` on stdin; receive a
     `{"type":"response","command":"get_state",...}` line. Print it.

2. **Prove extensions load under RPC.** Confirm `get_commands` returns SumoCode's
   extension/skill commands (proving `-e src/extension.ts` loaded in the subprocess).
   - **Verify:** the `get_commands` response `data.commands[]` includes at least one
     `source:"extension"` entry contributed by SumoCode.

3. **Transcript replay fidelity (claim 1).** Send a `prompt` that triggers a multi-turn
   response including at least: a thinking block, a tool call + result, and (if reproducible)
   an image and an aborted turn. Record every `AgentEvent` line to
   `scratch/rpc-spike/events-<scenario>.jsonl`. Then call `get_messages` and dump
   `data.messages`. Feed both through a copy of the view-model conversion
   (`src/sumo-tui/transcript/view-model.ts`) and diff against an in-process interactive
   capture of the same prompt.
   - Use **canonicalized JSON** for the diff (`JSON.stringify` drops `undefined` keys — a
     naive deep-equal false-positives). Sort keys before comparing.
   - **Verify:** the converted view-model from RPC equals the in-process one for chat text,
     thinking, tool args/results, and image blocks. Record any field present in-process but
     absent from the RPC feed in the verdict.

4. **Perf bench (claim 1 caveat).** Prompt for a long (~8k token) streamed assistant message.
   Measure bytes/sec on stdout and total `JSON.parse` time on the host; watch for the
   agent-loop throttling when the host pipe is slow (Pi awaits its backpressure listener).
   Compare wall-clock first-token and steady-state delta cadence against an in-process run.
   - **Verify:** record numbers in the verdict. Same-or-better requires the RPC path to not
     visibly stall streaming. SumoCode's ~100ms render coalescer should absorb batching.

5. **Approval round-trip (claim 2, SECURITY).** In the spike's `-e` extension copy, register a
   `tool_call` handler that, for a dangerous command (e.g. `rm -rf` pattern), emits an
   `extension_ui_request` `select` (options: `No` / `Yes` / `Always`) and **returns
   `{block:true}` until/unless the host answers an allowing choice**. From the host, answer
   `No` and assert the command never executes; answer `Yes` and assert it does.
   - **Verify (must pass):** with answer `No` (or no answer / timeout), the dangerous command
     produces **no** `tool_execution_start` for that tool and does not run. With `Yes`, it
     runs. There must be **zero** path where an unanswered/ambiguous response lets the command
     proceed.

6. **answer-tool over RPC (claim 3).** Copy `answer-tool`'s `complete()` logic out of the
   `custom()` closure into a standalone function and invoke it under the spike's RPC
   subprocess (branch on `ctx.mode === 'rpc'`). Confirm the LLM extraction actually fires and
   returns a value (today, nested in `custom()`, it silently no-ops).
   - **Verify:** the extraction call hits the model and returns a non-empty structured result
     over RPC.

7. **Inventory un-sourced surfaces.** Grep SumoCode for any rendered surface NOT backed by a
   persisted `AgentMessage` (e.g. transient skill-invocation components, share-URL mirrors).
   List each in the verdict with whether it has an RPC re-source.

8. **Write the verdict.** Create `plans/001-VERDICT.md`: PASS/FAIL per claim, the perf
   numbers, the un-sourced-surface inventory, any missing AgentEvent fields, and an overall
   **GO / NO-GO**. If NO-GO, state precisely which claim failed and why.

## Done criteria (machine-checkable where possible)

- `node scratch/rpc-spike/host.mjs --selftest` prints a `get_state` response and a
  `get_commands` list containing a SumoCode `source:"extension"` command. (exit 0)
- `scratch/rpc-spike/events-*.jsonl` exist for ≥3 scenarios (thinking, tool, image-or-abort).
- A committed `plans/001-VERDICT.md` with explicit PASS/FAIL per claim and a GO/NO-GO line.
- The security assertion in step 5 is demonstrated by a script
  (`scratch/rpc-spike/approval-test.mjs`) that exits non-zero if a `No`-answered dangerous
  command runs.

## Escape hatches — STOP and report instead of improvising

- If `-e src/extension.ts` does **not** load extensions under `--mode rpc` (step 2 fails),
  STOP — the whole "business logic stays a subprocess extension" architecture is invalid;
  report and re-plan.
- If there is **no** way to make a `tool_call` handler block on a host answer (step 5),
  STOP — the approval gate cannot be made safe over RPC without forking Pi; the migration is
  NO-GO as specified.
- If the RPC feed is missing fields the view-model needs and `get_messages` does not backfill
  them, STOP and record exactly which fields — that determines whether transcript parity is
  achievable.

## Test plan

This phase writes no production tests. The deliverable artifacts are the spike scripts and
`001-VERDICT.md`. The fixtures captured here (the `events-*.jsonl`) become the seed for the
real fixture-lane tests added in Plan 002.

## Maintenance note

Everything under `scratch/rpc-spike/` is disposable. Do not let spike code leak into `src/`.
If GO, Plan 002 re-implements the host properly (the spike host is a reference, not a base).
