# SumoTUI Audit — 2026-04-29

> Scope: current `sumocode` worktree, `src/sumo-tui/**`, Cathedral runtime/UI code, SumoTUI research docs, V2 visual spec, and a quick survey of other production TUI frameworks.
>
> Bottom line: **SumoTUI is the right strategic bet** for the final goal, but the project is currently in a risky middle state: part retained app-shell, part Pi line-renderer surgery. The fastest path to a daily-driver-quality SumoCode is to stop adding surfaces briefly, align spec/tests/runtime, then deepen SumoTUI into a small, composable app-shell kernel with one owner for terminal lifecycle, input, layout, transcript state, and rendering.

---

## 1. What I think about SumoTUI

SumoTUI is justified. This is not aesthetic overengineering.

Pi is excellent as an agent engine: models, tools, sessions, extension loading, editor edge cases, slash commands, auth, MCP. But Pi's default `pi-tui` render model is fundamentally a vertical `Component.render(width): string[]` concatenator. That model will always fight the final SumoCode goal:

- footer pinned to the viewport bottom;
- app-owned chat scrollback in altscreen;
- mouse wheel routing that does not mutate prompt history;
- portrait/landscape adaptive shell;
- modal focus stack;
- structured chat/tool/code blocks;
- SumoCode-specific visual identity that survives long sessions.

The accepted ADR is directionally correct: **keep Pi as runtime/editor/agent utility, and build SumoTUI as the root experience renderer**.

The current danger is not the decision to build SumoTUI. The danger is the **hybrid phase lasting too long**. Today SumoTUI has real primitives — Yoga nodes, cell buffer, diff writer, ScrollBox, ChatPager, lifecycle, mouse parser — but production still depends on private Pi container overrides and Pi full redraws. That means many bugs are now seam bugs: neither renderer has complete authority.

My high-confidence recommendation:

1. **Do not extract SumoTUI as a package yet.** Keep it bundled until SumoCode daily-drives it for at least 30 stable days.
2. **Do not add more Cathedral surfaces until runtime/spec/tests are aligned.** Right now new work will compound drift.
3. **Make SumoTUI a real app-shell kernel, not just a retained widget library.** It needs a model/update/render loop, typed styling primitives, a proper focus/input system, a headless test backend, and a clean Pi adapter seam.

---

## 2. Current health snapshot

### Commands run during audit

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration
pnpm visual:ci
```

### Results

| Check | Result | Notes |
|---|---:|---|
| `pnpm exec tsc --noEmit` | ✅ pass | TypeScript is clean. |
| `pnpm build` | ✅ pass | Build script is `tsc --noEmit`. |
| `pnpm test` | ✅ pass | 68 files / 399 tests passing on current HEAD `6097b23`. |
| `pnpm test:integration` | ❌ fail | `cursor-visibility.test.ts` times out. 10 files pass, 1 fails; 13 passing / 14 total. |
| `pnpm visual:ci` | ✅ review-compatible | 7 scenarios rendered. `footer-ready`, `sidebar-editorial`, `active-portrait` passed; `input`, `top-bar`, `splash`, `active-landscape` are still review states. |

### Immediate interpretation

The code is type-safe and unit coverage is green on the current sidebar V2 commit, but the repo is **not fully green** because one PTY integration test still times out. The remaining failure looks like a runtime/integration contract issue rather than TypeScript or pure renderer breakage. `cursor-visibility.test.ts` still deserves triage because V2 explicitly removed active input labels, and cursor correctness is a daily-driver P0.

Before feature work, align the remaining runtime contract and make integration green.

---

## 3. Current strengths

### 3.1 The ADR and research quality are unusually strong

`docs/adr/0001-sumo-tui-framework.md` and `docs/research/sumo-tui-spike/**` are a good decision trail. The project already captured the key architectural lesson from OpenCode/OpenTUI: **altscreen works only if the app owns scrollback**.

The edge-case catalog is also strong. It anticipates cursor remapping, wide chars, streaming races, resize, crash cleanup, images, no-TTY, Yoga leaks, Pi version drift, and mouse routing.

### 3.2 Core primitives exist and are tested

Good foundations already present:

- `TerminalController` for altscreen, SGR mouse, OSC bg, cleanup.
- `LifecycleRuntime` for signals, raw-mode restore, crash log.
- `FrameScheduler` with event-driven idle and streaming coalescing.
- `SumoNode` + Yoga WASM layout.
- `CellBuffer` + ANSI writer + frame diff.
- `ScrollBox` + `ChatPager` with sticky-bottom/manual-scroll behavior.
- `PiEditorLeaf` cursor-marker remapping.
- `RegionRegistry` and `SumoExtensionUIAdapter` as a retained replacement path for Pi UI hooks.
- Visual Bible + V2 visual harness.

This is not just a sketch; it is a real beginning of a terminal app framework.

### 3.3 Performance measurements are encouraging

`docs/research/sumo-tui-performance.md` shows:

- retained render p50 ~1.08ms, p95 ~1.41ms;
- streaming p95 ~9ms;
- SumoTUI idle RSS delta vs bare Pi ~19 MiB;
- streaming RSS well under the 300 MiB target.

`docs/research/sumo-tui-cpu-diagnosis.md` shows idle CPU at ~0.30% after the scheduler guard fixes. That is exactly the discipline this project needs.

### 3.4 The visual verification loop is a real differentiator

The V2 visual harness and Bible are worth keeping. Terminal UIs regress in ways unit tests do not see: stray bg cells, line overflow, missing cursor, stale ANSI. The current `pnpm visual:ci` loop is already catching those classes.

---

## 4. Biggest risks and improvement areas

### P0 — The runtime is stuck between two renderers

Evidence:

- `SumoInteractiveRuntime` starts SumoTUI primitives, then delegates the session loop to upstream `InteractiveMode`.
- `installChatViewportBridge()` overrides `upstream.chatContainer.render`, `clear`, `invalidate`, `handleEvent`, and `renderSessionContext`.
- Chat updates force `target.ui?.requestRender?.(true)` because Pi's differential scroll can smear SumoTUI's hybrid chat/sidebar layout.
- Chat geometry is computed by rendering Pi chrome components to count rows.

This is clever and probably necessary as a transitional bridge, but it is fragile. It means:

- Pi still owns root vertical flow.
- SumoTUI owns chat rows inside that flow.
- Sidebar is an overlay outside flow.
- Chat width is manually reduced by sidebar constants.
- Mouse events are translated through retained chat coordinates into a Pi-rendered shell.

That is not a stable final architecture.

**Recommendation:** define explicit modes and stop blurring them:

1. **Hybrid-safe mode**: Pi owns terminal/editor/chat. No altscreen unless SumoTUI owns scrollback. SumoCode uses header/footer/sidebar overlays only.
2. **Owned-shell mode**: SumoTUI owns terminal, root layout, chat viewport, footer, sidebar, modals, input routing. Pi provides agent/session/editor utilities through adapters.
3. **Experimental full-owned mode**: SumoTUI owns everything, including native editor replacement.

Daily-driver work should move to owned-shell mode. Hybrid-safe is fallback only.

---

### P0 — Some runtime contracts still lag the locked V2 spec

The sidebar V2 unit-test drift appears resolved on current HEAD `6097b23`, but several spec/runtime gaps remain:

- V2 spec says active input has **no label**; `cursor-visibility.test.ts` should not rely on obsolete labels and still times out in PTY.
- V2 spec says command palette has 6 modes including `SETTINGS`; current `PaletteMode` has 5 modes and no `SETTINGS`.
- V2 spec says cursor color should respect terminal preference; `TerminalController` unconditionally emits OSC 12 cursor color set/reset.
- V2 spec mentions `src/sumo-tui/render/truecolor.ts`; the code has `truecolor.test.ts` but no such module.
- V2 spec calls out command palette active-state opening and drill-down behavior as broken; current implementation still writes slash commands/editor text for some selections.

This is still a velocity killer because every new surface must decide whether to follow the code, the tests, or the V2 spec.

**Recommendation:** add a one-time "contract realignment" PR:

1. Mark `docs/ui/CATHEDRAL_UX_SPEC_V2.md` + Bible HTML as the only visual source of truth.
2. Keep the newly aligned V2 unit tests green; delete/update stale V1 assertions whenever they reappear.
3. Lock constants to V2: sidebar width 30, thresholds recomputed, terminal dim line dynamic.
4. Update integration tests to wait for durable runtime markers, not obsolete labels.
5. Add a `docs/visual/parity/CONTRACT.md` that defines which crops are review-only vs required.

---

### P0 — Terminal lifecycle has too many owners

Current ownership paths:

- `src/extension.ts` calls `installAltscreen(pi)`.
- `installAltscreen()` calls `installLifecycle(pi)`.
- `LifecycleRuntime` enters altscreen + mouse on `session_start` and restores on `session_shutdown`.
- `SumoInteractiveRuntime.start()` also calls `TerminalController.startRetainedSession()` before upstream init.
- The controllers are different instances.

This duplicate ownership may be benign in many runs because terminal sequences are idempotent-ish, but it increases risk during `/resume`, `SIGTSTP`, `SIGCONT`, uncaught exceptions, and no-session/no-TTY test modes.

Also, V2 says not to override cursor preference, but `TerminalController` emits:

```ts
export const CURSOR_COLOR_SET = "\x1b]12;#D97706\x1b\\";
```

**Recommendation:** introduce one `TerminalSessionOwner` singleton with an explicit reference-count or state machine:

```txt
idle → starting → active → suspending → suspended → active → stopping → stopped
```

Rules:

- exactly one place enters/leaves altscreen;
- exactly one place enables/disables mouse;
- OSC 11 bg paint is feature-flagged (`/sumo:bg paint|none`);
- OSC 12 cursor color is off by default and only set by explicit `/sumo:cursor`;
- no-TTY paths are no-op but still testable through a headless backend.

---

### P0 — Portrait support is still unresolved against the final goal

Project context says Mac mini is portrait and MacBook is landscape. PRD earlier wanted bottom/sidebar adaptations for portrait. V2 spec currently says:

- sidebar hidden on splash;
- sidebar hidden when `W < 120`;
- otherwise visible as a right pane.

That may be okay if portrait terminals still exceed 120 columns, but portrait often means narrower width and taller height. Hiding the sidebar entirely removes one of SumoCode's core value props: ambient memory/context.

**Recommendation:** decide this explicitly:

- **Option A:** V1 portrait hides sidebar and footer/hint row absorbs context. Simple, less personal.
- **Option B:** V1 portrait has a bottom registry band. More work, aligns with PRD/final goal.
- **Option C:** V1 portrait has a command-toggled overlay only. Middle ground.

My vote: **Option B eventually, Option C immediately.** Right now, make portrait overlay reliable and non-capturing; then add bottom band once the owned layout is stable.

---

### P0 — Command and keybinding conflicts are already visible

Examples:

- `src/command-palette.ts` registers `sumo:memory` as a stub.
- `src/memory-editor.ts` registers `sumo:memory` again with real behavior.
- V2 says command palette trigger is `Ctrl+/`, active-state opening is broken, and Enter should drill down rather than insert slash text.
- V2 says `Ctrl+T` thinking-cycle may be intercepted.

**Recommendation:** centralize command/keybind registration:

```ts
commands/register.ts
keybindings/register.ts
```

Add a startup conflict inspector that emits a structured dev warning:

```txt
keybind conflict: ctrl+/ owned by command-palette, skipped by X
slash conflict: /sumo:memory registered by command-palette and memory-editor
```

Borrow from Textual's event/message routing and Bubble Tea's central message loop: key events should flow through one router with priority, focus, modal stack, and trace logging.

---

### P1 — Rendering is too raw-string-heavy

There are repeated ad hoc helpers across files:

- `fg(hex)`, `bg(hex)`, `color(text, hex)`, `visibleLength()`, `padToWidth()`.
- ANSI resets and bg repaint logic differ by component.
- Many renderers emit strings directly rather than styled spans.

This causes the exact bugs already seen: cells falling through to terminal bg, nested resets clearing row bg, over-width lines, stale ANSI after truncation.

**Recommendation:** introduce a small typed render primitive layer before building more UI:

```ts
type Style = { fg?: Token; bg?: Token; bold?: boolean; italic?: boolean; dim?: boolean };
type Span = { text: string; style?: Style };
type Line = Span[];

renderLine(line: Line, width, options): string
box({ title, width, style, children }): Line[]
rule(width, style): Line
pad(line, width, fillStyle): Line
truncate(line, width): Line
```

Then build Cathedral surfaces from these primitives:

- `MessageFrame`
- `ToolPill`
- `ToolLedger`
- `CodeBlock`
- `ScriptoriumModal`
- `RegistrySidebar`
- `FooterLine`
- `InputFrame`

This is the "Lip Gloss" lesson from Charm: make styling/layout primitives pure, reusable, and boring.

---

### P1 — SumoTUI needs a unidirectional app model

Current state is scattered:

- Pi events update footer state directly.
- Sidebar reads from `ctx.sessionManager` during render.
- Chat bridge mutates `ChatPager` from Pi event hooks.
- Memory cache timers call render callbacks.
- Command palette directly writes editor text or calls UI selects.

This works for a small extension. It will not scale to a full shell.

Borrow the Elm/Bubble Tea pattern:

```ts
type AppModel = {
  terminal: TerminalModel;
  session: SessionModel;
  chat: ChatModel;
  sidebar: SidebarModel;
  modalStack: ModalModel[];
  input: InputModel;
  theme: ThemeModel;
};

type AppMsg =
  | { type: "pi.message_start"; message: PiMessage }
  | { type: "pi.tool_result"; result: PiToolResult }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "input.key"; event: KeyEvent }
  | { type: "mouse.event"; event: MouseEvent }
  | { type: "memory.loaded"; facts: Fact[] }
  | { type: "theme.changed"; theme: ThemeId };

function update(model: AppModel, msg: AppMsg): [AppModel, Command[]]
function view(model: AppModel): SumoNode
```

This gives you:

- deterministic state transitions;
- replayable bug reports;
- easier headless tests;
- a single place to profile resume/startup;
- clean async via commands/workers.

Borrow Textual's `Worker` idea for memory fetches, session summary, and long-running UI tasks: exclusive workers cancel stale work and avoid races.

---

### P1 — Chat model is not structured enough for V2 elements

V2 needs message frames, skill pills, tool pills, code blocks, scroll/scribe delegation, Divine Query, and later live bash. Current retained chat is mostly text-role messages.

**Recommendation:** introduce a structured transcript model now:

```ts
type ChatBlock =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string; source: string; collapsed?: boolean }
  | { type: "tool"; tool: ToolCallViewModel }
  | { type: "skill"; name: string; expanded: boolean }
  | { type: "question"; question: QuestionViewModel }
  | { type: "delegation"; scroll: ScrollViewModel };

type ChatMessageViewModel = {
  id: string;
  role: "user" | "sumo" | "system";
  displayName: string;
  timestamp?: Date;
  blocks: ChatBlock[];
};
```

Render `ChatMessageViewModel` to retained widgets. Do not keep trying to infer V2 surfaces from plain text rows.

---

### P1 — CellBuffer works, but should be optimized before longer sessions

Current `CellBuffer` uses a `Uint16Array` for chars, but style storage is multiple `Map<number, string|number>` structures. `clone()` copies maps every frame. This is okay at current sizes and measured benchmarks, but it will become a cost under:

- 160×60 full-shell frames;
- drag selection highlight;
- code/tool ledgers;
- animated splash;
- long streaming sessions;
- split panes later.

Borrow from Ratatui/OpenTUI:

- store style IDs in typed arrays;
- maintain a style table `{ fg,bg,attrs } -> id`;
- keep previous/current buffers and swap them instead of cloning maps;
- dirty-row/dirty-rect tracking;
- row hash before per-cell compare;
- cache wrapped markdown/code blocks by `(contentHash,width,themeVersion)`.

Do this only after contracts are aligned; current perf is acceptable.

---

### P1 — Testing strategy is good but not yet authoritative

The repo has a lot of tests, but the failure mode shows the problem: tests are not tied to the latest spec contract.

Borrow from Ratatui/Textual:

- a **headless backend** that behaves like the terminal but does not write real ANSI;
- a **Pilot API** that can press keys, send mouse events, resize, and assert visible cells;
- a **TestBackend** that exposes current/previous buffers and cursor state;
- visual goldens promoted only after human approval.

Proposed test layers:

1. **Pure render tests**: `renderFoo(snapshot,width)` returns styled lines/cells.
2. **Headless SumoTUI tests**: app model + backend + input events.
3. **PTY smoke tests**: real Pi/Sumo integration, terminal lifecycle, cursor, mouse.
4. **Visual Bible tests**: component/runtime crops.
5. **Long-session soak tests**: 10k messages, 1h idle, resize storm, streaming while scrolled up.

---

### P1 — Observability/devtools should become a first-class feature

Current diagnostics are good but low-level: JSONL diagnostics, CPU script, visual outputs.

Borrow Textual Devtools and OpenTUI debug overlays:

- `Ctrl+Shift+D` debug overlay with:
  - current mode: hybrid/owned;
  - terminal dims;
  - frame p50/p95;
  - renders/sec;
  - dirty queue depth;
  - focused widget;
  - modal stack;
  - scroll offset/manualScroll/unread;
  - active keybindings;
  - Pi event rate;
  - memory worker status.
- `SUMO_TUI_TRACE=1` writes replayable event logs.
- `sumocode replay <trace>` replays a bug in headless mode.

This will pay for itself because terminal bugs are hard to describe.

---

## 5. Patterns to borrow from other TUIs

### OpenCode / OpenTUI

Already researched in `docs/research/sumo-tui-spike/01-opencode.md` and `02-opentui.md`.

Steal aggressively:

- App-owned `ScrollBox` with sticky bottom.
- Prompt outside scrollbox.
- Explicit snap-to-bottom after async session load/submit.
- Message-boundary navigation using rendered child positions.
- Responsive sidebar: dock on wide, overlay on narrow.
- Theme tokens for every semantic surface.
- Central renderer lifecycle with suspend/resume/destroy.
- Hit grid / focus manager / mouse dispatcher.
- Selection-aware mouse handling.

Do **not** copy blindly:

- Bun/OpenTUI as direct runtime dependency; Pi extensions are Node/jiti today.
- Fixed FPS loop as the default; SumoTUI's event-driven idle model is better for agent sessions.

### Bubble Tea

Source: `https://github.com/charmbracelet/bubbletea`

Borrow:

- `Model -> Update -> View` architecture.
- Commands as async effects that return messages.
- Keep update/view fast; all blocking work becomes a command.
- Central message channel for safe background work.

Why it matters here: SumoCode currently has direct event-to-render hooks everywhere. A Bubble Tea-like loop would make runtime behavior testable and replayable.

### Ratatui

Sources:

- `https://ratatui.rs/`
- `https://docs.rs/ratatui/latest/ratatui/backend/struct.TestBackend.html`

Borrow:

- Immediate draw into a buffer, then diff previous/current buffers.
- TestBackend for integration tests with no terminal.
- Widget authors render into a `Frame`, not strings.
- Modular core vs app-facing package split once the API stabilizes.

Why it matters here: SumoTUI already has a retained tree, but the **backend/test** lesson is huge. Build a formal headless backend and stop relying so much on pty parsing for correctness.

### Textual

Sources:

- `https://textual.textualize.io/guide/reactivity/`
- `https://textual.textualize.io/guide/workers/`
- `https://textual.textualize.io/guide/events/`
- `https://textual.textualize.io/guide/testing/`
- `https://textual.textualize.io/guide/devtools/`

Borrow:

- Reactive properties that automatically invalidate the right widget.
- Worker API with `exclusive` behavior for canceling stale async tasks.
- Message pump with selector-style handlers.
- Headless `run_test()` + Pilot API.
- Devtools console that avoids corrupting terminal output.
- Styling separated from logic.

Why it matters here: memory queries, session summarization, MCP health, and visual state updates all need cancellation/race protection.

### Ink

Source: `https://github.com/vadimdemedes/ink`

Borrow:

- Component composition and flexbox mental model.
- Eventually, a declarative adapter for complex UI trees.

Do not start there. A React reconciler is a Phase 6+ idea. First make the imperative kernel correct.

### Charm Lip Gloss / Bubbles

Borrow:

- Small reusable styling primitives.
- Composable widgets that can be used without a full framework.
- Strong separation between layout/style and app logic.

This directly maps to the suggested `Span/Line/Style` layer.

---

## 6. Feature ideas that move SumoTUI toward the final goal

### Daily-driver UX

1. **Transcript search**: `/` inside chat scrollback, jump between matches, highlight cells.
2. **Semantic jumps**: next/previous user message, next/previous tool, last failed tool, last code block.
3. **Session archive overlay**: top-bar ARCHIVE opens a searchable session list.
4. **Recent session tabs**: passive first, interactive once session switching is stable.
5. **Command palette drill-downs**: SESSION / MODEL / THINKING / MEMORY / THEME / SETTINGS, all Scriptorium style.
6. **Keybinding conflict inspector**: visible list of active owner/priority for each binding.
7. **In-app selection + OSC 52 copy**: required because SGR mouse capture weakens native terminal selection.
8. **Slow terminal mode**: lower frame cap, disable animations, more aggressive row diffing.
9. **Safe recovery command**: `sumocode recover` emits reset bytes after SIGKILL/terminal corruption.
10. **Resume perf budget overlay**: show exact resume path timing when `SUMO_TUI_DEBUG=1`.

### Agent/product features

1. **Tool ledger cards**: compact by default, expanded on demand.
2. **Bash live view**: optional v2, preserve Pi security semantics.
3. **Code block frames/gutters**: shared renderer with edit/read ledgers.
4. **Skill pill**: `[skill] frontend-design (⌘O to expand)` inside SUMO messages.
5. **Divine Query modal**: replaces ugly question/confirm prompts.
6. **Approval modal**: use Pi risk policy, SumoTUI rendering.
7. **Memory Scriptorium**: read/edit/delete/search facts; deterministic panel routing.
8. **Primary agent display name**: `sumocode.json` controls `SUMO` vs `ZEUS` chat headers.
9. **MCP health real data**: replace placeholder MCP server rows.
10. **Memory diff on session end**: show what was remembered, allow reject/edit.

### Developer ergonomics

1. **Storybook-like Bible runner**: render individual components with fixtures.
2. **Trace replay**: record `AppMsg` stream and replay headlessly.
3. **Layout inspector**: show Yoga rects and z-index overlays.
4. **Perf budget CI**: fail if p95 render or idle CPU regresses beyond thresholds.
5. **Pi upgrade smoke matrix**: run against pinned + latest compatible Pi versions.

---

## 7. Recommended architecture target

### 7.1 SumoTUI should become a kernel with seven seams

```txt
┌─────────────────────────────────────────────────────────┐
│ SumoCode product shell                                  │
│  - Cathedral surfaces                                   │
│  - command palette, memory, sidebar, footer, chat        │
└─────────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────────┐
│ SumoTUI kernel                                           │
│ 1. AppModel + Update loop                                │
│ 2. TerminalSessionOwner                                  │
│ 3. InputRouter + FocusManager + SelectionManager         │
│ 4. LayoutTree / Yoga nodes                               │
│ 5. Renderer backend: CellBuffer + diff + writer          │
│ 6. Widget primitives: Box/Text/ScrollBox/Modal/TextInput │
│ 7. Headless TestBackend + TraceReplay                    │
└─────────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────────┐
│ Pi adapter                                               │
│  - agent/session event subscription                      │
│  - Pi editor leaf or native editor fallback              │
│  - extension UI compatibility                            │
│  - model/theme/settings/tool bridge                      │
└─────────────────────────────────────────────────────────┘
                         │
┌─────────────────────────────────────────────────────────┐
│ Pi runtime                                               │
│  - LLMs, tools, MCP, auth, sessions, skills              │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Deep modules to carve out

| Module | Responsibility | Why it is deep |
|---|---|---|
| `terminal-session-owner` | terminal mode state machine | Prevents cleanup/cursor/mouse regressions. |
| `app-runtime` | Model/Update/View + command effects | Gives locality for state/race bugs. |
| `input-router` | key/mouse/focus/modal/selection routing | Stops keybinding conflicts and lost focus. |
| `style` | tokens -> spans -> ANSI/cells | Prevents bg/reset/width bugs. |
| `transcript` | structured messages + virtualization | Enables chat frames/tool/code/search. |
| `pi-adapter` | private Pi seams isolated | Contains Pi drift risk. |
| `test-backend` | headless terminal + pilot | Makes runtime testable without pty flake. |

### 7.3 What should stay shallow

- Individual Cathedral renderers once built on primitives.
- Slash command registration wrappers.
- Static token definitions.
- Demo extensions.
- Bible scenario fixtures.

---

## 8. Prioritized backlog

### P0 — Contract and stability reset

1. **Remove stale Convex workflow from workspace agent instructions.** Done in `../AGENTS.md` during this audit.
2. **Make integration tests green.** Unit tests now pass; the cursor PTY test still times out.
3. **Pick and encode sidebar policy.** 30-col V2 is the apparent direction; portrait behavior still needs an explicit product decision.
4. **Single terminal owner.** Remove duplicate lifecycle ownership; gate OSC 11/12.
5. **Remove duplicate `/sumo:memory` registration.** Command palette should call memory editor; not register a stub.
6. **Fix command palette active-state open + drill-down behavior.** Align with Element 8.
7. **Fix integration test cursor marker to V2.** Wait for stable runtime/cursor bytes, not `SCRIPTOR INPUT`.
8. **Add memory/sidebar timer disposal.** `SidebarMemoryCache` needs `dispose()` to clear debounce/retry timers on session shutdown.
9. **Run Pi version smoke script in CI/local pre-release.** The fork patch must be verified.
10. **Update README status.** It still says v0.1 scaffold while the repo now contains a substantial renderer and V2 spec.

### P1 — Kernel deepening

1. Add `AppModel/AppMsg/update()` loop.
2. Add typed `Style/Span/Line` rendering layer.
3. Add headless `TestBackend` + pilot.
4. Add focus/modal stack and keybinding priority system.
5. Move chat to structured transcript model.
6. Add selection manager + OSC52 copy.
7. Add debug overlay.

### P2 — Visual/product surface completion

1. Element 13 chat message frames.
2. Element 11 Divine Query.
3. Element 9 tool pills/ledgers.
4. Element 10 code blocks.
5. Element 9a skill pill.
6. Element 12 scroll/scribe delegation.
7. Element 6 approval modal via Pi risk policy.
8. Element 7 Memory Scriptorium.
9. Top-bar LLM summaries + recent sessions.

### P3 — Extraction/public API

Only after 30 days stable:

- decide whether `src/sumo-tui` becomes `@sumodeus/sumo-tui`;
- publish architecture docs;
- add third-party Pi extension compatibility tier;
- consider React/Solid adapter.

---

## 9. Acceptance gates before declaring SumoTUI v1 daily-driver ready

### Correctness gates

- `pnpm test` passes.
- `pnpm test:integration` passes.
- `pnpm exec tsc --noEmit` passes.
- `pnpm build` passes.
- `pnpm visual:ci` has no hard failures and required crops pass.
- No known V2 contract contradiction between docs/tests/constants.

### Runtime gates

- Ctrl+C exits cleanly, no escape leakage.
- Ctrl+Z/fg works.
- No-TTY `pi --print` / ACPX paths do not emit UI or crash.
- Mouse wheel scrolls chat, not editor history.
- Cursor stays visible and correctly placed during typing, autocomplete, resize.
- Streaming while scrolled up preserves viewport and shows jump-to-bottom affordance.
- `/resume` active transition under 500ms or dominant cause documented.

### Performance gates

- Idle CPU < 1%.
- No retained render loop at idle.
- Streaming p95 render < 16.7ms target / < 33ms acceptable.
- Long session RSS < 300 MiB after 1h.
- 10k-message synthetic transcript keeps only virtualized active rows in tree.

### UX gates

- MacBook landscape: sidebar and chat feel balanced.
- Mac mini portrait: explicit approved behavior, not accidental hide.
- Visual Bible scenes for active, portrait, tools, code, palette, memory, approval, query, skill all exist.
- Dhruv has visually approved the promoted crops.

---

## 10. Final recommendation

Keep going with SumoTUI. The final goal needs it.

But spend the next slice on **consolidation**, not new polish:

1. Align V2 spec, constants, tests, and README.
2. Make terminal lifecycle single-owner.
3. Centralize commands/keybindings.
4. Introduce typed style primitives.
5. Add the app model/update loop and headless backend.

Once those are in place, the remaining Cathedral elements become straightforward surface work instead of brittle ANSI surgery.

The north star should be:

> **SumoCode feels like OpenCode-level terminal ownership, with Pi's agent engine and editor intelligence underneath, and a Cathedral product identity that is stable enough to daily-drive in cmux on both portrait and landscape machines.**
