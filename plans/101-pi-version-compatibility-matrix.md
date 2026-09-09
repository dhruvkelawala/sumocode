# Plan 101: Test every published Pi patch in the advertised supported range

> **Executor instructions**: Follow this plan step by step and run every verification command. Build a version matrix from the declared peer range, not guessed versions. Keep all three Pi packages aligned. Run installs only in disposable temporary directories. Stop if supported versions expose incompatible public RPC contracts. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat 4f79b14..HEAD -- package.json scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension package.json scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml`. If this reports pre-existing work, STOP and preserve it.
> If the drift check reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation. Commit `4f79b14` (current PR #429 head) is the execution baseline; it includes the completed Plan 096 launcher parser, subsequent delimiter/readiness fixes, and Plan 100 terminal redaction.
> **Read-only contract-reference check**: `git diff --stat 4f79b14..HEAD -- bin/sumocode.sh src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/editor.ts src/extension.ts src/interaction-registry.ts`. These are reference surfaces, not files this plan may modify. If their named contracts changed after the reconciled baseline, STOP and reconcile the fixture expectations.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/issues/092.md` (sanitized public dependency), `plans/096-handle-tui-mode-launcher-flag.md`
- **Category**: migration
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Reconciled at**: commit `4f79b14`, 2026-09-01 (current PR #429 head; Pi 0.84.3 + completed Plan 096 launcher contract + Plan 100 terminal redaction)
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/395

## Why this matters

`package.json` advertises `~0.84.3` compatibility for Pi AI, coding-agent, and TUI, but development and CI install only 0.84.3. A later allowed 0.84.x can change RPC commands, CLI value flags, built-in slash commands, or extension contracts without any gate. The existing smoke script accepts versions but is not run by CI and checks only install plus direct-Pi dry runs.

## Current state

`package.json:27-39` declares peer ranges `~0.84.3` and pins dev dependencies to `0.84.3`; its integration script now runs the verification harness added before PR #428. `scripts/smoke-pi-versions.sh` still defaults to one version, creates a fixed `/tmp/sumo-pi-${VERSION}` directory, installs only coding-agent plus SumoCode, checks `pi --version`, and tests direct-Pi dry-run bypass. No workflow runs a Pi compatibility matrix.

AGENTS.md requires every Pi bump to re-verify the RPC declaration contract, hardcoded built-in slash inventory, tool-bypass/security behavior, and direct-Pi modes. Candidate Pi owns two different command surfaces: `dist/core/slash-commands.js` exports `BUILTIN_SLASH_COMMANDS`, while RPC `get_commands` returns registered extension, prompt-template, and skill commands—not built-ins. `buildRpcAutocompleteCommands()` in `src/sumo-tui/rpc/editor.ts:99-121` deliberately unions those child-reported commands with the host inventory.

The installed RPC declaration is under the candidate package root at `dist/modes/rpc/rpc-types.d.ts`; it is not a tracked SumoCode source file. SumoCode's host and routed-child inventories are `RPC_HOST_SLASH_COMMANDS` and `RPC_HOST_ROUTED_CHILD_COMMANDS` in `src/sumo-tui/rpc/host-actions.ts:154-185`, plus `isTreeNavigationBlockedCommand()` around lines 694-711. `src/sumo-tui/rpc/host-actions.test.ts:1779-1805` already checks SumoCode's table-to-dispatch correspondence but does not compare different installed Pi versions. The `4f79b14` extension inventory includes `registerAccountsCommand(pi)` in both RPC-child and normal profiles; `accounts` must be present in the expected SumoCode extension-command fixture. The launcher fixture must exercise Plan 096's final option-consumption contract: `--tui-mode fullscreen` is forwarded while the first positional becomes `SUMOCODE_INITIAL_PROMPT`; direct-mode detection stops at the Pi-owned `--` delimiter.

Plan 076 intentionally retired the *active registration* while retaining dormant `src/approval-modal.ts`, `src/commands/approval.ts`, and their tests. The compatibility fixture must assert `installApprovalGate` is not imported/called by `src/extension.ts`, `registerApprovalCommand` is not installed by `src/interaction-registry.ts`, and no `sumo:approval`/approval-overlay RPC route is active. Do not delete the dormant modules or flag generic confirmations/modals and the `approval` color token.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Script syntax | `bash -n scripts/smoke-pi-versions.sh` | exit 0 |
| Contract fixture | `pnpm vitest run scripts/pi-compat-contract.test.mjs` | all current/drift fixtures pass |
| Local matrix | `scripts/smoke-pi-versions.sh --supported-matrix` | resolves every published version satisfying the peer range and prints one PASS marker per aligned version |
| Required gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` | exit 0 |

## Committed bundle freshness

Any `package.json` change invalidates both committed bundle manifests. After final metadata/script edits, run `pnpm build:host && pnpm build:extension` before `pnpm test` and keep `dist/host/**` plus `dist/extension/**` generated changes in scope.

## Scope

**In scope**:
- `dist/host/**` and `dist/extension/**` generated after package metadata changes.
- `scripts/smoke-pi-versions.sh`
- `scripts/pi-compat-contract.mjs` and `scripts/pi-compat-contract.test.mjs` (create) for pure RPC/command/gate contract assertions.
- `.github/workflows/ci.yml` or a dedicated `.github/workflows/pi-compat.yml`.
- `package.json` only if adding a script alias.

**Out of scope**:
- Expanding the peer range to 0.85 or newer.
- Updating Pi dependencies (Plan 102).
- Private Pi patches or vendored runtime code.
- Online provider calls or real credentials.

## Git workflow

- Branch: `advisor/101-pi-version-compatibility-matrix`
- Commit: `ci: test supported Pi versions`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define and unit-test the compatibility contract

Create `scripts/pi-compat-contract.mjs` as a pure checker and `scripts/pi-compat-contract.test.mjs` with committed fixtures. The checker must validate: aligned AI/coding-agent/TUI versions; the expected RPC requests/events used by SumoCode against `dist/modes/rpc/rpc-types.d.ts`; command inventories using the ownership rules below; absence of active approval-gate registration/routes named above; and direct-Pi/`--tui-mode` result records supplied by the smoke script. A changed declaration or command fixture must fail with the missing/extra member names.

Keep command ownership explicit and test the surfaces separately:
- require a committed ownership fixture that classifies every `RPC_HOST_SLASH_COMMANDS` entry as Pi-mirrored or host-owned; load candidate Pi's `BUILTIN_SLASH_COMMANDS` from its disposable `dist/core/slash-commands.js` and compare only the Pi-mirrored subset;
- validate the complete classified SumoCode host table against its host action/dispatch fixture independently of child RPC output;
- filter `get_commands` by `source === "extension"` in the isolated disposable install, then validate the expected SumoCode extension and `RPC_HOST_ROUTED_CHILD_COMMANDS` inventories; exclude prompt/skill entries and never require host-only commands such as `hotkeys` to appear in `get_commands`.

Fixtures must include a host-only command, the reconciled `accounts` extension command, another child extension command, and prompt/skill noise so an ownership regression fails while the known-good union passes.

Add `--supported-matrix`: fetch the published version list, intersect it with each declared Pi peer range, fail clearly if the three declared ranges or satisfying-version sets diverge, sort semantically, and run every unique published version satisfying the advertised range (currently every published `~0.84.3` patch). Preserve explicit version arguments for a pending bump. If the supported set becomes too large for bounded CI, narrow the advertised peer range in a separately reviewed compatibility change rather than sampling versions that remain declared compatible.

**Verify**: `pnpm vitest run scripts/pi-compat-contract.test.mjs` → current fixture passes; mismatched package versions, removed RPC member, added/removed command, and reintroduced gate fixtures fail for the asserted reason.

### Step 2: Harden the disposable package smoke

Use `mktemp -d` plus `trap` instead of fixed paths. Install aligned versions of `@earendil-works/pi-ai`, coding-agent, and pi-tui with the local SumoCode package. Preserve package-install behavior, including committed bundle/source fallback.

Extend checks to cover:
- Pi boots/version matches;
- SumoCode's production TypeScript source compiles against each candidate's installed Pi declarations, validating complete request fields and consumed response payload shapes rather than discriminants alone;
- direct `--print`, explicit `--mode`, and non-TTY bypass;
- `--tui-mode` positional extraction;
- RPC child starts and answers bounded `get_state`/`get_commands` requests offline;
- expected SumoCode terminal/subagent tools are discoverable;
- the installed `dist/modes/rpc/rpc-types.d.ts` and `dist/core/slash-commands.js` are located from the disposable candidate package root and passed to the pure contract checker;
- dormant approval modules may exist, but their installers/commands/routes remain absent from active extension/registry/RPC paths;
- candidate built-ins and source-tagged `get_commands` entries are passed separately to the checker for ownership-scoped missing/extra inventory diffs.

**Verify**: `scripts/smoke-pi-versions.sh --supported-matrix` → the resolved row list exactly equals every published version satisfying all three peer ranges, with one PASS marker per row and no contract-drift marker.

### Step 3: Add bounded PR and registry-freshness CI

Run the complete supported-patch matrix on pull requests that touch package metadata, launcher/RPC, extension entry, or the workflow/script itself. Also run the same job from a daily UTC `schedule` on the default branch so every newly published patch inside the advertised peer range is tested without waiting for a repository change; include `workflow_dispatch` for immediate maintainer checks. Scheduled/manual runs must freshly resolve the registry's complete satisfying-version set rather than reuse a cached row list.

Set a timeout and upload only bounded failure logs. No secrets or provider calls. Use concurrency to cancel superseded runs of the same ref/event without cancelling the distinct scheduled freshness check.

**Verify**: `scripts/smoke-pi-versions.sh --supported-matrix` is the literal workflow command and produces the same PASS markers locally; `pnpm lint` exits 0; workflow fixtures/tests prove qualifying PR, daily schedule, and manual dispatch all select the one bounded matrix job; `rg -n "schedule:|cron:|workflow_dispatch:|timeout-minutes|smoke-pi-versions.sh --supported-matrix" .github/workflows/*.yml` shows the external triggers, bounded timeout, and one canonical matrix invocation.

### Step 4: Make the script self-documenting

Keep documentation changes in Plan 115. Add `--help` output and a concise script comment that identify every published peer-range-satisfying patch as the canonical compatibility gate and show the exact explicit-version command used for a pending bump. Do not copy patch numbers into additional docs here.

**Verify**: `scripts/smoke-pi-versions.sh --help | grep -F "every published supported patch"` → exactly one matching line; `rg -n "scripts/smoke-pi-versions.sh" .github/workflows scripts/smoke-pi-versions.sh` shows the CI invocation and script usage text only.

## Test plan

Exercise a published range with minimum/intermediate/latest patches, a range with one patch, explicit unsupported version, unavailable registry response, divergent peer satisfying sets, RPC timeout, changed Pi-owned built-in, missing/extra SumoCode extension command, host-only command absent from `get_commands`, prompt/skill noise, launcher flag parsing, and workflow selection for PR/schedule/manual events. All contract fixtures run offline after package installation; matrix resolution/install intentionally uses the package registry.

## Done criteria

- [x] CI is configured to test every published version allowed by all Pi peer ranges on qualifying PRs and on a daily registry-freshness schedule, with manual dispatch available.
- [x] All Pi packages are version-aligned in each fixture.
- [x] Complete RPC request/consumed-response shapes, ownership-separated Pi built-in/host/extension command inventories, tool boundary, and direct-Pi bypass are checked.
- [x] Temporary installs cannot collide and are cleaned.
- [x] `pnpm vitest run scripts/pi-compat-contract.test.mjs` and `scripts/smoke-pi-versions.sh --supported-matrix` pass.
- [x] Full local gates pass under the execution contract's load-sensitive adjudication.
- [x] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [x] Plan 101's `plans/README.md` row is updated to `DONE` with completion evidence.

Completion evidence after rebasing onto PR #429 head `4f79b14`: the supported matrix passed for 0.84.3 and 0.84.4, including production-source typechecks against each candidate's request/response declarations, complete Pi built-in drift checks, and dangerous bash calls dispatched end-to-end through each candidate RPC child; contract fixtures passed 12/12; typecheck, build, and lint passed; the default-parallel unit suite passed 2,754/2,754.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Latest allowed 0.84.x is incompatible with the current public contract.
- Registry resolution/package installation is unavailable; report the matrix as BLOCKED with command/error evidence instead of substituting the local lockfile version.
- Matrix requires a provider credential or network call after install.
- Supporting the peer range requires version-specific production branches.

## Maintenance notes

If a supported patch fails, either narrow the peer range honestly or fix compatibility before upgrading. Do not mark a failing version allowed and skip its CI row.
