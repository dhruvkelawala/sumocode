# Plan 091: Isolate extension-install tests from real Pi durable state

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. Stop on any STOP condition; do not improvise. When done, update this plan's row in `plans/README.md` unless a reviewer says they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- src/extension.test.ts src/extension.ts src/background-tasks/task-store.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- src/extension.test.ts`. If this reports pre-existing work, STOP and preserve it.
> If these files changed, compare the excerpts below with live code before proceeding.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Milestone**: M1 — Command-ready foundation
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/385
- **Execution status**: DONE — implemented in `6ef8c13`; focused isolation 1/1, extension file 29/29 twice (1.57s and 1.44s), and full unit suite 2,514/2,514 with typecheck/build/lint green

## Why this matters

`src/extension.test.ts` installs the complete extension many times. Each install constructs `TerminalTaskStore` at the default `~/.pi/agent/state/sumocode-terminals`, so a developer's historical terminal records determine test runtime and failures. In the audited checkout, the targeted file took 32.8s and failed against the live store but passed all 28 tests in 2.84s with an isolated `PI_CODING_AGENT_DIR`. Tests must never inspect or mutate user state.

## Current state

- `src/extension.test.ts:32-59` defines/scrubs SumoCode environment keys, but `PI_CODING_AGENT_DIR` is absent.
- Full-install tests call `sumocode(pi)` at `extension.test.ts:346,416,436,465,479,500,531,538,547,560`, constructing orchestration state each time.
- `src/extension.ts:212-218` calls `installBackgroundTasks(pi)` through `installOrchestrationTools`.
- `src/background-tasks/task-store.ts:278-280` derives the default store root from `PI_CODING_AGENT_DIR` or the user's home directory:

```ts
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
return join(agentDir, "state", "sumocode-terminals");
```

Match the existing test convention: temporary paths use `mkdtempSync(join(tmpdir(), ...))` and are removed with `rmSync(..., { recursive: true, force: true })` in cleanup.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Targeted test | `pnpm vitest run src/extension.test.ts` | all tests pass |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit suite | `pnpm test` | exit 0 |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope**:
- `src/extension.test.ts`

**Out of scope**:
- Production store-root behavior in `src/background-tasks/task-store.ts`.
- Deleting, migrating, or reading the real terminal store.
- Global Vitest environment changes.

## Git workflow

- Branch: `advisor/091-isolate-extension-install-tests`
- Commit style: `test: isolate extension install state`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an owner-scoped temporary Pi agent directory

Import the required Node filesystem/OS/path helpers. For every test, create a fresh temporary directory, save the previous `PI_CODING_AGENT_DIR`, set it to the temporary root before calling `sumocode`, then restore the previous value and recursively remove the root in `afterEach`.

Keep this lifecycle beside the existing `AMBIENT_ENV_KEYS` snapshot so cleanup occurs even when a test throws. Do not add the variable only to the generic delete list without assigning an isolated replacement.

**Verify**: `pnpm vitest run src/extension.test.ts` → all tests pass without reading the developer's terminal history.

### Step 2: Add a regression assertion for root isolation

Add one focused test named exactly `isolates terminal state under the temporary Pi agent directory`. Full extension installation eagerly creates `<temporary-agent-dir>/state/sumocode-terminals` through the store constructor; assert that path exists without starting a real terminal. Never probe or alter the real home store.

**Verify**: `pnpm vitest run src/extension.test.ts -t "isolates terminal state"` → exactly the new test runs and passes.

### Step 3: Run repository gates

**Verify**: `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` → all commands exit 0.

## Test plan

- Existing install-profile, command, and tool-registration tests remain unchanged semantically.
- New regression covers the temporary durable root.
- Run the targeted file twice; both runs must pass with similar order-of-magnitude duration regardless of live user-store size.

## Done criteria

- [x] Every `sumocode(pi)` call in `src/extension.test.ts` runs with an isolated `PI_CODING_AGENT_DIR`.
- [x] The original environment value is restored after every test.
- [x] Temporary roots are removed after every test.
- [x] `pnpm vitest run src/extension.test.ts` passes twice.
- [x] Typecheck, build, lint, and unit suite pass.
- [x] `git status --porcelain -- src/ test/ scripts/ bin/ package.json pnpm-lock.yaml` shows only `src/extension.test.ts`; pre-existing unrelated dirty files are ignored, not modified.

## Execution outcome — 2026-08-29

Implementation commit: `6ef8c13` (`test: isolate extension install state`). The top-level test lifecycle owns one fresh Pi agent directory per test, restores `PI_CODING_AGENT_DIR` with undefined fidelity, and removes the directory in `afterEach`. The focused regression observes eager store creation through `sumocode(pi)` only; it does not start a terminal or inspect the home-directory terminal store. Keeping isolation at the suite lifecycle, rather than wrapping selected installs, ensures future full-install tests inherit it automatically.

TDD and verification evidence:

- Safe red: shell-owned `PI_CODING_AGENT_DIR` plus a distinct assertion root; focused test failed as expected (`1 failed`, Vitest 1.78s, real 3.80s) without touching the home terminal store.
- Focused green: `pnpm vitest run src/extension.test.ts -t "isolates terminal state"` passed 1/1 (Vitest 889ms, real 1.31s).
- Stability: `pnpm vitest run src/extension.test.ts` passed 29/29 twice (Vitest 1.57s/1.44s; real 2.00s/1.88s).
- Repository gates: `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` passed with `VITEST_MAX_WORKERS=1` (193 files, 2,514 tests; real 82.92s). Default parallel retries exposed unrelated timing-sensitive failures in `host-actions.test.ts` (and once `native-task-tool.test.ts`/`visual-parity-contract.test.ts`); those files passed in isolation, and `pnpm exec vitest run --fileParallelism=false` passed the same 193 files/2,514 tests in 72.58s. No out-of-scope test timing changes were made.

## STOP conditions

- The extension still reads another user-state root after `PI_CODING_AGENT_DIR` is isolated.
- Isolation requires changing production state semantics.
- Any test requires a real configured provider, session, or credential.

## Maintenance notes

Any future full-extension test must inherit this fixture. Reviewers should reject test helpers that fall back to `homedir()` or clean paths outside the test-created root.
