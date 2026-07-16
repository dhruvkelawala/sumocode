# Plan 034: Legacy cleanup — keep only what the RPC architecture needs

> **Executor instructions:** Base your worktree on the Track D integration
> branch (plan 033) once it exists — this plan runs LATE, after batches B9 and
> plan 030 land, because several keep-until items become deletable only then.
> **Every deletion below requires Dhruv's explicit approval first** (AGENTS.md
> non-negotiable: no file removal without approval). The reviewer will present
> the deletion list; do not start until the plan status says APPROVED-TO-RUN.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (deletions; mitigated by the verified reachability evidence)
- **Depends on:** audit `wf_cb2e8557-a69` (2026-07-03, adversarially verified),
  fix batch B9 (incremental chat sink), plan 030, plan 033
- **Category:** tech-debt
- **Planned at:** `b52ed45` + audit, 2026-07-03
- **Approval gate:** NOT YET APPROVED — Dhruv must approve the DELETE list.

## Why this matters

The seam removal left ~20 verified dead or stale artifacts: unreachable
pi-compat modules, demo-era fallbacks, dead env plumbing, stale docs, and a
knip config that produces false leads. Each was confirmed dead by two
independent adversarial verification passes (reachability from
`src/extension.ts`, `sumo-rpc-host.js`, `bin/sumocode.sh`, tests, and harness
scripts). The keep-until items are extraction donors or attachment points for
still-pending work and must NOT be deleted yet.

## DELETE (each pre-verified; re-verify reachability before deleting — a new
importer since the audit is a STOP)

1. `src/sumo-tui/pi-compat/pi-interactive-adapter.ts` (+ its test) — seam
   leftover, unreachable.
2. `src/sumo-tui/pi-compat/foreign-extension-warning.ts` (+ test) — unreachable,
   referenced by no plan.
3. `src/sumo-tui/pi-compat/retained-shell-transition.ts` (+ test) — unreachable.
   Also delete/absorb `splash-thinking-fix.test.ts`, which only exercises it.
4. `src/sumo-tui/pi-compat/bash-execution-mirror.ts` (+ test) — only importer
   is the reference-only chat-viewport-controller.
5. `src/sumo-tui/input/shared-input-router.ts` — remove the never-invoked
   `SharedInputRouterCallbacks.requestExit` field (line ~17) and its call-site
   plumbing in the host.
6. `src/sumo-tui/rpc/runtime.ts` — remove the editor-less "press q to quit"
   fallback (lines ~153-159): host.ts always wires an editor; the fallback's
   only reachable effect is a surprise exit on inputs containing `q`.
7. `src/sumo-tui/rpc/visual-fixtures.ts` + the `SUMOCODE_VISUAL_RPC_FIXTURE`
   injection path in `host.ts` — nothing sets the env var anymore (fixture
   lane uses its own pipeline). Remove the `rpcVisualFixtureFromEnv` branch
   and the module, plus the `visualFixture` guards it feeds.
8. `bin/sumocode.sh` — remove the exported-but-never-read `SUMO_RPC` selector
   and the doctor's "Pi main" constructor-patch check + patch-era comments
   (replace the doctor check with one that verifies `pi --mode rpc`
   availability and `sumo-rpc-host.js` presence).
9. `scripts/diag-task-auto-exit.mjs` — knip-orphan manual diagnostic,
   referenced only from a comment.
10. `scratch/rpc-spike/` — delete the 19 git-tracked files NOT referenced by
    tests; the 7 live fixture files (event/message JSONL used by tests) MOVE
    to `test/fixtures/rpc-spike/` (update importers), then remove the
    `.gitignore` scratch entry contradiction.
11. `src/spike/cmux-background/` — completed spike, functionality
    re-implemented in `src/background-tasks/`; delete with its tests (spike
    policy: promote-or-delete).
12. README + docs: remove the four stale private-Pi-patch descriptions in
    `README.md`; fix the stale `chat-viewport-controller` comments in
    `src/sidebar.ts:300` and `src/compaction-state.ts:6`.

## KEEP-UNTIL (do NOT delete in this plan; re-inventory after the named work)

- `src/sumo-tui/pi-compat/chat-viewport-controller.ts` (1009 lines) — runtime-
  dead but the behavioral oracle/extraction donor for batch B9 and plan 030
  fixtures. Delete in a follow-up after both land.
- `src/sumo-tui/pi-compat/owned-shell-renderer.ts` wrapper — plan 019's
  extraction source; survives only to feed its own test. Delete after 024
  approval confirms the extracted shell is final.
- `src/sumo-tui/rpc/editor.ts` `createNoopKeybindings` — load-bearing fallback
  until fix batch B6 (real KeybindingsManager) lands, then dead.
- `src/sumo-tui/transcript/controller.ts` seam-era options
  (`chat`/`scheduleRender`/resume-profiler hooks/`replaceFromSessionContext`)
  — B9's attachment points; prune whatever B9 leaves unused.
- `src/sumo-tui/transcript/transcript-pump.ts` live-state accessors — possible
  chrome-state inputs; re-check after D4 lands.

## ALSO FIX (not deletions)

- `knip.json`: add `sumo-rpc-host.js` and the JSON-driven visual scripts as
  entry points so knip stops producing false dead-code leads; remove the
  orphan `patches/**` ignore. Re-run `pnpm exec knip` and attach the delta to
  the report. The "130 unused exports" bulk is export-tightening, not
  deletion — file it as a follow-up note, do not chase here.

## Verification

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm exec knip 2>&1 | tail -30   # attach; expect fewer false leads, no new real ones
grep -rn "SUMO_RPC\|SUMOCODE_VISUAL_RPC_FIXTURE\|pi-interactive-adapter\|retained-shell-transition\|bash-execution-mirror\|foreign-extension-warning" src/ bin/ scripts/ --include="*" | grep -v test  # → no production matches
```

## Done criteria

- [ ] Every DELETE item removed (or individually reported as STOP with the new
  importer that appeared); every KEEP-UNTIL untouched
- [ ] Full battery green; knip delta attached
- [ ] `git log` shows one commit per DELETE group with the reachability
  argument in the body
- [ ] No file outside the lists touched

## STOP conditions

- Any DELETE target has gained an importer since `b52ed45` — report, skip it.
- A deletion breaks a test that is NOT the artifact's own colocated test.
- The approval gate in Status is not APPROVED-TO-RUN.
