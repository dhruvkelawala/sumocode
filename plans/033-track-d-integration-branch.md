# Plan 033: One integration branch, always runnable

> **Executor instructions:** Pure git + verification work — no source edits.
> Work in a dedicated worktree. On any merge conflict you cannot resolve
> trivially (identical-intent changes), STOP and report the conflicting
> hunks. Do not update `plans/README.md`.

## Status

- **Priority:** P0
- **Effort:** S
- **Risk:** LOW
- **Depends on:** reviewed/approved tips of 028 and 029
- **Category:** dx / integration
- **Planned at:** 2026-07-03
- **Decision context:** Dhruv delegated direction decisions 2026-07-03. A
  large part of the "everything is broken" experience was integration debt:
  eight stacked, unmerged executor branches while the checkout Dhruv actually
  ran contained none of the fixes. Standing rule from now on: every approved
  plan merges into ONE integration branch immediately, and that branch is
  what Dhruv runs.

## Steps

1. Create `integrate/track-d` from `7d213e9`
   (`codex/plan024-real-runtime-ui-parity-rerun-20260703-092057` — already
   contains 019–023, 025–027).
2. Merge the approved tip of `codex/plan029-kitty-release-filter`. Expected
   clean (based on `7d213e9`).
3. Merge the approved tip of `codex/plan028-close-visual-drift`. Expected
   clean or trivially resolvable (disjoint scopes: input vs shell/chrome).
4. Full battery on the merged result:
   `pnpm exec tsc --noEmit && pnpm build && pnpm test:integration` plus
   `pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-scroll.test.ts test/integration/rpc-kitty-release.test.ts`
   and `pnpm visual:review -- --lane runtime`. A failure that did not exist
   on either parent is an integration regression — STOP and report.
5. Report the branch name + tip SHA so Dhruv can `git checkout integrate/track-d`.

## Standing rule (record in your report; reviewer adds it to the index)

- Future plans (030, 031, 032, …) base their worktrees on
  `integrate/track-d` and merge back on approval.
- `codex/rpc-migration-no-seam` and Dhruv's working tree are never touched;
  Dhruv decides if/when `integrate/track-d` replaces it.

## Done criteria

- [ ] `integrate/track-d` exists, contains 7d213e9 + 028 + 029 tips
  (`git merge-base --is-ancestor <tip> integrate/track-d` for each)
- [ ] Full battery green on the branch
- [ ] No source files modified by hand (`git log --stat` shows merges only)

## STOP conditions

- Non-trivial merge conflict (report hunks).
- Post-merge test failure absent on both parents.
