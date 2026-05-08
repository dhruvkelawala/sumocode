# Cathedral UX Implementation Spec

> **Goal**: 100% visual + behavioral parity with `docs/ui/stitch/cathedral/*.png`.
> **Philosophy**: derived from `docs/ui/DESIGN.md`. This document is the
> *implementation* layer — it translates mockup pixels into Pi-extension code.
> **Hard rule**: every layer in §6 must visually match its mockup before it
> ships. Visual approval is required per layer (not per release).

---

## 0. What stays as-is

The cathedral mockups assume a populated empty state (sidebar + quote + chrome
visible). SumoCode is keeping its own **empty splash** as a permitted
deviation:

```
no messages              → splash (cat + SUMOCODE wordmark + quote, full width)
first message / /resume  → cathedral active state (this spec)
```

The splash component (`src/splash.ts`) and the static-sidebar-dock collapse
rule (`src/sidebar.ts` `shouldShowSidebar`) are NOT changed by this spec. They
gate when the active state mounts.

Everything else in this spec applies to the **active state only**.

---

## 1. Mockup catalog

| File | Scene | Mockup-defined regions used |
|---|---|---|
| `01-idle.png` | Idle, no chat yet | top chrome, registry sidebar, empty-state quote, input frame, registry footer |
| `02-streaming.png` | Streaming a response with code | top chrome, registry sidebar (SCRIPTOR active), assistant message, framed code block, "● THINKING…" status, registry footer |
| `03-tool-running.png` | Multiple tool calls executing | top chrome, registry sidebar (CONTEXT active + WORKSPACE sub-section), tool pills (read/bash/edit), running test output, code edit, registry footer |
| `04-approval.png` | Permission required | dimmed canvas, centered modal with `◆ APPROVAL REQUIRED`, command preview, `[Y/n]` prompt |
| `05-memory-editor.png` | `/sumo:memory edit` | top chrome (EDITOR active), registry sidebar (MEMORY active), `CATHEDRAL-MEMORY-EDITOR` page with 4 sub-panels (IDENTITY, PREFERENCES, STACK, PROJECTS), keyboard hint footer |
| `06-command-palette.png` | `Ctrl+K` palette | dimmed canvas, centered modal with `═══ COMMAND PALETTE ═══`, search input, list of mode rows, keyboard hint footer |

---

## 2. Mockup → token mapping

Re-confirming `DESIGN.md` § 2 against actual mockup pixels.

| Hex | Token | Mockup pixel-confirmed at |
|---|---|---|
| `#1A1511` | `background` | empty regions of every screen |
| `#241D17` | `surface` | sidebar bg, modal bg in 04/05/06 |
| `#120D0A` | `surfaceRecess` | input frame bg in 01, code block bg in 02/03 |
| `#3A342F` | `surfaceLifted` | not visible in current mockups (modal lift) |
| `#3A2F25` | `divider` | sub-section dividers, sidebar tab inactive bg |
| `#F5E6C8` | `foreground` | most body text |
| `#8B7A63` | `foregroundDim` | metadata, line numbers, hints |
| `#D97706` | `accent` | SUMOCODE wordmark, tab "active" markers, ❧ bullets, code keywords, modal title borders, button focus |
| `#7FB069` | `state.idle` | `✓` after completed tool pills, sidebar dot |
| `#E8B339` | `state.thinking` | `● THINKING…` row, function names in code |
| `#5B9BD5` | `state.tool` | `▶ running` indicator |
| `#C1443E` | `state.approval` | approval modal frame, `[Y/n]` accent |
| `#8E7AB5` | `state.learning` | memory-write indicator next to `CATHEDRAL-MEMORY-EDITOR` |

---

## 3. Global layout (active state)

```
Row 1            : top chrome bar (SUMOCODE + workspace tabs)
Row 2            : blank
Rows 3..N-3      : 2-pane content
                   - left pane (chat / tool pills / code blocks): cols 1..(W-50)
                   - 1-col gutter at col (W-49)
                   - right pane (registry sidebar): cols (W-48)..W
Row N-2          : input frame (3 rows: top border, content, bottom border)
Row N-1          : blank
Row N            : registry footer
```

`W` = terminal width. The 2-pane split is implemented by the existing
`StaticSidebarDock`. The top chrome and registry footer are NEW.

Modal overlays (approval, palette, memory editor) sit centered. Underlying
content remains rendered (no clear), but the mockups suggest dimming. In Pi
we cannot literally dim the canvas, so we will use Pi's overlay system with
a `surface-lifted` background and accept that the canvas behind it does not
visually dim.

---

## 4. Region-by-region spec

### 4.1 Top chrome bar (NEW — replaces session-UUID tab bar)

**Mockup reference**: `01-idle.png`, `02-streaming.png`, `03-tool-running.png`, `05-memory-editor.png` — all 4 active scenes show the same top bar.

**ASCII template**:
```
SUMOCODE                                   EDITOR  TERMINAL  ARCHIVE  SCRIPTOR  SETTINGS
─────────                                  ──────                                          
```
(Underline appears under the active tab only.)

**Tokens**:
- Left label `SUMOCODE`: `accent`, uppercase, no decoration. Single token, fixed.
- Tabs: uppercase. Inactive = `foregroundDim`. Active = `foreground` with a 1-row underline drawn in `accent` directly below.
- Background: `background`. No box-drawing frame.

**Tab list (fixed, left-to-right)**:
| Tab | Function | When active |
|---|---|---|
| `EDITOR` | normal chat / code editing view | default |
| `TERMINAL` | bash output stream view (tool pills only) | when `tool_call`s dominate the latest turn |
| `ARCHIVE` | session list / history | when `/archive` or `/sessions` is open |
| `SCRIPTOR` | streaming long assistant response | while `agent_start..agent_end` is in progress |
| `SETTINGS` | settings view | when `/settings` overlay is open |

**Implementation note**: tabs are **not** clickable mode-switchers in v1. They are *driven by current state* — a passive indicator of "what mode the chat is currently in". A future v2 may make them keyboard-navigable (`Ctrl+Tab`). For v1, the active tab is computed from the latest event.

**Active-tab computation rule**:
```
SETTINGS overlay open?            → SETTINGS
ARCHIVE overlay open?             → ARCHIVE
agent currently streaming?        → SCRIPTOR
last turn was mostly tool calls?  → TERMINAL
otherwise                         → EDITOR
```

**Width handling**: at narrow widths, drop tabs from the right one at a time
(SETTINGS first, then SCRIPTOR, then ARCHIVE, then TERMINAL). EDITOR always
shown. SUMOCODE always shown. Below `60` cols, drop SUMOCODE label too.

**Open question (mark)**: should tabs be keyboard-switchable in v1?
**Default**: no, passive only. Easy to add later.

### 4.2 Registry sidebar (REWRITE — replaces flat CONTEXT/MCP/MEMORY)

**Mockup reference**: every active scene's right pane.

**ASCII template (idle, MEMORY active)**:
```
                                   REGISTRY
                                   v 1.0.0

                                   ▢ CONTEXT
                                   ◆ MEMORY     ← active
                                   ▢ SCRIPTOR
                                   ▢ FILES

                                   ┌ ACTIVE_MEMORY ────
                                   ❧ prefers TypeScript strict
                                   ❧ pnpm not npm
                                   ❧ based in London
                                   ❧ BigCo → main-app
                                   ❧ imperative commits
```

**Tokens**:
- Header `REGISTRY`: `accent`, uppercase, letter-spaced. Right-aligned within sidebar column.
- `v 1.0.0`: `foregroundDim`, smaller logical hierarchy.
- Sub-tab marker glyphs: `◆` (active, `accent`) | `▢` (inactive, `foregroundDim`).
- Sub-tab labels: uppercase. Active = `foreground`. Inactive = `foregroundDim`.
- Section header inside content area: `┌ NAME ────` framed line, `accent` for label, `divider` for dashes.
- `❧` bullet: `accent`. Item text: `foreground`.

**Sub-tabs (fixed, top-to-bottom)**:
| Tab | Content shown when active |
|---|---|
| `CONTEXT` | project + branch, token usage gauge, $ spent, MCP server list (matches current sidebar's CONTEXT + MCP) |
| `MEMORY` | last 5–10 memory facts grouped under `ACTIVE_MEMORY`. Mirrors `01-idle.png` content. |
| `SCRIPTOR` | live streaming stats: tokens generated, ETA, model, thinking level. Mirrors `02-streaming.png` right pane. |
| `FILES` | files mentioned/touched in current session. Mirrors `03-tool-running.png`'s WORKSPACE sub-section in spirit. |

**Default active sub-tab**:
- on `session_start` (resume): `CONTEXT`
- once `tool_call` happens: switch to `FILES` if not user-overridden
- once memory write happens (Remnic `add`): switch to `MEMORY` for 5s, then back

**Sub-tab interaction**: selectable via keyboard. Default keybinds:
- `Ctrl+1` → CONTEXT
- `Ctrl+2` → MEMORY
- `Ctrl+3` → SCRIPTOR
- `Ctrl+4` → FILES

These are *additive* — they do not break Pi's defaults. If Pi already binds
one, we use `Ctrl+Shift+<n>` instead.

**Width**: sidebar pane fixed at 49 columns (already implemented in
`SIDEBAR_WIDTH`). 2-space leading indent within the pane (already done).

**Empty states per sub-tab**:
| Tab | Empty copy |
|---|---|
| CONTEXT | `no project context yet` (dim) |
| MEMORY | `no memory match` (dim) — **already implemented** |
| SCRIPTOR | `idle — no active turn` (dim) |
| FILES | `no files touched yet` (dim) |

**Daemon-down state**:
- MEMORY sub-tab: `memory unavailable` (dim) — already implemented.

**Open questions (mark)**:
- Are sub-tabs vertically stacked (mockup) or do they live as a *row* of icons? Mockup shows vertical, so vertical wins.
- Does `FILES` show files opened by the user via attachments, or files touched by tool calls, or both?
  **Default**: both — files opened in chat AND files referenced by `read` / `edit` / `write` tool calls in this session.

### 4.3 Registry footer (REWRITE — replaces OpenCode-ish footer)

**Mockup reference**: `01-idle.png`, `02-streaming.png`, `03-tool-running.png`, `05-memory-editor.png`.

**ASCII template**:
```
SYSTEM STATUS [ READY ]                          LANGS WIRE   LATENCY: 12MS   SCRIPTORIUM ACTIVE
```

**Tokens**:
- `SYSTEM STATUS`: `foregroundDim`, uppercase, letter-spaced
- `[ READY ]`: bracketed, content in current state's color (idle = sage, thinking = amber, etc.). Brackets `foregroundDim`.
- Right-side metrics: `foregroundDim` for labels, `foreground` for values. Three slots:
  - `LANGS <wire-protocol-name>` → which API protocol the active model uses (anthropic / openai-responses / openai-completions / google-genai). Static when not switching.
  - `LATENCY: <ms>MS` → median latency of last 5 turns. `—` if unknown.
  - `SCRIPTORIUM ACTIVE` → static when streaming, `SCRIPTORIUM IDLE` otherwise.

**Width handling**: at narrow widths, collapse right-to-left:
- < 110 cols: drop `LANGS WIRE`
- < 90 cols: drop `LATENCY`
- < 70 cols: drop `SCRIPTORIUM ACTIVE`
- < 50 cols: collapse left side to just `● ready` (state dot + label only)

**Per-state label**:
| state | bracket label |
|---|---|
| idle | `[ READY ]` |
| thinking | `[ THINKING ]` |
| tool | `[ WORKING ]` |
| approval | `[ NEEDS YOU ]` |
| learning | `[ LEARNING ]` |

**Removed from footer (was in old footer, mockup does NOT show)**:
- token gauge (`↑12k ↓8k`)
- cost (`$0.42`)
- context % (`42%/1.0M`)
- model id (`claude-opus-4-7`)
- cwd path

These move to: **CONTEXT sub-tab in the registry sidebar** (already there for tokens, cost, context%; need to add model id). Path was never in the mockup; drop entirely.

**Mandatory NEW addition (per #23)**:
- Thinking level appears as a suffix on the bracket label OR after the state, e.g. `[ READY · MEDIUM ]`. Use middle-dot (`·`).

### 4.4 Empty-chat content (idle scene only)

**Mockup reference**: `01-idle.png` middle area.

**ASCII template**:
```
                       "perfection is achieved when there is
                              nothing left to take away."
                                  — saint-exupéry
```

**Tokens**:
- italic dim quote (foregroundDim)
- em-dash attribution (foregroundDim)
- vertically centered in the chat pane (between top chrome and input frame)
- horizontally centered within chat pane width

**Behavior**:
- Renders only when:
  - sidebar is visible (active state, not splash)
  - branch has zero user messages
  - i.e. immediately after `/resume` of an empty session, or `/new` followed by a moment of waiting
- Disappears the moment the first message is added.

This is **not** the splash. The splash is `splash.ts` (cat + wordmark, full
width, no sidebar). This empty-chat quote replaces splash *only when the
session is in active state but happens to have no messages yet*. In practice
this is rare (would mean an empty resumed session) but the mockup defines it,
so we implement it.

**Implementation**: a new component, e.g. `src/empty-chat-quote.ts`, that
renders only when the predicate is true. Composed inside the chat container.

### 4.5 Input frame

**Mockup reference**: `01-idle.png` bottom of chat area.

**ASCII template (idle, no text)**:
```
   ┌──────────────────────────────────────┐
   │ > █                                  │
   └──────────────────────────────────────┘
```

**ASCII template (with text)**:
```
   ┌──────────────────────────────────────┐
   │ > review src/main-app/balance.ts█    │
   └──────────────────────────────────────┘
```

**Tokens**:
- Frame chars `┌ ─ ┐ │ └ ┘`: `divider`
- Background inside frame: `surfaceRecess`
- Prompt arrow `>`: `accent`
- Text: `foreground`
- Cursor `█`: `accent`

**Width**: same as chat pane width (cols 1..(W-50)). Frame consumes the chat
pane's full width; padding inside is 1 column on each side.

**Pi reality check**: Pi's editor is mounted via `setEditorComponent`. We can
either:
1. Replace the editor entirely with a custom carved version (extends
   `CustomEditor`).
2. Wrap Pi's default editor in a frame component above/below it.

**Default**: option 1, extends `CustomEditor`. We get app keybindings for
free by calling `super.handleInput`.

**Multi-line behavior**: when user pastes or types newlines, frame grows
vertically. Top/bottom borders stay; middle rows show content.

### 4.6 Tool pills (chat content)

**Mockup reference**: `03-tool-running.png` chat area.

**ASCII template (collapsed read)**:
```
━━━ [read]  src/app.ts                                   ━━━ ✓
   1   import { serve } from "bun";
   2   import { router } from "./routes";
   3
   4   console.log("Initializing SUMOCODE core…");
       120 lines collapsed
```

**ASCII template (running bash)**:
```
━━━ [bash]  pnpm test                                    ━━━ ▶ running

> sumocode@1.0.4 test /usr/src/app
> vitest run

✓ src/core/parser.test.ts (14 tests)
✓ src/utils/formatter.test.ts (8 tests)
✓ src/api/handlers.test.ts (22 tests)
✗ src/engine/runner.test.ts (running…)

Test Files 3 passed, 1 running
Tests 44 passed
[█████████░░░░░░░░░░] 57%
```

**ASCII template (completed edit)**:
```
━━━ [edit]  src/app.ts                                   ━━━ ✓

   12  - const server = serve({
   13  - port: process.env.PORT || 3000,
   14    fetch(req) {
   15      return router.handle(req);
   16    },
   17  + async fetch(req) {
   18      const res = await router.handle(req);
   19      console.log("[${req.method}] ${req.url} → ${res.status}");
   20      return res;
   21    },
   22  });
```

**Tokens**:
- `━━━` rule: `divider`
- `[name]` tag: `accent`, lowercase
- target path: `foreground`
- `✓` (completed): `state.idle` (sage)
- `▶ running`: `state.tool` (blue)
- `✗` (failed): `state.approval` (terracotta)
- diff `+` line: `state.idle` background tint
- diff `-` line: `state.approval` background tint
- line numbers: `foregroundDim`
- `120 lines collapsed`: `foregroundDim` italic

**Pi integration**: Pi already renders tool calls with its own ToolExecution
component. We override per-tool rendering via `tool.renderCall` /
`tool.renderResult` on tools we register. **For built-in Pi tools (bash, read,
edit, etc.) we cannot override directly** — they use Pi's built-in renderers.

**Workaround**: register a SumoCode "wrapper" tool set that intercepts
common tool names and re-renders. OR: theme Pi's built-in renderer via the
`Theme` we expose — Pi already calls `theme.fg(...)` so most coloring will
flow naturally if our theme is wired correctly. The frame-line decoration
is the real gap.

**Scope decision**: in v1 of this rework we do NOT replace Pi's tool
rendering. We accept Pi's renderer + our theme colors. We file a separate
spec layer for full tool-pill rendering once we understand how to plug into
Pi's tool component. This avoids reinventing Pi's tool diff logic.

**Open question (mark)**: do we replace Pi's tool rendering or just theme it?
**Default**: theme only in v1. Custom rendering is its own future layer.

### 4.7 Code blocks (assistant content)

**Mockup reference**: `02-streaming.png` middle.

**ASCII template**:
```
   1   function initializeCathedralEngine( config ) {
   2     const status = "yellow_protocol_active";
   3     let sequence = "0xDEAD";
   4
   5     /* Awaiting structural integration… */
   6     return ( status, sequence );
   7   }
```

**Tokens**:
- background: `surfaceRecess`
- line numbers: `foregroundDim`, right-aligned, 3 cols + 1 col gap
- keywords (`function`, `const`, `let`, `return`): `accent` (burnt orange)
- strings: `state.idle` (sage)
- numbers / function names: `state.thinking` (amber)
- comments: `#6F5D46` faded brown (defined in DESIGN.md syntax palette)
- operators / brackets: `foreground`

**Pi integration**: Pi's `Markdown` component already renders code blocks
with syntax highlighting via the theme. Our `cathedral.json` theme covers
all the syntax slots (already done in #16). Visual verification needed:
render an `02-streaming.png`-style turn and compare.

### 4.8 Approval modal

**Mockup reference**: `04-approval.png`.

**ASCII template**:
```
                ╔══════════════════════════════════════════╗
                ║          ◆ APPROVAL REQUIRED              ║
                ╠══════════════════════════════════════════╣
                ║                                          ║
                ║   You are about to execute:              ║
                ║                                          ║
                ║   ┌────────────────────────────────────┐ ║
                ║   │  rm -rf node_modules/              │ ║
                ║   └────────────────────────────────────┘ ║
                ║                                          ║
                ║   — This will remove 234MB and is        ║
                ║     irreversible.                        ║
                ║                                          ║
                ║   ■ SYSTEM NOTICE        Proceed? [Y/n]  ║
                ║                                          ║
                ╚══════════════════════════════════════════╝
```

**Tokens**:
- modal frame: `state.approval` (terracotta)
- title `◆ APPROVAL REQUIRED`: `accent`, centered
- divider line `╠═╣`: `divider`
- inner command frame: `divider` for chars, `surfaceRecess` for bg
- command text: `foreground`
- explanation paragraph: `foregroundDim`
- `■ SYSTEM NOTICE`: `state.approval`, uppercase
- `Proceed? [Y/n]`: `Proceed?` is `foreground`, `[Y/n]` is `accent`
- modal bg: `surfaceLifted`

**Width**: 60% of terminal width, min 50 cols, max 80 cols. Centered.

**Pi integration**: Pi exposes `ctx.ui.confirm(title, message, opts)` which
already shows a modal. We override its visual via either:
1. Custom modal via `ctx.ui.custom({ overlay: true, ... })` and route Pi's
   confirm requests through it. Risky — Pi calls `confirm` from its core,
   not from extensions, so we can't intercept.
2. Theme Pi's built-in modal via `theme` (limited control).
3. Replace `BashExecutor`-style approval prompts with our own and ask Pi
   to suppress its built-in.

**Default**: option 2 in v1 (theme only). Layer for full custom modal
deferred to a separate issue.

### 4.9 Command palette

**Mockup reference**: `06-command-palette.png`.

**ASCII template**:
```
                ╔════════════════════════════════════════╗
                ║         ════ COMMAND PALETTE ════       ║
                ║                                        ║
                ║  ▶ ENTER COMMAND OR SEARCH…            ║
                ║                                        ║
                ║  ▷ SESSION   ▶ CURRENT: WORK-20260424  ║
                ║  ★ MODEL     ▶ CURRENT: CLAUDE-OPUS-4-7║
                ║  ▷ THINKING  ▶ CURRENT: MEDIUM         ║
                ║  ▷ MEMORY    ▶ 55 FACTS                ║
                ║                                        ║
                ║  ↑↓ NAVIGATE   ✓ SELECT   ESC CLOSE    ║
                ╚════════════════════════════════════════╝
```

**Tokens**:
- modal frame: `accent`
- title banner `════ COMMAND PALETTE ════`: `accent`, centered
- search row arrow `▶`: `accent`
- search placeholder: `foregroundDim` italic
- mode-row glyph: `▷` inactive, `★` selected (`accent`)
- mode label: `foreground` (selected) / `foregroundDim` (others)
- `▶` between label and current value: `foregroundDim`
- `CURRENT: ...` value: `foreground` (selected) / `foregroundDim` (others)
- selected row bg: subtle `surfaceLifted` highlight band
- footer keybind line: `foregroundDim`
- modal bg: `surfaceLifted`

**Width**: 60% of terminal width, min 50, max 80. Centered.

**Trigger**: `Ctrl+K` (default). Configurable via `keybindings`.

**Mode rows in v1**: SESSION, MODEL, THINKING, MEMORY. Each row opens a
sub-selector when chosen.

**Pi integration**: implement via `ctx.ui.custom({ overlay: true, anchor:
"center", width: ... })`. Custom Component class with focus, search filter,
keyboard nav. This is fully implementable with current Pi APIs.

### 4.10 Memory editor

**Mockup reference**: `05-memory-editor.png`.

**ASCII template**:
```
   ╔═════ CATHEDRAL-MEMORY-EDITOR ═════╗  ◆ learning
   ║                                   ║
   ║  ┌ IDENTITY ─────┐  ┌ PREFERENCES ───────────┐
   ║  │ User: developer   │  │ ❧ TypeScript (Strict)  │
   ║  │ Org:  BigCo  │  │ ❧ pnpm execution        │
   ║  └───────────────┘  │ ❧ Prettier enforcing    │
   ║                     └─────────────────────────┘
   ║  ┌ STACK ────────┐  ┌ PROJECTS ───────────────┐
   ║  │ React 18+     │  │ ▶ main-app [active]     │
   ║  │ Vite bundler  │  └─────────────────────────┘
   ║  │ Tailwind v4   │
   ║  └───────────────┘
   ║
   ║              ✗CS SAVE   ✗CW CLOSE
   ╚═══════════════════════════════════╝
```

**Tokens**:
- modal frame: `accent`
- title `CATHEDRAL-MEMORY-EDITOR`: `accent`, uppercase
- `◆ learning` indicator (top-right): `state.learning` (dusty violet)
- sub-panel headers `┌ NAME ───`: `accent` for text, `divider` for chars
- sub-panel rows: `foreground`
- `❧` bullets: `accent`
- `▶` for expandable items: `accent`
- `[active]` badge: `state.idle`
- footer hints `✗CS SAVE / ✗CW CLOSE`: `foregroundDim` (✗ = ⌘ on macOS, Ctrl on Linux)
- modal bg: `surfaceLifted`

**Width**: 80% of terminal width, min 70, max 120. Centered.

**Trigger**: `/sumo:memory edit` slash command.

**Sub-panel content sources**:
- IDENTITY: from Remnic queries `identity:user`, `identity:org`
- PREFERENCES: from Remnic queries `preference:*`
- STACK: from Remnic queries `stack:*`
- PROJECTS: from Remnic queries `project:*` plus the currently-active project (cwd basename)

**Editing**: in v1 the modal is **read-only** — it visualizes what Remnic
holds. Editing is via slash commands (`/sumo:memory add ...`, `/sumo:memory
forget ...`). v2 may add inline editing.

**Open question (mark)**: does the `learning` indicator appear only during
active memory writes, or always when this view is open?
**Default**: only during active writes (last 3s after a `memory.add`). At
rest, no indicator.

---

## 5. Behaviors / state machines

### 5.1 Top-bar tab activation

```
on session_start          → activeTab = EDITOR
on agent_start            → activeTab = SCRIPTOR
on agent_end              → activeTab = EDITOR (or TERMINAL if last turn was tool-heavy)
on /archive open          → activeTab = ARCHIVE
on /settings open         → activeTab = SETTINGS
on overlay close          → activeTab = previous
```

"Tool-heavy" = last turn produced ≥3 tool calls AND zero text content. This
is a heuristic; tweak after visual review.

### 5.2 Sidebar sub-tab activation

```
on session_start (resume) → activeSub = CONTEXT
on tool_call              → activeSub = FILES (if user has not manually selected)
on memory.add success     → activeSub = MEMORY for 5s, then back
on Ctrl+1..4              → activeSub = explicit choice (sticky for session)
```

"Sticky for session" = once user picks via Ctrl+N, automatic switches no
longer happen for the rest of the session.

### 5.3 State dot transitions (footer + sidebar)

Already correct in current footer. Carries over unchanged.

### 5.4 Splash → active transition

Already implemented. Splash collapses on first message. Active state
materializes (top chrome + sidebar + registry footer + empty quote if no
chat yet).

---

## 6. Implementation layer order

Each row = one git branch + one issue + one TDD round + one visual review.
**No layer ships without visual approval.**

| # | Layer | Touches | Mockup verifying | Risk |
|---|---|---|---|---|
| 1 | **Top chrome bar** | replace `tab-bar.ts` with `top-chrome.ts` | 01–05 | low |
| 2 | **Registry footer** | replace `footer.ts` text/format with registry-tone | 01–05 | low |
| 3 | **Registry sidebar shell** | rewrite `sidebar.ts` rendering: sub-tabs (CONTEXT/MEMORY/SCRIPTOR/FILES) + active selection + sub-tab Ctrl+N keybinds | 01 | medium |
| 4 | **Sidebar sub-tab content — CONTEXT** | move project/branch/gauge/MCP into the CONTEXT sub-tab body | 01 right pane | low |
| 5 | **Sidebar sub-tab content — MEMORY** | refit existing memory facts under `┌ ACTIVE_MEMORY ────` block | 01 right pane | low |
| 6 | **Sidebar sub-tab content — SCRIPTOR** | live streaming stats (tokens/sec, ETA, model, thinking) | 02 right pane | medium (depends on Pi event coverage) |
| 7 | **Sidebar sub-tab content — FILES** | files touched in session via tool-call interception | 03 right pane "WORKSPACE" | medium |
| 8 | **Empty-chat quote** | new `empty-chat-quote.ts`, mounts when sidebar visible + zero user messages | 01 center area | low |
| 9 | **Carved input frame** | new `input-frame.ts` extending `CustomEditor` | 01 input | medium (Pi editor wrapping) |
| 10 | **Code block + markdown audit** | verify `cathedral.json` covers every syntax slot from the mockup | 02 code block | low |
| 11 | **Tool pill themed** | accept Pi's tool component; verify our theme colors map all slots; visual review | 03 tool blocks | low |
| 12 | **Approval modal themed** | theme Pi's confirm modal; visual review | 04 | low |
| 13 | **Command palette overlay** | new `command-palette.ts`, full custom Component, `Ctrl+K` trigger | 06 | medium |
| 14 | **Memory editor overlay** | new `memory-editor.ts`, read-only v1, `/sumo:memory edit` trigger | 05 | medium |

**Total estimated layers: 14.**
**Total open issues to file: 14** (one per layer).

---

## 7. Acceptance criteria (per layer)

For a layer to be considered done:

1. Pure render function tested via Vitest. Any behavior in a state machine
   (e.g. tab activation rules) covered by test.
2. `pnpm exec tsc --noEmit` passes.
3. `pnpm test` passes.
4. `pnpm visual` produces a `.png` for that layer's scene.
5. **You** have personally inspected the screenshot and approved.
6. Side-by-side comparison with the matching mockup shows no
   visually-significant difference (allowing for monospace-grid quantization
   that vhs cannot avoid).
7. The layer's PR is merged to main only after step 5.

---

## 8. Per-layer scaffolding

For each layer below, the spec is enough to scaffold the issue body, the
test names, and the source file. We will copy these into GitHub issues
when each layer is up next.

### Issue template (use for every layer)

```markdown
> Parent: #14 Cathedral parity pass
> Spec source: docs/ui/CATHEDRAL_UX_SPEC.md § <section>

## Mockup
docs/ui/stitch/cathedral/<file>.png — region: <which region>

## What we're shipping
<one-paragraph behavior summary>

## Visual contract
<paste ASCII template from spec>

## Tokens
<from spec section>

## TDD plan
- [ ] pure render — first behavior
- [ ] pure render — second behavior
- [ ] state-machine — first transition
- [ ] state-machine — second transition

## Acceptance
- [ ] tsc clean
- [ ] vitest green
- [ ] vhs scene rendered: docs/visual/<scene>.png
- [ ] visual approval from Dhruv
- [ ] no chat regressions in cathedral-idle.png + cathedral-help.png
```

---

## 9. Out of scope (for this pass)

- Animations of any kind
- Light-mode variant
- Web/HTML mirror of the design system
- Amber CRT and Obsidian Temple themes (those reuse this layout but
  re-skin tokens; spec applies only to Cathedral here)
- Multi-session tab bar (Pi 0.70.x doesn't expose enumeration)
- Tool pill custom rendering (deferred — see § 4.6 default)

---

## 10. Open questions to resolve before layer 1

These need a yes/no from Dhruv before issue #1 is filed.

| # | Question | Default if not answered |
|---|---|---|
| Q1 | Are top-bar tabs keyboard-switchable in v1? | no, passive only |
| Q2 | Do sidebar sub-tabs use Ctrl+1..4 keybinds? | yes |
| Q3 | Should `LATENCY` in registry footer be real (median of last 5 turns) or fake/static? | real |
| Q4 | What is "NAME" in `SYSTEM STATUS [ NAME ]`? | the active state label (READY / THINKING / WORKING / NEEDS YOU / LEARNING) |
| Q5 | Memory editor: read-only v1 or editable? | read-only v1 |
| Q6 | `learning` indicator on memory editor: always-on or only during writes? | only during writes |
| Q7 | `FILES` sub-tab: tool-touched files only, or include user-attached? | both |
| Q8 | Replace Pi's tool rendering or theme it? | theme only in v1 |
| Q9 | Replace Pi's confirm modal or theme it? | theme only in v1 |
| Q10 | Splash collapses entirely on /resume even if resumed session has content, or only on /new? | collapses if branch has any user messages — already implemented this way |

---

*Last updated: 2026-04-26 · v0.1 · Direction: Cathedral.*
*Status of source mockups: `docs/ui/stitch/cathedral/01..06-*.png`.*
