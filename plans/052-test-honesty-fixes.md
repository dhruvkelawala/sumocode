# Plan 052: Make the slash-command invariant non-tautological and de-flake new PTY tests

> **Executor instructions**: You are a test author. Follow this plan step by
> step; run every verification command. If a STOP condition occurs, stop and
> report. SKIP updating `plans/README.md` — your reviewer maintains the index.
> Test-only, with ONE small permitted production seam (Step 1) if and only if
> a genuine dead-advertised command is found; otherwise no production edits.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/rpc/editor.ts src/sumo-tui/rpc/host-actions.ts test/integration/`
> On excerpt mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Two test-quality gaps:

1. The "advertises only host-implemented or child-executable slash commands"
   test derives its predicate from the SAME list it validates
   (`isRpcHostSlashCommandName` and the advertised list both come from
   `RPC_HOST_SLASH_COMMANDS`), so a host command added to the advertised list
   with NO dispatch handler still passes. It cannot catch the regression it's
   named for (a `/login`-style dead advertisement).
2. Several new RPC PTY integration tests assert after fixed wall-clock sleeps
   (`delay(300)`, `delay(1_200)`) instead of readiness predicates — on loaded
   CI the sleeps can be too short, and they can mask ordering bugs by waiting
   past intermediate states. This compounds the already-accepted PTY
   concurrency flake.

## Current state

- `src/sumo-tui/rpc/editor.test.ts:342-361` — the tautological invariant:
  `expect(isRpcHostSlashCommandName(command.name) || childNames.has(command.name)).toBe(true)`.
- `src/sumo-tui/rpc/editor.ts:85-93` — `buildRpcAutocompleteCommands`
  advertises every `RPC_HOST_SLASH_COMMANDS` entry then merges child commands.
- `src/sumo-tui/rpc/host-actions.ts:108-137` — `RPC_HOST_SLASH_COMMANDS` and
  `isRpcHostSlashCommandName` (both from the same const); the real dispatch is
  `handleSubmittedText` (the big `switch` around :449+).
- PTY sleep sites (verified 2026-07-07):
  - `test/integration/rpc-ctrl-c.test.ts:60` → `delay(300)`
  - `test/integration/rpc-mouse-drag-select.test.ts:89,91,93` → `delay(50/50/300)`
  - `test/integration/rpc-mouse-scroll.test.ts:89` → `delay(300)`
  - `test/integration/rpc-scroll-during-stream.test.ts:96,110,129` → `delay(200/1_200/300)`
- PTY harness + helpers: `test/integration/spawn-pi-pty.ts`,
  `test/integration/rpc-child-fixture.ts`. Look for an existing
  wait-for-screen/poll helper before writing one.
- Conventions: tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Editor unit test | `pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |
| PTY integration | `pnpm test:integration` | the touched specs pass (see note) |

Note: `pnpm test:integration` has a documented concurrency flake in FULL
runs; run the specific specs you changed to judge them
(`pnpm vitest run test/integration/rpc-ctrl-c.test.ts` etc.) and report both.

## Scope

**In scope**:
- `src/sumo-tui/rpc/editor.test.ts` (rewrite the invariant test)
- `test/integration/rpc-ctrl-c.test.ts`, `rpc-mouse-drag-select.test.ts`,
  `rpc-mouse-scroll.test.ts`, `rpc-scroll-during-stream.test.ts`
- `test/integration/spawn-pi-pty.ts` / `rpc-child-fixture.ts` — ONLY to add a
  shared wait-for-predicate helper if none exists
- `src/sumo-tui/rpc/host-actions.ts` — ONLY if Step 1 finds a genuinely
  dead-advertised command (add its handler or remove it from the advertised
  list); otherwise DO NOT touch

**Out of scope**:
- Product behavior of any slash command.
- The accepted full-suite PTY concurrency flake (do not attempt to fix it
  here).

## Git workflow

- Branch: `advisor/052-test-honesty-fixes`
- Commit style: `test(rpc): ...` / `fix(rpc): ...` (only if a handler is added).
  Do NOT push.

## Steps

### Step 1: Real dispatch invariant

Rewrite the editor.test.ts invariant to drive each advertised HOST command
through the real dispatcher. Construct `RpcHostActions` with fakes (pattern in
`host-actions.test.ts`) and assert every `RPC_HOST_SLASH_COMMANDS` entry,
when submitted as `"/" + name`, is either handled (dispatch returns handled /
performs a fake control call / notifies) OR deliberately routes to a
"blocked"/notify branch — NOT silently unhandled. Keep the child-merge
assertions but rename them so they no longer claim to prove host
implementation.

If a command is advertised with no handler and no deliberate blocked-notify:
that is a real defect — add the minimal handler if it's a trivial
notify-blocked case, otherwise remove it from the advertised list; document
the choice in the report.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts` → pass; the new test FAILS if you temporarily add a fake advertised command with no handler (prove it, then remove the probe).

### Step 2: Add a wait-for-screen predicate helper

If no polling helper exists, add `waitForScreen(pty, predicate, { timeoutMs })`
to the PTY test support: polls the replayed xterm screen until `predicate`
holds for two consecutive polls or times out (throwing a named error). Model
it on the existing capture/replay in `spawn-pi-pty.ts`.

**Verify**: helper compiles; one spec converted uses it.

### Step 3: Replace fixed sleeps with predicates

In each of the four specs, replace `delay(...)` assertions with
`waitForScreen(...)` on the actual observable condition (prompt echoed,
chunk N visible, clipboard sequence emitted, scrolled row present). For
`rpc-scroll-during-stream`, if a mid-stream off-screen state genuinely has no
observable predicate, keep a MINIMAL bounded wait but add a comment naming why
and prefer a fixture sentinel event if `rpc-child-fixture.ts` can emit one.

**Verify**: `pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-drag-select.test.ts test/integration/rpc-mouse-scroll.test.ts test/integration/rpc-scroll-during-stream.test.ts` → pass (report any residual bounded waits and why).

## Test plan

Rewrite one existing unit test (Step 1) and harden four integration specs
(Steps 2–3). No new product tests beyond the invariant. Patterns from the
existing specs.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts` exits 0
- [ ] The invariant test provably fails on a dead-advertised probe command
      (demonstrated, then probe removed)
- [ ] The four PTY specs pass individually; remaining fixed waits are
      documented with rationale
- [ ] `git status` — only in-scope files changed; host-actions.ts touched only
      if a real dead command was found (report says which)

## STOP conditions

- Step 1 uncovers MANY advertised commands with no handler (>2) — report the
  list before editing product code; that is a design question, not a test fix.
- The PTY harness cannot expose a screen predicate without a real Pi
  round-trip that the fixture can't script — keep bounded waits, report.

## Maintenance notes

- The invariant is now behavioral; adding a slash command without a handler
  will fail it — that is the point.
- Reviewer: confirm the invariant drives the REAL dispatcher, and that
  converted specs assert on observable screen state, not elapsed time.
