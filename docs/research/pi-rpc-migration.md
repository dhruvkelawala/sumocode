# Pi RPC migration: dropping the InteractiveMode patch for `pi --mode rpc`

**Status:** RPC default active; old retained fallback removed
**Date:** 2026-06-30; updated 2026-07-02 for Phase 5 cutover
**Written against:** SumoCode `0.4.0` (commit `ae03bc0`), Pi `0.79.1` pinned; latest Pi `0.80.2`
**Companion to:** [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](../SUMO_TUI_PI_PATCH_STRATEGY.md), [`docs/research/pi-fork-upgrade.md`](pi-fork-upgrade.md)
**Executable handoff:** [`plans/README.md`](../../plans/README.md) (Phase 0–5 plans, also published as issues)

## Question

Can SumoCode stop patching Pi's `dist/main.js` constructor and instead spawn Pi in its
native `--mode rpc`, becoming the **host process** that drives Pi over the JSONL RPC
protocol and renders everything itself with the existing SumoTUI retained renderer? Hard
constraint: **the UI must remain the same or better.**

## Bottom line

**Feasible and now active as the only interactive runtime path.** The Phase 0–5 migration work has
proved the host shell, controls, editor, overlays, and security-critical approval path well
enough to make the launcher default the RPC host and remove the old retained fallback.

- The transcript (the largest visual surface) ports nearly verbatim.
- The editor de-risks to a **library re-host** (pi-tui exports), not a rebuild.
- The **approval gate + rich overlays** are the dominant, *security-critical* workstream
  because of a protocol gap confirmed by reading Pi's compiled source.

The strategic prize has landed: SumoCode deleted the `dist/main.js` patch, the
per-Pi-version-bump fragility, and the old in-process runtime loader. Remaining UI parity
work should improve the RPC host and shared renderers, not revive the
`chatContainer`/`handleEvent`/`renderSessionContext` monkeypatching in
[`src/sumo-tui/pi-compat/chat-viewport-controller.ts`](../../src/sumo-tui/pi-compat/chat-viewport-controller.ts),
or the retired constructor seam.

## Why the retired patch-strategy doc's rejection does not apply

[`SUMO_TUI_PI_PATCH_STRATEGY.md`](../SUMO_TUI_PI_PATCH_STRATEGY.md) rejected "remove patch
now", but it only evaluated **reverting to in-process public extension chrome**. Every
objection it lists (lines 99–108: "own the chat viewport render loop", "intercept
`chatContainer.render()`", "bridge `handleEvent()`/`renderSessionContext()`") is a problem
of **co-habiting Pi's in-process interactive renderer**. RPC mode *eliminates that entire
class of problem* — Pi-in-RPC renders nothing; it emits JSONL events. **The RPC-host
inversion is a third option that decision table never considered.** Its own removal trigger
(line 200: "Pi exposes a public API to select/replace interactive mode at CLI startup") is
arguably already satisfied by `--mode rpc`, in a different shape than anticipated.

## Target architecture — the "Owned mode"

Two processes, clean split:

- **HOST = SumoCode** (foreground): owns the terminal (altscreen / raw-mode / SIGWINCH /
  hardware cursor), the SumoTUI retained renderer, **all** chrome, **all** overlays/modals,
  the input editor, and the transcript view-model engine. Spawns
  `node <cli> --mode rpc -e src/extension.ts <args>` and drives it over JSONL RPC.
- **PI SUBPROCESS** (unchanged): agent loop, LLM, sessions, MCP, skills, context — **plus
  SumoCode's business-logic extension still loaded via `-e`**. Verified: extension / MCP /
  skill loading happens *before* the `appMode` branch in Pi's `dist/main.js`
  (`appMode === "rpc"` vs `"interactive"`), so the `pi update && pi` ecosystem and ADR-0001
  are honored.

Business logic (memory extraction, approval *gating*, question/answer tools, fast-mode)
**stays a Pi extension inside the RPC subprocess**; only *rendering* moves to the host.

This is the long-foreseen "Owned mode" — now realizable via `runRpcMode` instead of the
patch.

## The three landmines (verified against Pi source)

These are why the hard part is overlays/approval, **not** the editor.

### 1. The approval gate ships fail-OPEN over RPC — a real security regression

Pi's RPC `ctx.ui.custom()` is a hard no-op: `async custom() { return undefined; }`
(confirmed in Pi 0.79.1 and 0.80.2 `dist/modes/rpc/rpc-mode.js`, ~line 151). SumoCode's
3-way Y/N/A approval renders through `custom()` at
[`src/approval-modal.ts:265`](../../src/approval-modal.ts). Over RPC the returned choice is
*neither* "no" *nor* "always" — the gate returns `undefined`, **and the dangerous bash
command runs ungated.** Must be rewritten before any flag-gated ship.

**Fix:** the gate logic stays in-Pi as a `tool_call` handler returning `{block:true}` (this
truly vetoes *before* `tool_execution_start`); the modal renders host-side; the block
decision round-trips through a real `extension_ui` `select` (the 3-way can't use `confirm`,
which is boolean). **Never ship the un-rewritten gate, even behind a flag.**

### 2. There is no `custom` channel in the RPC protocol at all

`custom()` is a no-op and unknown command types are rejected by the server (rpc-mode.js
~line 529–532). The protocol's *only* host↔extension UI vocabulary is the fixed
`extension_ui_request` set: `select` / `confirm` / `input` / `editor` / `notify` /
`setStatus` / `setWidget` / `setTitle` / `set_editor_text`. A bespoke "custom channel"
**cannot be added without forking Pi.**

All **8** `ctx.ui.custom<>()` call sites (current as of `ae03bc0`) must move to
host-render + `extension_ui` value round-trip:

| Site | File |
|---|---|
| approval modal | [`src/approval-modal.ts:265`](../../src/approval-modal.ts) |
| Q&A wizard | [`src/answer-tool.ts:304`](../../src/answer-tool.ts) |
| LLM extraction | [`src/answer-tool.ts:338`](../../src/answer-tool.ts) |
| question tool | [`src/question-tool.ts:116`](../../src/question-tool.ts) |
| divine query | [`src/divine-query.ts:247`](../../src/divine-query.ts) |
| command palette | [`src/command-palette.ts:316`](../../src/command-palette.ts) |
| memory editor | [`src/memory-editor.ts:399`](../../src/memory-editor.ts) |
| theme check | [`src/commands/theme-check.ts:21`](../../src/commands/theme-check.ts) |

The `src/` renderers are reused verbatim — only the trigger/return plumbing changes.

### 3. `answer-tool` / `question-tool` silently break

Their `complete()` / LLM-extraction is *nested inside the `custom()` closure*
([`src/answer-tool.ts:338`](../../src/answer-tool.ts)) that never fires over RPC, and
`hasUI()` is `true` (so the no-UI guard does not save them) → they return "Cancelled" to
the model. Requires lifting `complete()` out of the closure and branching on
`ctx.mode === 'rpc'`.

## What de-risks below the first-pass estimate

- **Transcript ports nearly verbatim.** RPC `get_messages` and the `onEvent` stream emit
  the same plain-JSON `AgentMessage` / `AgentEvent` the in-process `handleEvent` consumes;
  JSONL is lossless and in-order. The view-model already accepts `unknown`/`Record` and
  feature-detects fields — 0.4's added image-block parsing in
  [`src/sumo-tui/transcript/view-model.ts`](../../src/sumo-tui/transcript/view-model.ts)
  (feature-detecting `data`/`base64`/`source.*`) is exactly this pattern and *reinforces*
  the clean port.
- **The editor is an importable library, not a rebuild.** pi-tui's `Editor` +
  `CombinedAutocompleteProvider` are public exports, and `CustomEditor` /
  `ModelSelectorComponent` / `ThemeSelectorComponent` / `SessionSelectorComponent` /
  `BorderedLoader` are public `@earendil-works/pi-coding-agent` exports. The host
  constructs them **in-process** (no per-keystroke RPC hop) and re-wraps the Cathedral
  chrome.

## Gap matrix

| Capability | RPC provides | Difficulty | Note |
|---|---|---|---|
| Transcript / streaming / tool calls | Direct | Med | Same events; watch O(n²) per-delta `partial` snapshot + backpressure throttle. |
| Slash commands / skills enum | Direct | Low | `get_commands` (name/desc/source). |
| Sessions / models / thinking / compaction | Direct | Low | First-class typed commands. |
| Stock UI primitives | Bridge | Low | 1:1 with `extension_ui_request`; host writes the responder. |
| Editor + autocomplete + cursor | Host re-host | Med | Re-host pi-tui `Editor`; hardcode 22 builtin slash cmds (absent from `get_commands`). |
| Model/theme/resume selectors | Host re-host | Med | Public exports — import, don't rebuild. |
| Tool-approval gate UI | Bridge (rewrite) | **High** | `{block:true}` veto + host modal via `select`. **Security-critical.** |
| Rich custom overlays | Missing → re-arch | **High** | No `custom()`; host-render + `extension_ui` value round-trip. |

## Genuine capability losses (all bounded)

- **Low** — third-party extensions using `ctx.ui.custom()` overlays render nothing (your own
  UI is unaffected; re-homed first-party).
- **Low** — extension-contributed autocomplete (`pi.addAutocompleteProvider`) and
  extension-command *argument* completion have no wire surface.
- **Med** — interactive `!`/`!!` bash loses live streaming (RPC `bash` is one-shot) unless
  run host-side.

## Pi 0.80 monorepo refactor — impact

Latest Pi is **0.80.2** (2026-06-23); SumoCode is pinned **0.79.1**. The monorepo
(`github.com/earendil-works/pi`) is now `packages/{agent, ai, coding-agent, orchestrator,
tui}`.

- **`@earendil-works/pi-agent-core` extracted** ("General-purpose agent with **transport
  abstraction**, state management") — now owns the agent loop, harness, sessions,
  compaction, and `AgentEvent`/`AgentMessage` types. The "transport abstraction" framing is
  the strategic signal: Pi is decoupling the agent from its IO — exactly the seam that makes
  RPC embedding first-class and the in-process patch a worse long-term bet.
- **RPC contract is byte-stable** 0.79.1 → 0.80.2 (`rpc-types.d.ts` identical, 71 commands;
  `rpc-mode.js` changed by one character — an id-correlation bugfix). `custom()` is still a
  no-op → **the three landmines are unchanged.**
- **Patch seam moved** (`new InteractiveMode(...)` ~line 618 → 645) → the retired patch
  would have needed regenerating for 0.80; this reconfirmed the version-bump tax.
- **`@earendil-works/pi-orchestrator`** (experimental, *not yet on npm*) ships
  `RpcProcessInstance` (`packages/orchestrator/src/rpc-process.ts`): a host-side supervisor
  that spawns `pi --mode rpc`, does JSONL framing, id-correlated request/response, event
  streaming, **and `setUiRequestHandler` for the `extension_ui` round-trip** the bare
  `RpcClient` lacks. This is the exact host machinery the migration needs — it retires the
  "net-new responder" cost. **Copy the pattern now (npm 404), adopt the dependency later.**

## SumoCode 0.4 deltas — impact

0.4.0 (the worktree fan-out / background-tasks milestone) does **not** change the
conclusions:

- **No new `custom()` sites** — `/ship` and `/worktree` route through the existing
  `divine-query` overlay.
- **Seam coupling unchanged at the time** — the old in-process runtime only gained
  `showNotice()` + boot diagnostics before removal.
- **Transcript reinforced** — image-block parsing makes the view-model more
  input-source-agnostic (good for RPC; adds an image-turn case Phase 0 must replay).
- **Bigger bg-task/worktree re-test surface** (`task-manager.ts` +434, new
  `git/worktree.ts` +257) — but the cmux/pane boundary is process-level via
  `bin/sumocode.sh` launching `sumocode` per pane (see
  [`fanout-coexistence.md`](fanout-coexistence.md) and
  [`pi-cmux-agent-command-boundary.md`](pi-cmux-agent-command-boundary.md)). Under RPC each
  pane simply becomes `sumocode`-host → `pi`-rpc-child — compatible, not a new risk
  category. Synthesis fan-out (in-process `pi-subagents`) is unaffected.
- **Launcher had become more patch-invested** before retirement, but added
  startup-readiness instrumentation
  (`boot_screen_frame`/`app_ready`/`input_ready`, `docs/perf/startup.json`) — a baseline for
  the Phase-0 "same-or-better" perf gate.
- **Open item:** `extension.ts` child-bail guard (`PI_CMUX_CHILD`/`SUMOCODE_BG_CHILD`,
  ~line 125) does not cover rpc-host mode — needs a new branch.

## Phased plan (UI identical at each step)

See [`plans/`](../../plans/README.md) for executor-grade detail. Summary:

| Phase | Goal | Size |
|---|---|---|
| 0 | RPC fidelity spike + go/no-go gate (incl. live security assertion) | M |
| 1 | Host shell + RpcClient + transcript + chrome on RPC, flag-gated | M |
| 2 | `extension_ui` responder + selectors + session/model/compaction controls | M |
| 3 | Editor internalization (re-host pi-tui `Editor`) | L |
| 4 | Overlays + approval-gate rewrite + answer/question-tool refactor (security-critical) | L |
| 5 | Cutover (flag flip, visual smoke matrix, patch removal) | M |

## Recommendation

**RPC default is active.** The launcher boots `sumo-rpc-host.js` by default for
interactive TTY use. The old retained path, package patch metadata, loader, and
in-process runtime bridge are removed.

Pi version bumps primarily need: (1) re-verify the RPC contract
(`rpc-types.d.ts` diff), (2) re-check the hardcoded builtin slash list used by the RPC
editor, (3) rerun the approval/security regression test, and (4) confirm direct Pi
non-interactive bypasses still work.

## Biggest unknown

Can the in-Pi-tool + host-rendered-overlay round-trip faithfully reproduce *all* rich
Cathedral overlays at same-or-better parity, given there is no `custom()` back-channel and
the only vocabulary is the fixed `extension_ui` set? This — not the editor — determines
whether the hard "same-or-better" constraint is satisfiable without forking Pi, and it is the
item Phase 0 must spike end-to-end.
