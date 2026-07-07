# Plan 032: Demote the stale Bible; regenerate it from approved captures

> **Executor instructions:** Phase 1 only — Phase 2 is a design/spike step
> gated on Dhruv promoting goldens after plan 024 approval. Base your
> worktree on the Track D integration branch (plan 033). On a STOP condition,
> stop and report. Do not update `plans/README.md`.

## Status

- **Priority:** P1
- **Effort:** S (Phase 1) + M spike (Phase 2, gated)
- **Risk:** MED (touches CI gating semantics)
- **Depends on:** 028 (drift fixes), 033 (integration branch); Phase 2 also on
  024 approval + golden promotion by Dhruv
- **Category:** verification / docs
- **Planned at:** 2026-07-03
- **Decision context:** Dhruv delegated direction decisions 2026-07-03. The
  Bible is stale (does not reflect current `main`), and a stale spec that
  gates CI green-lights drift from the real product. Decision: for parity
  work, `main` captures (018 comparator) and approved goldens are the only
  gating authorities; the Bible becomes review evidence until it is
  regenerated FROM approved captures — a build artifact of the approved
  product, not a hand-maintained parallel truth.

## Phase 1 — demote (executable now)

### Current gating semantics to change

`scripts/visual-v2/index.mjs` `cropResult()` (~lines 203-217): a `required`
crop **without** an approved golden gates against the Bible target
(`return biblePassed ? "passed" : "failed"`). With a stale Bible this fails
correct output and passes drifted output.

### Steps

1. In `cropResult()`: required crops without goldens now gate against the
   **main-baseline comparison** when a baseline root is supplied (the
   plan-018 `visual:compare` machinery), and report Bible drift as
   `review-diff` (evidence, never `failed`). Required crops WITH approved
   goldens keep gating on goldens (unchanged). Component-lane crops with
   goldens: unchanged.
2. Update `docs/visual/parity/CONTRACT.md`: the authority ladder is now
   `approved goldens > main-baseline comparison > (Bible = review evidence
   only, pending regeneration)`. Mark the Bible sections accordingly; do not
   delete them.
3. Update `src/visual-parity-contract.test.ts` assertions that encode the old
   ladder. The 026/027 contract-validation machinery (scenario contracts,
   determinism checks) is untouched — it validates capture integrity, not
   Bible authority.
4. Verify: `pnpm visual:ci` (must still gate — via goldens/baseline, not
   Bible), `pnpm vitest run src/visual-parity-contract.test.ts`,
   `pnpm exec tsc --noEmit && pnpm build`.

### Scope (Phase 1)

**In:** `scripts/visual-v2/index.mjs`, `docs/visual/parity/CONTRACT.md`,
`src/visual-parity-contract.test.ts`.
**Out:** Bible HTML files, `render:bible`, thresholds, crop definitions,
goldens, scenario contracts.

## Phase 2 — regenerate (spike; DO NOT build until goldens are promoted)

Design a `bible:regenerate` flow: promoted golden captures (terminal-snapshot
JSON) → Bible HTML `<pre class="grid">` markup (the exact format
`styled-cell-grid.mjs` parses — the regeneration is that parser's inverse).
Deliverable of the spike: a one-page design note in
`docs/visual/parity/BIBLE_REGENERATION.md` covering: which scenarios get
regenerated pages, how hand-authored annotation sections survive
regeneration, and how CI detects a Bible page older than its golden. STOP
after the note — building it is a follow-up plan Dhruv approves.

## Done criteria (Phase 1)

- [ ] A required runtime crop with stale-Bible mismatch but main-baseline
  match reports `passed` + `review-diff` evidence (add a unit test in the
  visual scripts' test coverage or contract test proving the ladder)
- [ ] `pnpm visual:ci` still exits 1 on a golden/baseline violation
  (prove with a deliberate temporary mutation in a test, not by hand-waving)
- [ ] CONTRACT.md documents the new ladder
- [ ] Full battery green; only in-scope files touched

## STOP conditions

- The ladder change cannot be expressed without weakening golden gating.
- `visual:ci` has consumers that pass no baseline root and would lose all
  gating for un-promoted required crops — report; do not silently drop gates.

## Maintenance notes

- After Phase 2 ships, `render:bible` should refuse to hand-render scenarios
  that have regeneration sources, so the two paths cannot diverge again.
