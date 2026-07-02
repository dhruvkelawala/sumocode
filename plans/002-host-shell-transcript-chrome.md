# 002 — Phase 1: Host shell + transcript + chrome on RPC (flag-gated)

**Written against commit:** `15a47c7`
**Size:** M · **Depends on:** 001 returns GO · **Blocks:** 003, 006
**Issue:** [#290](https://github.com/dhruvkelawala/sumocode/issues/290)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)
**Status:** DONE — executed in `codex/rpc-host-shell-002-exec` (`c643b75`, `6bdf876`)

## Why this exists

Stand up a real SumoCode **host process** that spawns Pi over `--mode rpc`, renders the
transcript from the RPC event stream, and re-homes the static chrome (footer, top-chrome,
splash, hint row, working/compaction indicators) — all behind a new env flag, with the
patched interactive build remaining the default. This is the spine of the migration. After
this phase, cold-load chat + chrome are stable on RPC, live transcript fixtures replay through
the retained view-model, and a node-pty smoke proves SumoCode boots and cleans up. The editor
and overlays are NOT yet ported (they stay disabled in the RPC path until 003–005).

**Do not proceed unless `plans/001-VERDICT.md` records GO.**

## Post-spike caveat decisions

- The approval-gate caveat does not block this phase. This phase must not attempt the approval
  rewrite, and must not make approval-dependent dangerous-command flows reachable over RPC.
  If an approval-dependent path is encountered, disable/defer it with a clear TODO for Plan 005.
- `get_messages` is a hydration/backfill API, not the live transcript source. Live partials,
  including task/tool progress, must flow through `AgentEvent` handling.
- Performance is not promised to improve. Keep the startup/perf measurement, but judge this phase
  on correctness, runtime proof, and maintaining the default patched path unchanged.
- Build the reusable runtime proof now: extend the existing node-pty integration harness rather
  than relying on manual boot output.

## Background facts (verified)

- Today SumoCode activates via the patch: `bin/sumocode.sh` sets `SUMO_TUI=1` +
  `SUMO_TUI_MODULE`, and `patches/@earendil-works__pi-coding-agent@0.79.1.patch` swaps
  `new InteractiveMode(...)` → `new SumoInteractiveMode(...)`. The RPC path must NOT use the
  patch — it spawns plain `pi --mode rpc`.
- The retained renderer (SumoTUI) lives in `src/sumo-tui/`. Chrome producers today call Pi's
  extension UI (`ctx.ui.setFooter`/`setHeader`/etc.) which SumoCode's
  `src/sumo-tui/pi-compat/extension-ui-adapter.ts` intercepts and renders. Over RPC those
  `set*` calls are no-ops on the Pi side, so chrome must be sourced host-side from RPC state.
- RPC state sources: `get_state` (model, thinking, streaming, session id/name, message
  counts), the `AgentEvent` stream (`agent_start`/`agent_end` → derive `isStreaming`),
  `get_session_stats` (token/context/cost — **must be polled**, not pushed).
- RPC prompt source: Pi's RPC protocol accepts `{"type":"prompt","message":"..."}` and streams
  async `AgentEvent` records after the prompt is accepted. Keyboard editor submission is still
  out of scope for this phase; tests that need a live prompt should call the RPC prompt command
  through the host/client layer, not fake an editor.
- Region rendering primitive: `src/sumo-tui/pi-compat/region-registry.ts` (chrome regions
  are published here today).
- Git-branch in the footer comes from Pi's FooterDataProvider today; over RPC it must be a
  host-side watcher.
- Reference host machinery: `RpcProcessInstance` (see Plan 001 background).
- Module load order is defined in `src/extension.ts` (the `installX` sequence).

## Scope

**In scope:**
- New host entrypoint (e.g. `src/host/rpc-host.ts` + a launcher branch).
- A host-side RPC client wrapper (framing, id correlation, event pump, `extension_ui`
  responder *skeleton* — full responder is Plan 003).
- `onEvent → handleAgentEvent` transcript pump feeding the existing view-model + ChatPager.
- `get_messages → replaceViewModels` for cold-load/resume.
- Re-homing footer / top-chrome / splash / input-hints / working-indicator /
  compaction-indicator to direct `region-registry` invocation sourced from RPC state.
- Host-side git-branch watcher.
- A node-pty SumoCode RPC smoke harness, preferably by extending
  `test/integration/spawn-pi-pty.ts` or adding a sibling `spawn-sumocode-pty.ts` that reuses its
  terminal-state probes.
- A new activation flag (e.g. `SUMO_RPC=1`) wired through `bin/sumocode.sh` as an opt-in,
  non-default path. The `extension.ts` child-bail guard (`PI_CMUX_CHILD`/`SUMOCODE_BG_CHILD`,
  ~line 125) gains an rpc-host branch.

**Out of scope (do NOT touch in this phase):** the 8 `ctx.ui.custom<>` overlays
(Plan 005), the editor (Plan 004), the `extension_ui` *full* responder (Plan 003), removing
the patch (Plan 006). The default path stays the patched build.

## Steps

1. **Host entrypoint.** Create the host process that spawns
   `pi --mode rpc -e src/extension.ts`, sets up JSONL framing + id correlation + event
   listeners, and a graceful shutdown (SIGTERM to child, drain stdin, await exit). Reuse the
   Plan 001 spike host as a reference, written properly with types from
   `@earendil-works/pi-coding-agent` (`RpcCommand`/`RpcResponse`/`RpcExtensionUIRequest`).
   - **Verify:** `SUMO_RPC=1 bin/sumocode.sh --offline --no-extensions --no-session` boots,
     spawns a child Pi rpc process, and renders an empty splash without crashing.

2. **Transcript pump.** Wire `onEvent(event) → handleAgentEvent(event)` to drive the existing
   view-model + ChatPager. On cold-load/resume, call `get_messages` and replace view-models.
   Delete (in the RPC path only) the chatContainer/handleEvent/renderSessionContext
   monkeypatch usage — the RPC path must not reach into Pi internals.
   - **Verify:** replay the Plan 001 `events-*.jsonl` fixtures through `handleAgentEvent` in a
     new fixture-lane test. If a live prompt test is added in this phase, drive it through the
     RPC `prompt` command rather than keyboard editor input.

3. **Chrome re-homing.** Re-source footer (model, branch, token/context bar, fast-mode label),
   top-chrome, splash, input-hints, working-indicator, compaction-indicator from `get_state`
   + event stream + polled `get_session_stats`. Implement the host-side git-branch watcher.
   Indicators keep their own animation timers; only the numeric token/context bar polls.
   - **Verify:** `pnpm visual:ci` passes for the runtime lane pointed at the RPC host; footer/
     header/hint/splash/indicators crop-match the patched build.

4. **Flag + guard.** Add `SUMO_RPC=1` to `bin/sumocode.sh` as opt-in (default unset → patched
   path unchanged). Add the rpc-host branch to the `extension.ts` child-bail guard so a
   spawned rpc-host child does not double-install.
   - **Verify:** with `SUMO_RPC` unset, behavior is byte-identical to today (run the existing
     integration suite). With `SUMO_RPC=1`, the RPC path activates.

5. **PTY runtime proof.** Extend the integration harness so tests can spawn
   `bin/sumocode.sh` itself with `SUMO_RPC=1`, `--offline`, `--no-extensions`, `--no-session`,
   and `--approve`. Assert the RPC host enters altscreen, renders a recognizable SumoCode/RPC
   empty state, remains alive long enough to be observed, and exits altscreen/cleans up after
   SIGINT or SIGTERM.
   - **Verify:** add a targeted integration test and run it directly before the full suite.

## Done criteria

- `pnpm exec tsc --noEmit && pnpm build` clean.
- `pnpm test` and `pnpm test:integration` green (existing suites unaffected; new fixture-lane
  transcript test added and green).
- A node-pty integration test proves `SUMO_RPC=1 bin/sumocode.sh --offline --no-extensions
  --no-session --approve` boots the RPC host, stays alive, and cleans terminal state on signal.
- `pnpm visual:ci` green for chat + chrome on the RPC runtime lane (no crop regressions vs
  committed goldens).
- `pnpm perf:startup` for the RPC path recorded and compared to the 0.4 baseline in
  `docs/perf/startup.json`; note any regression.
- With the flag unset, the default patched build is provably unchanged.

## Escape hatches — STOP and report

- If chrome cannot be sourced from RPC state at parity (e.g. a footer datum has no `get_state`
  / `get_session_stats` equivalent), STOP and list the missing data — it may need a polling
  workaround or a Pi upstream request.
- If the RPC host cannot boot and stay alive under node-pty, STOP — a print-and-exit smoke is
  not enough for this migration.
- If an approval-dependent dangerous-command path becomes reachable before Plan 005, STOP unless
  it fails closed or is explicitly disabled in RPC.
- If `pnpm visual:ci` shows a non-cosmetic transcript regression that is not a known
  intentional diff, STOP — transcript parity is the floor for this migration.

## Test plan

- New fixture-lane test: feed Plan 001 `events-*.jsonl` through `handleAgentEvent`, assert the
  resulting view-model matches a committed snapshot. Follow the existing fixture-lane pattern
  in `src/sumo-tui/transcript/view-model.test.ts`.
- A host-shutdown integration test (SIGTERM → child exits, no orphan).
- A node-pty `bin/sumocode.sh` RPC smoke that uses the existing write-buffer terminal probes for
  altscreen, cursor visibility, mouse mode, and cleanup sequence.

## Maintenance note

This phase deliberately leaves the editor and overlays disabled in the RPC path. Reviewers:
ensure no `ctx.ui.custom`/`setEditorComponent` call is silently no-op'd in the RPC path
without a tracking TODO pointing at Plan 004/005. Keep the patched path the default until
Plan 006.

## Execution review

- **Implementation branch:** `codex/rpc-host-shell-002-exec`
- **Implementation commits:** `c643b75 feat: add rpc host shell`, `6bdf876 fix: render rpc transcript messages`
- **Advisor verdict:** APPROVE. Scope is source/test/runtime only; no net `docs/`, `plans/`,
  `.gitignore`, or `scratch/` changes in the worker branch.
- **Verification:** targeted RPC/PTY suite passed (6 files, 20 tests); `pnpm exec tsc --noEmit &&
  pnpm build` passed; `pnpm test:integration` passed (20 files, 36 tests); `pnpm visual:ci`
  exited 0 after ignored Bible render assets were generated locally for the isolated worktree.
- **Known caveat:** full `pnpm test` reported 113 files / 1037 tests passed, then exited 1 from
  the pre-existing background-task temp `output.log` ENOENT timer issue in
  `src/background-tasks/task-manager.ts`, not from the RPC host changes.
