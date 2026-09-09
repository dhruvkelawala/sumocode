# Plan 108: Preserve parent-selected Pi and SumoCode executable provenance in nested work

> **Executor instructions**: Follow this plan step by step and run every verification command. Reuse and consolidate the existing `resolvePiBinary`/`createPiChildSpawner` provenance seam; do not wrap it in a second competing resolver. Thread resolved executables through explicit dependencies. Preserve PATH fallback only when no parent provenance exists. Test with fake binaries; do not invoke a developer's global Pi/SumoCode installation. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Reconciled baseline (2026-09-04):** `9ef92fa1` (PR #449 / Plan 117). The native launcher now canonicalizes `PI_BIN`, exports `SUMOCODE_LAUNCHER=process.execPath`, and resolves its own terminal-runner role. Preserve those contracts; this plan owns the remaining nested Pi/SumoCode launchers, not the native host's runtime selection.
>
> **Drift check (run first)**: `git diff --stat 9ef92fa1..HEAD -- bin/sumocode.sh src/executable-provenance.ts src/executable-provenance.test.ts src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts src/subagents/backend-pane.ts src/subagents/backend-pane.test.ts src/native-task-tool.ts src/native-task-tool.test.ts src/background-tasks/visible-spawn.ts src/background-tasks/visible-spawn.test.ts src/commands/worktree.ts src/commands/worktree.test.ts src/cli/open-worktree.ts src/cli/open-worktree.test.ts scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml test/integration/launcher-runtime-selection.test.ts test/integration/launcher-prompt-transport.test.ts test/integration/native-contract.test.ts`
> **Working-tree preflight (run at the same time)**: run `git status --short` and STOP if it reports pre-existing work. Generated `dist/**` is ignored and must not be committed.
> If commit-range drift changes a Current state provenance assumption, STOP and request plan reconciliation.
> **Read-only native launcher check**: `git diff --stat 9ef92fa1..HEAD -- src/native/main.ts src/native/paths.ts src/sumo-tui/rpc/spawn-child.mjs src/sumo-tui/rpc/spawn-child.test.ts scripts/build-native.mjs`. These define native runtime selection and are regression surfaces, not modification targets; if they change again, STOP and reconcile before proceeding. The source launcher is in scope only for canonical export/propagation of its already-selected executables.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/095-truthful-visible-steering-acks.md` (completes the wording-only `backend-pi.ts` overlap first), `plans/issues/097.md` (prompt transport), `plans/101-pi-version-compatibility-matrix.md`
- **Category**: tech-debt
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Reconciled at**: commit `9ef92fa1`, 2026-09-04 — native `sumocode` now exports canonical `PI_BIN` and `SUMOCODE_LAUNCHER`; existing `backend-pi` support remains the starting seam, not work to recreate
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/402

## Why this matters

Both source and native launchers resolve a concrete `PI_BIN`, and the native launcher exports its own canonical executable as `SUMOCODE_LAUNCHER`. The RPC child and headless subagents honor Pi provenance, but native tasks still spawn literal `pi`; visible subagents and interactive worktree commands still render literal `sumocode` through shell PATH. Those remaining paths can execute a different version/install/configuration than the parent or fail when only the parent-resolved executable exists. Plan 108 must consolidate the partial implementation rather than recreate it.

## Current state

- `bin/sumocode.sh` resolves `PI_BIN`, but exports raw `BASH_SOURCE[0]` as `SUMOCODE_LAUNCHER` and does not pass `PI_BIN` into direct-Pi children. A relative source-launcher path can therefore become invalid after a nested `cd`, and direct-Pi extension code can rebind to PATH. This plan must canonicalize/export the already-selected source paths without changing runtime selection or argument parsing. `src/native/main.ts` already canonicalizes the caller's Pi path before `chdir`, otherwise selects the archive's `bin/sumocode-pi`, then exports both values before starting the host.
- `src/sumo-tui/rpc/spawn-child.mjs` uses `env.PI_BIN` (or the native caller's explicit default) for the main child. `src/background-tasks/task-manager.ts` already selects the native executable's internal terminal-runner role; do not rework either seam here.
- `src/subagents/backend-pi.ts` defines `resolvePiBinary(env)`, normalizing `PI_BIN` with a `pi` fallback; `createPiChildSpawner(..., resolveBinary = resolvePiBinary)` injects that dependency and uses it at spawn time. Preserve its relative-path, command-name, and fallback behavior.
- `src/native-task-tool.ts` still calls `spawn("pi", ...)` and is the missing headless Pi path.
- `src/background-tasks/visible-spawn.ts` still builds `exec sumocode task ...`; `src/subagents/backend-pane.ts` does not inject a launcher. `src/commands/worktree.ts` also emits bare `exec sumocode` for interactive/delegated worktree sessions. These are the remaining SumoCode paths.
- Production injection patterns already exist: backend-pi accepts a spawn/resolver implementation, pane backends accept dependencies, and `src/cli/open-worktree.ts` already resolves `SUMOCODE_LAUNCHER` and shell-escapes it. Reuse those patterns; do not introduce a global mutable resolver.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Child tests | `pnpm vitest run src/executable-provenance.test.ts src/subagents/backend-pi.test.ts src/native-task-tool.test.ts src/background-tasks/visible-spawn.test.ts src/subagents/backend-pane.test.ts src/commands/worktree.test.ts src/cli/open-worktree.test.ts` | pass |
| Launcher/RPC | `bash -n bin/sumocode.sh scripts/smoke-pi-versions.sh && pnpm vitest run src/sumo-tui/rpc/spawn-child.test.ts test/integration/launcher-runtime-selection.test.ts test/integration/launcher-prompt-transport.test.ts` | pass |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && BUN_BIN=${BUN_BIN:-bun} pnpm test:native` | exit 0 |

## Generated bundle policy

PR #439 superseded committed-bundle instructions: `dist/**` and native archives are generated and ignored. Build them for verification, but never commit bundle, source-map, manifest, archive, or executable output.

## Scope

**In scope**:
- `src/executable-provenance.ts` and `src/executable-provenance.test.ts` (create): immutable per-spawn resolution contract.
- `bin/sumocode.sh` only to canonicalize/export `SUMOCODE_LAUNCHER` and propagate the selected `PI_BIN` into direct-Pi children; runtime selection, parsing, prompt transport, and redaction stay unchanged.
- `src/subagents/backend-pi.ts`, `src/subagents/backend-pane.ts`, `src/native-task-tool.ts`, `src/background-tasks/visible-spawn.ts`, `src/commands/worktree.ts`, and `src/cli/open-worktree.ts`, with colocated tests. Plan 095 is complete; do not alter steering acknowledgement wording.
- `test/integration/launcher-runtime-selection.test.ts`, `test/integration/launcher-prompt-transport.test.ts`, and `test/integration/native-contract.test.ts` for source and compiled parent→nested-child provenance coverage. `src/native/main.ts`, `src/native/paths.ts`, and `src/sumo-tui/rpc/spawn-child.mjs` are read-only authorities unless a newly discovered correctness bug forces a plan stop.
- Plan-101 `scripts/smoke-pi-versions.sh`, `scripts/pi-compat-contract.mjs`, and test for package-boundary provenance coverage.
- The existing Plan-101 compatibility workflow (`.github/workflows/pi-compat.yml`, or `.github/workflows/ci.yml` if that is where the job landed) only to add provenance-source paths to its pull-request trigger.

**Out of scope**:
- Installing or discovering arbitrary Pi versions.
- Changing child tool/role policy.
- Replacing Herdr/login-shell behavior unrelated to executable choice.
- Pi compatibility updates (Plans 101–102).

## Git workflow

- Branch: `advisor/108-child-executable-provenance`
- Commit: `fix(children): preserve parent executable provenance`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Consolidate the existing executable-provenance contract

Promote the existing `resolvePiBinary` behavior into the shared provenance seam rather than layering a second resolver around `backend-pi`. A behavior-preserving move/re-export is acceptable so existing imports and tests remain valid. Add the corresponding SumoCode launcher resolution. The shared immutable per-spawn config contains resolved Pi and SumoCode commands, with this resolution order:
1. explicit injected option;
2. nonblank parent-provided `PI_BIN`/`SUMOCODE_LAUNCHER` (path-like values normalized exactly as `resolvePiBinary` does; command names retained);
3. current PATH command fallback for standalone/classic contexts.

Do not resolve once at module import if tests/session reload can change the injected environment. Do not probe or silently replace an explicit parent value: launch-time failure is more truthful than rebinding to a different installation. Preserve the already-shipped whitespace, relative-path, command-name, and fallback cases.

**Verify**: `pnpm vitest run src/executable-provenance.test.ts src/subagents/backend-pi.test.ts` → existing `resolvePiBinary` cases still pass, plus absolute path, command-name, explicit injection, environment injection, SumoCode launcher, blank-value fallback, and per-call environment changes, without executing a binary.

### Step 2: Finish Pi provenance in the remaining headless path

Keep `createPiChildSpawner` on the existing injected resolver (or its behavior-preserving shared re-export); do not add another backend-pi provenance abstraction. Use the same resolved Pi command in native task spawning. Add a constructor/options dependency for native-task spawn/executable selection rather than mutating a module-global or PATH in tests. Preserve `shell: false`, process-group handling, argv, and stdin semantics. Include provenance in bounded diagnostics without prompt/credential content.

**Verify**: `pnpm vitest run src/subagents/backend-pi.test.ts src/native-task-tool.test.ts -t "uses injected Pi provenance"` → the existing subagent resolver regression remains green, native-task captured spawn command equals the injected binary, no literal `pi` appears when provenance exists, and fallback uses `pi` only when no provenance exists.

### Step 3: Thread SumoCode launcher through visible commands

Pass a shell-escaped resolved launcher path through the pane backend into `buildVisibleAgentCommand`, and use the same resolver for interactive/delegated `/sumo:worktree` commands and the existing CLI worktree command builder. Keep shell PATH available for child tools, but do not use PATH to select the top-level SumoCode binary when the parent path is known. The native parent already exports `SUMOCODE_LAUNCHER=process.execPath`; consume it rather than detecting Bun or reconstructing archive paths. This does not add a top-level `sumocode worktree` subcommand to the native executable.

**Verify**: `pnpm vitest run src/background-tasks/visible-spawn.test.ts src/subagents/backend-pane.test.ts src/commands/worktree.test.ts -t "launcher provenance"` → space/metacharacter paths are shell-escaped once, exactly one launcher invocation appears, native/source parent paths are preserved, and fallback uses `sumocode` only without provenance.

### Step 4: Add package-boundary matrix coverage

Extend the exact Plan-101 helpers. First add a pure `preserves nested executable provenance` fixture to `scripts/pi-compat-contract.test.mjs` using two synthetic executable paths representing parent-selected and PATH-global versions. Then extend the default `scripts/smoke-pi-versions.sh --supported-matrix` path so every disposable installed-package row runs nested provenance through source and installed layouts, explicit `PI_BIN`, explicit `SUMOCODE_LAUNCHER`, and PATH-only fallback. Do not hide this behind an opt-in flag: Plan 101's existing pull-request, daily scheduled, and manual workflow invocation must remain the literal `scripts/smoke-pi-versions.sh --supported-matrix` and automatically gain this check. Expand that workflow's pull-request path filter to include every changed provenance source/test so regressions gate before merge rather than waiting for the daily run. Add a compiled native-contract row proving that a fake parent-selected Pi path and the archive's canonical `SUMOCODE_LAUNCHER` reach native-task, visible-subagent, and worktree child launch plans without invoking a developer-global installation.

This package-boundary command requires registry/network access for disposable installs. If unavailable, run the pure/local tests and STOP with Plan 108 marked `BLOCKED — package-boundary matrix unavailable`; do not claim completion. If Plan 101 is `DONE` but its named `--supported-matrix`/contract helper or scheduled workflow invocation is absent, STOP for reconciliation rather than inventing another fixture.

**Verify**: `pnpm vitest run scripts/pi-compat-contract.test.mjs -t "preserves nested executable provenance" && scripts/smoke-pi-versions.sh --supported-matrix` → exit 0; every published supported installed row reports a nested-provenance PASS marker for parent-selected Pi/SumoCode commands and the explicit fallback case reports PATH commands. Workflow fixture/tests prove a pull request touching each provenance source selects the compatibility job; `rg -n "executable-provenance|backend-pi|native-task-tool|visible-spawn|smoke-pi-versions.sh --supported-matrix" .github/workflows/*.yml` shows the source filters and canonical scheduled/manual invocation with no extra opt-in flag.

### Step 5: Run full gates

**Verify**: all command-table commands pass.

## Test plan

Cover explicit absolute binary, PATH command resolution, blank fallback, relative/path-with-spaces values, visible/headless/native-task/worktree paths, reload, installed package layout, source direct-Pi propagation, and the compiled native parent. Assert no recursive second UI is introduced and the native internal terminal-runner role remains unchanged.

## Done criteria

- [x] Source and native parents expose stable launcher/Pi provenance after nested `cd`; direct-Pi source children inherit the already-selected `PI_BIN`.
- [x] Existing nested-subagent `PI_BIN` behavior remains intact, and native-task Pi children use the same parent-selected binary when available.
- [x] Visible and `/sumo:worktree` children use the parent-selected SumoCode launcher when available.
- [x] Standalone fallback remains functional and explicit.
- [x] Paths are shell-safe and diagnostics contain no prompts/secrets.
- [x] Exact pure and package-boundary provenance fixtures run by default in every published supported-version row, and provenance-source pull requests trigger the matrix before merge; no opt-in or “targeted tests or matrix” escape route remains.
- [x] Full gates pass.
- [x] `git status --short` contains only files listed in Scope plus explicitly authorized deterministic security-fixture repairs and this plan/index bookkeeping.
- [x] Plan 108's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Plan 095, 097, or 101 is not `DONE`, or Plan 101's named compatibility helper/`--supported-matrix` contract is absent.
- Commit-range/working-tree preflight changes a reconciled provenance assumption (especially `resolvePiBinary`, native `PI_BIN`/`SUMOCODE_LAUNCHER` export, or the injected `createPiChildSpawner` seam), any verification fails twice after a reasonable fix, or completion requires changing native runtime selection.
- Preserving parent provenance would require probing it or silently falling back to another installation.
- Fix requires a global mutable singleton shared across unrelated sessions.
- Visible launch loses its recursion guard or TTY selection.

## Maintenance notes

Any new child launcher should accept the provenance object rather than spawning a bare command name. Pi matrix tests are the regression authority.
