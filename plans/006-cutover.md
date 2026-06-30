# 006 — Phase 5: Cutover (flag flip, visual smoke matrix, rollback)

**Written against commit:** `ae03bc0`
**Size:** M · **Depends on:** 002, 003, 004, 005 all DONE · **Blocks:** none
**Issue:** [#294](https://github.com/dhruvkelawala/sumocode/issues/294)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

Flip the RPC host from opt-in to default, then delete the patch and its machinery — but only
after the full visual smoke matrix and the security test pass, and with a one-release
rollback ready. This is the irreversible-feeling step; treat it conservatively.

**Do not start until 002–005 are all DONE and Plan 005's security regression test is green.**

## Background facts (verified)

- The patch + its machinery to remove (per `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` §"Removal
  plan"): `patches/@earendil-works__pi-coding-agent@*.patch`,
  `pnpm.patchedDependencies` in `package.json`, the `sumo-interactive-mode.js` loader,
  `SUMO_TUI_MODULE` plumbing in `bin/sumocode.sh`, the `loadSumoInteractiveMode` patch-health
  checks in `bin/sumocode.sh` + `sumocode doctor`, and the missing-patch fallback.
- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` and the in-process viewport bridge
  (`chat-viewport-controller.ts` monkeypatches) become dead in the RPC path — remove only
  after the RPC path is the sole path.
- The visual smoke matrix and runtime goldens: `pnpm visual:ci` (V2 gate); promotion requires
  explicit human approval (`pnpm visual:promote`) per `AGENTS.md`.
- Release mechanics (per `AGENTS.md`/`DEV_LOOP.md`): bump `package.json` version + `VERSION`
  in `src/extension.ts`, tag, push tags; tagged releases are what propagate.

## Scope

**In scope:** flipping the default to the RPC host; running + promoting the smoke matrix;
deleting the patch and dead in-process bridges; updating launcher, doctor, and docs;
preparing the rollback.

**Out of scope:** any new feature work. This phase only flips and cleans up.

## Steps

1. **Full smoke matrix on the RPC build.** Run `pnpm visual:ci` across all lanes
   (component/fixture/runtime) plus `pnpm test`, `pnpm test:integration`, `pnpm perf:startup`.
   Confirm chat, chrome, editor, all 8 overlays, and selectors crop-match committed goldens,
   and that the Plan 005 security test is green.
   - **Verify:** all gates green; perf within the 0.4 baseline (or better) in
     `docs/perf/startup.json`. Get explicit human approval before any golden promotion.

2. **Flip the default.** Make the RPC host the default activation in `bin/sumocode.sh`
   (`SUMO_TUI`/patched path becomes the opt-in fallback, gated behind a flag like
   `SUMO_LEGACY=1`). Keep the patched path runnable for one release as rollback.
   - **Verify:** a fresh `sumocode` (no flags) boots the RPC host; `SUMO_LEGACY=1 sumocode`
     boots the patched path.

3. **Remove the patch + dead bridges.** Delete the patch files, `pnpm.patchedDependencies`,
   the `sumo-interactive-mode.js` loader, `SUMO_TUI_MODULE` plumbing, and the
   patch-health checks. Remove the now-dead `sumo-interactive-mode.ts` + viewport-bridge
   monkeypatches. Update `sumocode doctor` so a missing patch is no longer a failure
   condition. Run `pnpm dead-code:strict` (knip) to catch leftovers.
   - **Verify:** `pnpm install` no longer applies a patch; `pnpm exec tsc --noEmit && pnpm build`
     clean; `pnpm dead-code:strict` reports no new dead exports introduced by the removal;
     full suite + `pnpm visual:ci` still green.

4. **Docs + decision record.** Update `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` to mark the patch
   removed (or supersede it), update `docs/research/pi-rpc-migration.md` status to "shipped",
   refresh `AGENTS.md`'s "Pi patch seam" + launcher sections, and note the new Pi-version-bump
   process (no patch regen; verify RPC contract + builtin slash list instead).
   - **Verify:** `AGENTS.md` no longer instructs regenerating the patch on Pi bumps; the
     smoke matrix references the security test.

5. **Rollback readiness.** Document the one-release rollback (`SUMO_LEGACY=1`) in the release
   notes and `DEV_LOOP.md`. Define the trigger to delete the legacy path entirely (e.g. 30
   stable days on RPC default).
   - **Verify:** rollback path is documented and tested once end-to-end.

## Done criteria

- A fresh `sumocode` defaults to the RPC host; the full gate (`pnpm test`,
  `pnpm test:integration`, `pnpm visual:ci`, security test) is green.
- The patch and `pnpm.patchedDependencies` are gone; `pnpm install` applies no patch.
- `pnpm dead-code:strict` clean for the removal.
- Docs updated; rollback documented and exercised once.

## Escape hatches — STOP and report

- If any overlay, the editor, or the security test regresses against goldens, STOP — do not
  flip the default. Fix in the relevant phase plan first.
- If perf regresses materially vs the 0.4 baseline, STOP — "same-or-better" is the
  constraint; investigate the per-delta serialization/backpressure path before flipping.
- Do not delete the legacy patched path in the same release that flips the default — keep one
  release of rollback.

## Test plan

- The full existing gate, run against the RPC default.
- A rollback smoke test: `SUMO_LEGACY=1` boots the patched build successfully.

## Maintenance note

After this lands, Pi version bumps no longer need a patch regen — but DO need: (1) re-verify
the RPC contract (`rpc-types.d.ts` diff), (2) re-check the hardcoded builtin slash list
(Plan 004), and (3) re-run the security regression test. Fold these into the
`docs/SUMO_TUI_PI_PATCH_STRATEGY.md` smoke matrix's successor.
