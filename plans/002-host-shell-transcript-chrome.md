# 002 — Phase 1: Host shell + transcript + chrome on RPC (flag-gated)

**Written against commit:** `ae03bc0`
**Size:** M · **Depends on:** 001 returns GO · **Blocks:** 003, 006
**Issue:** [#290](https://github.com/dhruvkelawala/sumocode/issues/290)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

Stand up a real SumoCode **host process** that spawns Pi over `--mode rpc`, renders the
transcript from the RPC event stream, and re-homes the static chrome (footer, top-chrome,
splash, hint row, working/compaction indicators) — all behind a new env flag, with the
patched interactive build remaining the default. This is the spine of the migration. After
this phase, chat + chrome are pixel-stable on RPC; editor and overlays are NOT yet ported
(they stay disabled in the RPC path until 003–005).

**Do not proceed unless `plans/001-VERDICT.md` records GO.**

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
   - **Verify:** prompting in the RPC build produces a streamed assistant message, thinking,
     and tool call/result rendering identical to the patched build. Replay the Plan 001
     `events-*.jsonl` fixtures through `handleAgentEvent` in a new fixture-lane test.

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

## Done criteria

- `pnpm exec tsc --noEmit && pnpm build` clean.
- `pnpm test` and `pnpm test:integration` green (existing suites unaffected; new fixture-lane
  transcript test added and green).
- `pnpm visual:ci` green for chat + chrome on the RPC runtime lane (no crop regressions vs
  committed goldens).
- `pnpm perf:startup` for the RPC path recorded and compared to the 0.4 baseline in
  `docs/perf/startup.json`; note any regression.
- With the flag unset, the default patched build is provably unchanged.

## Escape hatches — STOP and report

- If chrome cannot be sourced from RPC state at parity (e.g. a footer datum has no `get_state`
  / `get_session_stats` equivalent), STOP and list the missing data — it may need a polling
  workaround or a Pi upstream request.
- If `pnpm visual:ci` shows a non-cosmetic transcript regression that is not a known
  intentional diff, STOP — transcript parity is the floor for this migration.

## Test plan

- New fixture-lane test: feed Plan 001 `events-*.jsonl` through `handleAgentEvent`, assert the
  resulting view-model matches a committed snapshot. Follow the existing fixture-lane pattern
  in `src/sumo-tui/transcript/view-model.test.ts`.
- A host-shutdown integration test (SIGTERM → child exits, no orphan).

## Maintenance note

This phase deliberately leaves the editor and overlays disabled in the RPC path. Reviewers:
ensure no `ctx.ui.custom`/`setEditorComponent` call is silently no-op'd in the RPC path
without a tracking TODO pointing at Plan 004/005. Keep the patched path the default until
Plan 006.
