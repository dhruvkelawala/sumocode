# Plan 018: Establish canonical TUI baseline and reject duplicate RPC shell

> **Executor instructions:** Follow this plan step by step. Run the verification
> commands and record the produced evidence paths. If a STOP condition occurs,
> stop and report instead of improvising.
>
> **Drift check (run first):**
> `git status --short && git rev-parse --short HEAD main`
> This plan was written against current HEAD `a3966a7` and main `c744cd2`.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** 014, audit in `docs/research/rpc-portable-tui-audit.md`
- **Category:** tests / architecture
- **Planned at:** `a3966a7`, 2026-07-02
- **Executed:** 2026-07-02 — compatible main-code baseline
  `/tmp/sumocode-main-visual-plan018-contract/parity`, clean duplicate-shell
  branch capture `/tmp/sumocode-branch-visual-plan018-contract/parity`,
  comparison reports `docs/visual/out/parity-main-rpc/` (expected rejection).
  The branch capture was produced from detached `HEAD` plus only the Plan 018
  runtime-manifest fix, so unrelated dirty runtime edits in the working tree did
  not affect the rejection evidence.

## Why this matters

The branch passed visual gates while still drifting from the current main TUI.
Before refactoring, create an executable baseline that proves the current RPC
renderer is not acceptable unless it matches the canonical retained shell.

## Current evidence

- `src/sumo-tui/rpc/runtime.ts` has its own splash/active frame renderer,
  sidebar snapshot, top/footer mapping, and `writeFramePatches(..., null)`.
- `src/sumo-tui/pi-compat/owned-shell-renderer.ts` already owns the canonical
  full-screen shell, input placement, overlay composition, sidebar placement,
  and hardware cursor path.
- `docs/visual/parity/scenarios.json` uses `SUMOCODE_VISUAL_RPC_FIXTURE` for
  active runtime scenarios, so those scenarios do not prove a real child session.

## Scope

**In scope:**

- Visual/test harness files under `scripts/visual-v2/`, `docs/visual/parity/`,
  and `test/integration/`.
- New ignored output under `docs/visual/out/` or `/tmp/sumocode-*`.
- Documentation explaining canonical baseline capture.

**Out of scope:**

- Refactoring runtime source.
- Promoting visual goldens.
- Reintroducing the old constructor patch or fallback runtime.

## Steps

### Step 1: Capture main as the canonical product baseline

Create a temporary worktree for `main` outside the current checkout, install if
needed, and run the same runtime visual scenarios on it. Final evidence must
use a compatible Plan 018 scenario contract, with
`capture-metadata.json.scenarioContract` present in each runtime scenario. Older
main captures without that metadata are diagnostic only; they must at least
match command, args, dimensions, and runtime input count before the compare
helper will use them.

```bash
git worktree add /tmp/sumocode-main-tui-baseline main
cd /tmp/sumocode-main-tui-baseline
pnpm install
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
```

Copy or reference the generated review pack paths in the executor report. Do not
promote goldens.

### Step 2: Add a main-vs-branch comparison mode

Add a harness mode or script that accepts two capture roots and compares the
same scenario/crop pairs cell-for-cell and PNG crop-by-crop:

- main capture is the canonical baseline,
- current branch RPC capture is the candidate,
- reports are written under `docs/visual/out/parity-main-rpc/`.

The text reports must include styled-cell diffs and geometry audit summaries.

### Step 3: Make the current duplicate RPC shell fail

Run the comparison against the current branch before any portable-shell work.
It should fail for at least one user-visible shell region if the duplicate
renderer remains.

Expected failure categories:

- active/splash input placement,
- footer or hint row geometry,
- sidebar cell background/foreground,
- top chrome layout,
- hardware cursor visibility/position in captured cell metadata if available.

### Step 4: Document the acceptance rule

Update `docs/visual/parity/CONTRACT.md` to say RPC parity is accepted only when:

- runtime scenarios exercise a real RPC child where the scenario is labelled
  runtime,
- deterministic completed states live in fixture scenarios,
- RPC candidate captures match the canonical main retained TUI for equivalent
  terminal dimensions and scripted inputs,
- Dhruv approves any golden promotion.

## Verification

```bash
pnpm vitest run src/visual-parity-contract.test.ts
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm exec tsc --noEmit && pnpm build
```

The main-vs-branch comparison should fail before the Track D implementation
plans (019-023, plus the behavioral fixes in 025) and pass only after the
portable shell work is complete — final sign-off happens in Plan 024.

## Done criteria

- [x] Main baseline capture evidence exists and is referenced in the report.
- [x] A repeatable main-vs-branch comparison path exists.
- [x] The current duplicate RPC shell fails the new comparison.
- [x] Visual docs describe the canonical-baseline acceptance rule.
- [x] No visual golden promotion was performed.

## STOP conditions

- The harness cannot run main and branch scenarios without modifying goldens.
- The comparison cannot distinguish fixture scenes from true runtime scenes.
- Current source files contain unrelated dirty edits that would affect the
  baseline; ask the operator before cleaning or reverting anything.
