# Plan 105: Stop rerunning unit tests in the integration lane

> **Executor instructions**: Follow this plan step by step and run every verification command. Change Vitest selection only. Prove unit and integration commands are disjoint and complete. Do not increase parallelism for PTY tests. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- vitest.config.ts package.json .github/workflows/ci.yml scripts/vitest-lane-selection.test.mjs`
> If this reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/399

## Why this matters

CI runs `pnpm test` and then `pnpm test:integration` in separate jobs. When integration paths appear in argv, `vitest.config.ts` includes all source/script unit tests plus integration tests, so the second job repeats the full unit suite serially under `--fileParallelism=false`. This wastes CI time and compounds unrelated test failures.

## Current state

`vitest.config.ts` currently selects:

```ts
include: includeIntegration
  ? ["src/**/*.test.ts", "scripts/**/*.test.mjs", "test/integration/**/*.test.ts"]
  : ["src/**/*.test.ts", "scripts/**/*.test.mjs"]
```

`package.json` defines `test:integration` as `vitest run test/integration/ --fileParallelism=false`. `.github/workflows/ci.yml` already runs unit and integration commands in separate jobs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Unit list | `pnpm vitest list` | only src/scripts tests |
| Integration list | `pnpm vitest list test/integration/ --fileParallelism=false` | only test/integration tests |
| Suites | `pnpm test && pnpm test:integration` | both pass |
| Required | `pnpm exec tsc --noEmit && pnpm build && pnpm lint` | exit 0 |

## Scope

**In scope**:
- `vitest.config.ts`
- `package.json` only if a dedicated config/script is clearer.
- `scripts/vitest-lane-selection.test.mjs` (create) as the machine-checkable inventory regression.

**Out of scope**:
- PTY parallelism or sharding.
- Test isolation fixes (Plans 091–092).
- Removing any test from both lanes.
- Changing CI continue-on-error/timeouts.

## Git workflow

- Branch: `advisor/105-integration-only-lane`
- Commit: `test: keep integration lane integration-only`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Pin test inventory

Create `scripts/vitest-lane-selection.test.mjs`. It must spawn the same two list commands used by package scripts, normalize repository-relative test paths, and assert: unit has only `src/**/*.test.ts` plus `scripts/**/*.test.mjs`; integration has only `test/integration/**/*.test.ts`; intersection is empty; and the union equals a filesystem walk of those three intended globs. Include a targeted integration-file and targeted unit-file invocation case.

Write the regression test before changing selection. Under the current config its integration-only assertion is expected to fail and print at least one duplicated `src/` or `scripts/` path; record that red result in execution notes, then make Step 2 green.

**Verify**: `pnpm vitest run scripts/vitest-lane-selection.test.mjs` → before Step 2, fails specifically on duplicated non-integration paths (expected red); no parse/spawn error is acceptable.

### Step 2: Select integration paths only

Simplify config so an explicit `test/integration/` invocation includes only integration files. Prefer separate Vitest projects/configs if argv sniffing remains ambiguous; keep the smallest clear solution.

Preserve `--fileParallelism=false` for PTY safety.

**Verify**: `pnpm vitest run scripts/vitest-lane-selection.test.mjs` → pass; its captured integration set contains zero `src/`/`scripts/` paths, unit contains zero `test/integration/` paths, intersection is empty, and union equals the filesystem inventory.

### Step 3: Run both lanes

Record durations as evidence only. Confirm CI commands require no workflow change unless a new config path is introduced.

**Verify**: all command-table commands pass.

## Test plan

Test default unit invocation, explicit integration directory, a targeted integration file, and a targeted unit file. Ensure script `.test.mjs` files remain in unit coverage.

## Done criteria

- [ ] Unit and integration inventories are disjoint.
- [ ] Their union retains all intended test files.
- [ ] Integration lane remains serial.
- [ ] `pnpm vitest run scripts/vitest-lane-selection.test.mjs` proves disjointness and complete union.
- [ ] Both suites and required gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 105's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Vitest CLI selection cannot be made deterministic without dropping targeted-file workflows.
- Any test disappears from both inventories.
- The change requires parallelizing PTY tests.

## Maintenance notes

When new top-level test directories are added, update the inventory assertion so CI ownership stays explicit.
