# Plan 040: Make `pnpm test` exit 0 so the unit gate is trustworthy again

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP updating `plans/README.md` — your reviewer
> maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/background-tasks/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

`pnpm test` currently reports 129/129 test files passing and then exits 1.
CI's required "Unit tests" step runs `pnpm test` directly
(`.github/workflows/ci.yml`, step "Unit tests: run: pnpm test"), so the
repo's one-command unit gate is red-by-default: a genuinely new failure is
indistinguishable from the accepted caveat, and multiple executor reports
have already normalized "all tests passed, but Vitest exited 1" as an
expected result. Fixing this restores a binary green/red signal for every
subsequent plan in this batch.

## Current state

The failure is an asynchronous timer write after test teardown, not a failing
assertion. Reproduced 2026-07-07 on a clean run:

```
Error: ENOENT: no such file or directory, open '/var/folders/.../sumocode-bg-test-E6useU/sumocode-bg/bg-.../output.log'
 ❯ writeFileSync node:fs:2411:35
 ❯ appendLogLine src/background-tasks/task-manager.ts:199:2
 ❯ Timeout._onTimeout src/background-tasks/task-manager.ts:882:5
The latest test that might've caused the error is
"keeps started agent task running when no exit marker appears after the old watchdog window"
Test Files  129 passed (129)   → exit code 1
```

Relevant code:

- `src/background-tasks/task-manager.ts:198-200`:

```ts
function appendLogLine(logFile: string, line: string): void {
	writeFileSync(logFile, line, { flag: "a" });
}
```

- `src/background-tasks/task-manager.ts:856-892` — `armResponseWatcher` starts
  a `setInterval` (`task.responseTimer`, unref'd at :889-891) whose callbacks
  call `appendLogLine(task.logFile, ...)` at :874-877 and :882-885. When the
  test's temp directory is removed while the interval is still armed, the next
  tick throws ENOENT from inside a timer, which Vitest records as an unhandled
  error after all assertions passed → process exit 1.
- File philosophy (this matters for the fix): the sibling helpers already
  swallow filesystem errors deliberately. `truncateLogIfOverCap`
  (`task-manager.ts:189-196`) wraps its work in `try { ... } catch { /*
  best-effort; logging must never interrupt task lifecycle */ }`, and
  `readLogTail` (`:211+`) catches too. `appendLogLine` is the only logging
  helper that can throw.

Conventions: TypeScript strict, tabs for indentation, tests colocated
(`task-manager.test.ts` sits next to `task-manager.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted test | `pnpm vitest run src/background-tasks/task-manager.test.ts` | all pass, exit 0 |
| Full unit gate | `pnpm test` | **exit 0** (this is the deliverable) |

## Scope

**In scope** (the only files you may modify):
- `src/background-tasks/task-manager.ts` — `appendLogLine` only
- `src/background-tasks/task-manager.test.ts` — teardown for the watchdog tests only

**Out of scope** (do NOT touch):
- Watchdog/poll semantics (`armResponseWatcher`, `finalizeTask`, intervals,
  deadlines) — behavior must not change.
- Any other test file, any `src/sumo-tui/**` file.

## Git workflow

- Branch: `advisor/040-fix-unit-test-exit-gate` (created off `86e5062` by your dispatch instructions)
- Commit style: conventional, e.g. `fix(background-tasks): stop post-teardown log writes from failing the unit gate`
- Do NOT push.

## Steps

### Step 1: Make `appendLogLine` best-effort, matching the file's stated philosophy

Wrap the `writeFileSync` in `try { ... } catch { /* best-effort; logging must
never interrupt task lifecycle */ }` — the exact contract the neighboring
`truncateLogIfOverCap` comment already states. Keep the signature unchanged.

**Verify**: `pnpm exec tsc --noEmit` → exit 0

### Step 2: Clear armed timers in the watchdog tests' teardown

In `src/background-tasks/task-manager.test.ts`, find the test named
"keeps started agent task running when no exit marker appears after the old
watchdog window" and its sibling watchdog tests. Inspect how the manager under
test is created and whether an existing disposal API exists (search the class
for `dispose`, `stop`, `clearInterval`, `responseTimer`). If a disposal/stop
API exists, call it in `afterEach`/test teardown so no interval outlives the
temp dir. If none exists, rely on Step 1 alone and note it in your report —
do NOT add new public API to `TaskManager` for this.

**Verify**: `pnpm vitest run src/background-tasks/task-manager.test.ts` → all pass, exit 0

### Step 3: Prove the gate

Run the full unit suite twice (the failure was timing-dependent).

**Verify**: `pnpm test` → exit 0, both runs

## Test plan

No new test files. The deliverable is the exit code of the existing suite.
Do not weaken or delete any existing assertion in `task-manager.test.ts`.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/background-tasks/task-manager.test.ts` exits 0
- [ ] `pnpm test` exits 0 on two consecutive runs
- [ ] `git status` shows changes only in the two in-scope files
- [ ] No existing assertion removed or weakened

## STOP conditions

- The ENOENT reproduces from a call site other than `appendLogLine`
  (a different helper throwing means the diagnosis is incomplete).
- Fixing the exit code appears to require changing watchdog semantics or
  adding public API to `TaskManager`.
- `pnpm test` still exits nonzero after Steps 1–2 for a reason unrelated to
  this ENOENT (report the new failure verbatim; do not chase it).

## Maintenance notes

- If a new logging helper is added to task-manager, it must follow the same
  best-effort contract; a throwing logger inside a timer is exactly this bug.
- Reviewer should scrutinize: no assertion weakened; the catch is empty-with-
  comment, not error-swallowing logic that hides real task failures elsewhere.
