# Plan 031: Keybinding matrix — enumerate, verify, and gate

> **Executor instructions:** Base your worktree on the reviewed tip of plan
> 030's branch. Follow the steps; on a STOP condition, stop and report. Do
> not update `plans/README.md`.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** LOW (audit + tests; minimal production code)
- **Depends on:** 030 (this is its acceptance gate)
- **Category:** verification / UX parity
- **Planned at:** 2026-07-03

## Why this matters

"Keybindings are broken" has been reported repeatedly, fixed instance by
instance (Ctrl+/, Ctrl-C tiers, Kitty releases), and re-reported. The binding
surface is fully enumerable from code — so the honest fix is a complete
matrix: every binding, its expected effect, verified in both input encodings,
as a permanent PTY test suite. After this plan, "which keybindings work" is a
generated table, not anecdote, and every future input regression fails CI.

## Sources to enumerate (all of them — the matrix must be exhaustive)

1. pi-tui editor + TUI bindings: `TUI_KEYBINDINGS`, `getKeybindings()`,
   `KeybindingsManager` defaults (`@earendil-works/pi-tui`), and the editor
   component's key handling (cursor movement, word nav, home/end, delete
   variants, undo, multiline Shift+Enter, submit Enter, CSI-u Enter).
2. Pi interactive hotkeys that the RPC host re-implements or intentionally
   drops: extract the list Pi shows for `/hotkeys`
   (`node_modules/@earendil-works/pi-coding-agent/dist/` — grep the interactive
   mode's hotkey table) and mark each SUPPORTED / HOST-EQUIVALENT /
   INTENTIONALLY-DROPPED (dropped ones need a one-line rationale).
3. SumoCode host bindings: every `KeyRouter.bind` call site, the interception
   point (Ctrl-C tiers, Esc — plan 025), `chatScrollCommandFromInput`
   (PgUp/PgDn/Shift+↓), command palette (Ctrl+/ incl. `` and CSI-u
   variants), autocomplete keys (Tab, arrows, Esc dismiss).

## Deliverables

1. `docs/audit/KEYBINDING_MATRIX.md` — one row per binding:
   `binding | source | expected effect | plain-encoding test | kitty-encoding test | status`.
   Generated content must state the commit it was generated against.
2. `test/integration/keybinding-matrix.test.ts` — spec-driven: a table of
   `{keys, encodings, expect}` entries executed against `spawnSumocodePty`,
   asserting the visible effect (editor content, palette open, scroll
   position, draft cleared, …). Every matrix row that is testable in a PTY
   must have an entry; rows that are not PTY-testable are marked
   `MANUAL-CHECK` in the doc with a reason.
3. Kitty encoding helper: encode each keystroke the way Ghostty does with
   flags 1+2+4 (press + release CSI-u pairs; modifiers via `;<mods>` field) —
   a small shared helper in `test/integration/`, unit-tested against the
   examples in pi-tui `keys.js`.

## Scope

**In scope:** the two deliverables + the helper + fixes for SMALL bugs the
matrix surfaces (≤ ~10 lines each, in `src/sumo-tui/input/` or
`src/sumo-tui/rpc/host-actions.ts`, each with its matrix test flipping red →
green). **Anything larger: record the row as FAIL with evidence and move on —
do not refactor.**

**Out of scope:** new keybindings, palette design, editor internals, mouse.

## Steps

1. Enumerate (sources above) → draft matrix doc with expected effects.
   Where an expected effect is uncertain, determine it from main's code
   (`git show main:<file>`), or mark `VERIFY-ON-MAIN` — never guess.
2. Build the Kitty encoding helper + unit tests. Commit.
3. Implement the spec-driven PTY suite; run; record per-row status in the
   doc. Commit (tests + doc together).
4. Fix qualifying small bugs, one commit each, matrix row flipping green.
5. Full battery: `pnpm test:integration && pnpm exec tsc --noEmit && pnpm build`.

## Done criteria

- [ ] Matrix doc exists, states its commit, has zero rows with an empty
  status; every `FAIL` row has evidence (what was observed)
- [ ] PTY suite runs both encodings for every testable row and passes except
  documented FAILs
- [ ] All prior input/interrupt tests still pass
- [ ] Full battery green; only in-scope files touched

## STOP conditions

- A binding's expected effect cannot be determined from pi-tui, Pi, or main's
  code — list it for Dhruv instead of inventing behavior.
- More than ~5 rows need non-small fixes — stop and report the list; that is
  a planning signal, not executor work.

## Maintenance notes

- Re-run this suite on every Pi/pi-tui version bump (AGENTS.md bump
  checklist) — it IS the input-contract re-verification.
- New bindings land with a matrix row + suite entry in the same commit.
