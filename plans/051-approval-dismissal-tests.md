# Plan 051: End-to-end tests that every approval-prompt dismissal resolves to deny

> **Executor instructions**: You are a test author. Follow this plan step by
> step; run every verification command. If a STOP condition occurs, stop and
> report. SKIP updating `plans/README.md` — your reviewer maintains the index.
> This plan is TEST-ONLY: do not modify production source. If a test reveals
> the deny contract is NOT upheld on some path, pin the current behavior and
> flag it prominently in your report — do not change the source.
>
> **Drift check (run first)**: `git diff --stat advisor/046-extension-ui-protocol-hardening..HEAD -- src/sumo-tui/rpc/extension-ui-responder.ts src/sumo-tui/rpc/host-overlays.ts src/sumo-tui/rpc/host.ts`
> Your base branch is `advisor/046-extension-ui-protocol-hardening` (it adds
> `overlays.drain()`, which one test below asserts). On excerpt mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (guards a safety-critical contract)
- **Depends on**: plans/046-extension-ui-protocol-hardening.md
- **Category**: tests
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

The approval gate's contract is: only an explicit Yes/Always permits a
dangerous command; every other outcome — No, cancel, timeout, the overlay
being displaced, the child exiting while a prompt is open — must resolve to
deny. The gate LOGIC was re-verified sound during audit, but the coverage is
Yes/No happy-path plus overlay/router mechanics tested in ISOLATION. The
composed dismissal paths the audit called out have no end-to-end test, so a
future refactor could turn a dismissal into a non-deny (or a hang) with
nothing failing. This plan encodes the deny contract as executable tests.

## Current state

- `src/sumo-tui/rpc/extension-ui-responder.ts:215-241` — approval select:
  `approvalOverlay.show()`, choice mapped via `approvalOption()`, `catch` →
  `"No"`, timeout closes with `"no"`. This is the resolution surface.
- `src/approval-modal.ts:258-263` — `normalizeApprovalChoice` maps
  malformed/missing/unknown → `"no"`; `:442-455` — the gate returns
  `blockDenied()` for anything but normalized yes/always, `blockUnavailable()`
  when UI is missing.
- `src/sumo-tui/rpc/host-overlays.ts` — `close(value?)` resolves active +
  promotes queue; `drain(value?)` (added by plan 046) resolves active + all
  queued WITHOUT promotion. The responder maps a resolved `undefined` to a
  deny.
- `src/sumo-tui/rpc/host.ts` — the child-exit handler (wired ~:752-766) now
  calls `overlays.drain()` during teardown (plan 046).
- Existing tests: `src/sumo-tui/rpc/extension-ui-responder.test.ts:~334-374`
  (Yes/No + sanitization), `src/sumo-tui/rpc/host-overlays.test.ts`
  (queue/close), `src/sumo-tui/rpc/host.test.ts:~416-429` (child exit closes
  overlays — asserts closure, not the pending approval's resolved VALUE).
- Conventions: tabs, strict TS, fake RPC client + fake overlay host patterns
  already present in these files.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/host-overlays.test.ts src/sumo-tui/rpc/host.test.ts src/approval-modal.test.ts` | all pass |

## Scope

**In scope**:
- `src/sumo-tui/rpc/extension-ui-responder.test.ts`,
  `src/sumo-tui/rpc/host.test.ts` (add cases only)
- Optionally a new `src/approval-modal.test.ts` case if the composed
  responder→gate mapping is best asserted there

**Out of scope**:
- ALL production source (test-only plan).
- Approval OPTION rendering/labels.

## Git workflow

- Branch: `advisor/051-approval-dismissal-tests` off
  `advisor/046-extension-ui-protocol-hardening`
- Commit style: `test(rpc): ...`. Do NOT push.

## Steps

### Step 1: Encode the deny contract as a shared helper in the test file

Add a small test helper asserting "this responder outcome denies" — i.e. the
outbound `extension_ui_response` for the approval request is a value the
approval gate's `normalizeApprovalChoice` maps to `"no"` (or `cancelled`
which the gate also treats as deny). Reference the real mapping in
`src/approval-modal.ts` so the test breaks if the mapping changes.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts` → passes.

### Step 2: Cover each dismissal path (one `it` each)

1. **Timeout**: approval overlay times out → response denies.
2. **Overlay close with undefined**: `overlay.close(undefined)` while an
   approval is active → the approval response denies.
3. **Displacement**: an approval is active; another `show()` is requested
   (queued, per plan 046 — it must NOT resolve the approval); when the
   approval is later dismissed it denies, and the queued overlay never forced
   the approval to a non-deny.
4. **Child exit mid-prompt**: with a pending approval, the child-exit handler
   runs `overlays.drain()` → the pending approval's promise settles to a deny
   (assert the resolved value the responder sends, not just that the overlay
   closed). Extend the existing host.test.ts child-exit test.
5. **Thrown UI**: the overlay `create`/handler throws → response denies
   (the `catch → "No"` path).

**Verify**: all four targeted test files exit 0; each new `it` has a name
that states the path and the expected deny.

## Test plan

This plan IS the test plan. Every case asserts the OUTBOUND response value's
deny-equivalence, not merely that a modal closed. No production edits.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] All targeted test files exit 0
- [ ] Five dismissal-path tests exist (timeout, close-undefined, displacement,
      child-exit-drain, thrown-UI), each asserting deny-equivalence
- [ ] `git status` — only test files changed
- [ ] Any path found NOT to deny is flagged in the report (not silently pinned)

## STOP conditions

- Any dismissal path resolves to something the gate does NOT treat as deny —
  STOP and report loudly (this is a security finding, not a test to quietly
  pin).
- `overlays.drain()` is absent (plan 046 not in the base branch) — STOP;
  wrong base.

## Maintenance notes

- These tests are the guardrail for the fail-closed contract; any future
  change to overlay/responder resolution must keep them green.
- Reviewer: confirm each test asserts the RESPONSE value, and that the
  deny-equivalence helper references the real `normalizeApprovalChoice`.
