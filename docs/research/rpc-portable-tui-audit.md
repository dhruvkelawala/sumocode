# RPC portable TUI audit

**Status:** audit conclusion and replacement plan track
**Date:** 2026-07-02
**Current branch:** `codex/rpc-migration-no-seam`
**Current HEAD:** `a3966a7`
**Canonical TUI baseline:** `main` at `c744cd2`

## Bottom line

The RPC migration broke UX because the branch turned `src/sumo-tui/rpc/` into a
second SumoCode application. It reimplemented the shell, stdin routing,
transcript pumping, command handling, extension UI handling, and visual fixtures
instead of making the existing retained TUI portable across backends.

The correct next direction is:

1. Keep the current main branch retained TUI as the canonical product surface.
2. Extract backend-neutral shell, transcript, input, and region contracts from
   the current retained implementation.
3. Make Pi in-process and Pi RPC just two backend adapters.
4. Remove the duplicated RPC full-frame renderer after RPC can drive the shared
   shell.
5. Verify parity against the canonical main TUI, not only against synthetic RPC
   fixtures or Bible crops.

## Findings

### ARCH-01: RPC owns a parallel full-frame shell

`src/sumo-tui/rpc/runtime.ts` imports product UI primitives directly and
reassembles the whole screen:

- `renderTopChrome`, `renderFooterBlock`, `renderInputFrame`
- `createSplashTree`
- `createSidebarTree`
- `ChatPager`
- `CellBuffer`, `composite`, and `diffFrames`

It then defines its own `renderSplashFrame`, `renderActiveFrame`, bottom rows,
sidebar snapshot, active hint, footer snapshot, and overlay painting. That
duplicates responsibilities already held by
`src/sumo-tui/pi-compat/owned-shell-renderer.ts`, which has the real product
layout decisions: splash/active switching, input centering, top chrome gap,
sidebar reservation, widget rows, pending messages, footer pinning, overlay
composition, selection, and hardware cursor propagation.

The user-visible regressions match that duplication:

- splash cursor painted at the end of placeholder instead of the live editor
  cursor path,
- prompt text duplicated into the active input,
- sidebar background/color drift,
- shell/footer/sidebar spacing differences.

### ARCH-02: RPC forks product behavior, not just transport

`src/sumo-tui/rpc/host.ts` creates the client, state store, transcript pump,
controls, editor, modal manager, overlay manager, notifications, action router,
and runtime in one host process.

`src/sumo-tui/rpc/host-actions.ts` then reimplements command palette choices,
model/thinking/session/settings flows, memory commands, theme commands, and
approval preview behavior. `src/sumo-tui/rpc/editor.ts` hard-codes the Pi 0.79
builtin slash command list because the RPC command surface does not provide all
argument completion behavior.

Some of this host-side behavior is unavoidable because Pi RPC has no `custom`
channel, but it must be isolated as backend/control adapters. It must not be
mixed into the shell renderer.

### ARCH-03: Canonical chrome publication was removed, not replaced

On `main`, `top-chrome.ts` and `sidebar.ts` publish real components into the
retained runtime when it exists. On this branch, `top-chrome.ts` says the RPC
host renders its own top chrome, and `sidebar.ts` installs only a Pi overlay
widget. The RPC runtime then fabricates a sidebar snapshot with incomplete data
such as empty memory and one synthetic session.

That lost the important boundary: product modules should publish components or
snapshots into a retained shell, while backend adapters supply state and
requests. RPC should not need a hand-built sidebar snapshot inside its frame
renderer.

### ARCH-04: Transcript ingestion was forked

`src/sumo-tui/rpc/transcript-pump.ts` folds messages and live tool events on its
own. The existing `chat-viewport-controller.ts` already handles message start,
message update, message end, live tool execution, compaction summaries, resume
hydration, streaming deltas, selection state, and `ChatPager` updates.

Maintaining two event pumps risks losing Track B fixes again. The next plan
should extract a shared transcript controller that accepts backend events and
writes to `ChatPager`.

### CORRECTNESS-05: Input routing was forked

`RpcHostRuntime.handleInput` handles modal/editor fallthrough plus Ctrl-C and
`q`/Esc. The existing retained input bridge handles SGR mouse batches, partial
mouse-byte buffering, multiline paste normalization, chat scroll commands,
selection copy keys, and forwarding rewritten input to Pi.

The keybinding and double-input reports are consistent with this split. RPC
needs a shared input router with backend-specific submit/control callbacks.

### TEST-06: Runtime parity can pass through synthetic fixtures

The active runtime visual scenarios run `./bin/sumocode.sh`, but set
`SUMOCODE_VISUAL_RPC_FIXTURE=completed-active`. That validates a synthetic RPC
scene, not a real child session with extension UI requests, event ordering,
working indicators, and lifecycle behavior.

The harness also gates against Bible crops and approved runtime goldens, but it
does not currently compare the RPC branch against the current main retained TUI
for the same terminal dimensions and scripted inputs.

## What should be reimplemented

Reimplementation is only justified at backend boundaries:

- RPC process supervision and JSONL command/event transport.
- RPC control adapter for model, thinking, session, compaction, prompts, and
  stats.
- RPC extension UI responder for Pi's fixed `extension_ui_request` vocabulary.
- Host-side replacement flows for first-party rich `custom()` overlays that Pi
  RPC cannot carry.
- Adapter code that maps RPC events and state into shared shell/transcript/input
  interfaces.

The retained shell, sidebar/top chrome/footer composition, editor leaf cursor
path, transcript folding, input routing, region mounting, selection, and visual
parity rules should be shared.

## Replacement plan track

The old Track C is no longer sufficient. Plans 016 and 017 marked parity as
done after composing RPC from existing-looking pieces, but that still left a
parallel shell. Track D replaces that approach:

- 018: Canonical main-TUI baseline and RPC rejection harness.
- 019: Extract a backend-neutral retained shell package.
- 020: Rehost RPC on the portable shell and delete duplicate frame composition.
- 021: Extract shared transcript ingestion.
- 022: Use shared extension UI regions and chrome publication.
- 023: Use shared input routing, keybindings, mouse, paste, and selection.
- 024: Real-runtime UI parity verification and approval evidence.

