# Plan 115: Reconcile active documentation with the RPC-first 0.4.1 product

> **Executor instructions**: Follow this plan step by step and run every verification command. This changes documentation plus one docs-verification helper/test only; do not change production source. Verify every factual update against current code/config before writing. Preserve historical documents by marking them superseded rather than rewriting history. Invoke the `writing-for-agents` skill before modifying AGENTS.md if available. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- AGENTS.md README.md DEV_LOOP.md SETUP.md docs/perf/startup.md docs/SUMO_TUI_PI_PATCH_STRATEGY.md docs/SUMO_TUI_AUDIT.md docs/SUMO_TUI_CONSOLIDATION_PLAN.md docs/adr/0001-sumo-tui-framework.md docs/prd.md docs/research/v0.4-roadmap.md docs/PI_TOOL_ARCHITECTURE.md docs/ui/bible/README.md docs/visual/README.md plans/README.md scripts/check-doc-references.mjs scripts/check-doc-references.test.mjs`
> **Working-tree preflight (run at the same time)**: `git status --short -- AGENTS.md README.md DEV_LOOP.md SETUP.md docs/perf/startup.md docs/SUMO_TUI_PI_PATCH_STRATEGY.md docs/SUMO_TUI_AUDIT.md docs/SUMO_TUI_CONSOLIDATION_PLAN.md docs/adr/0001-sumo-tui-framework.md docs/prd.md docs/research/v0.4-roadmap.md docs/PI_TOOL_ARCHITECTURE.md docs/ui/bible/README.md docs/visual/README.md plans/README.md scripts/check-doc-references.mjs scripts/check-doc-references.test.mjs`. If this reports pre-existing work, STOP and preserve it; do not overwrite a dirty authority document.
> If commit-range drift changes a Current state fact, STOP and request plan reconciliation.
> **Read-only authority check**: `git diff --stat b34bd79..HEAD -- package.json bin/sumocode.sh src/extension-entry.ts src/sumo-tui/rpc/spawn-child.mjs .github/workflows`. These files define facts but are out of scope; if they changed, re-verify every affected statement and STOP if this plan would need source/config edits.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. Then apply `plans/EXECUTION.md`'s final-wave gate: every accepted non-deferred Plan 091–114 row must be `DONE` (Plan 105 is rejected and Plan 110 is deferred outside the current campaign, so neither counts against the gate). If either check fails, STOP; do not document unfinished campaign work as current fact.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: LOW
- **Depends on**: `plans/094-truthful-command-readiness.md`, `plans/101-pi-version-compatibility-matrix.md`, plus the final-wave gate covering every accepted non-deferred Plan 091–114 row (Plan 105 rejected; Plan 110 deferred outside the current campaign)
- **Category**: docs
- **Milestone**: M6 — Maintenance
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/409

## Why this matters

Public guidance mixes the current RPC-first 0.4.1 product with obsolete v0.1–0.4 roadmaps, a retired private-patch architecture, dead VHS instructions, wrong test/CI claims, machine-specific checkout assumptions outside the canonical primary-tree rule, and incomplete durable-state documentation. Contributors can run the wrong entry point, expose a credential while troubleshooting, repeat shipped work, or treat historical plans as active.

## Current state

Verified drift includes:
- `README.md` badge says 0.4.0 while `package.json` is 0.4.1.
- `DEV_LOOP.md` and `SETUP.md` treat `/Volumes/SumoDeus NVMe/code/sumocode` as the universal checkout. `AGENTS.md` intentionally names it as the canonical primary dev tree and requires quoting paths with spaces; preserve that non-negotiable while making portable contributor commands repository-relative.
- `DEV_LOOP.md` says the launcher runs `src/extension.ts`, lists obsolete test counts/Pi/version, and claims PR CI/lint do not exist.
- Canonical runtime entry is `src/extension-entry.ts` via package metadata/spawn helper; `extension.ts` is implementation/source fallback.
- `docs/perf/startup.md` uses old readiness names/baseline (Plan 094 updates metrics).
- `docs/ui/bible/README.md` claims 95 mockups and TODOs for elements that have generated files.
- `docs/visual/README.md` documents a `.tape`/VHS flow with no tapes; V2 parity is canonical.
- `SETUP.md` recommends printing an API-key environment variable and documents only some durable state.
- `docs/PI_TOOL_ARCHITECTURE.md` says all modals route through classic `ctx.ui.custom`, omitting the RPC host responder path.
- PRD/roadmap/consolidation/audit/research docs still present retired features as future/active.
- `plans/README.md` has historical approval-gate evidence plus a current rejected-finding statement. `plans/076-disable-approval-gate.md` removed active installation/registration, but dormant `src/approval-modal.ts`, `src/commands/approval.ts`, and their tests intentionally remain. Current docs must say “not wired into the runtime,” not “the modules were deleted.” The filename is required because another historical file also begins with `076-`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Checker tests | `pnpm vitest run scripts/check-doc-references.test.mjs` | clean/current and broken-link/stale-claim/credential/count fixtures pass |
| Docs references | `node scripts/check-doc-references.mjs --check all` | exit 0; no broken local link, active stale claim, secret-print command, or count mismatch |
| Required code gates | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |

## Suggested executor toolkit

- Use `writing-for-agents` for AGENTS.md changes.
- Use the current code/config as authority: `package.json`, `bin/sumocode.sh`, `src/sumo-tui/rpc/spawn-child.mjs`, CI workflows, and `docs/visual/parity/CONTRACT.md`.

## Scope

**In scope**:
- `AGENTS.md`, `README.md`, `DEV_LOOP.md`, `SETUP.md`.
- `docs/perf/startup.md` only to consume Plan 094's current report.
- `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`, `docs/SUMO_TUI_AUDIT.md`, `docs/SUMO_TUI_CONSOLIDATION_PLAN.md`, relevant ADR/PRD/roadmap/research banners.
- `docs/PI_TOOL_ARCHITECTURE.md`, `docs/ui/bible/README.md`, `docs/visual/README.md`.
- `plans/README.md` status-authority/rejected-finding corrections.
- `scripts/check-doc-references.mjs` and `scripts/check-doc-references.test.mjs` (create): docs-only reference/claim checker, not runtime code.

**Out of scope**:
- Production source/runtime behavior and package/workflow configuration.
- Regenerating or promoting visual goldens.
- Rewriting historical evidence to pretend old decisions never existed.
- Documenting private `sumocode-config` contents or secret values.
- Updating every dated research artifact; banner/link only when it can mislead as active authority.

## Git workflow

- Branch: `advisor/115-docs-reconciliation`
- Commits may split contributor docs, architecture/history, visual docs.
- Message: `docs: reconcile RPC-first development guidance`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Establish authority, historical banners, and a checker

Add a concise docs authority map: AGENTS.md for agent/repo rules, README for current product, DEV_LOOP for current contributor/release flow, plans ledger for execution status, V2 parity contract for visuals. Historical docs get a top `> **Status: historical/superseded as of <date>**` banner with a repository-relative current-authority link; preserve their body.

Create `scripts/check-doc-references.mjs` and its fixture-driven test. It must resolve repository-relative Markdown links, validate referenced backtick paths/commands from the active docs in Scope, and distinguish active from historical claims only through the required top banner—not a subjective allowlist. Support `--check links|active-claims|security-state|bible|all`. External URLs are syntax-checked only; no network fetch.

**Verify**: `pnpm vitest run scripts/check-doc-references.test.mjs && node scripts/check-doc-references.mjs --check links` → exit 0; missing local target, missing historical banner/current link, and path-with-anchor fixtures fail for the asserted reason.

### Step 2: Fix contributor and release guidance

Replace universal machine-specific checkout assumptions in contributor/setup docs with repository-relative commands or documented `$SUMOCODE_ROOT`. Retain AGENTS.md's canonical `/Volumes/SumoDeus NVMe/code/sumocode` primary-tree rule and its requirement to quote paths with spaces. Correct version badge, Node/Pi/package metadata, canonical `extension-entry.ts` behavior, release propagation, CI/lint/test commands, and remove mutable hard-coded test counts unless generated.

Update AGENTS.md without weakening non-negotiables or removing that canonical path rule. Correct the approval narrative with the full citation `plans/076-disable-approval-gate.md`: active installation/registration was intentionally retired; dormant modules/tests remain; external Pi/operator trust policy owns approval. Do not claim the source files were deleted.

**Verify**: `node scripts/check-doc-references.mjs --check active-claims` → exit 0; checker fixtures prove an active old version/path/entrypoint claim fails while the same text in a correctly bannered historical file passes.

### Step 3: Make setup/security/state guidance current

Replace `echo $...API_KEY` with a non-printing presence check. Remove v0.1 scaffold/splash/notification expectations. Document terminal store and Activity state roots, permissions, ownership, retention/no-auto-deletion, sessions, and private config split. Do not tell users to delete state as troubleshooting.

**Verify**: `node scripts/check-doc-references.mjs --check security-state` → exit 0; the checker rejects `echo`/`printf`/shell expansion of credential-like variables and requires terminal/activity/session rows with non-printing presence-check guidance.

### Step 4: Reconcile architecture and overlay docs

Update current launcher contract to `extension-entry.ts`. Explain classic `ctx.ui.custom` versus RPC `extension_ui`/host-owned modal responder with one canonical current example. Mark private-patch/hybrid narratives and obsolete PRD/v0.4 roadmap as historical.

Reconcile plan status authority: `plans/README.md` is canonical; individual rejected/superseded plans get explicit status notes without deleting evidence.

**Verify**: `node scripts/check-doc-references.mjs --check links && node scripts/check-doc-references.mjs --check active-claims` → exit 0; retired patch/InteractiveMode claims occur only in files with the required historical banner/current link.

### Step 5: Refresh visual documentation

Generate inventory counts from current Bible HTML/PNG directories and distinguish design-lock from implementation status. Make `visual:review`/`visual:ci` the active path. Mark VHS `.tape` guidance legacy or remove it from active instructions; do not claim headless glyph equivalence unsupported by the V2 contract.

**Verify**: `node scripts/check-doc-references.mjs --check bible` → exit 0 by comparing any documented count to live `docs/ui/bible/*.html` and `docs/ui/bible/renders/*.png` inventory; active visual guidance contains `pnpm visual:review`/`pnpm visual:ci` and does not call `pnpm visual` or VHS canonical.

### Step 6: Update readiness/perf references and run checks

Consume Plan 094's `editor_ready`/`command_ready` terminology and current baseline. Do not regenerate perf numbers independently if Plan 094 is not DONE; STOP and leave a dependency note.

Run link/path/version scans and typecheck/build to ensure doc examples reference valid files/commands.

**Verify**: `pnpm vitest run scripts/check-doc-references.test.mjs && node scripts/check-doc-references.mjs --check all && pnpm exec tsc --noEmit && pnpm build` → exit 0.

## Test plan

Documentation verification is search/link/file evidence:
- every command exists in `package.json`/launcher;
- every referenced path exists;
- current versions derive from package metadata;
- Bible counts match filesystem;
- no secret-printing command;
- historical docs have banners/current links;
- plan ledger approval/readiness statements match accepted decisions.

## Done criteria

- [ ] Contributor/setup docs use repository-relative/configurable paths; AGENTS.md retains the canonical primary-tree and quoted-path rules.
- [ ] Version, Pi, entrypoint, CI, lint, test, and release guidance match current code.
- [ ] Setup never prints credential values and documents all durable state.
- [ ] RPC overlay/tool architecture is accurate.
- [ ] Obsolete architecture/PRD/roadmap/VHS docs are clearly historical.
- [ ] Bible inventory and readiness terminology are current.
- [ ] No production source, package/workflow config, or golden file changed; only scoped docs/checker files plus plan bookkeeping appear in `git status --short`.
- [ ] `pnpm vitest run scripts/check-doc-references.test.mjs && node scripts/check-doc-references.mjs --check all` exits 0.
- [ ] Every accepted non-deferred Plan 091–114 row was `DONE` before documentation edits began (Plan 105 rejected; Plan 110 deferred outside the current campaign).
- [ ] Plan 115's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree/read-only authority preflight changes a Current state assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Plan 094 or 101 is not complete, any other accepted non-deferred Plan 091–114 row is unfinished (Plan 105 rejected and Plan 110 deferred outside the current campaign do not block), or current readiness/version facts cannot be stated.
- A document's historical status is genuinely disputed.
- Correcting a claim would require exposing private configuration or credential locations beyond existing public contracts.
- Visual inventory generation changes HTML/PNG outputs.
- An AGENTS.md edit would remove or weaken the canonical primary-tree or quoted-path rules.

## Maintenance notes

Prefer generated metadata and authority links over repeating volatile counts/versions. Dated research may remain historical evidence; only active guidance must be continuously current.
