# Typecheck baseline and budget

Recorded 2026-09-05 at the Effect campaign base (stack tip `99b8cc4d` plus Plan 118 docs), Apple M4
Mac mini, TypeScript 6.0.3, `skipLibCheck: true`. Raw numbers live in
[`typecheck.json`](typecheck.json) and are enforced by `scripts/check-tsc-budget.mjs`.

| Run | Instantiations | Check time | Total time |
|---|---:|---:|---:|
| Full pass (`--incremental false`, the CI gate) | 1,353,836 | 2.93 s | 4.18 s |
| Incremental, no source change | 0 (skipped) | — | 0.80 s |
| Incremental, one file touched | partial | 0.08 s | 0.95 s |

## Why two modes

- `tsconfig.json` enables `incremental` with the build info under `.local/tsc/` (git-ignored) so the
  local `pnpm typecheck` / `pnpm build` loop drops from ~4 s to ~1 s.
- CI runs `node scripts/check-tsc-budget.mjs`, which forces a full pass because an incremental run only
  reports the files it re-checked and its instantiation count is not comparable to the baseline.

## Budget

The script fails when `Instantiations` exceeds `budgetFactor` (2x) times the recorded baseline. Effect
is type-heavy; Track D measured its cost as a fixed ~258 ms plus ~1.3 ms per additional Effect-heavy
file, so a 2x jump signals a real change (a wide `Layer` composition or generic helper), not the
dependency itself. Re-record with `node scripts/check-tsc-budget.mjs --record` in the same PR that
causes an intended jump, and say why in the PR body.
