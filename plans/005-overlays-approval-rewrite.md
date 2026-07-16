# 005 — Phase 4: Overlays + approval-gate rewrite + answer/question-tool refactor

**Written against commit:** `ae03bc0`
**Size:** L · **Depends on:** 003 · **Blocks:** 006 (parallel with 004)
**Issue:** [#293](https://github.com/dhruvkelawala/sumocode/issues/293)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)
**SECURITY-CRITICAL — read the security note below before starting.**

## Why this exists

Pi's RPC protocol has **no `custom` channel** — `ctx.ui.custom()` is a no-op returning
`undefined`, and a bespoke channel cannot be added without forking Pi. SumoCode renders 8
rich overlays through `ctx.ui.custom<>()`. Over RPC every one of them silently no-ops. Two of
those failures are dangerous:

- **The approval gate fails OPEN** — the dangerous-command modal returns `undefined`, which is
  neither "no" nor "always", so **the dangerous command runs ungated**.
- **answer-tool / question-tool silently break** — their logic is nested inside the `custom()`
  closure that never fires, so they return "Cancelled" to the model (answer-tool's LLM
  extraction never runs).

This phase re-architects all overlays to: **render host-side, use the in-Pi tool only for the
final typed value via an `extension_ui` round-trip** (and `{block:true}` for approval). The
`src/` renderers are reused verbatim; only the trigger/return plumbing changes.

## SECURITY NOTE (do not skip)

The approval-gate rewrite is the single highest-risk item in the whole migration. It no longer
blocks starting Phase 1, but it still blocks any default/shared cutover unless the product
explicitly removes dangerous-command approval from the RPC surface. The failure mode is
*fail-open*, which is worse than crashing. Treat "block on uncertainty" as the invariant:
any ambiguous, missing, timed-out, or malformed response must resolve to **blocked**, never
to proceed. Until this plan lands, RPC paths that would require approval must be disabled,
deferred, or reported unsupported rather than silently allowed.

## Background facts (verified — current `custom<>` sites)

| Overlay | File:line | Notes |
|---|---|---|
| approval modal (Y/N/A) | `src/approval-modal.ts:265` | 3-way → must use `select` (not boolean `confirm`) |
| Q&A wizard | `src/answer-tool.ts:304` | multi-question |
| LLM extraction | `src/answer-tool.ts:338` | `complete()` nested in `custom()` — must be lifted out |
| question tool | `src/question-tool.ts:116` | blocks on user answer |
| divine query | `src/divine-query.ts:247` | used by `/ship`, `/slate`, command palette |
| command palette | `src/command-palette.ts:316` | |
| memory editor | `src/memory-editor.ts:399` | |
| theme check | `src/commands/theme-check.ts:21` | |

- An in-Pi `tool_call` handler returning `{block:true}` vetoes a tool **before**
  `tool_execution_start` (verified in Pi's agent loop). This is the supported veto mechanism.
- The host-side overlay renderers (e.g. `renderApprovalModal` in `src/approval-modal.ts`, the
  divine-query renderer in `src/divine-query.ts`) are pure string renderers and survive
  verbatim.
- The `extension_ui` responder built in Plan 003 is the back-channel for the value round-trip.
- `ctx.mode` is exposed to extensions (`'interactive'` | `'rpc'` | …) — branch on it.

## Scope

**In scope:** rewriting the approval gate for RPC; lifting `answer-tool.complete()` out of the
`custom()` closure; re-plumbing all 8 overlays to host-render + `extension_ui` value
round-trip; the security regression test.

**Out of scope:** changing overlay *visuals* (renderers are reused as-is); the editor
(Plan 004); the responder substrate (Plan 003, a dependency).

## Steps

1. **Approval gate (do this first — security).** Keep the gate as an in-Pi `tool_call`
   handler. For a command requiring approval, emit an `extension_ui_request` `select`
   (options: `No`/`Yes`/`Always`) and **return `{block:true}` unless the host's answer is an
   allowing choice**. The host renders the existing `renderApprovalModal` output via the
   modal layer and replies with the chosen value. Map: `No`/cancelled/timeout/malformed →
   stay blocked; `Yes` → allow once; `Always` → allow + persist per existing policy.
   - **Verify (MUST pass):** the security test (step 5) shows a dangerous command blocked on
     `No`/no-answer and allowed on `Yes`. Zero fail-open paths.

2. **Lift `answer-tool.complete()` out of the closure.** Extract the LLM-extraction logic at
   `src/answer-tool.ts:338` into a standalone function callable outside `custom()`. Branch on
   `ctx.mode === 'rpc'`: render the Q&A wizard host-side via `extension_ui` and run
   `complete()` server-side; in interactive mode, keep the existing `custom()` path.
   - **Verify:** a test asserts the LLM extraction actually fires over RPC and returns a
     non-empty result (regression against the silent-Cancel bug).

3. **question-tool.** Re-plumb `src/question-tool.ts:116` to render host-side and round-trip
   the typed answer via `extension_ui` (`select` for choice lists, `input` for free text).
   - **Verify:** asking a question over RPC surfaces the Cathedral question UI and returns the
     user's answer to the model (not "User cancelled.").

4. **Remaining overlays.** Re-plumb divine-query, command-palette, memory-editor, and
   theme-check the same way: host-render the existing renderer, round-trip the value. For
   `void`-returning overlays (memory-editor, theme-check) round-trip a completion/cancel
   signal.
   - **Verify:** `/ship`, `/slate`, the command palette, the memory editor, and theme-check
     all function over RPC and crop-match the patched build (`pnpm visual:ci`).

5. **Security regression test.** Add an integration test (and a standalone assertion) that
   spawns the RPC build, issues a dangerous command, answers `No`, and asserts the command did
   not execute (no file change / no `tool_execution_start`). Repeat with `Yes` → executes.
   Include unanswered/timeout → blocked.
   - **Verify:** the test is part of `pnpm test:integration` and fails loudly if the gate
     regresses to fail-open.

## Done criteria

- `pnpm exec tsc --noEmit && pnpm build` clean.
- `pnpm test` + `pnpm test:integration` green, **including the security regression test**.
- `pnpm visual:ci` green for all 8 overlays on the RPC runtime lane.
- A test asserts answer-tool's LLM extraction fires over RPC.
- Grep proves no `ctx.ui.custom` call in the RPC path resolves to a silent no-op without a
  host-rendered replacement.

## Escape hatches — STOP and report

- If a dangerous command can reach execution on any non-`Yes`/`Always` answer, STOP
  immediately — the gate is unsafe; do not mark this plan progressing.
- If the 3-way approval cannot be expressed via `select` round-trip at parity, STOP and record
  the gap — do not fall back to `confirm` (boolean loses the "Always" option).
- If an overlay needs richer interaction than the fixed `extension_ui` vocabulary supports,
  STOP and document it — this is the migration's biggest unknown and may need an upstream Pi
  request.

## Test plan

- Security regression test (above) — the most important test in the migration.
- answer-tool extraction-fires-over-RPC test.
- question-tool returns-answer test.
- Visual fixtures for all 8 overlays.

## Maintenance note

This is the workstream most likely to hide a fail-open regression in future refactors. Keep
the security regression test in the required gate and reference it in
`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`'s smoke matrix. Any future change to the approval flow
must re-run it. Document the host-render + `extension_ui` round-trip pattern as the canonical
replacement for `ctx.ui.custom()` so new overlays do not reintroduce the no-op trap.

## Execution review

**Status:** DONE — accepted in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`,
`573248c`), based on approved Plan 002 branch `codex/rpc-host-shell-002-exec`.

**Advisor verdict:** APPROVE after revision. The first reviewed stack was rejected because it
returned `yes` from `showApprovalModal()` in RPC mode and skipped the approval gate for
`ctx.mode === "rpc"`, recreating the exact fail-open caveat. The accepted revision installs
`installApprovalGate()` in the RPC child profile and normalizes every non-`Yes`/`Always`
approval outcome to blocked. `No`, cancel, timeout, malformed values, thrown prompt errors,
and missing UI all block dangerous bash.

The accepted revision also adds host-owned replacements for the bespoke custom-overlay
surfaces: command palette, theme check, memory editor, approval preview, model/thinking/
session/settings selectors, and answer/question/divine-query RPC branches through the
`extension_ui` back-channel or retained host overlays.

**Verification rerun by advisor:**

- Focused RPC/security/runtime suite — passed, 10 files / 96 tests.
- `pnpm exec tsc --noEmit && pnpm build` — passed.
- `pnpm test:integration` — passed, 20 files / 36 tests.
- `pnpm visual:ci` — exited 0; review pack produced in the worker worktree.
- `pnpm test` — all 119 files / 1112 tests passed, but Vitest exited 1 from the known
  unrelated background-task temp `output.log` ENOENT unhandled error.

**Scope review:** no `plans/` or `docs/` diffs were present in the accepted source branch.
The branch remained descended from `codex/rpc-host-shell-002-exec` and preserved
`src/sumo-tui/rpc/runtime.ts`.
