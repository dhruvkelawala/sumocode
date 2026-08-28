# Plan 101: Test every supported Pi version through the real package boundary

> **Executor instructions**: Follow this plan step by step and run every verification command. Build a version matrix from the declared peer range, not guessed versions. Keep all three Pi packages aligned. Run installs only in disposable temporary directories. Stop if supported versions expose incompatible public RPC contracts. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- package.json scripts/smoke-pi-versions.sh scripts/pi-compat-contract.mjs scripts/pi-compat-contract.test.mjs .github/workflows/ci.yml .github/workflows/pi-compat.yml`
> If this reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation.
> **Read-only contract-reference check**: `git diff --stat b34bd79..HEAD -- bin/sumocode.sh src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts src/extension.ts src/interaction-registry.ts`. These are reference surfaces, not files this plan may modify. If their named contracts changed, STOP and reconcile the fixture expectations.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/issues/092.md` (sanitized public dependency), `plans/096-handle-tui-mode-launcher-flag.md`
- **Category**: migration
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/395

## Why this matters

`package.json` advertises `~0.84.1` compatibility for Pi AI, coding-agent, and TUI, but development and CI install only 0.84.1. A later allowed 0.84.x can change RPC commands, CLI value flags, built-in slash commands, or extension contracts without any gate. The existing smoke script accepts versions but is not run by CI and checks only install plus direct-Pi dry runs.

## Current state

`package.json:27-39` declares peer ranges `~0.84.1` and pins dev dependencies to `0.84.1`. `scripts/smoke-pi-versions.sh` defaults to one version, creates a fixed `/tmp/sumo-pi-${VERSION}` directory, installs only coding-agent plus SumoCode, checks `pi --version`, and tests direct-Pi dry-run bypass. `.github/workflows/ci.yml` has no Pi compatibility job.

AGENTS.md requires every Pi bump to re-verify the RPC declaration contract, hardcoded built-in slash inventory, tool-bypass/security behavior, and direct-Pi modes. The installed declaration is under the candidate package root at `dist/modes/rpc/rpc-types.d.ts`; it is not a tracked SumoCode source file. The SumoCode inventories to compare are `RPC_HOST_SLASH_COMMANDS` and `RPC_HOST_ROUTED_CHILD_COMMANDS` in `src/sumo-tui/rpc/host-actions.ts:154-185`, plus `isTreeNavigationBlockedCommand()` around lines 694-711. `src/sumo-tui/rpc/host-actions.test.ts:1779-1805` already checks SumoCode's table-to-dispatch correspondence but does not compare different installed Pi versions.

Plan 076 intentionally retired the *active registration* while retaining dormant `src/approval-modal.ts`, `src/commands/approval.ts`, and their tests. The compatibility fixture must assert `installApprovalGate` is not imported/called by `src/extension.ts`, `registerApprovalCommand` is not installed by `src/interaction-registry.ts`, and no `sumo:approval`/approval-overlay RPC route is active. Do not delete the dormant modules or flag generic confirmations/modals and the `approval` color token.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Script syntax | `bash -n scripts/smoke-pi-versions.sh` | exit 0 |
| Contract fixture | `pnpm vitest run scripts/pi-compat-contract.test.mjs` | all current/drift fixtures pass |
| Local matrix | `scripts/smoke-pi-versions.sh --supported-matrix` | resolves peer minimum/latest and prints one PASS marker per aligned version |
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

Create `scripts/pi-compat-contract.mjs` as a pure checker and `scripts/pi-compat-contract.test.mjs` with committed fixtures. The checker must validate: aligned AI/coding-agent/TUI versions; the expected RPC requests/events used by SumoCode against `dist/modes/rpc/rpc-types.d.ts`; SumoCode's hardcoded command inventory against candidate `get_commands`; absence of active approval-gate registration/routes named above; and direct-Pi/`--tui-mode` result records supplied by the smoke script. A changed declaration or command fixture must fail with the missing/extra member names.

Add `--supported-matrix`: resolve the peer minimum (currently 0.84.1) and latest published version satisfying the declared `~0.84.1` range, fail clearly if declared peer ranges diverge, then run those two unique versions. Do not test every patch if the range becomes large; minimum + latest is the required boundary. Preserve explicit version arguments for a pending bump.

**Verify**: `pnpm vitest run scripts/pi-compat-contract.test.mjs` → current fixture passes; mismatched package versions, removed RPC member, added/removed command, and reintroduced gate fixtures fail for the asserted reason.

### Step 2: Harden the disposable package smoke

Use `mktemp -d` plus `trap` instead of fixed paths. Install aligned versions of `@earendil-works/pi-ai`, coding-agent, and pi-tui with the local SumoCode package. Preserve package-install behavior, including committed bundle/source fallback.

Extend checks to cover:
- Pi boots/version matches;
- direct `--print`, explicit `--mode`, and non-TTY bypass;
- `--tui-mode` positional extraction;
- RPC child starts and answers bounded `get_state`/`get_commands` requests offline;
- expected SumoCode terminal/subagent tools are discoverable;
- the installed `dist/modes/rpc/rpc-types.d.ts` is located from the disposable candidate package root and passed to the pure contract checker;
- dormant approval modules may exist, but their installers/commands/routes remain absent from active extension/registry/RPC paths;
- candidate commands are passed to the checker for an explicit missing/extra inventory diff.

**Verify**: `scripts/smoke-pi-versions.sh --supported-matrix` → one PASS marker per unique minimum/latest version and no contract-drift marker (one marker is valid only when minimum equals latest).

### Step 3: Add a bounded CI job

Run the minimum/latest matrix on pull requests that touch package metadata, launcher/RPC, extension entry, or the workflow/script itself. Set a timeout and upload only bounded failure logs. No secrets or provider calls.

**Verify**: `scripts/smoke-pi-versions.sh --supported-matrix` is the literal workflow command and produces the same PASS markers locally; `pnpm lint` exits 0; `rg -n "timeout-minutes|smoke-pi-versions.sh --supported-matrix" .github/workflows/*.yml` shows the compatibility job's bounded timeout and exactly one supported-matrix invocation.

### Step 4: Make the script self-documenting

Keep documentation changes in Plan 115. Add `--help` output and a concise script comment that identify minimum + latest supported as the canonical bump gate and show the exact explicit-version command used by CI. Do not copy patch numbers into additional docs here.

**Verify**: `scripts/smoke-pi-versions.sh --help | grep -F "minimum + latest supported"` → exactly one matching line; `rg -n "scripts/smoke-pi-versions.sh" .github/workflows scripts/smoke-pi-versions.sh` shows the CI invocation and script usage text only.

## Test plan

Exercise minimum/latest, explicit unsupported version, unavailable registry response, RPC timeout, changed command inventory, and launcher flag parsing. All fixtures run offline after package installation.

## Done criteria

- [ ] CI tests the minimum and latest version allowed by all Pi peer ranges.
- [ ] All Pi packages are version-aligned in each fixture.
- [ ] RPC, command inventory, tool boundary, and direct-Pi bypass are checked.
- [ ] Temporary installs cannot collide and are cleaned.
- [ ] `pnpm vitest run scripts/pi-compat-contract.test.mjs` and `scripts/smoke-pi-versions.sh --supported-matrix` pass.
- [ ] Full local gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 101's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Latest allowed 0.84.x is incompatible with the current public contract.
- Registry resolution/package installation is unavailable; report the matrix as BLOCKED with command/error evidence instead of substituting the local lockfile version.
- Matrix requires a provider credential or network call after install.
- Supporting the peer range requires version-specific production branches.

## Maintenance notes

If a supported patch fails, either narrow the peer range honestly or fix compatibility before upgrading. Do not mark a failing version allowed and skip its CI row.
