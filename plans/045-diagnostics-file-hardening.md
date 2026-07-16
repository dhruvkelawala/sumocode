# Plan 045: Harden the opt-in diagnostics trace — owner-only file mode, leaner payloads

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/044-input-router-interrupt-fixes..HEAD -- src/sumo-tui/runtime/diagnostics.ts src/sumo-tui/input/selection.ts bin/sumocode.sh`
> Your base branch is `advisor/044-input-router-interrupt-fixes` (this plan
> stacks on plan 044 because both touch `shared-input-router.ts`'s file). On
> excerpt mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/044-input-router-interrupt-fixes.md
- **Category**: security (defensive maintenance of a debug facility)
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

The opt-in debug mode (`sumocode -d`) writes a JSONL trace to a predictable
world-readable location (`/tmp/sumocode-manual.jsonl`) using the process
umask. The trace intentionally includes low-level input events (this is the
documented DF-4 keybinding-debugging workflow and must keep working), and the
selection-copy path additionally logs an 80-char plaintext preview of whatever
text the user selected. Hardening goals: the file should be readable only by
its owner, and payloads that duplicate user content (the selection preview)
should be reduced to shape/length metadata. The debugging workflow itself is a
product feature — do not remove it.

## Current state

- `src/sumo-tui/runtime/diagnostics.ts:15-18, 42-49` — diagnostics are a no-op
  unless `SUMO_TUI_DIAG_FILE` is set; writes use `appendFileSync` with no
  explicit `mode`, so file creation inherits the umask.
- `src/sumo-tui/input/selection.ts:250`:

```ts
logDiagnostic("selection_copy_success", { chars: text.length, preview: text.slice(0, 80) });
```

  and `selection.ts:233-240` — `selection_finish` logs selection geometry
  (verify whether it includes text content; if it does, apply the same
  reduction).
- `src/sumo-tui/input/shared-input-router.ts:253-260` — the input trace event
  (`raw_key_input`) exists for the documented keybinding-debug workflow
  (AGENTS.md: "Run `sumocode -d .`, reproduce the broken key, then
  `sumocode diag`"). KEEP this event; this plan does not change router
  behavior (plan 044 owns that file's logic — avoid editing it at all if
  possible).
- `bin/sumocode.sh:349-352` — `-d` / `--diag-file` set `SUMO_TUI_DIAG_FILE`
  (default `/tmp/sumocode-manual.jsonl`) and clear the file at startup unless
  `--no-clear-diag`.
- `scripts/diag-summary.mjs` — the summarizer consumes event counts and
  shapes; it does not require the selection preview text.
- AGENTS.md documents the diagnostics contract: "Diagnostics must stay no-op
  unless `SUMO_TUI_DIAG_FILE` is set." That contract is unchanged here.
- Conventions: tabs, strict TS, colocated tests.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/runtime/diagnostics.test.ts src/sumo-tui/input/selection.test.ts` | all pass (create the diagnostics test file if absent) |
| Launcher smoke | `bash -n bin/sumocode.sh` | exit 0 (syntax) |

Full `pnpm test` currently exits 1 from a known unrelated flake — not a gate.

## Scope

**In scope**:
- `src/sumo-tui/runtime/diagnostics.ts` (+ its test file, create if absent)
- `src/sumo-tui/input/selection.ts`, `src/sumo-tui/input/selection.test.ts`
- `bin/sumocode.sh` (only the diag-file creation/clear lines)
- `DEV_LOOP.md` / `AGENTS.md` — ONLY if either documents the selection
  preview field (then update the sentence); otherwise leave both untouched.

**Out of scope**:
- `src/sumo-tui/input/shared-input-router.ts` — plan 044's file. The
  `raw_key_input` event stays as-is.
- The diag summarizer (`scripts/diag-summary.mjs`) unless a field it reads is
  renamed (prefer not renaming fields it reads).
- Any default-path rename (`/tmp/sumocode-manual.jsonl` is documented in
  AGENTS.md/DEV_LOOP.md and the `diag` subcommand; keep it).

## Git workflow

- Branch: `advisor/045-diagnostics-file-hardening` off
  `advisor/044-input-router-interrupt-fixes`
- Conventional commits (`fix(diagnostics): ...`). Do NOT push.

## Steps

### Step 1: Owner-only file mode at creation

In `diagnostics.ts`, ensure the trace file is created with mode `0o600`:
open once with `openSync(path, "a", 0o600)` (or `appendFileSync(path, line,
{ mode: 0o600 })` — note `mode` only applies at creation) and keep appending
via the retained fd or per-call append; preserve the existing no-op-without-
env-var behavior and never throw (wrap in try/catch consistent with the
current writer). In `bin/sumocode.sh`, where the launcher clears/creates the
diag file at startup, create it with `umask 177` in a subshell or
`install -m 600 /dev/null "$file"`-equivalent using portable bash 3.2
constructs (macOS default bash) — match the file's existing style.

**Verify**: new `diagnostics.test.ts` case — set `SUMO_TUI_DIAG_FILE` to a
temp path, emit one event, `statSync(path).mode & 0o777` equals `0o600`
(guard with `process.platform !== "win32"`).

### Step 2: Reduce the selection-copy payload to metadata

In `selection.ts:250`, drop the `preview` field; keep `chars`. If
`selection_finish` (:233-240) carries any selected text content, reduce it the
same way (geometry and counts are fine).

**Verify**: `pnpm vitest run src/sumo-tui/input/selection.test.ts` — update or
add a test asserting the `selection_copy_success` payload contains `chars`
and does NOT contain `preview`.

### Step 3: Keep the summarizer and docs coherent

Run `node scripts/diag-summary.mjs` against a small fixture trace produced by
the tests (or construct one) to confirm it still summarizes without the
removed field. Grep `DEV_LOOP.md`/`AGENTS.md` for `preview` in the diagnostics
sections; update only if a sentence names the removed field.

**Verify**: `node scripts/diag-summary.mjs <fixture>` exits 0 and prints a
summary.

## Test plan

- diagnostics.test.ts (new): mode-0600 creation; no-op when env unset
  (pin the AGENTS.md contract).
- selection.test.ts: payload shape assertion (chars yes, preview no).
- Pattern: nearest existing tests in `src/sumo-tui/input/` and
  `src/sumo-tui/runtime/`.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0
- [ ] `grep -n "preview" src/sumo-tui/input/selection.ts` → no matches
- [ ] Mode test asserts `0o600`
- [ ] `bash -n bin/sumocode.sh` exits 0
- [ ] `git status` — only in-scope files changed (NOT shared-input-router.ts)

## STOP conditions

- The diagnostics writer is constructed somewhere that makes an fd-based
  approach leak across tests (report; per-call append with `mode` is the
  fallback).
- `scripts/diag-summary.mjs` reads the removed field (then coordinate: keep
  the field name but empty? NO — report instead).
- Any needed change lands in `shared-input-router.ts`.

## Maintenance notes

- Future diagnostic events should log shape/length metadata for user content,
  not content itself; the input-byte trace exists specifically for the
  keybinding workflow and is the deliberate exception.
- Reviewer: confirm the launcher still clears the file on start (the
  `--no-clear-diag` path untouched) and `sumocode diag` still works.
