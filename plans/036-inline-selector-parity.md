# Plan 036: In-place selectors — stop selector commands taking over the full screen

> **Executor instructions**: Follow step by step; commit per selector migrated.
> Base on the current `integrate/track-d` tip; commit to `feat/inline-selectors`
> and hand the reviewer the SHA (do NOT move the ref the user has checked out).

## Status

- **Priority**: P1 (jarring, high-frequency UX regression vs Pi/main)
- **Effort**: M
- **Depends on**: none; coordinate with plan 035 (it changes selector *content*; this changes the *container*)
- **Category**: UX parity
- **Planned at**: `549095d`, 2026-07-03
- **Source audit**: workflow findings 2026-07-03 (agent a9f9d1e6134445eea)

## Why this matters — and what the audit corrected

The reported problem was "slash commands open a full-screen modal; Pi's inline
is better." The audit found the **inline autocomplete is not the problem** — it
already works and matches Pi byte-for-byte: `CathedralEditor` leaves Pi's real
`Editor`/`CombinedAutocompleteProvider` in charge, so typing `/` triggers Pi's
own inline dropdown under the input frame (`cathedral-editor.ts:29-32,343-356`;
`editor.js:920-922`; identical to main). The command palette (Ctrl+/) is also
fine — a floating 80%-box that leaves the transcript visible.

The actual regression: after you autocomplete `/model` (or `/thinking`,
`/sessions`, `/settings`, bare `/fork`) and press Enter, the payoff is a
**full-viewport `ModalLayer` backdrop** (`modal-layer.ts:101-123`, `centerRows`
paints a `surfaceRecess` backdrop across the entire `rows × cols` and hides the
transcript) with a small centered card. Pi does the opposite: `showSelector()`
(`interactive-mode.js:3252-3263`) clears the **editor region only** and mounts
the selector *there*, leaving the transcript above fully visible — a
lightweight in-place swap, no backdrop, no takeover.

Root cause (structural, not a routing bug): the RPC host can't call Pi's
`InteractiveMode.showSelector()` — that method and its `editorContainer` live
only inside the headless `pi --mode rpc` child, which renders nothing. So the
host authors reused the pre-existing full-screen `ModalLayer` widget for these
selectors instead of building an in-place, editor-region-swap equivalent.

## Current state

- Selector commands route to `this.modals.select(...)` (`ModalLayer`):
  `host-actions.ts:338-345` `openModelSelector`, `:357-361` `openThinkingSelector`,
  `:368-381` `openSessionControls`, `:383-394` `openSettings`, `:396-414` `openForkSelector`.
- `ModalLayer` composites full-screen: `shell-adapter.ts:632-640` mounts the
  modal `ShellOverlayEntry` at `anchor:"top-left", row:0, col:0, width:"100%",
  maxHeight:"100%"`, and `modal-layer.ts` paints a full backdrop.
- Contrast: the command palette overlay at `shell-adapter.ts:623-630` uses
  `anchor:"center", width:"80%", maxHeight:"80%"` (floating, transcript visible)
  — the shape the in-place selector should be closer to, but anchored to the
  **editor region**, not centered.
- Pi's target behavior: `showSelector()` = editor-region swap
  (`interactive-mode.js:3252-3263`); `showModelSelector` `:3542-3564` etc. all
  go through it. Never a full-screen backdrop for these.
- The inline autocomplete stack (DO NOT TOUCH): `cathedral-editor.ts`,
  `CombinedAutocompleteProvider`, `editor.ts:69-98` `buildRpcAutocompleteCommands`.
- Convention: tabs, strict TS, colocated tests. Overlay pattern:
  `RpcHostOverlayManager` (`host-overlays.ts`) and its `ShellOverlayEntry`
  wiring in `shell-adapter.ts`.

## Scope

**In scope**: a new in-place selector host surface (a component/overlay entry
anchored to the editor region, transcript-preserving) — likely a new
`src/sumo-tui/rpc/inline-selector.ts` + its `ShellOverlayEntry` wiring in
`shell-adapter.ts`; rewiring the five selector call sites in
`src/sumo-tui/rpc/host-actions.ts` to use it instead of `this.modals.select`;
colocated tests.

**Out of scope**: inline autocomplete (works — do not touch); the command
palette (`CommandPaletteComponent`, Ctrl+/, `/sumo:palette` — leave as-is);
`ModalLayer` itself (keep it for genuinely-blocking prompts like approvals —
only migrate the *selector* call sites off it); selector *content* richness
(plan 035 owns `/fork`'s searchable picker etc.).

## Steps

1. **Build the in-place selector surface.** A host component that renders a
   selection list (reuse the existing select rendering / `SelectList` from
   pi-tui if it fits) positioned in the editor's region — i.e. the shell
   composites it where the editor normally sits (bottom band), with the
   transcript, top chrome, sidebar, and footer all still rendered above/around
   it. Model the region behavior on Pi's `showSelector` (editor-region swap):
   while the selector is open, the editor is hidden and the selector occupies
   its slot; Esc closes and restores the editor; Enter selects. No full-screen
   backdrop, no transcript blanking. Wire its `ShellOverlayEntry` in
   `shell-adapter.ts` anchored to the editor band (not `top-left/100%/100%`).
   Test: the composited frame with the selector open still contains transcript
   rows and chrome (assert transcript text present, no full backdrop fill).
2. **Migrate `openModelSelector`** to the in-place surface; keep its data
   (`getAvailableModels`) and result handling unchanged. Test.
3. **Migrate `openThinkingSelector`, `openSessionControls`, `openSettings`,
   `openForkSelector`** the same way, one commit each. (`openForkSelector`'s
   content stays flat here; plan 035 upgrades it to searchable — they compose:
   036 puts it in-place, 035 makes it richer.) Test each.
4. **Verify `ModalLayer` is now used only for blocking prompts** (approval /
   confirm / input dialogs), not selectors. `grep` the `modals.select` call
   sites — none should remain in `host-actions.ts` for these five commands.
5. **Interrupt/focus integration**: the in-place selector must participate in
   the input router's focus order like the modal did (Esc closes it; Ctrl-C
   tier dismisses it; keys route to it while open, not the editor). Reuse the
   `handleFocusedOverlayInput` / overlay-active gating. Test: Esc closes and
   restores the editor; a keypress while open goes to the selector.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm vitest run src/sumo-tui/rpc/ src/sumo-tui/widgets/` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual | `bin/sumocode.sh -d .` → `/model⏎` | selector opens in editor band, transcript stays visible |

## Done criteria

- [ ] `/model`, `/thinking`, `/sessions`, `/settings`, `/fork` open an in-place
  selector in the editor region; the transcript above stays rendered (no
  full-screen backdrop)
- [ ] `grep -n "modals.select" src/sumo-tui/rpc/host-actions.ts` → no matches for the five selector commands (ModalLayer retained only for approval/confirm/input)
- [ ] Esc closes the selector and restores the editor; keys route to the selector while open
- [ ] Inline autocomplete + command palette unchanged (their tests still green)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0; `pnpm test:integration` exit 0
- [ ] A test asserts the selector-open frame still contains transcript content (no backdrop takeover)

## STOP conditions

- The shell layout can't composite a component in the editor band without a
  broader retained-shell change (report the layout constraint; don't force a
  full-screen fallback).
- Migrating a selector off `ModalLayer` breaks the approval/confirm/input
  flows that legitimately need the full-screen modal (they must keep working —
  only the five selectors migrate).
- Any verification fails twice.

## Maintenance notes

- Keep `ModalLayer` for blocking dialogs; the distinction is "selector =
  in-place, transcript visible" vs "must-block prompt = full-screen." Document
  it so future commands pick the right surface.
- Coordinate landing order with plan 035: this plan changes the container;
  035 enriches selector content. Land 036's surface first so 035's richer
  pickers inherit the in-place behavior.
