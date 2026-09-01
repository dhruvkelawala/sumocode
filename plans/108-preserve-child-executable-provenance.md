# Plan 108: Preserve parent-selected Pi and SumoCode executable provenance in nested work

> **Executor instructions**: Follow this plan step by step and run every verification command. Reuse and consolidate the existing `resolvePiBinary`/`createPiChildSpawner` provenance seam; do not wrap it in a second competing resolver. Thread resolved executables through explicit dependencies. Preserve PATH fallback only when no parent provenance exists. Test with fake binaries; do not invoke a developer's global Pi/SumoCode installation. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat ca0c62b..HEAD -- dist/host dist/extension src/executable-provenance.ts src/executable-provenance.test.ts src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts src/native-task-tool.ts src/native-task-tool.test.ts src/background-tasks/visible-spawn.ts src/background-tasks/visible-spawn.test.ts scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension src/executable-provenance.ts src/executable-provenance.test.ts src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts src/native-task-tool.ts src/native-task-tool.test.ts src/background-tasks/visible-spawn.ts src/background-tasks/visible-spawn.test.ts scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state provenance assumption, STOP and request plan reconciliation.
> **Read-only launcher check**: `git diff --stat ca0c62b..HEAD -- bin/sumocode.sh src/sumo-tui/rpc/spawn-child.mjs src/sumo-tui/rpc/spawn-child.test.ts test/integration/spawn-pi-pty.test.ts`. These already carry parent environment provenance and are regression surfaces, not modification targets; if that reconciled contract changes again, STOP and reconcile before proceeding.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/095-truthful-visible-steering-acks.md` (completes the wording-only `backend-pi.ts` overlap first), `plans/issues/097.md` (prompt transport), `plans/101-pi-version-compatibility-matrix.md`
- **Category**: tech-debt
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Reconciled at**: commit `ca0c62b`, 2026-09-01 — existing `PI_BIN` support in `backend-pi` is now the starting seam, not work to recreate
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/402

## Why this matters

The launcher resolves a concrete `PI_BIN`, and the RPC child uses it. Headless subagents now also honor that value through `resolvePiBinary`, but native tasks still spawn literal `pi` and visible children still run literal `sumocode` through a login-shell PATH. Those remaining paths can execute a different version/install/configuration than the parent or fail when only the parent-resolved executable exists. Plan 108 must consolidate the partial implementation rather than recreate it.

## Current state

- `bin/sumocode.sh:429-445` resolves `PI_BIN` and passes it in the launcher invocation environment. Direct `pi -e .`/classic contexts may have no `PI_BIN`, so their explicit fallback remains the command name `pi`.
- `src/sumo-tui/rpc/spawn-child.mjs:24-42` uses `env.PI_BIN` for the main child.
- `src/subagents/backend-pi.ts:343-346` already defines `resolvePiBinary(env)`, normalizing `PI_BIN` with a `pi` fallback; `createPiChildSpawner(..., resolveBinary = resolvePiBinary)` injects that dependency and uses it at spawn time. `src/subagents/backend-pi.test.ts:28-35` pins the environment, relative-path, command-name, and fallback cases. Preserve this contract.
- `src/native-task-tool.ts:738` still calls `spawn("pi", ...)` and is the missing headless Pi path.
- `src/background-tasks/visible-spawn.ts:98-108` still builds `exec sumocode task ...` and is the missing SumoCode path.
- Production injection patterns already exist: backend-pi accepts a spawn/resolver implementation and managers accept dependencies. `native-task-tool.ts` imports `spawn` directly and therefore needs an explicit injectable spawn/executable dependency seam. For launcher shell escaping, copy the existing `src/cli/open-worktree.ts:26-27` pattern that resolves `SUMOCODE_LAUNCHER` then passes it through `shellEscape`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Child tests | `pnpm vitest run src/subagents/backend-pi.test.ts src/native-task-tool.test.ts src/background-tasks/visible-spawn.test.ts` | pass |
| Launcher/RPC | `pnpm vitest run src/sumo-tui/rpc/spawn-child.test.ts test/integration/spawn-pi-pty.test.ts` | pass |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration` | exit 0 |

## Committed bundle freshness

After final source edits, run `pnpm build:host && pnpm build:extension` before `pnpm test`; keep `dist/host/**` and `dist/extension/**` generated changes in scope. Rerun both builders after integration and verify no additional unexpected generated drift.

## Scope

**In scope**:
- `dist/host/**` and `dist/extension/**` generated by the committed bundle builders.
- `src/executable-provenance.ts` and `src/executable-provenance.test.ts` (create): immutable per-spawn resolution contract.
- `src/subagents/backend-pi.ts`, `src/native-task-tool.ts`, and `src/background-tasks/visible-spawn.ts`, with colocated tests. Plan 095 must be DONE first; its `backend-pi.ts` ownership is limited to the `SpawnedChild.send` wording, while this plan owns only executable-resolver consolidation. Do not alter the steering acknowledgement wording.
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
2. parent-provided `PI_BIN`/`SUMOCODE_LAUNCHER` validated as executable;
3. current PATH fallback for standalone/classic contexts.

Do not resolve once at module import if tests/session reload can change the injected environment. Preserve the already-shipped `PI_BIN` whitespace, relative-path, command-name, and fallback cases before adding stricter validation; if validation would break one of those cases, STOP and reconcile the contract instead of silently changing it.

**Verify**: `pnpm vitest run src/executable-provenance.test.ts src/subagents/backend-pi.test.ts` → existing `resolvePiBinary` cases still pass, plus absolute executable, command-name fallback, missing/non-executable override, explicit injection, environment injection, SumoCode launcher, and per-call environment changes, without executing a binary.

### Step 2: Finish Pi provenance in the remaining headless path

Keep `createPiChildSpawner` on the existing injected resolver (or its behavior-preserving shared re-export); do not add another backend-pi provenance abstraction. Use the same resolved Pi command in native task spawning. Add a constructor/options dependency for native-task spawn/executable selection rather than mutating a module-global or PATH in tests. Preserve `shell: false`, process-group handling, argv, and stdin semantics. Include provenance in bounded diagnostics without prompt/credential content.

**Verify**: `pnpm vitest run src/subagents/backend-pi.test.ts src/native-task-tool.test.ts -t "uses injected Pi provenance"` → the existing subagent resolver regression remains green, native-task captured spawn command equals the injected binary, no literal `pi` appears when provenance exists, and fallback uses `pi` only when no provenance exists.

### Step 3: Thread SumoCode launcher through visible commands

Pass a shell-escaped resolved launcher path into `buildVisibleAgentCommand`. Keep login-shell PATH available for child tools, but do not use PATH to select the top-level SumoCode binary when the parent path is known.

**Verify**: `pnpm vitest run src/background-tasks/visible-spawn.test.ts -t "uses injected SumoCode launcher provenance"` → space/metacharacter paths are shell-escaped once, exactly one launcher invocation appears, and fallback uses `sumocode` only without provenance.

### Step 4: Add package-boundary matrix coverage

Extend the exact Plan-101 helpers. First add a pure `preserves nested executable provenance` fixture to `scripts/pi-compat-contract.test.mjs` using two synthetic executable paths representing parent-selected and PATH-global versions. Then extend the default `scripts/smoke-pi-versions.sh --supported-matrix` path so every disposable installed-package row runs nested provenance through source and installed layouts, explicit `PI_BIN`, explicit `SUMOCODE_LAUNCHER`, and PATH-only fallback. Do not hide this behind an opt-in flag: Plan 101's existing pull-request, daily scheduled, and manual workflow invocation must remain the literal `scripts/smoke-pi-versions.sh --supported-matrix` and automatically gain this check. Expand that workflow's pull-request path filter to include `src/executable-provenance.ts`, `src/subagents/backend-pi.ts`, `src/native-task-tool.ts`, `src/background-tasks/visible-spawn.ts`, and their relevant tests so provenance regressions gate before merge rather than waiting for the daily run.

This package-boundary command requires registry/network access for disposable installs. If unavailable, run the pure/local tests and STOP with Plan 108 marked `BLOCKED — package-boundary matrix unavailable`; do not claim completion. If Plan 101 is `DONE` but its named `--supported-matrix`/contract helper or scheduled workflow invocation is absent, STOP for reconciliation rather than inventing another fixture.

**Verify**: `pnpm vitest run scripts/pi-compat-contract.test.mjs -t "preserves nested executable provenance" && scripts/smoke-pi-versions.sh --supported-matrix` → exit 0; every published supported installed row reports a nested-provenance PASS marker for parent-selected Pi/SumoCode commands and the explicit fallback case reports PATH commands. Workflow fixture/tests prove a pull request touching each provenance source selects the compatibility job; `rg -n "executable-provenance|backend-pi|native-task-tool|visible-spawn|smoke-pi-versions.sh --supported-matrix" .github/workflows/*.yml` shows the source filters and canonical scheduled/manual invocation with no extra opt-in flag.

### Step 5: Run full gates

**Verify**: all command-table commands pass.

## Test plan

Cover explicit absolute binary, PATH command resolution, path with spaces, invalid override, visible/headless/native-task paths, reload, and installed package layout. Assert no recursive second UI is introduced.

## Done criteria

- [ ] Existing nested-subagent `PI_BIN` behavior remains intact, and native-task Pi children use the same parent-selected binary when available.
- [ ] Visible children use the parent-selected SumoCode launcher when available.
- [ ] Standalone fallback remains functional and explicit.
- [ ] Paths are shell-safe and diagnostics contain no prompts/secrets.
- [ ] Exact pure and package-boundary provenance fixtures run by default in every published supported-version row, and provenance-source pull requests trigger the matrix before merge; no opt-in or “targeted tests or matrix” escape route remains.
- [ ] Full gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 108's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Plan 095, 097, or 101 is not `DONE`, or Plan 101's named compatibility helper/`--supported-matrix` contract is absent.
- Commit-range/working-tree preflight changes a reconciled provenance assumption (especially `resolvePiBinary` or its injected `createPiChildSpawner` seam), any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Parent provenance cannot be validated without invoking the binary.
- Fix requires a global mutable singleton shared across unrelated sessions.
- Visible launch loses its recursion guard or TTY selection.

## Maintenance notes

Any new child launcher should accept the provenance object rather than spawning a bare command name. Pi matrix tests are the regression authority.
