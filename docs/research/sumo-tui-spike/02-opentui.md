# Deep Dive: OpenTUI Core Architecture

Research snapshot: `/tmp/sumo-tui-research/opentui`, commit `26cda81`.

## 1. High-level finding

OpenTUI is a real terminal application renderer, not a string-widget helper. The core package exports a renderer, renderables, layout primitives, input parsers, color utilities, and widget classes (`packages/core/src/index.ts:1-31`). The renderer can create a terminal backend from native bindings, build a render tree, diff/render frames, parse keyboard and mouse input, manage focus, enter/leave alternate screen, and expose React/Solid adapter layers.

The most important constraint for SumoCode is runtime: OpenTUI core currently imports Bun-specific/native integration. The Zig/native entry point imports `bun:ffi` and declares native symbols through Bun FFI (`packages/core/src/zig.ts:1-35`). OpenCode runs in Bun and depends directly on `@opentui/core`/`@opentui/solid` (`/tmp/sumo-tui-research/opencode/packages/opencode/package.json:124-165`). Pi extensions, however, run in Node/jiti. That makes a direct in-process OpenTUI dependency risky today. `opentui-island` solves that by running OpenTUI in a Bun sidecar and projecting frames back into a host framework.

## 2. Renderer and terminal ownership

The CLI renderer is created with a config object and a terminal backend. The renderer constructor accepts output/input streams, terminal object, width/height, fps, keyboard/mouse flags, and exit behavior (`packages/core/src/renderer.ts:121-181`). It creates a root `GroupRenderable`, stores input state, initializes focus and mouse managers, tracks renderables by ID, and registers terminal resize handling (`packages/core/src/renderer.ts:183-266`).

OpenTUI can own terminal mode. `start()` enables raw mode, hides cursor, optionally switches to alternate screen, enables bracketed paste, initializes Kitty keyboard protocol, installs mouse tracking, and starts the render loop (`packages/core/src/renderer.ts:353-448`). `destroy()` reverses those responsibilities: it clears intervals, removes listeners, disables mouse/keyboard modes, shows cursor, disables bracketed paste, leaves alternate screen, and restores raw mode (`packages/core/src/renderer.ts:473-558`). `suspend()` and `resume()` provide explicit pause/rejoin semantics for shell/editor handoff (`packages/core/src/renderer.ts:560-652`).

For Sumo-Tui, this validates the architecture we need: terminal ownership must be centralized and reversible. The current SumoCode altscreen patch tried to add ownership at extension edge; OpenTUI shows that ownership belongs to a renderer lifecycle object.

## 3. Renderables and layout model

OpenTUI's `Renderable` is the base class for nodes that draw into a frame buffer. It stores position, size, visibility, z-index, parent/children, focusability, style, and layout properties (`packages/core/src/Renderable.ts:1-120`). Renderables can add/remove children, mark layout/render dirty, request render, and recursively participate in layout/render passes (`packages/core/src/Renderable.ts:122-313`).

The renderer integrates Yoga/flex-style layout. Layout configuration exposes width/height, flex direction, grow/shrink, padding, margin, position, display, border, and overflow-like properties through style/layout conversion (`packages/core/src/Renderable.ts:315-560`). The renderer has layout pass timing and dirty propagation (`packages/core/src/renderer.ts:793-895`). This is the missing primitive in `pi-tui`: SumoCode needs row/column/flex composition, not root child-order surgery.

The practical implication: Sumo-Tui should not invent a one-off footer/sidebar layout model. It should define a render tree with `Box`, `Text`, `ScrollView`, `Textarea`, `Overlay`, and `Portal`, backed by Yoga-like measurement. Whether the backend is OpenTUI, pi-tui-compatible strings, or a custom renderer, the app model should be flex-first.

## 4. ScrollBox and app-owned scrollback

OpenTUI ships `ScrollBoxRenderable`, which is the primitive OpenCode uses for session history. Its constructor takes content dimensions, scrollbar config, stickiness, scroll speed, and viewport sizing (`packages/core/src/renderables/ScrollBox.ts:50-160`). It tracks scroll position, max scroll, viewport/content size, visible scrollbars, sticky behavior, and content area (`packages/core/src/renderables/ScrollBox.ts:162-260`). It exposes imperative scroll methods such as `scrollTo`, `scrollBy`, `scrollToTop`, and `scrollToBottom` (`packages/core/src/renderables/ScrollBox.ts:336-415`). Mouse wheel handling updates the scroll position and marks the renderable dirty (`packages/core/src/renderables/ScrollBox.ts:548-620`).

This is the direct answer to SumoCode's altscreen problem. Once the terminal is in alternate screen, host scrollback is gone. A real TUI must render only a visible transcript window and own wheel/PgUp/PgDn semantics. OpenTUI already has that shape; Sumo-Tui either needs to use it through a Bun sidecar or reproduce the same primitive in Node.

## 5. Textarea and editor feasibility

OpenTUI includes `TextareaRenderable`, a multi-line editable text widget. It manages cursor position, selection, scroll offsets, placeholder, value changes, input handlers, paste handling, focus behavior, custom keybindings, and submit callbacks (`packages/core/src/renderables/Textarea.ts:1-190`). It implements character insertion, deletion, newline insertion, cursor movement, word movement, line navigation, and scroll synchronization (`packages/core/src/renderables/Textarea.ts:320-720`). It renders placeholder/text/cursor/selection into the terminal buffer (`packages/core/src/renderables/Textarea.ts:760-920`).

OpenCode layers significant agent-specific logic on top of this textarea; OpenTUI gives the base text box, not Pi-level slash commands and autocomplete. For SumoCode, this means an eventual editor replacement can use Textarea-like mechanics, but we still need to port Pi/editor behaviors deliberately: slash command completion, MCP resource completion, file path completion, paste compaction, prompt history, and app keybindings.

## 6. Keyboard and mouse parsing

OpenTUI parses modern keyboard protocols. Kitty key parsing lives under `parse.keypress-kitty.ts`, decoding CSI-u, event types, modifiers, alternate/base layout keys, and functional key equivalents (`packages/core/src/lib/parse.keypress-kitty.ts:1-240`). Mouse parsing handles SGR/URXVT-like mouse encodings, button state, wheel direction, modifier bits, coordinates, and event kinds (`packages/core/src/lib/parse.mouse.ts:1-220`).

This matters because cmux/libghostty is a modern terminal environment. Sumo-Tui can rely on 24-bit color and modern key protocols, but it must also avoid partial ownership. If mouse tracking is enabled, wheel events belong to the app. If Kitty keyboard protocol is enabled, the app must decode it and route it consistently. Pi already has similar key parsing utilities in `@mariozechner/pi-tui`, so Sumo-Tui should either reuse those in Node phases or adopt OpenTUI's parser wholesale only inside a full renderer.

## 7. React and Solid adapters

OpenTUI has declarative adapters. The React package implements a reconciler host config that creates OpenTUI instances, appends/removes children, commits property updates, and supports text instances (`packages/react/src/reconciler/host-config.ts:1-220`). The Solid package implements a Solid renderer/reconciler that maps JSX elements to OpenTUI renderables and sets properties (`packages/solid/src/reconciler.ts:1-220`). OpenCode uses the Solid adapter in production.

For SumoCode, this argues for a two-layer architecture:

- **Imperative core**: terminal lifecycle, render tree, layout engine, input routing, focus, overlay stack, scroll model.
- **Optional declarative adapter**: React-compatible components for complex screens once the core is stable.

Starting with React-only would couple SumoCode to reconciler complexity too early. Starting with imperative-only keeps the path small enough for tests and incremental integration.

## 8. Performance and frame model

OpenTUI targets a fixed FPS loop and tracks render/layout timings in the renderer (`packages/core/src/renderer.ts:121-181`, `packages/core/src/renderer.ts:660-760`). It maintains dirty renderables and performs layout/render passes before drawing. This is meaningfully different from `pi-tui`'s synchronous `Component.render(width): string[]` model. The OpenTUI model is better for animated/full-screen apps, but more expensive to embed if each surface becomes an independent process.

The previous SumoCode island spike measured this cost in practice: two always-on islands meant two Bun sidecars and roughly +201MB RSS. That does not indict OpenTUI; it indicts per-widget sidecars. If SumoCode chooses the OpenTUI-sidecar path, it should be a single app shell sidecar or lazy modal sidecars, not one sidecar per footer/sidebar/input ornament.

## 9. Compatibility with Pi / Node

Direct in-process OpenTUI use in Pi is blocked by Bun/native assumptions. `packages/core/src/zig.ts` imports `bun:ffi` (`packages/core/src/zig.ts:1-35`), and OpenCode's own package scripts are Bun-centered (`/tmp/sumo-tui-research/opencode/packages/opencode/package.json:8-18`). Pi extension APIs expose `setHeader`, `setFooter`, `setWidget`, `custom`, `onTerminalInput`, `setEditorComponent`, and autocomplete hooks (`/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode/node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2_ws@8.20.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:66-186`). Those APIs are designed for augmenting Pi's existing TUI, not replacing its root renderer.

Therefore there are three viable integration shapes:

1. **Pi-native repair layer**: stay in pi-tui, avoid altscreen, keep editor/chat native. Lowest risk, limited fidelity.
2. **OpenTUI island layer**: use Bun sidecars for bounded layout-heavy surfaces. Good for splash/modal prototypes, but watch memory and fixed-height host allocation.
3. **Sumo-Tui full app**: create an owned root renderer and eventually either call Pi agent core headlessly or fork/integrate Pi interactive mode. Highest payoff, highest effort.

## 10. Recommendation for Sumo-Tui

Use OpenTUI as the architectural reference and optional backend, not as an immediate hard dependency in the Pi extension runtime. The core Sumo-Tui interfaces should mirror the concepts that OpenTUI proves:

- `RendererLifecycle`: enter/leave altscreen, raw mode, bracketed paste, Kitty keyboard, mouse, cleanup.
- `LayoutTree`: flex/Yoga-like boxes with absolute overlays.
- `InputRouter`: key/mouse parse, focus, command dispatch, text input routing.
- `ScrollViewport`: sticky-bottom, scrollbar, wheel/page commands, virtualization-ready transcript rendering.
- `OverlayManager`: modal stack, focus restore, backdrop, z-index.
- `EditorSurface`: Textarea-like buffer with autocomplete and paste extensions.

Implementation recommendation: start bundled under `src/sumo-tui/` with a Node-compatible imperative core and tests. Use `opentui-island` only for bounded proof-of-concept shells or modals until OpenTUI can run in-process under Node or SumoCode moves the full interactive app to Bun. Extract to `@sumodeus/sumo-tui` only after the interfaces survive SumoCode's real UX constraints.
