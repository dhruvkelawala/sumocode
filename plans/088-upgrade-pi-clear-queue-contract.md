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
> git diff --stat 42e6eec..HEAD -- \
>   package.json pnpm-lock.yaml README.md AGENTS.md \
>   bin/sumocode.sh \
>   src/sumo-tui/rpc src/extension.test.ts \
>   src/sumo-tui/rpc/clipboard-paste.ts \
>   src/sumo-tui/rpc/clipboard-paste.test.ts \
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
> RPC union, launcher bypass, or tool-boundary contract is a STOP condition until the
> plan is amended.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: first published `@earendil-works/pi-coding-agent` release whose shipped RPC runtime and public types contain `clear_queue`
- **Category**: migration / tests
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Deep-audit revision**: commit `42e6eec`, 2026-08-28
- **Issue**: [#375](https://github.com/dhruvkelawala/sumocode/issues/375)
- **Execution status**: BLOCKED — Pi `main` has `clear_queue` after `0.84.3`, but no published release contains it yet

## Outcome

SumoCode pins one published Pi release across `pi-ai`, `pi-coding-agent`, and
`pi-tui`. A package-level contract test proves that the installed worker accepts
`clear_queue` and returns `{steering, followUp}`. The compatibility suite also
locks the post-`0.84.1` event enrichments, public entrypoint layout, built-in
slash inventory, intentional non-gating built-in-tool boundary, and direct-Pi
launcher bypass.
The qualification record also pins the target release's thinking-level
contract: capability response shape, setter response payload, clamp behavior,
and change-event emission rule. Plan 089 uses that record to choose its
authoritative reconciliation path.

Plans 089–093 remain blocked until this plan is merged and its contract gate is
green. Merely seeing `clear_queue` on GitHub main is not enough.

## Why this matters

Plans 089–093 deliberately target the next stable Pi protocol rather than an
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
- `src/extension.test.ts:475-492` is the canonical full-install regression:
  SumoCode intentionally does not gate Pi's built-in bash tool. A version bump
  must preserve that boundary, not resurrect the dormant approval modal.
- `scripts/smoke-pi-versions.sh` installs a named published version and proves
  direct-Pi bypass dry runs, but defaults to the old pin. It also derives a
  recursive-delete path from unvalidated version text; the migration must use
  `mktemp -d`, quoted arguments, and trap-owned cleanup.
- `src/sumo-tui/rpc/clipboard-paste.ts` deep-imports Pi's physical
  `dist/utils/clipboard-image.js`. This existing compatibility exception must
  be qualified against the target tarball or migrated to a public export; it
  must not be silently broken by the package-layout bump.
- Pi `0.84.3` changed model/thinking persistence to opt-in
  `ModelMutationOptions.persist`. RPC setters expose no persistence flag, while
  `editor.ts` advertises `app.models.save` with no retained-host handler.
  Current-state mutation and saved-default parity are separate contracts that
  the target release must qualify explicitly.

Target deltas already established by the audit:

```text
0.84.2: message_update.usage is cumulative provider usage
0.84.3: toolcall_start may include id and toolName; public bin/rpc entry files moved
next release: clear_queue command + {steering, followUp} response
current dispatch: each input line starts independently; mutating commands are not globally serialized
```

Compatibility rules:

- accept optional fields as absent or `null` where upstream docs/source differ;
- use `get_commands[].sourceInfo`, not stale flat provenance examples;
- preserve unknown top-level events and message/content variants;
- validate response envelopes and only the authoritative fields SumoCode
  consumes; do not cast malformed known payloads into domain state;
- keep `message_end.message` and `toolcall_end.toolCall` authoritative;
- resolve public package exports/CLI, never a physical `dist/main.js` path.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Published version | `npm view @earendil-works/pi-coding-agent version` | returns a published version newer than `0.84.3` |
| Inspect package | `tmp_dir="$(mktemp -d)"; npm pack @earendil-works/pi-coding-agent@<target> --pack-destination "$tmp_dir"` | a real tarball is created in a unique cleanup-owned directory for type/runtime/export inspection |
| Install | `pnpm install --frozen-lockfile=false` | exit 0; lockfile updates only to the selected Pi line and transitive consequences |
| Focused contracts | `pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/spawn-child.test.ts src/sumo-tui/rpc/clipboard-paste.test.ts src/sumo-tui/rpc/host-actions.test.ts src/extension.test.ts test/integration/rpc-contract.test.ts` | wire, spawn, clipboard, slash, and intentional tool-boundary contracts pass |
| Version smoke | `./scripts/smoke-pi-versions.sh <supported-floor> <target>` | both advertised compatibility boundaries pass install, protocol, boot, and bypass probes |
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
- `src/sumo-tui/rpc/contract-classification.ts` and tests (create) for an
  exhaustive, non-executing command/event/extension-UI disposition matrix
- `src/sumo-tui/rpc/spawn-child.mjs` and its tests only if public export movement requires it
- `src/sumo-tui/rpc/clipboard-paste.ts` and its tests to remove or explicitly
  requalify the existing private clipboard-image layout seam
- `src/sumo-tui/rpc/host-actions.ts` and tests only to reconcile upstream built-ins
- `src/sumo-tui/rpc/editor.ts` and tests only for honest target persistence/save
  action availability
- `test/integration/rpc-contract.test.ts` (create)
- `test/integration/spawn-pi-pty.test.ts`
- `test/integration/rpc-host-shell.test.ts`
- `.github/workflows/ci.yml` for a lower-bound/target Pi compatibility lane
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
2. Create a directory with `mktemp -d`, install a trap that removes only that
   exact resolved directory, and run `npm pack ... --pack-destination` without
   `--dry-run`. Extract and inspect the real tarball. Validate `<target>` as a
   registry version; never interpolate untrusted text into a recursive-delete
   path.
3. Inspect the tarball—not a Git checkout—for all of the following:
   - `RpcCommand` contains `{ type: "clear_queue" }`;
   - the success response contains `steering: string[]` and `followUp: string[]`;
   - the RPC dispatcher calls the session queue-clear operation;
   - the public CLI and `rpc-entry` package exports resolve;
   - `message_update.usage` and optional `toolcall_start.id/toolName` match the
     audited shapes.
   - `get_available_thinking_levels` returns the active model's typed
     capabilities and whether an empty array is valid;
   - `set_thinking_level` either returns the effective level or remains a void
     success after applying Pi's clamp;
   - the session emits `thinking_level_changed` on effective change only (or
     record the target's different exact rule).
   - record whether the RPC line reader still starts command handlers
     concurrently and whether response completion order is guaranteed.
   - record whether model/thinking mutations are session-only by default,
     whether RPC exposes an official persistence command/field, and exact
     restart/new-session behavior;
   - verify the clipboard-image helper has a public export or record the exact
     shipped compatibility path that still exists.
4. Record the selected version, upstream release link, and those thinking
   semantics—including current-state versus saved-default limitations—in
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

Harden `scripts/smoke-pi-versions.sh` before passing it version arguments: use
quoted `"$@"` iteration, validate versions through the registry, create every
temporary install with `mktemp -d`, and clean only trap-owned resolved paths.
Add CI coverage for the supported peer lower bound plus the selected target; if
that matrix is impractical, narrow the published peer range to what CI actually
tests. Do not continue advertising untested `~0.84.1` patches.

### Step 3: Add a shipped-worker RPC capability test

Create `test/integration/rpc-contract.test.ts`. Spawn the installed public Pi
CLI directly in RPC mode with offline/no-extension/no-session isolation, using
Node process APIs and a bounded timeout. Send an id-correlated `clear_queue`
request and assert a successful response with two arrays. Ensure the child is
terminated in `finally` on success, failure, and timeout.

Also assert that unknown optional enrichment fields do not crash the SumoCode
client and present enrichment fields are accepted. Do not test against a copied
fixture or Git-main file; this gate exists to prove the published worker.

Add type-level/shape assertions for `get_state.thinkingLevel`,
`get_available_thinking_levels.levels`, the `set_thinking_level` response, and
`thinking_level_changed`. Do not require a live provider credential merely to
force a model clamp here; Plan 089 owns deterministic clamp/event traces using
the exact semantics recorded from the shipped session runtime.

At SumoCode's protocol boundary, add minimal command-specific normalization for
the authoritative response fields exercised by this migration. Require a real
boolean `success`, the matching command discriminator, and valid shapes for
`get_state`, model/thinking capability and mutation data, and `clear_queue`.
Preserve additive fields and unknown event types. Do not attempt an exhaustive
validator for Pi's open message/content unions.

Add a compile-exhaustive target-release classification beside the client:

- every public `RpcCommand['type']` is marked implemented, intentionally
  bypassed, downstream-plan-owned, or unsupported with a reason;
- every known `AgentSessionEvent['type']` is marked projected, scheduler-only,
  transcript-only, intentionally ignored, or downstream-plan-owned;
- every extension UI request method is mapped to its retained-host handler or an
  explicit degradation behavior.

Use `satisfies Record<...>` (or an equivalent exhaustive switch) so additive
union members fail the upgrade build until classified. This is a classification
gate, not permission to execute destructive/session-mutating commands in the
real-worker smoke. Keep unknown runtime events forward-tolerant after known
members are classified.

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

Requalify clipboard paste through the target's public exports. If no public
clipboard export exists, document the existing narrow exception and pin a
target-tarball smoke that proves it still loads; do not add another physical
`dist/...` dependency. Disable or migrate the dead `app.models.save` action
unless the target exposes an official RPC persistence capability. Never write
Pi's private settings files from SumoCode to simulate Ctrl+S.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/spawn-child.test.ts src/sumo-tui/rpc/clipboard-paste.test.ts src/sumo-tui/rpc/host-actions.test.ts src/extension.test.ts
pnpm vitest run test/integration/spawn-pi-pty.test.ts test/integration/rpc-host-shell.test.ts --fileParallelism=false
./scripts/smoke-pi-versions.sh <supported-floor> <target>
```

Expected: all tests and install/boot/bypass smokes pass.

### Step 5: Re-run the tool and runtime boundaries

Run the canonical full-install regression proving built-in tools remain
ungated, doctor, full unit and PTY
integration suites, visual CI, typecheck/build, and optional bundle rebuild.
Manually smoke interactive RPC boot plus direct `--print`, explicit `--mode rpc`,
non-TUI diagnostic bypass, clean Ctrl-C, slash controls, and separation between
direct user bash and the LLM's built-in bash tool.

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
- Malformed/missing known response fields fail as bounded protocol errors;
  additive unknown fields and events remain forward-compatible.
- Every target command, known event, and extension UI method has a compile-
  exhaustive implemented/deferred/ignored disposition.
- Target thinking capability, setter-response, clamp, and event semantics are
  recorded from the published package rather than assumed from Pi main.
- Public child spawn and extension shim resolution.
- Target value flags, `--` delimiter semantics, and bundled CLI doctor lookup.
- Hardcoded slash-list/switch correspondence.
- Full extension install does not re-register or block Pi's built-in bash tool.
- Model/thinking current-state and saved-default behavior across restart/new
  session is explicit; unsupported save UX is not advertised.
- Smoke cleanup cannot escape a `mktemp` directory through version input.
- Direct Pi bypass for print, explicit mode, and non-TTY behavior.

## Done criteria

- [ ] A published Pi release—not a Git SHA—contains `clear_queue` in shipped types and runtime.
- [ ] All three Pi packages resolve to the same selected version.
- [ ] `test/integration/rpc-contract.test.ts` proves the installed worker command.
- [ ] The target release's thinking-level response and event authority is
  recorded precisely enough for Plan 089's reconciliation tests.
- [ ] Known authoritative response payloads are normalized once before reaching
  stores; malformed fixtures cannot masquerade as successful Pi responses.
- [ ] A compile-exhaustive classification covers the target release's complete
  command, known-event, and extension-UI unions without executing unsafe verbs.
- [ ] `./scripts/smoke-pi-versions.sh <supported-floor> <target>` passes.
- [ ] Tool-boundary and built-in slash regressions pass.
- [ ] Lower-bound plus target Pi compatibility is tested, or the peer range is
  narrowed to the tested contract.
- [ ] Clipboard paste resolves on the target without adding a new private seam.
- [ ] Model/thinking persistence parity is either supported through official
  RPC or explicitly disabled/documented in SumoCode UX.
- [ ] `pnpm lint`, unit, integration, visual CI, typecheck, and build pass.
- [ ] Direct Pi bypass behavior is unchanged.
- [ ] Target CLI value flags and `--` delimiter behavior are covered.
- [ ] Bundle generation is deterministic on the target release.
- [ ] Plan 088 and the index record the released version and move from BLOCKED to DONE.

## STOP conditions

- No published release contains `clear_queue` in both shipped types and runtime.
- The three Pi packages cannot be pinned to a compatible release line.
- The release requires adding a new private physical `dist/...` import, or the
  existing clipboard exception can neither migrate to a public export nor be
  explicitly requalified against the target tarball.
- The worker responds “unknown command” or a non-array queue payload.
- The published thinking-level types and runtime disagree, or their authority
  cannot be determined from the shipped package.
- Safe normalization would require rejecting additive fields/unknown events or
  exhaustively reimplementing Pi's message schema.
- SumoCode starts gating/re-registering a Pi built-in tool, contrary to the
  canonical architecture and full-install regression.
- The target has no official model/thinking persistence seam and the product
  would continue advertising a save action as though it worked.
- Clipboard compatibility requires adding a new unqualified private import.
- Print/explicit-mode/non-TTY execution enters the foreground RPC host.
- The launcher cannot preserve the target CLI's value/delimiter semantics.
- Required changes expand into queue UX or another downstream plan.

## Maintenance notes

- Future Pi bumps must keep the installed-worker capability test; version numbers
  and changelog text are supporting evidence, not the contract.
- `clear_queue` is text-only. This plan does not claim lossless queued-image
  recovery.
- Re-qualify thinking semantics on every Pi bump. A successful setter response
  without an effective-level payload is an acknowledgement, not proof that the
  requested level survived clamping.
- Re-qualify session mutation separately from default persistence. Do not infer
  Ctrl+S/classic persistence from `set_model` or `set_thinking_level` success.
- The supported peer range is a tested compatibility claim, not package-manager
  decoration; keep CI/smoke coverage aligned with it.
- RPC still cannot abort compaction or branch summarization, and `get_state`
  still does not expose authoritative auto-retry state. Keep those limitations
  visible in the audit and release notes.
