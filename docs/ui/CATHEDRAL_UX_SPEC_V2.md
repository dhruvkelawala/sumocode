# Cathedral UX Implementation Spec — v2

> **Status**: locked decisions, post-grill 2026-04-28.
> **Supersedes**: `CATHEDRAL_UX_SPEC.md` v0.1 (2026-04-26).
> **Source decisions**: `CATHEDRAL_DECISIONS.md` (Elements 1–8) + this session (Elements 9–13 + cross-cutting).
> **Goal**: 100% visual + behavioral parity between this spec, `CATHEDRAL_VISUAL_BIBLE.md` (forthcoming), and the running runtime. Every element has a single locked decision and a single mockup.
> **Hard rule**: visual approval per element before merge.

---

## 0. Status board

### Locked & shipping in v1

| # | Element | Status | Bug count |
|---|---|---|---|
| 1 | Sidebar (active state) | partial — width/inter-section bg/footer-when-hidden need work | 3 |
| 2 | Top bar | partial — LLM summary missing, recent tabs missing | 2 |
| 3 | Splash | shipped, mostly working | 1 (rotating placeholder) |
| 4 | Active-state input frame | shipped wrong (label + flavour text leaked) | 2 |
| 5 | Footer + version line | partial — context-on-collapse missing | 2 |
| 6 | Approval modal | DISABLED, design locked | needs reactivation |
| 7 | Memory editor | not visually verified | needs verification + inline edit |
| 8 | Command palette | broken in active state | 2 |
| 9 | Tool pills | Pi default + theme only — needs cathedral framing | new |
| 9a | Skill pill | NEW — Pi inline skill notice, cathedral-colored | new |
| 10 | Code blocks | Pi default + theme only — needs full frame + gutter | new |
| 11 | Question/Confirm UI (DIVINE QUERY) | NEW — Pi default ugly, needs cathedral modal | new |
| 12 | Task tool sub-agent UI | NEW — task_tool works under hood, UI broken | new |
| 13 | Chat message rendering | NEW — current `Sumo > ...` is barebone, needs framing | new |

### Out of scope (for v1)

- Amber CRT theme, Obsidian Temple theme (cathedral-only v1)
- Light mode
- Animations beyond cursor blink + state-dot color transitions
- Multi-pane workspace splits
- Web/HTML mirror of design system

---

## 1. Visual tokens

Unchanged from v1. Reproduced for completeness.

| Hex | Token | Used in |
|---|---|---|
| `#1A1511` | `background` | terminal-default (OSC 11), splash bg, chat bg |
| `#241D17` | `surface` | sidebar bg, modal bg |
| `#120D0A` | `surfaceRecess` | input frame bg, code block bg |
| `#3A342F` | `surfaceLifted` | modal bg (alternate), focused row band |
| `#3A2F25` | `divider` | sub-section dividers, sidebar tab inactive bg |
| `#F5E6C8` | `foreground` | most body text |
| `#8B7A63` | `foregroundDim` | metadata, line numbers, hints |
| `#D97706` | `accent` | SUMOCODE wordmark, ❧ bullets, code keywords, modal title borders, focus fills |
| `#7FB069` | `state.idle` | sage — `READY`, `✓` completed |
| `#E8B339` | `state.thinking` | amber — `MEDITATING`, function names, numbers |
| `#5B9BD5` | `state.tool` | blue — `ILLUMINATING`, `▶ running` |
| `#C1443E` | `state.approval` | terracotta — `DEFERRING`, modal frame, `✗ failed`, OVER badge |
| `#8E7AB5` | `state.learning` | violet — `INSCRIBING` |
| `#6F5D46` | `syntax.comment` | comments |

OSC 11 (`\x1b]11;#1A1511\x1b\\`) painted on altscreen entry. OSC 111 reset on exit. **Focus**: cmux/Ghostty (libghostty); other terminals best-effort. Research follow-up listed in §7.

---

## 2. Global layout

```
Row 1            : top chrome bar (Element 2)
Row 2            : blank
Rows 3..N-3      : 2-pane content
                   - left  (chat / tool pills / code blocks): cols 1..(W-30)
                   - right (registry sidebar):                cols (W-29)..W
Row N-2          : input frame (3 rows)
Row N-1          : blank
Row N            : registry footer (Element 5)
Row N+1 (splash) : version line (only on splash)
```

`W` = terminal width.

**CHANGED v1 → v2**: Sidebar width `49 → 30` cols. Two-pane split adjusts at `W-30`.

**Sidebar visibility rules**:
- Hidden on splash (always full-width splash content)
- Hidden when `W < 120` cols (footer absorbs context info — see Element 5)
- Hidden when user runs `/sidebar hide`
- Visible otherwise

Modal overlays sit centered. We cannot dim the underlying canvas in a terminal — modals use `surfaceLifted` bg to read as elevated.

---

## 3. Element-by-element spec

### Element 1 — Sidebar (active state only)

**LOCKED 2026-04-28** after grilling 4 directions (REGISTRY baseline / V1 DENSE / V2 EDITORIAL / V3 MARGINALIA).

**Direction**: V2 EDITORIAL — magazine display with tracked-out section names, thick `━` underline rules, hero values, generous whitespace.

**Mockups**: `docs/ui/bible/01-sidebar-{context,memory,context-over-budget,memory-empty,memory-daemon-down,with-metrics}.html` (6 state variants, all 30 cols).

**Width**: **30 cols** (was 49).

**Sub-tabs**: CONTEXT (`Ctrl+1`) + MEMORY (`Ctrl+2`). SCRIPTOR + FILES deferred to v2.

**Chrome (V2 EDITORIAL)**:

```
  REGISTRY
  — v 1.0.0

  ◆ C O N T E X T
  ▢ M E M O R Y
  
  ━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Key design moves:
- `REGISTRY` accent left-aligned, `— v 1.0.0` dim subtitle
- Sub-tabs use **tracked-out** narrow-no-break-space typography (`C O N T E X T`) for editorial display feel
- Heavy `━` rule (26 chars) separates header from content
- All section labels (CONTEXT / SESSION / MCP / METRICS) use tracked-out style

**CONTEXT sub-tab content (V2 EDITORIAL)**:

```
  sumo-deus
  on main

  C O N T E X T
  ▉▉▉▉▉░░░░░░░░░░░░░░░░░
  42k / 200k

  S E S S I O N
  $0.42 · 3.4M cumul

  ━━━━━━━━━━━━━━━━━━━━━━━━━━

  M C P

  ● github                  idle
  ● stitch                    ok
  ● context7              idle
  ● chrome-dev          idle
```

Key design moves:
- Hero project name (`sumo-deus`) in foreground weight, `on <branch>` dim subtitle
- `CONTEXT` tracked-out section label
- Token bar uses block-fill `▉▉▉▉▉` (left-aligned, 22 cells) over `░` empty cells — sage when under, terracotta when OVER
- Token ratio `42k / 200k` foreground+dim split
- `SESSION` tracked-out label + cost+cumul on one line
- `MCP` block: `●` state-color pill + name (left) + state text (right)

**Over-budget state**: bar fills full + turns terracotta. Token row gets `OVER` suffix:
```
  3.4M / 1.0M OVER
```
(via fg-approve color)

**MEMORY sub-tab content**:

```
                              ┌ ACTIVE_MEMORY ─
                              ❧ prefers TS strict
                              ❧ pnpm not npm
                              ❧ based London · BST
                              ❧ Argent → argent-x
                              ❧ imperative commits
                              48 more · ⌘M
```

`⌘M` opens memory editor (Element 7). Second path alongside `Ctrl+/ → MEMORY`.

**Inter-section bg**: ALL rows in sidebar paint `surface` bg. No row falls through to terminal default. Empty rows between sections explicitly painted via `surfaceLine("", 30)`.

**Empty states**:
| Sub-tab | Empty copy |
|---|---|
| CONTEXT | `no project context yet` (dim) |
| MEMORY | `no memory match` (dim) |
| MEMORY (daemon down) | `memory unavailable` (dim) |

**Collapsed mode**:
- `/sidebar hide` → sidebar disappears, chat takes full width
- `/sidebar show` → restores
- `W < 120 col` → automatic hide

When sidebar is hidden by either mechanism, footer absorbs context info per Element 5.

**METRICS HUD** (htop sparklines):
- Hidden by default
- `/metrics on` shows sparkline mode
- Compact mode at sidebar-narrow: just `CPU 16% MEM 414M` text, no bars
- Full mode (sparklines) only at `W ≥ 160` cols where there's room

---

### Element 2 — Top bar

**Mockup**: forthcoming `v4/03-top-bar-states.png` (idle / streaming / tool / approval / learning).

**Layout**:

```
SUMOCODE   ║ ● auth-flow-refactor ║   │ debug-balance-tx   │ index-issues   │ ARCHIVE        [terminal]  [⚙]
                                                                                              Ctrl+\\      Ctrl+,
```

- `SUMOCODE` accent left, always visible
- `║ ● <session-name> ║` active session marker. **Dot is STATIC `accent`** (matches SUMOCODE wordmark color). It is a session marker, not a state indicator. Agent state lives in the FOOTER dot.
- **Dot size togglable** via `/sumo:dotsize {small | medium | large}` slash command:
  - `small`  → `·` MIDDLE DOT (most subtle)
  - `medium` → `•` BULLET (default, balanced)
  - `large`  → `●` BLACK CIRCLE (most prominent)
- `│ <session-name>` recent sessions, dim, mtime-desc, max 5 visible
- `│ ARCHIVE` opens session list overlay (full archive)
- `[terminal]` = bash sub-shell overlay (`Ctrl+\`)
- `[⚙]` = `/settings` overlay (`Ctrl+,`)

**Session naming**:
- Trigger: `agent_end` after first 5 user messages in session
- Cached: stored in session metadata, never re-summarized
- Model: configurable via `/sumo:summaryModel <provider/model>` slash. Default TBD (not haiku per user direction).
- Fallback chain on offline / error:
  1. local heuristic (kebab-case 4-5 nouns from first user prompt)
  2. UUID first segment (`019dcad9`)

**Recent session tabs**:
- Interactive in v1 if "easy" (clickable / Tab-cyclable): switches to that session
- Otherwise passive indicators

**Width handling**: drop tabs from the right at narrow widths. `[⚙]` first, then `[terminal]`, then `ARCHIVE`, then recents one by one. SUMOCODE always visible until `W < 60`, then drop too.

**Hide via**: `/sumo:tabs hide|show`.

**Bug to fix**: top bar visibility intermittent in daily-drive — investigate.

---

### Element 3 — Splash

**Mockup**: existing `v3/misc/splash.png` + forthcoming `v4/00-splash.png` updated for rotating placeholder.

**Renders only when session has zero user messages.** Top bar and footer render around splash; sidebar HIDDEN.

```
                              (cat face, 24×14 chafa render)



                             S U M O C O D E                       ← pixel-block, accent



                  "perfection is achieved when there is
                              nothing left to take away."
                                  — saint-exupéry



   ┌─ DIVINE INVOCATION ───────────────────────────────────────┐
   │ > <rotating placeholder>  █                                │
   └───────────────────────────────────────────────────────────┘

   └─ AWAITING DIVINE INVOCATION              TAB · AGENTS  CTRL+/ · COMMANDS

                          SUMOCODE V0.2.0 · CATHEDRAL · 160 × 45 MONOSPACE
```

**Rotating placeholders** (random per boot, 5 in v1):
1. `Ask anything... "Refactor the auth flow."`
2. `Ask anything... "Why does the test for X fail?"`
3. `Ask anything... "Explain this codebase architecture."`
4. `Ask anything... "Find the bug in src/foo.ts:42."`
5. `Ask anything... "Show me what changed since yesterday."`

Disappears on first keystroke.

**Stretch goal**: animated/glitchy variant of cat hero (multi-frame chafa cycle). Polish, not blocker.

---

### Element 4 — Active-state input frame

**Mockup**: forthcoming `v4/04-active-input.png`.

```
   ┌──────────────────────────────────────────────┐
   │ > █                                          │
   └──────────────────────────────────────────────┘
                                          TAB · AGENTS  CTRL+/ · COMMANDS
```

- **No label** above frame (regression to fix — currently shows `INPUT` / `SCRIPTOR INPUT`)
- `>` prompt arrow inside frame, accent (currently missing — fix)
- **No flavour text** on hint row (regression to fix — currently shows `INPUT PROTOCOL AWAITING COMMAND`)
- Hint row right side only: `TAB · AGENTS  CTRL+/ · COMMANDS`
- Frame chars in `divider`
- Bg inside frame: `surfaceRecess` — **EVERY ROW** including padding rows above/below cursor row
- Text: `foreground`
- Cursor: **terminal user preference** (DON'T override OSC 12). `/sumo:cursor block|bar|thin` slash command for explicit override

**Multi-line behavior**: paste with newlines, frame grows vertically. Top/bottom borders stay; middle rows show content.

**Bug observed 2026-04-28**: input frame currently renders 5+ rows tall (top border, dark band, cursor row, dark band, bottom border) with the dark bands NOT painted in `surfaceRecess` — they fall through to terminal default bg. Fix: every interior row uses `surfaceLine("", innerWidth)` painted with `surfaceRecess`, same pattern as sidebar #65 fix. Same bug class as Element 1 inter-section bg.

---

### Element 5 — Footer + bottom version line

**Mockup**: forthcoming `v4/05-footer-states.png` (one row per agent state).

```
● MEDITATING · claude-opus-4-7 · xhigh           sumo-deus (main) · 42k/200k · $0.42
```

**Left zone**: `● <STATE>` (uppercase) `· <model-id>` (lowercase) `· <thinking-level>` (lowercase). State dot color = agent state.

**Right zone**: `<project-shortname> (<branch>) · <ctx-tokens>/<ctx-window> · $<session-cost>`.

**Cathedral state labels**:
| internal | UI label |
|---|---|
| idle | READY |
| thinking | MEDITATING |
| tool | ILLUMINATING |
| approval | DEFERRING |
| learning | INSCRIBING |

**Same shape regardless of sidebar visibility** (single-row always).

**When sidebar is hidden** (W<120 OR `/sidebar hide`): footer right zone shows ctx + cost. Sidebar (when visible) shows fuller view: bar visualization + cumulative session totals — NOT in footer.

**Bottom version line on splash only**:
```
                          SUMOCODE V0.2.0 · CATHEDRAL · 160 × 45 MONOSPACE
```
- Dim, centered, second row below footer
- `160 × 45` = current terminal dims
- Vanishes in active state

**Width handling**: at narrow widths, collapse right zone right-to-left:
- `< 110 cols`: drop project name (keep `(branch)`)
- `< 90 cols`: drop branch
- `< 70 cols`: drop $ cost
- `< 50 cols`: drop ctx tokens (just left zone visible)

**State dot redundancy with top-bar**: both have a dot. Top-bar dot = session indicator (which session is active). Footer dot = agent-state indicator. Different concepts. Keep both.

---

### Element 6 — Approval modal

**Mockup**: forthcoming `v4/06-approval-modal.png`.

**v1 policy CHANGE from DECISIONS**: do NOT gate all bash/edit/write. Use Pi's default risk-assessment logic. Most ops auto-approve. Risky ops (e.g., `rm -rf`, system paths) prompt.

**Slash command**: `/yolo` disables all approvals for the session.

**Implementation task**: investigate Pi's `pi-coding-agent` source for how it currently triggers approvals, then plug our themed modal into that flow rather than re-implementing the policy.

**Modal design** (locked, unchanged from DECISIONS):

```
                                 APPROVAL REQUIRED
   ────────────────────────────────────────────────────────────────────────

   You are about to execute:

   ┌─────────────────────────────────────────────┐
   │ rm -rf node_modules/                        │
   └─────────────────────────────────────────────┘

   — This will remove 234MB and is irreversible.

   ────────────────────────────────────────────────────────────────────────
   ■ SYSTEM NOTICE                              [Y]ES  [N]O  [A]LWAYS
```

- Flat-hybrid (no double-line border)
- Title `APPROVAL REQUIRED` accent, centered
- Inner code frame (`┌─┐│└─┘`) with `surfaceRecess` bg
- Em-dash explanation row: `foregroundDim`
- `■ SYSTEM NOTICE`: `state.approval` square + dim brown label
- Buttons: outlined, focused button accent-fill. Default focus on `[N]O` for safety
- `Y` / `N` / `A` letter-keys select directly. `Tab` cycles focus
- `[A]LWAYS` forwards to Pi's allowlist (no separate SumoCode allowlist)

---

### Element 7 — Memory editor

**Mockup**: forthcoming `v4/07-memory-editor.png`.

**Trigger**: `/sumo:memory edit` slash, OR `⌘M` keybind, OR Ctrl+/ → MEMORY drill-down.

**v1 = inline editable + AI-driven**:
- `e` key opens inline editor for selected fact
- `d` key deletes selected fact
- AI-driven: user asks AI in chat → AI writes to Remnic via tool
- Slash commands `/sumo:memory add --panel <name> "..."` and `/sumo:memory forget <id>` retained as power-user paths

**6 panels** (all confirmed):

| Panel | Routing signals |
|---|---|
| `IDENTITY` | tag `sumocode:identity`, entityRef=user, keywords (name/org/location) |
| `PREFERENCES` | category `preference`/`rule`/`principle`, tag `sumocode:preference` |
| `WORKFLOW` | category `procedure`/`skill`/`rule`/`decision`, tags `sumocode:workflow` |
| `PROJECTS` | tag `sumocode:project`, project tags, project keywords |
| `SYSTEM` | tag `sumocode:system`, runtime/machine constraints |
| `GENERAL` | unclassified — hidden when empty |

**Routing precedence** (deterministic, no LLM):
1. explicit `sumocode:<panel>` tag
2. Remnic `category` field
3. keyword rules on `content`
4. fallback → `GENERAL`

**Visual** (locked):

```
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   │ search…                                              48 facts │

   ╭─ IDENTITY ───────────────────╮  ╭─ PREFERENCES ────────────────╮
   │ Dhruv · Senior FE · Argent     │  │ prefers TypeScript strict      │
   │ London / BST                   │  │ pnpm not npm                   │
   ╰──────────────────────────────╯  ╰────────────────────────────────╯

   ... 4 more panels in 2-across grid ...

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate   /  search   e  edit   d  delete   esc  close
```

Width: 80% of terminal, min 70, max 120. Centered.

---

### Element 8 — Command palette

**LOCKED**: Scriptorium variant approved 2026-04-29.

**Mockup**: `docs/ui/bible/08-palette-v2-scriptorium.html`.

**Trigger**: `Ctrl+/`. Drops Pi's `Ctrl+P`, `Ctrl+K` registrations (Pi defaults preserved).

**Bug to fix**:
1. Currently works on splash, broken in active state (palette doesn't open)
2. Enter on a row inserts slash command into input field instead of opening sub-overlay (drill-down path broken)

**6 modes** (was 5 — add SETTINGS): SESSION, MODEL, THINKING, MEMORY, THEME, SETTINGS.

**Visual contract**:

```txt
                         ✾  COMMAND PALETTE  ✾

              ──────────────────────  ·  ──────────────────────

     ❯  █what shall we attend to…

     ·   SESSION                                      auth-flow-refactor
     ❈   MODEL                                         claude-opus-4-7
     ·   THINKING                                                xhigh
     ·   MEMORY                                               55 facts
     ·   THEME                                              cathedral
     ·   SETTINGS

              ──────────────────────  ·  ──────────────────────
                         ↑↓ wander    ⏎ attend    ⎋ retreat
```

**Tokens**:
- Title text + `✾` floral marks: `accent`
- Decorative rules + center `·`: `divider`
- Search chevron `❯`: `accent`
- Search cursor block: active cursor token / accent bg
- Search placeholder: `foregroundDim`
- Focused row marker `❈` heavy sparkle: `accent`
- Unfocused row marker `·`: `divider`
- Focused label + value: `foreground`
- Unfocused label + value: `foregroundDim`
- Footer keybind text: `foregroundDim`

**Behavior**:
- All drill-down (no in-place cycling).
- Enter on a row opens that mode's sub-overlay rather than inserting text into the input field.
- Filter/search narrows visible rows while preserving the scriptorium chrome.

Width: 60% of terminal, min 50, max 80. Centered.

---

### Element 9 — Tool pills

**Mockup**: forthcoming `v4/09-tool-pills.png` (read / bash / edit / write states).

**v1 = ship cathedral framing.** Replace Pi default tool rendering for `bash`, `edit`, `write`, `read`.

```
━━━ [read]  src/app.ts                                   ━━━ ✓
   1   import { serve } from "bun";
   2   import { router } from "./routes";
   3
       120 lines collapsed
```

```
━━━ [bash]  pnpm test                                    ━━━ ▶ running

> sumocode@1.0.4 test /usr/src/app
> vitest run
✓ src/core/parser.test.ts (14 tests)
[█████████░░░░░] 57%
```

**Tokens**:
- `━━━` rule: `divider`
- `[name]` lowercase tag: `accent`
- target path: `foreground`
- `✓` (done): `state.idle`
- `▶ running`: `state.tool`
- `✗` (failed): `state.approval`
- line numbers (read/edit): `foregroundDim`
- collapse marker (`120 lines collapsed`): `foregroundDim` italic

**Diff rendering** (`edit` tool): for v1, use Pi's default themed to cathedral palette. Custom diff style deferred.

**Long output collapse**: auto-collapse to last 20 lines + `N lines collapsed` marker. Expand on key (`E` or click).

**Implementation**: register custom tool renderers via `tool.renderCall` / `tool.renderResult`.

---

### Element 9a — Skill pill

**NEW.** Skills are Pi capability packs loaded on-demand via `/skill:name` or model-triggered progressive disclosure. Pi renders the invocation inline in the assistant turn; Cathedral keeps that interaction lightweight rather than turning it into a full tool card.

**Locked direction**: V1 inline notice — Pi-default structure with cathedral colors.

**Mockup**: `docs/ui/bible/skill-v1-inline.html`.

**Visual contract**:

```
[skill] frontend-design (⌘O to expand)
```

Inside a SUMO message box:

```
╭ SUMO ─────────────────────────────────────────────── 11:42 ─╮
│ Let me design that frontend with a fresh aesthetic.          │
│                                                              │
│ [skill] frontend-design (⌘O to expand)                       │
│                                                              │
│ Picking direction "brutally minimal" — generating now.       │
╰──────────────────────────────────────────────────────────────╯
```

**Tokens**:
- Brackets `[` `]`: `divider`
- `skill` tag: `accent`
- Skill name: `foreground`
- Expand hint `(⌘O to expand)`: `foregroundDim`

**Behavior**:
- Collapsed by default, one row only.
- `⌘O` / Pi expand action reveals the loaded `SKILL.md` content using Pi's existing expansion behavior, themed to Cathedral where possible.
- No per-skill icon, no description preview, no tool-pill frame. The skill pill is metadata inside the assistant reasoning flow, not a tool execution result.

---

### Element 10 — Code blocks

**Mockup**: forthcoming `v4/10-code-block.png`.

**v1 = full frame + line gutter (if trivial)**:

```
   ╭───────────────────────────────────────────────────╮
   │   1   function initializeCathedralEngine( config ) {
   │   2     const status = "yellow_protocol_active";
   │   3     let sequence = "0xDEAD";
   │   4
   │   5     /* Awaiting structural integration… */
   │   6     return ( status, sequence );
   │   7   }
   ╰───────────────────────────────────────────────────╯
```

- Full frame `╭───╮│╰───╯` with `surfaceRecess` bg
- Line numbers: `foregroundDim`, right-aligned 3 cols, 1 col gap. SHIP if trivial — otherwise skip in v1
- Syntax colors:
  - keywords (`function`, `const`, `let`, `return`): `accent`
  - strings: `state.idle`
  - numbers, function names: `state.thinking`
  - comments: `syntax.comment` (`#6F5D46`)
  - operators, brackets: `foreground`

**Implementation**: audit `cathedral.json` syntax slots, ensure every kind Pi emits has the right slot, verify with code-render visual test.

---

### Element 11 — Question/Confirm UI (DIVINE QUERY)

**NEW.** Replaces Pi default `ctx.ui.ask` / `ctx.ui.confirm` rendering.

**Mockup**: forthcoming `v4/11-divine-query.png`.

```
                              DIVINE QUERY
   ────────────────────────────────────────────────────────────────────────

   Should I rename `foo` to `bar`?

     A) Yes, rename it
   █ B) No, leave it                                                   █
     C) Use a different name

   ────────────────────────────────────────────────────────────────────────
   ↑↓  navigate    ⏎  select    esc  cancel
```

- Flat-hybrid modal (matches Elements 6, 7, 8)
- Title `DIVINE QUERY` accent, centered
- Question body in `foreground`
- Options as a list. Selected row filled with `accent` bg
- Footer keybinds: `↑↓ navigate / ⏎ select / esc cancel`

Width: 60% of terminal, min 50, max 80. Centered.

**Implementation**: intercept Pi's question/confirm calls via `ctx.ui.custom` overlay.

---

### Element 12 — Task tool sub-agent UI

**NEW.** task_tool extension works under the hood; UI broken or missing.

**Mockup**: forthcoming `v4/12-task-tool-progress.png`.

**Investigation task**: triage `dhruvkelawala/sumocode#11` to confirm what's actually broken.

**Proposed v1 UX**: nested tool pill in chat showing sub-agent state.

```
━━━ [task]  refactor auth flow into smaller modules        ━━━ ▶ running

   ┌ child agent · gpt-5.5 · medium ─────────────────
   │ [read]  src/auth.ts                          ✓
   │ [edit]  src/auth.ts                          ✓
   │ [edit]  src/auth-helpers.ts                  ✓
   │ [bash]  pnpm test src/auth                   ▶
   │
   │ Tokens: ↑8k ↓3k · 22s elapsed
   └─────────────────────────────────────────────
```

- Outer `━━━ [task]` framing matches Element 9
- Inner `┌─┐│└─┘` framing showing sub-agent's tool calls indented
- Sub-agent state line at bottom of inner frame: model, thinking, tokens, elapsed time
- On sub-agent done: outer pill marks `✓` + summary

---

### Element 13 — Chat message rendering

**LOCKED 2026-04-28** after grilling 7 design directions.

**Mockup**: `docs/ui/bible/13-chat-boxed-a-refined.html` (landscape) +
`13-chat-boxed-a-refined-portrait.html` (portrait).

**Visual contract**:

```
╭ USER ───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ hello, refactor the auth flow to use the new session pattern.                                                                  │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
                                                                                                                                  (blank)
╭ SUMO ─────────────────────────────────────────────────────────────────────────────────────────────────────── 11:42 ─╮
│ Reading the auth flow.                                                                                                         │
│                                                                                                                                │
│ ✓ [read]  src/auth/session.ts                                                                                                 │
│ ✓ [edit]  src/auth/session.ts                                                                                                 │
│                                                                                                                                │
│ Done. Updated 14 lines, deleted 6 stale helpers.                                                                               │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Each message renders as a self-contained closed-frame box:
- **Rounded corners**: `╭ ╮ ╰ ╯`
- **Vertical sides**: `│`
- **Horizontal**: `─`
- **Top border** has the role label inline + dashes filling + (SUMO only) right-aligned time
- **Box interior** is **TRANSPARENT** (no bg fill) in the LOCKED default. Frame + interior all sit on terminal default bg. Pure typographic frames.
- **Frame chars** in `divider` color
- **1 blank row** between consecutive boxes
- **No model id** in header (decluttered — model lives in footer)
- **Time** right-aligned on SUMO top border: `╭ SUMO ─────...─── 11:42 ─╮`

**Tokens**:
- Frame chars `╭╮╰╯│─`: `divider`
- `USER` label: `foreground`, uppercase
- `SUMO` label: `accent`, uppercase
- ` HH:MM` time on SUMO header: `foregroundDim`
- Body text: `foreground`
- Box interior bg fill (default): **transparent** — falls through to terminal default bg `#1A1511`
- Tool pills (Element 9) live INSIDE the SUMO message box

**Spacing**: 1 blank row between consecutive messages. No blank between assistant text and the tool pills it produced (within the same SUMO box).

**Word wrap**: chat width minus 4 cells (`│ ` + content + ` │`).
  - Landscape (sidebar visible, chat = 130 cols): wrap to 126 cells per line
  - Portrait / sidebar hidden (chat = full term width): wrap to `term_width - 4`

**Slash command toggle**: `/sumo:chat-style {default | sharp | dual}`

| Style | Mockup | Description |
|---|---|---|
| `default` (locked) | `13-chat-boxed-a-refined.html` | rounded corners, **transparent interior** (no bg fill), 1 blank row between |
| `sharp` (alt) | `13-chat-boxed-b-sharp-tablet.html` | sharp corners `┌┐└┘` + `surface-recess` bg fill + `═══` header divider + tight (no blank) |
| `dual` (alt) | `13-chat-boxed-c-dual-tone.html` | rounded + USER **transparent** (matches default) + SUMO `surface-lifted` warm amber bg fill. One-sided emphasis on the assistant turn. |

**Color update**: `--surface-lifted` was `#3A342F` in v1. Bumped to `#3D3024` (warmer amber) for v2 because `#3A342F` reads as cool grey on monitor. The runtime `cathedral.json` + `src/sumo-tui/render/truecolor.ts` must adopt the new value when Element 13 implementation begins.

**Backup directions** (kept in `docs/ui/bible/_archive/` as references; not implemented):
- `13-chat-brutalist.html` — heavy `━━━` rules + `[USER]/[SUMO]` brackets
- `13-chat-ledger.html` — numbered entries + right-aligned timestamps

---

## 4. Slash commands inventory

| Command | Effect | Element |
|---|---|---|
| `/sidebar [show\|hide]` | toggle sidebar visibility | 1 |
| `/metrics [on\|off]` | toggle METRICS HUD in sidebar | 1 |
| `/sumo:cursor [block\|bar\|thin]` | override cursor shape | 4 |
| `/sumo:dotsize [small\|medium\|large]` | active-session dot size | 2 |
| `/sumo:summaryModel <model-id>` | set model for session-name summarization | 2 |
| `/sumo:tabs [show\|hide]` | toggle top-bar tabs | 2 |
| `/sumo:bg [paint\|none]` | toggle OSC 11 bg painting | cross-cut |
| `/yolo` | disable approvals for session | 6 |
| `/sumo:memory edit` | open memory editor | 7 |
| `/sumo:memory add --panel <NAME> "..."` | add memory fact | 7 |
| `/sumo:memory forget <id>` | remove memory fact | 7 |

---

## 5. Keybindings inventory

| Keybind | Effect | Element |
|---|---|---|
| `Ctrl+/` | open command palette | 8 |
| `Ctrl+1` | sidebar CONTEXT sub-tab | 1 |
| `Ctrl+2` | sidebar MEMORY sub-tab | 1 |
| `Ctrl+\` | bash sub-shell overlay (top-bar `[terminal]` icon) | 2 |
| `Ctrl+,` | settings overlay (top-bar `[⚙]` icon) | 2 |
| `⌘M` (Mac) | open memory editor | 7 |
| **Pi defaults preserved** | | |
| `Ctrl+P` | model cycle forward | Pi |
| `Ctrl+Shift+P` | model cycle backward | Pi |
| `Ctrl+K` | delete to line end | pi-tui |
| `Ctrl+T` | thinking-level cycle | Pi (currently broken — investigate) |
| `Ctrl+M` | model selector | Pi |
| `Ctrl+E` | expand tools | Pi |

**Investigation task**: `Ctrl+T` thinking-cycle currently doesn't reach Pi. Suspect our key-router intercepts. File as part of #67 follow-up or separate.

---

## 6. Cross-cutting

### 6.1 Mouse text selection + auto-copy (NEW for v1)

**Decision**: ship in v1. Replace native terminal selection (which is blocked by our SGR mouse capture) with in-app selection + OSC 52 auto-copy.

- Listen for mouse-down / mouse-up via SGR parser (already in place)
- Track cells under selection drag
- Inverse-video highlight on selected cells
- On mouse-up: extract text → emit `\x1b]52;c;<base64>\x1b\\` to system clipboard
- Cmd+C also copies (pi-tui keybind)
- Selection clears on click outside or Esc

**Implementation**: ~1 day. New module `src/sumo-tui/input/selection.ts` + compositor highlight pass + clipboard escape emitter.

### 6.2 Cathedral OSC 11 bg

**Decision**: keep paint for v1, focus on cmux/Ghostty (libghostty). Other terminals: best-effort. Research follow-up: investigate per-terminal escape handling for v2 (e.g., does Apple Terminal honor OSC 111 reset reliably? iTerm2? Alacritty?).

### 6.3 Resume flow performance (HIGH priority)

User-perceived: 2-3s splash → active transition on `/resume`. Must be < 500ms.

**Investigation**:
1. Profile resume path: extension activate → Pi session load → Remnic memory boot → Yoga layout calc → first frame render
2. Identify the dominant cost
3. Likely culprits: Remnic synchronous init, Yoga first-layout cost, full chat history replay

**Fix in v1**.

### 6.4 Defects from T1 verification harness

| # | Defect | Severity v2 |
|---|---|---|
| #71 | Splash regression in `--offline --no-session` | LOW (test-config only — works in normal use) |
| #72 | Crash at 40-col width | HIGH — Element 1 + footer width handling |
| #73 | Skill-conflict banner cosmetic | LOW |

---

## 7. Open follow-ups (researchable, not blocking v1)

- **OSC 11/111 cross-terminal compatibility** — when do other terminals honor reset?
- **Pi approval risk-assessment logic** — read `pi-coding-agent` to find current approval triggers, integrate with our themed modal
- **Ctrl+T thinking-level keybind** — why doesn't it reach Pi? Our key-router suspect
- **Top-bar visibility** intermittent — investigate
- **Animated splash hero** — multi-frame chafa cycle, polish stretch
- **Tool diff rendering style** — keep Pi default for v1, redesign in v2
- **Chat code block — line gutter** — ship if trivial, skip otherwise

---

## 8. Implementation order (revised v2)

Each row = one PR + one issue + visual approval.

**Phase A — Element corrections (regressions to fix)**:
1. Element 4 input frame: drop `SCRIPTOR INPUT` label + drop `INPUT PROTOCOL AWAITING COMMAND` flavour + add `>` prompt
2. Element 1 sidebar: width 49 → 30, paint inter-section bg, render `N more · ⌘M` overflow marker, ⌘M keybind
3. Element 1: `/sidebar [show|hide]` slash, `/metrics [on|off]` slash, compact metrics mode
4. Element 5 footer: drop `↑/↓` cumulative, switch to `42k/200k · $0.42` right zone

**Phase B — Element 13 chat messages + Element 11 questions**:
5. Element 13 chat message framing (`┌ USER │ ... └`, `┌ SUMO · model · time │ ... └`)
6. Element 11 DIVINE QUERY modal

**Phase C — Element bugs**:
7. Element 8 command palette: implement locked scriptorium palette, fix active-state opening + drill-down behavior + add SETTINGS row
8. Element 2 top bar: ship LLM session summarization + recent session tabs (interactive if easy)

**Phase D — Element 9, 10, 12 (new design)**:
9. Element 9 tool pills: cathedral framing for bash/edit/write/read
9a. Element 9a skill pill: inline `[skill] name (⌘O to expand)` rendering inside SUMO boxes
10. Element 10 code blocks: full frame + cathedral syntax colors + (optional) line gutter
11. Element 12 task tool sub-agent UI

**Phase E — Element 6 + crosscut**:
12. Element 6 approval modal: re-enable + Pi default policy integration + `/yolo` slash
13. Cross-cut: mouse selection + OSC 52 auto-copy
14. Cross-cut: resume perf fix (HIGH)
15. Element 7 memory editor: inline `e`/`d` editing + verify visually + AI-driven write path

**Phase F — Polish stretch**:
16. Animated splash hero (cycle frames)
17. Per-terminal OSC 11/111 compat research
18. Tool diff redesign

---

## 9. v2 punted to v3+

- Sidebar SCRIPTOR + FILES sub-tabs (originally locked, deferred)
- Tool pills custom diff renderer (Pi default for v1)
- Themes Amber CRT + Obsidian Temple
- Light mode
- Multi-pane workspace splits
- Settings UI as full overlay (Ctrl+, opens Pi's existing /settings)
- Bash sub-shell overlay (`Ctrl+\` opens — detailed UX TBD)

---

## 10. Acceptance criteria for declaring "v2 spec implemented"

For the visual bible to lock and CI golden-image diff to engage:

- [ ] Phase A (regressions) — 4 PRs, all green, visual approved
- [ ] Phase B (chat + queries) — 2 PRs, all green, visual approved
- [ ] Phase C (palette + top bar) — 2 PRs, all green, visual approved
- [ ] Phase D (tool pills + skill pill + code + task) — 4 PRs, all green, visual approved
- [ ] Phase E (approvals + selection + perf + memory) — 4 PRs, all green, visual approved
- [ ] All 13 elements + Element 9a skill pill have locked bible mockups committed before implementation
- [ ] T2 verification harness (golden-image diff) gates CI on every Phase A–E PR

Phase F is post-acceptance polish.

---

## 11. Bugs to file (during/before Phase A)

From this grill session:
- E1: sidebar inter-section bg + width + footer-on-collapse
- E2: top-bar visibility intermittent
- E3: rotating placeholder
- E4: input regressions (label + flavour text + missing `>`)
- E5: footer right-zone reorganization
- E6: approval re-enabling + Pi default policy integration
- E7: memory editor visual verification + inline edit
- E8: palette broken in active state + drill-down
- E9: tool pill cathedral framing
- E10: code block frame + syntax audit
- E11: DIVINE QUERY modal (NEW)
- E12: task tool UI (NEW)
- E13: chat message framing (NEW)
- Cross-cut: mouse selection + auto-copy
- Cross-cut: resume perf
- Cross-cut: OSC 11 cross-terminal research
- Cross-cut: Ctrl+T plumbing investigation

That's ~17 issues. Will file in batches as Phases proceed.

---

*Last updated: 2026-04-28 · v2.0 · Direction: Cathedral.*
*Next: build `CATHEDRAL_VISUAL_BIBLE.md` with mockups for all 13 elements, locked palette, locked layout. Then Phase A begins.*
