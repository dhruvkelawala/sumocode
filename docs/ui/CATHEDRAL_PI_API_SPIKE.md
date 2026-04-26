# Cathedral Pi-API Technical Spike

> Branch: `spike/cathedral-pi-api`
> Scope: prove robust Cathedral implementation routes using public `ExtensionAPI`,
> `ExtensionUIContext`, and `@mariozechner/pi-tui` only.
> Rule: no `tui.children.splice`, no monkey-patching, no forked Pi core.

---

## Executive summary

The public Pi extension surface is strong enough for most Cathedral regions:

- **Top chrome**: `ctx.ui.setHeader()`.
- **Registry footer**: `ctx.ui.setFooter()`.
- **Carved input**: `ctx.ui.setEditorComponent()` with `CustomEditor`.
- **Command palette + memory editor + Sumo-owned approvals**:
  `ctx.ui.custom({ overlay: true })`.
- **Tool pills**: `pi.registerTool()` with same built-in tool names,
  delegated execution, and `renderShell: "self"`.
- **Custom Sumo messages**: `pi.registerMessageRenderer()`.

The one hard gap remains the **static, full-height, column-reserving right
sidebar for Pi's built-in chat rows**. Public APIs can either:

1. draw a sidebar overlay without focus capture, but not reserve chat columns;
2. draw a split-pane inside a tall header, but the real chat still begins below
   it; or
3. draw a side band inside the custom editor, but only on editor rows.

Therefore, the current `dockStaticSidebar()` root-container surgery must not be
expanded. The robust path is to request/add a public Pi side-panel/layout API and
then migrate SumoCode to it. Until that exists, overlay is the best public API
for sidebar *visibility*, but it is not a faithful replacement for the mockups'
reserved column.

---

## 1. Public API inventory

### 1.1 Extension lifecycle and events

Signature source:
`node_modules/.../@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`.

```ts
pi.on(eventName, handler): void
```

Relevant events:

| Event | Can do | Cannot do | Cathedral use |
|---|---|---|---|
| `session_start` | mount header/footer/widgets/editor/overlays for a UI session | reserve chat columns | initial chrome/sidebar/footer/editor setup |
| `session_shutdown` | clean up session-local state | mutate next session UI directly | dispose overlay handles/state |
| `before_agent_start` | inspect prompt/system prompt, inject a custom message/system prompt replacement | render token stream | state switches to SCRIPTOR/thinking |
| `agent_start` / `agent_end` | toggle stateful UI | inspect individual deltas | top chrome + footer state |
| `message_start` / `message_update` / `message_end` | observe user/assistant/tool-result message lifecycle | override built-in assistant renderer | collapse splash, update counters |
| `tool_call` | block or mutate tool input before execution | replace renderer for already-registered built-ins by event alone | approvals, files tab updates |
| `tool_result` | modify result content/details/error | change built-in renderer by event alone | files tab, state transitions |
| `tool_execution_start/update/end` | observe streaming tool execution status and partial results | render by itself | live SCRIPTOR/FILES sidebar stats |
| `before_provider_request` / `after_provider_response` | inspect provider payload/response status and headers | direct UI layout | latency metric |
| `model_select` | observe model changes | list all sessions | footer/model palette |
| `input` | transform/handle user input before Pi processing | own editor rendering | command routing, palette commands |
| `user_bash` | replace/handle user `!` shell commands | agent bash tool calls | terminal tab heuristics |

Constraints:
- Events are behavioral hooks, not layout hooks.
- No event exposes "before render every chat row" or "chat column width".

### 1.2 UI dialogs

```ts
ctx.ui.select(title: string, options: string[], opts?): Promise<string | undefined>
ctx.ui.confirm(title: string, message: string, opts?): Promise<boolean>
ctx.ui.input(title: string, placeholder?: string, opts?): Promise<string | undefined>
ctx.ui.editor(title: string, prefill?: string): Promise<string | undefined>
ctx.ui.notify(message: string, type?: "info" | "warning" | "error"): void
```

Can do:
- quick built-in UI prompts;
- RPC-mode compatible user interaction.

Cannot do:
- Cathedral-specific box drawing / modal geometry;
- custom keyboard model;
- custom modal content layout.

Examples:
- `confirm-destructive.ts`
- `qna.ts`
- `questionnaire.ts`
- `modal-editor.ts`

Cathedral recommendation:
- use `ctx.ui.custom({ overlay: true })` for visually critical overlays;
- use built-ins only for non-Cathedral fallback paths.

### 1.3 Header

```ts
ctx.ui.setHeader(
  factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined
): void
```

Can do:
- replace Pi's startup header with any vertical component;
- request re-render via `tui.requestRender()`;
- render multiple rows.

Cannot do:
- interleave with normal chat rows;
- reserve a side column for built-in chat;
- pin content across the full viewport below chat.

Example:
- `custom-header.ts`.

Prototype:
- `src/spike/top-chrome-setheader.ts`
- `src/spike/sidebar-custom-header.ts`
- `src/spike/empty-chat-quote-setheader.ts`

Implementation detail from `interactive-mode.js`:
- custom header is inserted into `headerContainer`, replacing `builtInHeader`.
- This is a public operation through `setHeader`, unlike direct `tui.children`
  surgery.

### 1.4 Footer

```ts
ctx.ui.setFooter(
  factory: ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined
): void
```

Can do:
- replace the bottom footer row/component;
- read git branch via `footerData.getGitBranch()`;
- subscribe to branch changes via `footerData.onBranchChange()`;
- read extension statuses set by `ctx.ui.setStatus()`.

Cannot do:
- move editor;
- control chat/body layout;
- reserve vertical side regions.

Example:
- `custom-footer.ts`.

Prototype:
- `src/spike/footer-registry-tone.ts`

### 1.5 Widgets

```ts
ctx.ui.setWidget(
  key: string,
  content: string[] | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" }
): void

ctx.ui.setWidget(
  key: string,
  content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" }
): void
```

Can do:
- add vertical components above or below the editor;
- use strings or full `Component` factories.

Cannot do:
- horizontal sidebars;
- reserve right columns;
- render inside the chat scrollback.

Examples:
- `widget-placement.ts`
- `plan-mode/`

Constraint confirmed in `interactive-mode.js`:
- string-array widgets are capped at `InteractiveMode.MAX_WIDGET_LINES = 10`.
- component factory widgets are not string-capped, but still render only in the
  widget container above/below the editor.

Cathedral use:
- good for small contextual notes;
- not sufficient for registry sidebar.

### 1.6 Custom overlays

```ts
ctx.ui.custom<T>(
  factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component & { dispose?(): void } | Promise<Component & { dispose?(): void }>,
  options?: {
    overlay?: boolean;
    overlayOptions?: OverlayOptions | (() => OverlayOptions);
    onHandle?: (handle: OverlayHandle) => void;
  }
): Promise<T>
```

Overlay options:

```ts
type OverlayAnchor =
  | "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "top-center" | "bottom-center" | "left-center" | "right-center";

interface OverlayOptions {
  width?: number | `${number}%`;
  minWidth?: number;
  maxHeight?: number | `${number}%`;
  anchor?: OverlayAnchor;
  offsetX?: number;
  offsetY?: number;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  visible?: (termWidth: number, termHeight: number) => boolean;
  nonCapturing?: boolean;
}
```

Can do:
- centered modals;
- right side overlay panels;
- keyboard-focused UI;
- non-capturing passive overlays;
- responsive visibility.

Cannot do:
- reserve columns;
- dim the whole underlying canvas through an extension-level API;
- resize/reflow built-in chat around overlay.

Examples:
- `overlay-qa-tests.ts`
- `overlay-test.ts`
- `doom-overlay/`

Prototypes:
- `src/spike/sidebar-overlay-noncapturing.ts`
- `src/spike/command-palette-overlay.ts`
- `src/spike/memory-editor-overlay.ts`
- `src/spike/approval-modal-overlay.ts`

Implementation caveat:
- Type docs say `overlayOptions` may be a function. In `interactive-mode.js`,
  the function is resolved when the overlay is shown and then passed to
  `tui.showOverlay(...)`. Treat it as open-time dynamic, not guaranteed
  per-render dynamic, until upstream confirms otherwise.

### 1.7 Raw terminal input

```ts
ctx.ui.onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void
```

Can do:
- global-ish input interception in interactive mode;
- support passive state machines.

Cannot do:
- robust focused complex UI; use `ctx.ui.custom()` components for that;
- work in RPC/print mode.

Cathedral use:
- avoid unless a region truly needs raw terminal interception. Prefer
  `registerShortcut` and component `handleInput()`.

### 1.8 Custom editor

```ts
ctx.ui.setEditorComponent(
  factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined
): void
```

Can do:
- replace the input editor;
- preserve Pi app shortcuts when extending `CustomEditor` and calling
  `super.handleInput(data)`;
- copy current text into the replacement editor;
- receive autocomplete provider wiring.

Cannot do:
- render full-height sidebars;
- render chat rows;
- change the scrollback width.

Examples:
- `modal-editor.ts`
- `rainbow-editor.ts`

Prototypes:
- `src/spike/input-frame-customeditor.ts`
- `src/spike/sidebar-editor-boundary.ts`

### 1.9 Autocomplete

```ts
ctx.ui.addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void
```

Can do:
- stack command/path/model completions into the default editor.

Cannot do:
- render command palette overlays;
- change editor frame.

Cathedral use:
- later: `/sumo:*` command completions and memory commands.

### 1.10 Status + terminal title + working indicators

```ts
ctx.ui.setStatus(key: string, text: string | undefined): void
ctx.ui.setTitle(title: string): void
ctx.ui.setWorkingMessage(message?: string): void
ctx.ui.setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void
ctx.ui.setHiddenThinkingLabel(label?: string): void
```

Can do:
- feed built-in status/footer surfaces;
- customize spinner/working label;
- customize hidden-thinking label.

Cannot do:
- custom layout.

Examples:
- `model-status.ts`
- `hidden-thinking-label.ts`

Cathedral use:
- already used for SumoCode working indicator;
- footer rework should not depend on `setStatus()` except for extension status
  aggregation.

### 1.11 Tool registration and rendering

```ts
pi.registerTool<TParams, TDetails, TState>({
  name,
  label,
  description,
  parameters,
  renderShell?: "default" | "self",
  execute(toolCallId, params, signal, onUpdate, ctx),
  renderCall?(args, theme, context): Component,
  renderResult?(result, options, theme, context): Component,
})
```

Can do:
- define new tools;
- override built-in tools by registering the same name;
- delegate execution to built-in tool factories;
- fully own tool framing with `renderShell: "self"`.

Cannot do:
- override built-in renderers from an event handler alone;
- change tool rows already rendered before override load.

Examples:
- `built-in-tool-renderer.ts`
- `minimal-mode.ts`
- `tool-override.ts`
- `todo.ts`

Prototype:
- `src/spike/tool-pill-renderer.ts`

Important doc finding:
- Built-in renderer inheritance is public: if an override omits a slot renderer,
  Pi falls back to the built-in renderer for that slot. That lets production
  wrap only the Cathedral shell while keeping Pi's mature result parsing where
  useful.

### 1.12 Custom message rendering

```ts
pi.registerMessageRenderer<T>(
  customType: string,
  renderer: (message: CustomMessage<T>, options: { expanded: boolean }, theme: Theme) => Component | undefined
): void

pi.sendMessage({ customType, content, display, details }, options?): void
```

Can do:
- render Sumo-owned session entries with custom components;
- persist extension messages in the session.

Cannot do:
- replace Pi's built-in assistant/user/tool-result renderers;
- change markdown rendering for normal assistant messages.

Example:
- `message-renderer.ts`

Prototype:
- `src/spike/codeblock-message-renderer.ts`

Cathedral use:
- useful for Sumo-specific pages/chrome/status entries;
- normal assistant markdown code blocks remain theme-driven.

### 1.13 Shortcuts, commands, session state, providers

```ts
pi.registerCommand(name, { description?, getArgumentCompletions?, handler })
pi.registerShortcut(shortcut: KeyId, { description?, handler })
pi.appendEntry(customType, data?)
pi.sendMessage(...)
pi.sendUserMessage(...)
pi.setSessionName(name)
pi.setModel(model)
pi.getThinkingLevel()
pi.setThinkingLevel(level)
pi.registerProvider(name, config)
```

Can do:
- expose `/sumo:*` commands;
- open overlays via shortcuts (`ctrl+k`);
- persist UI state as custom session entries;
- drive command palette model/thinking rows.

Cannot do:
- layout rows/columns by themselves.

Examples:
- `commands.ts`
- `session-name.ts`
- `send-user-message.ts`
- `model-status.ts`
- `custom-provider-*`

---

## 2. Region-by-region recommendation

### 2.1 Top chrome

Recommended API: `ctx.ui.setHeader()`.

Prototype: `src/spike/top-chrome-setheader.ts`.

Why robust:
- header replacement is explicitly public;
- state-driven active tab can be updated from events and `tui.requestRender()`.

Concession:
- header is above chat, which matches the mockup top bar.
- no pixel concession expected.

### 2.2 Registry sidebar

Recommended API today: `ctx.ui.custom(..., { overlay: true, nonCapturing: true })`
for a public-API prototype only.

Prototype: `src/spike/sidebar-overlay-noncapturing.ts`.

Why robust:
- uses public overlay API;
- `nonCapturing: true` keeps editor/chat keyboard focus.

Concession:
- **major**: overlay does not reserve columns. Chat content may render
  underneath it. This fails the mockup's two-pane layout when lines are wide.

Final recommendation:
- do not ship overlay as "parity complete";
- request/upstream a public side-panel/layout API, then implement production
  registry sidebar against that.

### 2.3 Registry footer

Recommended API: `ctx.ui.setFooter()`.

Prototype: `src/spike/footer-registry-tone.ts`.

Why robust:
- footer replacement is public;
- has access to git branch/status provider and can derive model/thinking/state
  from context/events.

Concession:
- no expected pixel concession.

### 2.4 Empty-chat quote

Recommended API: `ctx.ui.setHeader()` as a conditional tall header region, or a
future side-panel/layout API if available.

Prototype: `src/spike/empty-chat-quote-setheader.ts`.

Why robust:
- public header API; no internal tree mutation.

Concession:
- quote appears in the header region above chat, not inside the built-in chat
  scrollback. For the preserved Sumo splash this is acceptable; for exact
  active-empty parity it wants a proper layout/body slot.

### 2.5 Carved input frame

Recommended API: `ctx.ui.setEditorComponent()` with a `CustomEditor` subclass.

Prototype: `src/spike/input-frame-customeditor.ts`.

Why robust:
- public custom editor API;
- `interactive-mode.js` copies current text, callbacks, autocomplete, and app
  action handlers onto custom editors.

Concession:
- no expected pixel concession for the input frame itself.

### 2.6 Tool pills

Recommended API: `pi.registerTool()` overrides for built-in `read`, `bash`,
`edit`, `write`, etc., delegating execution to Pi's built-in tool factories and
using `renderShell: "self"` where needed.

Prototype: `src/spike/tool-pill-renderer.ts`.

Why robust:
- public documented pattern in `built-in-tool-renderer.ts`;
- renderer inheritance lets us override only display pieces if desired.

Concession:
- more code; production must carefully delegate each built-in tool and preserve
  parameter schemas/execution semantics.

### 2.7 Code blocks

Recommended API: Cathedral `cathedral.json` theme slots for normal assistant
markdown; `pi.registerMessageRenderer()` only for Sumo-owned custom messages.

Prototype: `src/spike/codeblock-message-renderer.ts`.

Why robust:
- theme slots are public and already used by Pi's Markdown renderer;
- custom message renderer is public for extension-owned code blocks.

Concession:
- no public API to replace the built-in assistant markdown renderer wholesale.
  If theme slots cannot achieve final parity, we need an upstream
  `registerAssistantMessageRenderer` / markdown theme hook.

### 2.8 Approval modal

Recommended API for Sumo-owned approval gates: `tool_call` interception +
`ctx.ui.custom({ overlay: true })`.

Prototype: `src/spike/approval-modal-overlay.ts`.

Why robust:
- public tool-blocking event;
- public overlay component.

Concession:
- Pi core `ctx.ui.confirm()` modals cannot be globally re-skinned through a
  public API. We can style only approval prompts we own/intercept.

### 2.9 Command palette

Recommended API: `pi.registerShortcut("ctrl+k", ...)` +
`ctx.ui.custom({ overlay: true })` focused component.

Prototype: `src/spike/command-palette-overlay.ts`.

Why robust:
- keyboard shortcuts and custom overlays are public;
- component `handleInput()` owns arrow/enter/escape behavior.

Concession:
- no global dimming of background; overlay composites over current content.

### 2.10 Memory editor

Recommended API: `/sumo:memory edit` command +
`ctx.ui.custom({ overlay: true })` focused component.

Prototype: `src/spike/memory-editor-overlay.ts`.

Why robust:
- command + custom overlay public APIs;
- can read Remnic through existing client and render a read-only view.

Concession:
- no global dimming; inline editing requires more `EditorComponent` or focused
  child input work but is not required for v1.

---

## 3. Sidebar problem — three honest paths

### Path A — custom editor owns bottom region and side band

Prototype: `src/spike/sidebar-editor-boundary.ts`.

Result:
- works technically inside editor-owned rows;
- cannot reach chat rows or full-height content.

Verdict:
- reject for registry sidebar;
- keep only for carved input.

### Path B — `setHeader()` renders tall split-pane workspace

Prototype: `src/spike/sidebar-custom-header.ts`.

Result:
- can reserve a right column inside header-rendered lines;
- can render quote + registry in one component;
- normal Pi chat starts below this header, so streaming messages/tools do not
  share the split-pane.

Verdict:
- useful for splash/empty preview states;
- reject as active chat/sidebar architecture.

### Path C — non-capturing right overlay

Prototype: `src/spike/sidebar-overlay-noncapturing.ts`.

Result:
- public and stable;
- right-side registry can be persistent and non-focus-stealing;
- responsive visibility works;
- does not reserve columns.

Verdict:
- acceptable as a temporary public-API fallback;
- not acceptable as "mockup parity complete".

### Path D — public side-panel/layout API (not present in Pi 0.70.2)

Desired API sketch:

```ts
ctx.ui.setSidePanel("right", {
  width: 49,
  minTerminalWidth: 120,
  gutter: 1,
  component: (tui, theme) => registryComponent,
});
```

or:

```ts
ctx.ui.setLayout({
  body: {
    rightPanel: {
      width: 49,
      visible: (w) => w >= 120,
      component: (tui, theme) => registryComponent,
    },
  },
});
```

Result:
- not available today.

Verdict:
- recommended final architecture.
- file upstream request / implement in Pi if Dhruv wants exact sidebar parity
  without private-state mutation.

---

## 4. Gap list and upstream feature-request drafts

### Gap 1 — static column-reserving side panel

Mockup region:
- right `REGISTRY` sidebar in `01-idle.png`, `02-streaming.png`,
  `03-tool-running.png`, `05-memory-editor.png`.

Missing public API:
- side panel that reserves columns from the chat/body area and participates in
  responsive layout.

Draft upstream request:

> Add `ctx.ui.setSidePanel(position, factory, options)` for extensions. It
> should support `position: "right" | "left"`, fixed/percentage width,
> responsive `visible(termWidth, termHeight)`, gutter columns, and lifecycle
> disposal. The panel must reserve columns for the built-in chat/status body
> instead of compositing as an overlay. This lets extensions build persistent
> terminal sidebars without mutating `TUI.children`.

### Gap 2 — body/empty-state slot

Mockup region:
- centered active-empty quote in `01-idle.png`.

Missing public API:
- a body/empty-state component slot rendered inside the chat/body area when
  there are no messages.

Draft upstream request:

> Add `ctx.ui.setEmptyState(factory)` or `ctx.ui.setBodyBackground(factory)` so
> extensions can render a component inside the message viewport when the session
> has no visible messages. Header is too high-level and overlays do not reserve
> layout.

### Gap 3 — assistant markdown renderer override

Mockup region:
- exact code-block framing/syntax in `02-streaming.png`.

Missing public API:
- extension-level hook to wrap/replace built-in assistant markdown rendering.

Draft upstream request:

> Add `pi.registerAssistantMessageRenderer(renderer)` or expose a documented
> Markdown theme factory hook beyond color slots, so extensions can control code
> block borders, line-number policy, and markdown block spacing while retaining
> Pi's streaming message lifecycle.

### Gap 4 — global modal/dialog theming

Mockup region:
- `04-approval.png`, built-in permission prompts.

Missing public API:
- custom renderer/theme for built-in `ctx.ui.confirm/select/input/editor`.

Draft upstream request:

> Add dialog theming hooks or `ctx.ui.setDialogRenderer()` for built-in
> `select`, `confirm`, `input`, and `editor` prompts. Extensions should be able
> to supply component factories for standard dialog types while preserving the
> built-in promise-based APIs.

### Gap 5 — overlay backdrop dimming

Mockup region:
- `04-approval.png` and `06-command-palette.png` dim the entire terminal.

Missing public API:
- overlay backdrop style / opacity / fill.

Draft upstream request:

> Add `backdrop?: "none" | "dim" | { char?: string; style?: ... }` to
> `OverlayOptions`, letting overlays request a dimmed underlying canvas without
> manual full-screen composition.

---

## 5. Recommended layer order revision

Current `CATHEDRAL_UX_SPEC.md` §6 starts with top chrome/footer/sidebar. The
spike suggests splitting "public API implementable now" from "requires upstream
side-panel".

Proposed revision:

1. **Retire shortcut plan** — document that `dockStaticSidebar()` is temporary
   and blocked on side-panel API for exact parity.
2. **Top chrome** — `setHeader`, passive tabs.
3. **Registry footer** — `setFooter`, thinking level included.
4. **Carved input frame** — `setEditorComponent` with `CustomEditor`.
5. **Command palette overlay** — `registerShortcut` + custom overlay.
6. **Memory editor overlay** — `/sumo:memory edit` + custom overlay.
7. **Tool pill renderer** — re-register built-in tools, delegate execution,
   `renderShell: "self"`.
8. **Approval gates we own** — intercept dangerous tool calls, custom overlay.
9. **Markdown/code block audit** — theme slots first; upstream hook if exact
   framing impossible.
10. **Registry sidebar content/state machine** — pure render/state code can be
    built and tested now, but production mount waits for side-panel API.
11. **Public side-panel API integration** — once available, replace
    `dockStaticSidebar()` and mount registry sidebar for real.
12. **Empty-active quote inside body** — use side-panel/body slot if available;
    otherwise header-based fallback only.

Rationale:
- We should keep shipping public-API-backed pieces while not pretending overlay
  equals reserved-column parity.

---

## 6. Migration plan for existing `dockStaticSidebar()` shortcut

1. Add a new production module, e.g. `src/registry-sidebar.ts`, with pure
   `renderRegistrySidebar()` and a public `installRegistrySidebar(pi)` function.
   Initially mount via overlay only behind a feature flag named
   `sumocode.registrySidebarMount = "overlay" | "sidePanel" | "off"`.
2. Stop extending `dockStaticSidebar()`; treat it as frozen compatibility code.
3. Add tests proving the registry render/state machine is independent from the
   mount mechanism.
4. File upstream Pi issue for `ctx.ui.setSidePanel(...)` using §4 Gap 1.
5. Once Pi exposes a side-panel/layout API, implement a `sidePanel` mount path
   without touching `tui.children`.
6. Flip default mount from current `dockStaticSidebar()` to the new public
   side-panel mount.
7. Remove `StaticSidebarDock`, `dockStaticSidebar`, and all tests that assert
   root-container surgery.
8. Delete the dev-only local symlink note if no longer required by visual tests,
   or document it separately as a visual harness concern rather than UI layout.
9. Run `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm visual`, get Dhruv visual
   approval, then merge.

---

## 7. Prototype index

| Prototype | Public API proven | Tests |
|---|---|---|
| `src/spike/top-chrome-setheader.ts` | `ctx.ui.setHeader` | `top-chrome-setheader.test.ts` |
| `src/spike/footer-registry-tone.ts` | `ctx.ui.setFooter` | `footer-registry-tone.test.ts` |
| `src/spike/sidebar-overlay-noncapturing.ts` | `ctx.ui.custom` overlay + `nonCapturing` | `sidebar-overlay-noncapturing.test.ts` |
| `src/spike/sidebar-custom-header.ts` | tall `ctx.ui.setHeader` split-pane | `sidebar-custom-header.test.ts` |
| `src/spike/sidebar-editor-boundary.ts` | editor-slot side-band limitation | `sidebar-editor-boundary.test.ts` |
| `src/spike/input-frame-customeditor.ts` | `ctx.ui.setEditorComponent` + `CustomEditor` | `input-frame-customeditor.test.ts` |
| `src/spike/command-palette-overlay.ts` | shortcut + focused overlay | `command-palette-overlay.test.ts` |
| `src/spike/memory-editor-overlay.ts` | slash command + focused overlay | `memory-editor-overlay.test.ts` |
| `src/spike/approval-modal-overlay.ts` | `tool_call` gate + focused overlay | `approval-modal-overlay.test.ts` |
| `src/spike/tool-pill-renderer.ts` | tool renderers + `renderShell: "self"` | `tool-pill-renderer.test.ts` |
| `src/spike/codeblock-message-renderer.ts` | custom message renderer | `codeblock-message-renderer.test.ts` |

---

## 8. Verification

Spike verification completed locally:

```bash
pnpm exec tsc --noEmit
pnpm test
```

Result at time of authoring:

- TypeScript: clean
- Vitest: 22 files passed, 105 tests passed

No visual harness run was required for this spike; these prototypes prove API
feasibility, not final visuals.
