# Sumo-Tui Research Synthesis + Recommended Roadmap

## Decision headline

Build **Sumo-Tui** as a Node-native retained terminal framework for SumoCode, but do it with a disciplined boundary:

1. **Own what creates SumoCode’s UX ceiling**: altscreen lifecycle, layout, in-app chat scrollback, mouse routing, sidebar, footer/editor pinning, modal layers, splash centering, visual frame scheduling.
2. **Reuse what Pi already got right**: raw terminal setup, Kitty/modifyOtherKeys key parsing, bracketed paste, text width/ANSI slicing, terminal capabilities/images/hyperlinks, Pi editor, Pi extension API, Pi session/agent runtime.
3. **Use OpenTUI/OpenCode/opentui-island as blueprints**, not as a direct runtime dependency for the core, because OpenTUI is Bun/FFI-based and Pi extensions run in Node via jiti.

Recommended choice from the earlier decision matrix: **Hybrid scope + imperative core with declarative adapter later + bundled first**.

But the “hybrid” here does **not** mean a thin pi-tui extension layer. It means Sumo-Tui is the root renderer/layout framework and Pi is used as a utility/runtime/editor library.

## What the research proved

### pi-tui

- pi-tui’s core `Container` is a vertical line-concatenation model (`tui.js:42-71`). This is why footer pinning/sidebar/flex can only be hacked today.
- pi-tui’s renderer is optimized for main-screen scrollback with a growing line buffer and bottom viewport tracking (`tui.js:674-967`). This is not an altscreen app-scroll framework.
- pi-tui’s `Editor` is sophisticated and should be preserved (`components/editor.js:159-218`, `components/editor.js:331-433`, `components/editor.js:450-685`, `components/editor.js:921-981`, `components/editor.js:1778-1888`).
- pi-tui’s keyboard and terminal lifecycle layers are valuable and should not be rewritten first (`keys.js:1-1173`, `terminal.js:40-253`).
- Pi’s extension API expects pi-tui `Component` factories (`extensions/types.d.ts:45-170`), so Sumo-Tui must provide an adapter/shim.

### OpenCode

- Current OpenCode is TypeScript/Bun/Solid/OpenTUI, not Go/Bubble Tea (`app.tsx:1-23`, `app.tsx:132-180`).
- OpenCode solves “altscreen means no terminal scrollback” by rendering messages inside an OpenTUI `scrollbox` with sticky-bottom behavior (`routes/session/index.tsx:1058-1075`).
- Its chat pager has explicit `scrollBy`, `scrollTo`, `scrollHeight`, child-position lookup, PgUp/PgDn/Home/End commands (`routes/session/index.tsx:682-770`).
- Its layout pins prompt/footer by making the chat scrollbox flex-grow and prompt region flex-shrink zero (`routes/session/index.tsx:1037-1209`).
- Its sidebar is responsive: dock on wide, overlay with backdrop on narrow (`routes/session/index.tsx:164-180`, `routes/session/index.tsx:1210-1225`).

### OpenTUI

- OpenTUI has the architecture Sumo-Tui needs: retained tree, Yoga layout, hit grid, mouse dispatch, scrollbox, renderer lifecycle (`Renderable.ts:199-296`, `Renderable.ts:697-1117`, `renderer.ts:2485-2558`, `renderer.ts:2800-2965`, `renderables/ScrollBox.ts:109-600`).
- It is not Node-compatible in-process because core imports `bun:ffi` and requires Bun (`packages/core/package.json:80-83`, `zig.ts:1-39`).
- Therefore we should copy concepts, not directly embed OpenTUI as the production core.

### opentui-island

- The sidecar bridge proves Node host + Bun OpenTUI sidecar works (`sidecar/client.ts:474-490`, `sidecar/server.ts:280-313`).
- It provides useful HostFrame/FrameDiff/Mouse parsing patterns (`types.ts:1-59`, `frame-diff.ts:1-98`, `terminal-mouse.ts:1-88`).
- The pi-tui surface is fixed-height and cannot own global layout (`adapters/pi-tui/index.ts:122-148`, `adapters/pi-tui/index.ts:360-365`).
- It is useful for experiments/lazy modal islands, but not the Sumo-Tui core.

## Sumo-Tui v1 architecture

### Package shape

Bundled first inside the SumoCode repo:

```text
src/sumo-tui/
  index.ts
  runtime/
    terminal-controller.ts
    lifecycle.ts
    frame-scheduler.ts
    screen-buffer.ts
    ansi-writer.ts
  input/
    mouse.ts
    focus.ts
    key-router.ts
  layout/
    node.ts
    flex.ts
    measure.ts
    rect.ts
  render/
    compositor.ts
    cursor-marker.ts
    ansi-lines.ts
    diff.ts
  widgets/
    box.ts
    text.ts
    scrollbox.ts
    modal-layer.ts
    pi-component-leaf.ts
    pi-editor-leaf.ts
  pi-compat/
    sumo-interactive-mode.ts
    extension-ui-adapter.ts
    region-registry.ts
  devtools/
    snapshot.ts
    trace.ts
```

### Core layers

1. **Terminal controller**
   - Enters/exits altscreen.
   - Enables SGR mouse tracking.
   - Delegates raw mode, bracketed paste, Kitty keyboard negotiation, modifyOtherKeys fallback, and drain cleanup to Pi’s `ProcessTerminal` where possible.
   - Owns signal handlers and cleanup ordering.

2. **Retained layout tree**
   - `SumoNode` with rect, parent/children, visible, focusable, overflow, flex props, z-index, handlers.
   - v1 flex subset: row/column, flexGrow, flexShrink, fixed width/height, min/max, gap, padding, absolute overlays.
   - Optional Yoga dependency only if Node/jiti validation passes.

3. **Compositor/render buffer**
   - Draws into a 2D cell buffer.
   - Converts to ANSI rows.
   - Diffs previous frame to current frame.
   - Preserves and maps Pi `CURSOR_MARKER` from leaf-rendered editor rows into hardware cursor coordinates.

4. **Input router**
   - Uses Pi’s key parser for keyboard sequences.
   - Parses SGR mouse events based on opentui-island parser.
   - Routes scroll to nearest scrollable under pointer or focused scrollbox fallback.
   - Routes key input to focused widget/editor unless app keybindings consume it.

5. **ScrollBox / ChatPager**
   - In-app scrollback with `scrollTop`, `scrollHeight`, `scrollBy`, `scrollTo`, `stickyBottom`, `manualScroll`.
   - Mouse wheel scroll with acceleration.
   - PgUp/PgDn/Home/End.
   - Snap-to-bottom on new content if sticky; preserve position if user scrolled up.

6. **Pi compatibility**
   - `PiComponentLeaf` wraps any pi-tui `Component.render(width): string[]`.
   - `PiEditorLeaf` wraps Pi’s `Editor`/`CustomEditor` with untouched rows.
   - Extension region factories map to named slots.

## v1 screen topology

```text
Root(altscreen, full terminal)
└── CathedralShell(column, height=terminal.rows)
    ├── TopChrome(height=2-3)
    ├── Main(row, flexGrow=1)
    │   ├── Content(column, flexGrow=1)
    │   │   ├── SplashOrChat(ScrollBox, flexGrow=1, stickyBottom=true)
    │   │   ├── Pending/Status(optional, fixed)
    │   │   ├── WidgetsAbove(optional, fixed)
    │   │   ├── Editor(PiEditorLeaf, fixed/intrinsic)
    │   │   └── WidgetsBelow(optional, fixed)
    │   └── Sidebar(docked if width >= adaptive threshold)
    ├── Footer(height=2-3)
    └── ModalLayer(absolute, z-index above all)
```

This topology solves today’s problems:

- Footer is actually bottom-pinned because shell consumes terminal height.
- Chat scroll works in altscreen because `ScrollBox` owns scrollback.
- Mouse wheel does not cycle prompt history because SGR mouse captures wheel before it becomes arrows.
- Sidebar appears based on adaptive layout, not a hardcoded too-high threshold.
- Splash centering is a layout property, not padding math.
- Editor rows stay native and untouched.

## Phased roadmap

### Phase 0 — Research checkpoint + ADR (current)

Deliverables:
- Research docs for OpenCode, OpenTUI, opentui-island, pi-tui.
- Visual explainer.
- ADR: “Build Sumo-Tui as Node-native retained renderer over Pi runtime utilities.”

Exit criteria:
- Dhruv approves architecture direction.

### Phase 1 — Terminal lifecycle + mouse proof (2-3 days)

Deliver:
- `TerminalController` around Pi `ProcessTerminal`.
- Altscreen enter/exit.
- SGR mouse enable/disable.
- Signal cleanup tests.
- TTY smoke harness in cmux/vhs.

Tests:
- Clean exit after Ctrl+C/SIGTERM.
- Mouse wheel no longer reaches Pi editor as Up/Down.
- Raw mode/bracketed paste restored.

### Phase 2 — Layout/compositor MVP (4-6 days)

Deliver:
- Retained node tree.
- Flex subset.
- Cell buffer + ANSI output + frame diff.
- Pi component leaf adapter.
- Pi editor leaf adapter with cursor marker mapping.

Tests:
- Editor autocomplete `/res` still works.
- Cursor marker maps to expected cell.
- No rendered row exceeds terminal width.
- Snapshot tests for portrait/landscape layouts.

### Phase 3 — ChatPager / ScrollBox (4-6 days)

Deliver:
- ScrollBox node.
- Mouse wheel scroll.
- PgUp/PgDn/Home/End.
- Sticky bottom/manual scroll detection.
- “Scrolled up — jump to bottom” affordance.

Tests:
- 500-message transcript scrolls smoothly.
- New streaming output sticks only when at bottom.
- User scroll position preserved while streaming.
- Wheel over editor does not mutate prompt history.

### Phase 4 — SumoInteractiveMode fork (5-8 days)

Deliver:
- Fork Pi interactive mode enough to instantiate Sumo-Tui root.
- Map Pi containers to Sumo slots.
- Preserve extension UI context and events.
- Preserve Pi editor/autocomplete/session restore.

Tests:
- Current SumoCode extension suite still passes.
- Slash autocomplete and commands pass.
- Existing `setHeader`, `setFooter`, `setWidget`, `custom`, `setEditorComponent` behavior adapted.

### Phase 5 — Cathedral shell parity (4-7 days)

Deliver:
- Top chrome, splash, bottom footer, sidebar dock/overlay.
- Approval modal, command palette, memory editor as native modal layer.
- Adaptive portrait/landscape rules.

Tests:
- Visual VHS snapshots for Mac mini portrait + MacBook landscape.
- Dhruv screenshot approval per slice.

### Phase 6 — Hardening + extraction decision (1-2 weeks daily drive)

Deliver:
- Performance profiling.
- Crash cleanup.
- Debug overlay / frame traces.
- Decide whether to extract `@sumodeus/sumo-tui`.

Exit criteria:
- 30 days daily driving without API churn, or a second consumer needs it.

## Risk register

- **Private Pi internals**: forked interactive mode may rely on non-public `dist/modes/interactive/*` imports. Mitigation: keep patch small, document upstream version, add upgrade smoke tests.
- **Editor cursor regressions**: any row decoration breaks Pi cursor. Mitigation: PiEditorLeaf renders raw rows and only maps cursor marker.
- **Keyboard cleanup**: lifecycle must coordinate with Pi `ProcessTerminal.drainInput()`. Mitigation: terminal controller owns ordering and signal tests.
- **Flex solver scope creep**: full Yoga parity is large. Mitigation: terminal-specific flex subset first; only add needed properties.
- **Performance**: pure TS renderer may be slower than OpenTUI Zig. Mitigation: event-driven diff, cell buffer optimizations, no 60fps unless animation is active.
- **Altscreen UX**: users lose terminal scrollback. Mitigation: in-app ChatPager is Phase 3 before daily-driver altscreen release.

## Recommendation

Proceed. Build Sumo-Tui, but do not do a blank-slate terminal/editor rewrite. The right architecture is:

> **Node-native retained renderer + in-app scrollback + SGR mouse + Pi terminal/editor/key utilities + Pi runtime compatibility.**

This gives SumoCode OpenCode-level terminal ownership while avoiding a wasteful rewrite of Pi’s hardest, least-visible edge cases.
