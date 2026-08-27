# Plan 088: Upgrade to the first published Pi release containing `clear_queue`

> **Executor instructions**: This plan is release-gated. Do not change the
> repository until the release qualification in Step 1 passes. Follow every
> step in order and run every verification command. If a STOP condition occurs,
> stop and report the exact package/version/output; do not install Pi from a Git
> SHA, copy files from Pi main, patch `node_modules`, or restore a private Pi
> constructor seam.
>
> **Drift check (run first after the release gate passes)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   package.json pnpm-lock.yaml README.md AGENTS.md \
>   bin/sumocode.sh \
>   src/sumo-tui/rpc src/approval-modal.test.ts \
>   test/integration/spawn-pi-pty.test.ts \
>   test/integration/rpc-host-shell.test.ts \
>   test/integration/rpc-contract.test.ts \
>   scripts/smoke-pi-versions.sh dist/extension \
>   docs/research/pi-fork-upgrade.md \
>   docs/research/PI_RPC_MAIN_SPEC_RESEARCH.md \
>   docs/research/SUMOCODE_PI_RPC_AUDIT_2026.md
> ```
>
> Reconcile compatible drift against the live code. A changed Pi package layout,
> RPC union, launcher bypass, or approval boundary is a STOP condition until the
> plan is amended.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: first published `@earendil-works/pi-coding-agent` release whose shipped RPC runtime and public types contain `clear_queue`
- **Category**: migration / tests
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Issue**: [#375](https://github.com/dhruvkelawala/sumocode/issues/375)
- **Execution status**: BLOCKED — Pi `main` has `clear_queue` after `0.84.3`, but no published release contains it yet

## Outcome

SumoCode pins one published Pi release across `pi-ai`, `pi-coding-agent`, and
`pi-tui`. A package-level contract test proves that the installed worker accepts
`clear_queue` and returns `{steering, followUp}`. The compatibility suite also
locks the post-`0.84.1` event enrichments, public entrypoint layout, built-in
slash inventory, dangerous-tool approval gate, and direct-Pi launcher bypass.

Plans 089–092 remain blocked until this plan is merged and its contract gate is
green. Merely seeing `clear_queue` on GitHub main is not enough.

## Why this matters

Plans 089–092 deliberately target the next stable Pi protocol rather than an
unpublished commit. The queue migration cannot preserve Alt+Up/Escape recovery
without an atomic public `clear_queue` command. Pi `main` at
`4e494929998d6bc4fccf75e0a233f727db4b70ee` implements that command, while its
package manifest still reports `0.84.3` and the changelog lists the feature as
Unreleased. This plan turns the eventual release into a verified dependency,
not a version-number assumption.

## Current state

- `package.json:28-30` declares all three Pi peers as `~0.84.1`.
- `package.json:37-39` pins all three development packages to `0.84.1`.
- `pnpm-lock.yaml` resolves those packages to `0.84.1`.
- `docs/research/pi-fork-upgrade.md:3` incorrectly says the current pin is
  `0.83.0`; its checklist does not qualify `clear_queue` at runtime.
- `src/sumo-tui/rpc/spawn-child.mjs:27-41` correctly launches the public Pi CLI
  with `--mode rpc` and the stable SumoCode extension shim.
- `bin/sumocode.sh:474-523` mirrors an older Pi value-flag table. It does not
  account for current `--tui-mode` or target-main `--use-theme`, so a flag value
  can be misclassified as kickoff prompt text.
- `bin/sumocode.sh:323-326` consumes `--` rather than preserving its end-of-
  options protection for a dash-prefixed Pi prompt.
- `bin/sumocode.sh:586-625` probes legacy `dist/main.js`/`dist/cli.js`, while
  published `0.84.3` points its bin at `dist/bundle/cli.js`; `doctor` can falsely
  reject a working global install.
- `bin/sumocode.sh` must continue to bypass the foreground host for `--print`,
  explicit `--mode`, and non-TTY stdout.
- `src/sumo-tui/rpc/host-actions.ts:153-178` owns the hardcoded built-in slash
  list that `get_commands` intentionally does not supply.
- `src/approval-modal.test.ts:391-429` proves dangerous RPC bash fails closed on
  no, thrown UI, and unavailable UI.
- `scripts/smoke-pi-versions.sh` installs a named published version and proves
  direct-Pi bypass dry runs, but defaults to the old pin.

Target deltas already established by the audit:

```text
0.84.2: message_update.usage is cumulative provider usage
0.84.3: toolcall_start may include id and toolName; public bin/rpc entry files moved
next release: clear_queue command + {steering, followUp} response
```

Compatibility rules:

- accept optional fields as absent or `null` where upstream docs/source differ;
- use `get_commands[].sourceInfo`, not stale flat provenance examples;
- preserve unknown top-level events and message/content variants;
- keep `message_end.message` and `toolcall_end.toolCall` authoritative;
- resolve public package exports/CLI, never a physical `dist/main.js` path.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Published version | `npm view @earendil-works/pi-coding-agent version` | returns a published version newer than `0.84.3` |
| Inspect package | `npm pack @earendil-works/pi-coding-agent@<target> --dry-run` | shipped file list includes public RPC types/runtime/export targets |
| Install | `pnpm install --frozen-lockfile=false` | exit 0; lockfile updates only to the selected Pi line and transitive consequences |
| Focused contracts | `pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/spawn-child.test.ts src/sumo-tui/rpc/host-actions.test.ts src/approval-modal.test.ts test/integration/rpc-contract.test.ts` | all pass |
| Version smoke | `./scripts/smoke-pi-versions.sh <target>` | install, boot, and bypass probes pass |
| Launcher | `pnpm vitest run test/integration/spawn-pi-pty.test.ts test/integration/rpc-host-shell.test.ts --fileParallelism=false` | target CLI flags, delimiter, doctor, and bypass tests pass |
| Doctor | `./bin/sumocode.sh doctor` | RPC host and Pi checks pass |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- `package.json`
- `pnpm-lock.yaml`
- `bin/sumocode.sh`
- `README.md` when it displays the pinned Pi version
- `docs/research/pi-fork-upgrade.md`
- the two RPC audit notes when version status needs reconciliation
- `scripts/smoke-pi-versions.sh`
- `src/sumo-tui/rpc/client.ts` and its tests only for compatible wire parsing
- `src/sumo-tui/rpc/spawn-child.mjs` and its tests only if public export movement requires it
- `src/sumo-tui/rpc/host-actions.ts` and tests only to reconcile upstream built-ins
- `test/integration/rpc-contract.test.ts` (create)
- `test/integration/spawn-pi-pty.test.ts`
- `test/integration/rpc-host-shell.test.ts`
- committed host/extension bundles only if `pnpm build:bundles` reports them stale
- `plans/README.md` status row

**Out of scope**:

- Native queue ownership, `clear_queue` UI behavior, or the delivery toggle (Plan 090).
- Lifecycle/presentation changes (Plan 089).
- Direct bash or native image implementation (Plans 091 and 092).
- A Git dependency, Pi fork, `node_modules` patch, private constructor, or hardcoded `dist/bundle` import.
- Declaring complete classic-TUI parity; RPC still lacks compaction and branch-summary abort commands.

## Git workflow

- Branch: `advisor/088-upgrade-pi-clear-queue-contract`
- Commit subject: `chore: upgrade Pi and lock the RPC contract`
- Use tabs in TypeScript and match neighboring test helpers.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Qualify the published release before touching the repo

1. Read the published version and changelog. It must be newer than `0.84.3`.
2. Download the published tarball into a `mktemp -d` directory.
3. Inspect the tarball—not a Git checkout—for all of the following:
   - `RpcCommand` contains `{ type: "clear_queue" }`;
   - the success response contains `steering: string[]` and `followUp: string[]`;
   - the RPC dispatcher calls the session queue-clear operation;
   - the public CLI and `rpc-entry` package exports resolve;
   - `message_update.usage` and optional `toolcall_start.id/toolName` match the
     audited shapes.
4. Record the selected version and upstream release link in
   `docs/research/pi-fork-upgrade.md`.

**Verify**: package inspection finds the command in both types and runtime. If
either side is missing, STOP without editing the repository.

### Step 2: Update the Pi dependency line atomically

Set every Pi peer to the same compatible `~<target>` range and every Pi dev
dependency to the exact same `<target>` version. Update the Node engine only if
the shipped Pi manifest raises its floor. Regenerate `pnpm-lock.yaml`; do not
hand-edit lockfile resolutions.

Update the current-version text in `docs/research/pi-fork-upgrade.md` and any
README badge/version copy. Preserve the public/private package boundary.

**Verify**:

```bash
pnpm install --frozen-lockfile=false
pnpm list @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui
```

Expected: one selected version line for all three packages; no `0.84.1` Pi
resolution remains.

### Step 3: Add a shipped-worker RPC capability test

Create `test/integration/rpc-contract.test.ts`. Spawn the installed public Pi
CLI directly in RPC mode with offline/no-extension/no-session isolation, using
Node process APIs and a bounded timeout. Send an id-correlated `clear_queue`
request and assert a successful response with two arrays. Ensure the child is
terminated in `finally` on success, failure, and timeout.

Also assert that unknown optional enrichment fields do not crash the SumoCode
client and present enrichment fields are accepted. Do not test against a copied
fixture or Git-main file; this gate exists to prove the published worker.

**Verify**:

```bash
pnpm vitest run test/integration/rpc-contract.test.ts --fileParallelism=false
```

Expected: the installed worker answers `clear_queue` successfully and exits
cleanly.

### Step 4: Reconcile package-layout and command drift

Run the focused client/spawn/host-action tests. Compare Pi's current built-in TUI
command list with `RPC_HOST_SLASH_COMMANDS`; add/remove mappings only when the
host actually implements the action. Confirm the launcher still invokes public
Pi entrypoints and the direct paths never enter `sumo-rpc-host.js`.

Diff the target release's public CLI argument table and manifest against
`bin/sumocode.sh`. Update value-taking flag handling (including `--tui-mode` and
the target's `--use-theme` if shipped), preserve `--` and the following
dash-prefixed positional, and make doctor resolve the published bin/export
layout rather than only legacy physical paths. Add regression cases for both
`--flag value` and `--flag=value` forms. Keep direct `--mode`, print, and non-TTY
bypass semantics unchanged.

Feature-detect additive event fields; do not make a post-`0.84.3` optional field
mandatory unless the published union does.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/spawn-child.test.ts src/sumo-tui/rpc/host-actions.test.ts
pnpm vitest run test/integration/spawn-pi-pty.test.ts test/integration/rpc-host-shell.test.ts --fileParallelism=false
./scripts/smoke-pi-versions.sh <target>
```

Expected: all tests and install/boot/bypass smokes pass.

### Step 5: Re-run the security and runtime boundaries

Run the fail-closed dangerous-command approval tests, doctor, full unit and PTY
integration suites, visual CI, typecheck/build, and optional bundle rebuild.
Manually smoke interactive RPC boot plus direct `--print`, explicit `--mode rpc`,
non-TUI diagnostic bypass, clean Ctrl-C, slash controls, and approval denial.

Run `pnpm build:bundles`, inspect that only expected tracked
`dist/extension/**` outputs changed, then run it a second time and require a clean
diff. `dist/host/**` remains generated verification output.

Do not promote a runtime golden; captures remain review evidence until Dhruv
explicitly approves promotion.

**Verify**: every command in the table passes and `git status --short` contains
only the in-scope version, contract, documentation, and generated bundle files.

## Test plan

- Published-worker success response for empty `clear_queue`.
- Request/response id correlation and bounded child cleanup.
- Compatibility with absent and present `message_update.usage`.
- Compatibility with absent and present `toolcall_start.id/toolName`.
- Public child spawn and extension shim resolution.
- Target value flags, `--` delimiter semantics, and bundled CLI doctor lookup.
- Hardcoded slash-list/switch correspondence.
- Dangerous tool approval fails closed.
- Direct Pi bypass for print, explicit mode, and non-TTY behavior.

## Done criteria

- [ ] A published Pi release—not a Git SHA—contains `clear_queue` in shipped types and runtime.
- [ ] All three Pi packages resolve to the same selected version.
- [ ] `test/integration/rpc-contract.test.ts` proves the installed worker command.
- [ ] `./scripts/smoke-pi-versions.sh <target>` passes.
- [ ] Approval/security and built-in slash regressions pass.
- [ ] `pnpm lint`, unit, integration, visual CI, typecheck, and build pass.
- [ ] Direct Pi bypass behavior is unchanged.
- [ ] Target CLI value flags and `--` delimiter behavior are covered.
- [ ] Bundle generation is deterministic on the target release.
- [ ] Plan 088 and the index record the released version and move from BLOCKED to DONE.

## STOP conditions

- No published release contains `clear_queue` in both shipped types and runtime.
- The three Pi packages cannot be pinned to a compatible release line.
- The release requires importing a private physical `dist/...` file.
- The worker responds “unknown command” or a non-array queue payload.
- The dangerous-command approval test no longer fails closed.
- Print/explicit-mode/non-TTY execution enters the foreground RPC host.
- The launcher cannot preserve the target CLI's value/delimiter semantics.
- Required changes expand into queue UX or another downstream plan.

## Maintenance notes

- Future Pi bumps must keep the installed-worker capability test; version numbers
  and changelog text are supporting evidence, not the contract.
- `clear_queue` is text-only. This plan does not claim lossless queued-image
  recovery.
- RPC still cannot abort compaction or branch summarization, and `get_state`
  still does not expose authoritative auto-retry state. Keep those limitations
  visible in the audit and release notes.
