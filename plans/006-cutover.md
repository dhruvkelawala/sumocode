# 006 — Phase 5: Cutover (flag flip, visual smoke matrix, rollback)

**Written against commit:** `ae03bc0`
**Size:** M · **Depends on:** 002, 003, 004, 005 all DONE · **Blocks:** none
**Issue:** [#294](https://github.com/dhruvkelawala/sumocode/issues/294)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

Flip the RPC host from opt-in to default with a one-release legacy rollback. Do **not** delete
the patch and its machinery in this phase; patch removal happens only after the RPC default has
survived the documented stability window. This is the irreversible-feeling step; treat it
conservatively.

**Do not start until 002–005 are all DONE.** If dangerous-command approval remains part of the
RPC product surface, Plan 005's security regression test must be green before this starts. If
approval is intentionally removed/deferred for RPC instead, that product decision must be
documented in this plan first and the RPC path must prove it does not silently fail open.

## Background facts (verified)

- The patch + its machinery to keep as one-release rollback:
  `patches/@earendil-works__pi-coding-agent@*.patch`, `pnpm.patchedDependencies` in
  `package.json`, the `sumo-interactive-mode.js` loader, `SUMO_TUI_MODULE` plumbing in
  `bin/sumocode.sh`, the `loadSumoInteractiveMode` patch-health checks in `bin/sumocode.sh` +
  `sumocode doctor`, and the missing-patch fallback.
- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` and the in-process viewport bridge
  (`chat-viewport-controller.ts` monkeypatches) become legacy-only after this phase. Do not
  remove them until the legacy path is intentionally retired.
- The visual smoke matrix and runtime goldens: `pnpm visual:ci` (V2 gate); promotion requires
  explicit human approval (`pnpm visual:promote`) per `AGENTS.md`.
- Release mechanics (per `AGENTS.md`/`DEV_LOOP.md`): bump `package.json` version + `VERSION`
  in `src/extension.ts`, tag, push tags; tagged releases are what propagate.

## Scope

**In scope:** flipping the default to the RPC host; running the smoke matrix; keeping and
testing the legacy rollback path; updating launcher, doctor, and docs; preparing the
post-stability patch-removal follow-up.

**Out of scope:** deleting the patch, `pnpm.patchedDependencies`, `sumo-interactive-mode.js`,
or dead in-process bridges; any new feature work; any visual golden promotion without explicit
human approval.

## Steps

1. **Full smoke matrix on the RPC build.** Run `pnpm visual:ci` across all lanes
   (component/fixture/runtime) plus `pnpm test`, `pnpm test:integration`, `pnpm perf:startup`.
   Confirm chat, chrome, editor, all 8 overlays, and selectors crop-match committed goldens,
   and that the Plan 005 security test is green.
   - **Verify:** all gates green; perf within the 0.4 baseline (or better) in
     `docs/perf/startup.json`. Get explicit human approval before any golden promotion.

2. **Flip the default.** Make the RPC host the default activation in `bin/sumocode.sh`.
   The patched retained path becomes the opt-in fallback, gated behind `SUMO_LEGACY=1`.
   Keep the patched path runnable for one release as rollback.
   - **Verify:** a fresh `sumocode` (no flags) boots the RPC host; `SUMO_LEGACY=1 sumocode`
     boots the patched path.

3. **Keep legacy health checks scoped to rollback.** Update launcher and doctor output so the
   patch is no longer required for the default path, but is still checked when
   `SUMO_LEGACY=1` requests the patched fallback. Do not delete patch files or patched
   dependencies in this phase.
   - **Verify:** default RPC startup does not require `loadSumoInteractiveMode`; legacy startup
     still validates the patch before exporting `SUMO_TUI_MODULE`; `pnpm exec tsc --noEmit &&
     pnpm build` clean.

4. **Docs + decision record.** Update `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` to mark the patch
   legacy/rollback-only, update `docs/research/pi-rpc-migration.md` status to "RPC default
   staged", refresh `AGENTS.md`'s "Pi patch seam" + launcher sections, and note the new
   Pi-version-bump process during the rollback window (verify RPC contract + builtin slash
   list; regenerate patch only while the legacy fallback is kept).
   - **Verify:** `AGENTS.md` no longer describes the patch as the default path; the smoke matrix
     references the security test.

5. **Rollback readiness.** Document the one-release rollback (`SUMO_LEGACY=1`) in the release
   notes and `DEV_LOOP.md`. Define the trigger to delete the legacy path entirely (e.g. 30
   stable days on RPC default).
   - **Verify:** rollback path is documented and tested once end-to-end.

## Done criteria

- A fresh `sumocode` defaults to the RPC host; the full gate (`pnpm test`,
  `pnpm test:integration`, `pnpm visual:ci`, security test) is green or has only the documented
  unrelated background-task `output.log` ENOENT caveat after all assertions pass.
- `SUMO_LEGACY=1 sumocode` boots the patched retained path and remains documented as the
  one-release rollback.
- The patch and `pnpm.patchedDependencies` are still present and treated as rollback-only.
- Docs updated; rollback documented and exercised once.

## Escape hatches — STOP and report

- If any overlay, the editor, or the security test regresses against goldens, STOP — do not
  flip the default. Fix in the relevant phase plan first.
- If perf regresses materially vs the 0.4 baseline, STOP — "same-or-better" is the
  constraint; investigate the per-delta serialization/backpressure path before flipping.
- Do not delete the legacy patched path, patch file, or patched dependency in this phase — keep
  one release of rollback.

## Test plan

- The full existing gate, run against the RPC default.
- A rollback smoke test: `SUMO_LEGACY=1` boots the patched build successfully.

## Maintenance note

After this lands, Pi version bumps primarily need: (1) re-verify the RPC contract
(`rpc-types.d.ts` diff), (2) re-check the hardcoded builtin slash list (Plan 004), and
(3) re-run the security regression test. Patch regeneration is needed only while the
`SUMO_LEGACY=1` rollback path is kept. After the stability window, write a separate patch
retirement plan to remove the legacy path and run dead-code checks.

## Execution preflight

**Ready for execute:** yes. Plans 002-005 are approved in source branches:

- Plan 002: `codex/rpc-host-shell-002-exec` (`a8643bd`, `1b7a7a4`)
- Plans 003-005: `codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`)

Use `codex/rpc-precutover-stack-clean-exec` as the source base for Plan 006. The accepted
pre-cutover stack preserved the retained RPC runtime, wired host-owned editor/controls/
overlays, and verified fail-closed dangerous-command approval in the RPC child profile.

**Latest advisor verification on the Plan 006 base:**

- Focused RPC/security/runtime suite — passed, 10 files / 96 tests.
- `pnpm exec tsc --noEmit && pnpm build` — passed.
- `pnpm test:integration` — passed, 20 files / 36 tests.
- `pnpm visual:ci` — exited 0.
- `pnpm test` — all 119 files / 1112 tests passed, but command exited 1 from the known
  unrelated background-task temp `output.log` ENOENT unhandled error.

**Cutover caution:** Plan 006 may edit launcher/source docs as part of its scope, but must not
remove patch machinery and must not touch `plans/`; the advisor owns plan status updates.

**Fresh worktree visual bootstrap:** isolated worktrees may not contain ignored
`docs/ui/bible/renders/*.png` assets. If `pnpm visual:ci` fails only with missing visual parity
assets under `docs/ui/bible/renders/`, run `pnpm render:bible` in the disposable worker
worktree, confirm it leaves no tracked source/doc drift except ignored render artifacts, and
rerun `pnpm visual:ci`. This is verification setup, not a golden promotion.

## Execution review

**Verdict:** DONE / APPROVE.

**Accepted source branch:** `codex/rpc-cutover-006-exec`
**Accepted commit:** `96a2a0a` (`feat: default sumocode to rpc host`)
**Base:** `codex/rpc-precutover-stack-clean-exec` (`573248c`)
**Executor worktree:**
`/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-rpc-cutover-006-exec`

**What landed:**

- `bin/sumocode.sh` now defaults interactive TTY launches to `sumo-rpc-host.js`.
- `SUMO_LEGACY=1` selects the patched retained rollback path for one release.
- `--print`, explicit `--mode`, and non-TTY stdout bypass the foreground RPC host and execute Pi
  directly with the SumoCode extension loaded.
- `sumocode doctor`, `AGENTS.md`, `DEV_LOOP.md`, `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`, and
  `docs/research/pi-rpc-migration.md` now describe RPC default plus legacy rollback.
- The RPC runtime emits the startup readiness diagnostics expected by `pnpm perf:startup`.
- The runtime capture path exits cleanly on harness SIGTERM so `pnpm visual:ci` can terminate
  captured RPC hosts without treating expected cleanup as an early runtime failure.

**Advisor verification rerun:**

- `pnpm vitest run src/approval-modal.test.ts src/sumo-tui/rpc/runtime.test.ts
  test/integration/rpc-host-shell.test.ts test/integration/spawn-pi-pty.test.ts
  test/integration/sumo-reload.test.ts` — passed, 5 files / 55 tests.
- `pnpm exec tsc --noEmit && pnpm build` — passed.
- `pnpm test:integration` — passed, 20 files / 39 tests.
- `pnpm visual:ci` — exited 0; review pack:
  `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-rpc-cutover-006-exec/docs/visual/out/parity/index.html`.
- `pnpm perf:startup` — exited 0; default RPC readiness diagnostics no longer time out.
  Advisor rerun measured `input-ready` average middle runs at `2032.7ms`.
- `pnpm test` — all 119 files / 1113 tests passed, but Vitest exited 1 because of the known
  unrelated background-task temp `output.log` ENOENT unhandled errors.

**Scope notes:**

- No `plans/` files were changed by the executor branch.
- Patch files, `pnpm.patchedDependencies`, `sumo-interactive-mode.js`, and legacy bridges remain
  present and rollback-only.
- No visual goldens were promoted.
- No push, merge, tag, or release action was performed.
