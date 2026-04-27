# Deep Dive: Pi TUI / Pi Extension Boundary

Research snapshot: local SumoCode dependency tree, `@mariozechner/pi-tui@0.70.2` and `@mariozechner/pi-coding-agent@0.70.2`.

## 1. High-level finding

`pi-tui` is a compact, line-oriented terminal UI engine. Its component contract is synchronous: every component implements `render(width): string[]`, optional `handleInput(data)`, optional `wantsKeyRelease`, and `invalidate()` (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.d.ts:7-30`). A `Container` simply renders each child and concatenates the resulting lines (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:40-70`). The main `TUI` extends `Container`, owns differential rendering, focus, input listeners, overlays, and terminal writes (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:73-99`).

This is why SumoCode's current chrome hacks are fragile. `pi-tui` is excellent for inline CLI rendering and a battle-tested editor, but it is not a flexbox root layout system. It has no native concept of “footer pinned to terminal bottom while chat scrolls above it”; it renders a line list, compares it to previous lines, and lets terminal scrollback absorb growth.

## 2. Terminal lifecycle

`ProcessTerminal.start()` enables raw mode, sets stdin encoding, resumes stdin, enables bracketed paste, registers resize handling, and queries/enables Kitty keyboard protocol or falls back to xterm `modifyOtherKeys` (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/terminal.js:41-69`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/terminal.js:128-137`). It does **not** enter alternate screen or mouse tracking by default. This is important: Pi's default model is inline terminal output with normal scrollback.

The stop path disables bracketed paste, Kitty keyboard protocol, and `modifyOtherKeys`, destroys stdin buffering, removes listeners, pauses stdin, and restores raw mode (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/terminal.js:204-243`). `TUI.stop()` moves to the end of content, emits a newline, shows cursor, and stops the terminal (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:287-307`).

SumoCode's altscreen patch sat outside this lifecycle. That is why it could improve exit cleanup while still breaking mouse/scroll behavior during runtime: Pi itself does not know it is in alternate screen and has no app-owned chat pager to receive wheel events.

## 3. Rendering model and cursor mechanics

`TUI.requestRender()` coalesces rendering to a minimum interval of 16ms and supports forced redraws that reset previous lines/width/height/cursor state (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:308-355`). `doRender()` renders the full component tree to `newLines`, composites overlays, extracts cursor marker position, applies resets, and then either full-renders or differentially updates only changed lines (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:674-699`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:700-763`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:764-970`). It uses synchronized output escape sequences around full and differential writes (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:700-711`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:847-957`).

Hardware cursor placement depends on a special zero-width `CURSOR_MARKER`, documented in the type declarations and implementation (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.d.ts:37-54`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:16-21`). `extractCursorPosition()` scans the bottom visible viewport, finds the marker, computes its visual column, strips it, and later positions the hardware cursor for IME candidate windows (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:649-672`).

This explains the production regression: wrapping `super.render()` rows in a custom frame changes width, row positions, and marker placement. It may look visually correct but violates the editor's render math. The native Pi editor should not be decorated by transforming its output rows.

## 4. Input routing

`TUI.handleInput()` first runs registered input listeners; a listener can consume input or rewrite it (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:356-372`). It then consumes terminal cell-size responses, handles a debug key, validates overlay visibility/focus, filters key-release events unless the component opts in, forwards input to the focused component, and requests render (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:373-405`).

The key parser supports legacy sequences, Kitty keyboard protocol, modifyOtherKeys, modifiers, special keys, and printable CSI-u decoding (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/keys.js:1-19`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/keys.js:417-531`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/keys.js:616-680`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/keys.js:1100-1172`). Terminal startup queries Kitty and enables flags 1, 2, and 4 when supported (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/terminal.js:78-100`).

This is valuable code. Sumo-Tui should reuse or mirror Pi's key semantics during migration so Ctrl/Alt/Super bindings and international layouts do not regress.

## 5. Overlay model

Pi already has overlays. `TUI.showOverlay()` pushes an overlay entry with options, prior focus, hidden state, and focus order; it can hide/show/focus/unfocus and restores focus when hidden (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:143-218`). Overlays can be anchored, sized by absolute/percentage values, constrained by margins/max height, and conditionally visible by terminal dimensions (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.d.ts:56-119`). Overlay compositing pads to terminal height, computes viewport start, and splices overlay lines into base content (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/tui.js:550-598`).

This is sufficient for approval modals, command palettes, and memory editor overlays. It is insufficient for an OpenCode-style root layout because it overlays on a line list after base rendering; it does not solve chat viewport ownership or footer pinning by itself.

## 6. Editor capabilities

Pi's editor is substantial. It tracks logical lines, cursor, focus, width, vertical scroll offset, autocomplete provider/list/state, paste buffers, prompt history, kill ring, jump mode, sticky visual column, snapped cursor state, undo stack, submit/change callbacks, and submit disabling (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/components/editor.js:159-214`). It handles marker-aware paste segmentation, word wrapping, scroll indicators, visible line slicing, cursor rendering, hardware cursor marker, and autocomplete rendering (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/components/editor.js:1-153`, `node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/components/editor.js:320-428`).

Input handling includes bracketed paste buffering, undo, autocomplete navigation/apply, Tab completion, delete variants, kill/yank, cursor movement, newline/submit semantics, history navigation, page scroll, character jump mode, printable CSI-u decoding, and regular insertion (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/components/editor.js:429-685`). It exposes `getExpandedText`, `setText`, programmatic insertion, line-ending normalization, and paste marker expansion (`node_modules/.pnpm/@mariozechner+pi-tui@0.70.2/node_modules/@mariozechner/pi-tui/dist/components/editor.js:769-835`).

This is the strongest argument against replacing Pi's editor prematurely. SumoCode should treat editor replacement as a dedicated phase with parity tests, not as frame styling.

## 7. Public Pi extension API

Pi exposes useful extension UI APIs: terminal input listeners, status cells, working indicator, hidden thinking label, above/below editor widgets, custom footer/header factories, title, focused custom components/overlays, paste/set/get editor text, an editor dialog, autocomplete provider stacking, custom editor component factory, theme getters/setters, and tool expansion settings (`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2_ws@8.20.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:66-186`). It also documents that a custom editor should extend `CustomEditor` and call `super.handleInput(data)` for keys it does not handle (`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2_ws@8.20.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:135-167`).

This boundary is perfect for current SumoCode features like footer, header, overlays, command palette, memory editor, approval gate, and key/status integrations. It is not a root renderer replacement API. A full Sumo-Tui cannot be implemented purely as `setFooter` + `setHeader` + `setWidget` if it must own chat scrollback and mouse wheel routing.

## 8. What Sumo-Tui should reuse vs replace

Reuse or preserve initially:

- Pi editor/autocomplete/slash/paste/history behavior (`editor.js:159-214`, `editor.js:429-685`).
- Pi key parsing and terminal protocol handling (`keys.js:1-19`, `terminal.js:78-137`).
- Pi overlay API for v1 modals (`tui.js:143-218`, `tui.js:550-598`).
- Pi extension APIs for header/footer/status/widgets while in hybrid mode (`types.d.ts:66-186`).

Replace or own later:

- Root layout allocation: `Container.render()` concatenation cannot pin footer under a scroll viewport (`tui.js:40-70`).
- Chat scrollback: Pi's inline renderer writes growing line history; full altscreen requires app-owned transcript paging.
- Mouse wheel routing: Pi default terminal does not enable mouse and has no chat pager target.
- Editor only after parity: Sumo editor must match or exceed Pi's current feature set.

## 9. Practical recommendation

For the daily driver, undo the parts that violate Pi's model:

1. Disable/remove `installAltscreen(pi)` unless SumoCode owns in-app scrollback.
2. Stop wrapping `super.render()` from the Pi editor; if a frame is required, render it as separate chrome around the editor allocation or defer until Sumo-Tui owns the editor.
3. Debug sidebar visibility as a layout/width issue, not as an editor issue.

For Sumo-Tui, define a boundary explicitly:

- **Hybrid mode**: Pi owns terminal/editor/chat; SumoCode uses public extension APIs and no altscreen.
- **Shell mode**: one bounded sidecar/surface owns splash/sidebar/footer chrome but does not intercept Pi editor rows.
- **Owned mode**: Sumo-Tui owns terminal lifecycle, mouse, chat pager, footer pinning, and eventually editor. At this point Pi interactive mode is no longer the root TUI; SumoCode either drives Pi agent core headlessly or reimplements the interactive composition layer.
