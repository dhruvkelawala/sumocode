# Cathedral UX Decisions Log

> Working log of decisions made during the grill-me session for the cathedral
> active-state implementation. Each entry is final unless explicitly revisited.
> This file is the source of truth for the rewrite of `CATHEDRAL_UX_SPEC.md`
> once the grill is complete.
>
> **Path:** B (from `CATHEDRAL_PI_API_SPIKE.md`) — public Pi API for 9 of 10
> regions, `dockStaticSidebar` retained for the registry sidebar mount.
>
> **Canonical mockup map:** mixed. Each element below records which mockup it
> derives from.

---

## Element 1 — Sidebar (active state only)

**Locked: F (REGISTRY chrome + 2 sub-tabs + Claude Design content)**

- Chrome / aesthetic: from Stitch v1/v2 — `REGISTRY` header, `v 1.0.0` line,
  `◆ active / ▢ inactive` sub-tab markers.
- Sub-tabs: only **CONTEXT** and **MEMORY** in v1.
  - `Ctrl+1` → CONTEXT
  - `Ctrl+2` → MEMORY
  - SCRIPTOR + FILES are deferred to a v2 backlog issue.
- Sub-tab content: derived from Claude Design — real progress bar, dollar
  amounts, MCP status pills, `❧ fact` bullets with `N more · ⌘M` overflow
  marker.
- Sidebar visibility:
  - **HIDDEN on splash** (no messages yet).
  - **VISIBLE in active state** (sidebar mount uses `dockStaticSidebar`,
    accepted as legitimate Container API per Path B).
  - Hidden when terminal width < 120 cols.

Sketch (active state, CONTEXT selected):

```
                                                  REGISTRY
                                                  v 1.0.0

                                                  ◆ CONTEXT       ← Ctrl+1
                                                  ▢ MEMORY        ← Ctrl+2

                                                  ┌ ACTIVE_CONTEXT ─
                                                  argent-x (main)
                                                  [██████░░░] 42k/200k
                                                  $0.42 spent · session

                                                  ┌ MCP ─
                                                  ● stitch          ok
                                                  ● figma          down
```

When user presses `Ctrl+2`:

```
                                                  REGISTRY
                                                  v 1.0.0

                                                  ▢ CONTEXT       ← Ctrl+1
                                                  ◆ MEMORY        ← Ctrl+2

                                                  ┌ ACTIVE_MEMORY ─
                                                  ❧ prefers TypeScript strict
                                                  ❧ pnpm not npm
                                                  ❧ based in London · BST
                                                  48 more · ⌘M
```

---

## Element 2 — Top bar

**Locked: single-row hybrid with functional icons.**

Layout:

```
SUMOCODE   ║ ● refactor-auth-flow ║   │ debug-balance-tx   │ index-issues   │ ARCHIVE        [terminal]  [⚙]
                                                                                              Ctrl+\\      Ctrl+,
```

- `SUMOCODE` — always visible, top-left, accent (burnt orange).
- `║ ● <name> ║` — active session marker, name is LLM-summarized (see Q2.6).
  - State dot color matches current state (idle / thinking / tool / approval /
    learning).
- `│ <name>` — recent sessions, dim, ordered by mtime descending.
- `│ ARCHIVE` — opens full session list overlay.
- `[terminal]` icon — opens bash sub-shell overlay. Keybind: `Ctrl+\\`.
- `[⚙]` icon — opens `/settings` overlay. Keybind: `Ctrl+,`.

### Q2.4 — Layout: **a**

`SUMOCODE | ║active║ | recents | ARCHIVE | [icons]`. SUMOCODE on the left
because it's the brand label. Right-side icons after ARCHIVE so they don't
get lost in the session list.

### Q2.5 — Icon functionality: **a**

Both icons are functional:

- terminal = bash sub-shell overlay (`Ctrl+\\`)
- settings = `/settings` overlay (`Ctrl+,`)

### Q2.6 — Session-name summarization: **a**

- Trigger: on `agent_end` after the first 5 user messages.
- Cache: stored in session metadata (one summary per session, never
  re-summarized).
- Fallback chain on offline / no API key / failure:
  1. local heuristic — extract 4-5 nouns from first user prompt, kebab-case.
  2. UUID first segment (`019dcad9`).

### Element 1 follow-ups carried in here

- **Q1**: Top bar tabs are passive (state-driven, not interactive). Hideable
  via `/sumo:tabs hide|show`. SUMOCODE label always visible.
- **Q2** (original): mockup names dropped — we use session tabs instead of
  `EDITOR/TERMINAL/ARCHIVE/SCRIPTOR/SETTINGS`.

---

## Element 3 — Splash middle content

**Locked: cat + wordmark + quote (kept as shipped) + DIVINE INVOCATION input.**

Splash renders only when the session has zero user messages.

```
                              (cat face, 24×14 chafa render)



                             S U M O C O D E                       ← pixel-block, accent



                  "perfection is achieved when there is
                              nothing left to take away."
                                  — saint-exupéry



   ┌─ DIVINE INVOCATION ───────────────────────────────────────┐
   │ > Ask anything... "Refactor the auth flow."  █            │
   └───────────────────────────────────────────────────────────┘

   └─ AWAITING DIVINE INVOCATION              TAB · AGENTS  CTRL+/ · COMMANDS
```

- Top bar (Element 2) renders above the splash.
- Footer (Element 5) renders below the splash.
- Sidebar is hidden during splash (full chat width).
- Splash collapses on `message_start` (first user message).

### Q3.1 — middle content (cat + wordmark + quote): **A** — keep as shipped

### Q3.2 — chrome on splash: **a** — top bar + footer always render, including on splash

### Q3.3 — input frame label: **a** — labeled

After ranking cathedral vocabulary (INVOCATION, SCRIPTORIUM, PETITION, etc.),
the user requested a `DIVINE ...` variant. Final pick:

**`DIVINE INVOCATION`** — formal calling-upon, single-meaningful-pair, fits
the scriptorium aesthetic.

### Q3.4 — splash placeholder: **b**

Static dim placeholder example, e.g.
`Ask anything... "Refactor the auth flow."`. Disappears on first keystroke.

### Q3.5 — hint row: **a**

Both hints below the input frame:

- Left (dim flavour): `└─ AWAITING DIVINE INVOCATION`
- Right (dim keybinds): `TAB · AGENTS  CTRL+/ · COMMANDS`

---

## Element 4 — Active-state input frame

**Locked: minimal — no label, no flavour text, keybinds always shown, no placeholder.**

```
   ┌──────────────────────────────────────────────┐
   │ > █                                          │
   └──────────────────────────────────────────────┘
                                                  TAB · AGENTS  CTRL+/ · COMMANDS
```

### Q4.1 — Active-state input label: **b** — drop the `DIVINE INVOCATION` label in active state

The label is splash-only ceremony. Active state has just the carved frame.

### Q4.2 — Active-state hint row: **b** — keep keybinds only, drop cathedral flavour

`TAB · AGENTS  CTRL+/ · COMMANDS` on the right of the row below the frame.
No `AWAITING DIVINE INVOCATION` flavour text.

### Q4.3 — Active-state placeholder: **b** — no placeholder

Empty active-state input is just `> █`. Onboarding is a one-time concern
served by splash.

---

## Element 5 — Footer + bottom version line

**Locked: F1 footer + version line on splash only + same footer everywhere + thinking level in footer + READY/MEDITATING/ILLUMINATING/DEFERRING/INSCRIBING state labels.**

### Q5.1 — Footer style: **F1 (two-zone hybrid)**

Left zone = agent state. Right zone = session metrics. No context window in footer (lives in sidebar CONTEXT sub-tab).

```
● READY · claude-opus-4-7 · xhigh                       sumocode (main) · ↑12k ↓8k · $0.42
```

- Left: state dot (color matches state) · state label UPPERCASE · model id (lowercase) · thinking level (lowercase).
- Right: project shortname (no `~/` prefix) (branch) · ↑ input tokens ↓ output tokens · $ session cost.
- Cathedral tone via uppercased state label only. Model id + thinking level + tokens stay practical lowercase.

Splash footer is the same shape — nothing special on splash.

### Q5.2 — Bottom version line: **c (only on splash)**

```
SUMOCODE V0.2.0 · CATHEDRAL · 160 × 45 MONOSPACE
```

- Renders as a second row below the footer **only on splash**. In active state the row is gone.
- Dim. Centered horizontally.
- Identity / first-contact ceremony.

### Q5.3 — Footer same on splash and active: **a (yes, always identical)**

One footer style. The splash difference is the bottom version line (Q5.2), not the footer itself.

### Q5.4 — Thinking level placement: **a (footer, after model id)**

Closing issue **#23**. Thinking level appears as `· xhigh` after the model id. Updates live when user changes thinking level mid-session.

### Q5.5 — State labels (final): **mixed cathedral set**

```
internal     UI label       reason for choice
─────────    ───────────    ─────────────────
idle      →  READY          most common state — stays practical for daily glance
thinking  →  MEDITATING     contemplative thought, scriptorium feel
tool      →  ILLUMINATING   the scribe decorates / writes / reads
approval  →  DEFERRING      agent honestly defers decision to user
learning  →  INSCRIBING     writing into the codex (memory)
```

Propagation:
- footer state label
- working indicator label / message
- state dot tooltip (if any)
- src/voice.ts replaces `ready/thinking/working/needs you/learning`
- src/tokens.ts colors stay mapped to internal state names (no token rename)

---

## Carried-over hard locks (from earlier in the conversation)

- **Splash discipline**: sidebar HIDDEN during splash, full-width splash
  content. Discipline implemented in `dockStaticSidebar` predicate
  `shouldShowSidebar()` already.
- **`dockStaticSidebar`** is treated as **legitimate Container API**, not a
  shortcut. It is the production sidebar mount. Reframed in the spike (Path
  B). No longer marked for retirement.
- **Cathedral palette / DESIGN.md tokens**: unchanged. All region styling
  draws from `cathedral.json` slots.
- **No internal-state mutation beyond `Container.children` mutation through
  the public Container API**. No monkey-patching, no fork-and-modify.
- **TDD per element**: red → green → minimal refactor. Visual approval per
  layer before merge.
- **Splash ASCII pipeline**: claude-art-skill (Gemini Nano Banana 2) →
  chafa → `.ans` asset embedded in `src/assets/`. Reusable for any future
  cathedral asset.

---

## Implementation layer order (revised, post-grill so far)

1. Top bar (Element 2) — `setHeader` + state-driven active tab + LLM session
   summarization.
2. Splash carved input + hint row (Element 3 input region) —
   `setEditorComponent` + `CustomEditor` subclass with conditional label.
3. Active-state input frame (Element 4) — same `CustomEditor`, no label.
4. Re-enable sidebar (Element 1, F) — wire `dockStaticSidebar` back into
   `extension.ts`, render `RegistrySidebarComponent` with sub-tabs.
5. Footer + bottom version line (Element 5, pending) — `setFooter`.
6. Sidebar sub-tab CONTEXT content (Element 1.4) — wire existing footer
   stats sources.
7. Sidebar sub-tab MEMORY content (Element 1.5) — already working in
   `src/sidebar.ts`, refit to F shape.
8. Approval modal (TBD) — `tool_call` interception + custom overlay.
9. Memory editor (TBD) — `/sumo:memory edit` + custom overlay.
10. Command palette (TBD) — `Ctrl+/` + custom overlay.
11. Tool pills (TBD) — `pi.registerTool()` overrides.
12. Code blocks audit (TBD) — verify `cathedral.json` covers all syntax slots.

---

## Element 6 — Approval modal

**Locked: extend (not rewrite) `bash`/`edit`/`write` with our approval flow + flat-hybrid modal style + explicit `[Y]ES [N]O [A]LWAYS` buttons + use Pi's allowlist mechanism.**

### Q6.1 — Scope: **B (extend via re-register)**

For the three destructive built-in tools (`bash`, `edit`, `write`), `pi.registerTool()` re-registers each with:
- our custom approval modal as the gate
- delegated execution via Pi's underlying machinery (`BashOperations` / `ctx.exec` / Pi's existing edit-write helpers)
- `renderShell: "self"` for the call/result frame

We DO NOT reimplement the underlying execution — only the approval flow and rendering.

### Q6.2 — Modal visual: **flat-hybrid (v1/v2 card + v3 code-block frame)**

Final sketch:

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

Visual treatment:
- Card: subtle elevation via `surfaceLifted` background, no double-line border
- Title `APPROVAL REQUIRED`: large, accent (burnt orange), centered
- Divider rules above/below content: `divider` color
- Code block: carved frame from v3 (`┌─┐ │ └─┘`) with `surfaceRecess` bg, accent text
- Body text: regular `foreground`
- Em-dash explanation row: `foregroundDim`
- `■ SYSTEM NOTICE`: small caps, `state.approval` (terracotta) for square + dim brown for label
- Buttons: outlined (`[Y]ES`, `[N]O` with subtle border), with **active button** filled in `accent` (burnt orange) like v3's `[A]LWAYS`

### Q6.3 — `[A]lways`: **present + use Pi's allowlist**

Pi already supports always-allow (per-tool / per-pattern). Our modal exposes the third button and the answer is forwarded to Pi's existing allow-list machinery. We do not maintain a separate SumoCode allowlist.

### Q6.4 — Buttons: **B (explicit `[Y]ES [N]O [A]LWAYS`)**

Not a text prompt (`Proceed? [Y/n/a]`). Three real focusable buttons. Default focus on `[N]O` for safety. `Tab` cycles focus, `Y/N/A` letters select directly.

### Q6.5 — Wrap which tools: **b (`bash`, `edit`, `write`)**

All three destructive built-ins re-registered. `read`/`find`/`grep`/`ls` stay Pi default.

---

## Element 7 — Memory editor (`/sumo:memory edit` modal)

**Locked: read-only browser + Remnic-native metadata categorization with 6 panels + flat-hybrid modal style matching Element 6.**

### Q7.1 — Scope: **A (read-only browser)**

Modal lists existing memories. Editing happens via slash commands:
- `/sumo:memory add --panel <name> "..."`
- `/sumo:memory forget <id>`

No inline editing in v1.

### Q7.2 — Categorization: **A (Approach 2-lite from spike)**

**6 panels** rendered as a v3-style categorized grid:

| Panel | Routing signals |
|---|---|
| `IDENTITY` | tag `sumocode:identity`, `entityRef=dhruv`, category `entity`/`relationship`, keywords `dhruv`/`argent`/`london`/`senior frontend` |
| `PREFERENCES` | category `preference`/`rule`/`principle`, tag `sumocode:preference` |
| `WORKFLOW` | category `procedure`/`skill`/`rule`/`decision`, tags `sumocode:workflow`/`sumocode:tdd`/`sumocode:visual` |
| `PROJECTS` | tag `sumocode:project`, `project:sumocode`/`project:openclaw`, keywords `sumocode`/`openclaw`/`cmux`/`cathedral` |
| `SYSTEM` | tag `sumocode:system`, runtime/machine constraints (`cmux`, `mac mini portrait`, `macbook landscape`, `terminal`, `visual verification`) |
| `GENERAL` | unclassified — **hidden if empty** |

**Routing precedence per fact** (deterministic, no LLM):

1. explicit `sumocode:<panel>` tag
2. Remnic `category` field
3. keyword rules on `content`
4. fallback → `GENERAL`

**Future enhancement**: `/sumo:memory add --panel <name> "..."` writes the `sumocode:<panel>` tag at write-time, so new facts skip heuristic routing entirely. Existing untagged facts continue to route via category + keywords with zero migration.

### Q7.3 — Visual: **B (flat-hybrid matching Element 6)**

```
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   │ search…                                              48 facts │

   ╭─ IDENTITY ───────────────────╮  ╭─ PREFERENCES ────────────────╮
   │ Dhruv · Senior FE · Argent     │  │ prefers TypeScript strict      │
   │ London / BST                   │  │ pnpm not npm                   │
   ╰──────────────────────────────╯  ╰────────────────────────────────╯

   ╭─ WORKFLOW ───────────────────╮  ╭─ PROJECTS ───────────────────╮
   │ TDD by default                 │  │ sumocode/cathedral parity      │
   │ visual approval before done    │  │ openclaw ACPX integration      │
   ╰──────────────────────────────╯  ╰────────────────────────────────╯

   ╭─ SYSTEM ─────────────────────╮
   │ cmux runtime, libghostty       │
   │ mac mini portrait              │
   │ macbook landscape              │
   ╰──────────────────────────────╯

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate   /  search   ⏎  copy id   esc  close
```

- Same flat card style as approval modal (no double-line border)
- Title `SUMOCODE MEMORY` accent, centered
- Search input with `48 facts` count right-aligned
- Panels rendered as bordered sub-cards, 2 across when width allows
- Empty panels hidden
- Footer keybind hints same style as Element 3

### Implementation refs

- Spike: `docs/ui/MEMORY_CATEGORIZATION_SPIKE.md`
- Existing Remnic client: `src/memory.ts` — needs `browse({ status, q, limit, offset })` method added (the spike notes this).
- New module: `src/memory-categorization.ts` — pure grouping function, fully unit tested.

---

## Element 8 — Command palette

**Locked: Ctrl+/ palette + 5 modes + drill-down + flat-hybrid modal.**

### Q8.1 — Trigger keybind: **Ctrl+/; leave Pi model/editing defaults alone**

- `Ctrl+/` opens the SumoCode command palette. This supersedes the earlier `Ctrl+P` decision after daily-drive issue #48: Pi owns `Ctrl+P` / `Shift+Ctrl+P` for model cycling, and pi-tui owns `Ctrl+K` for delete-to-line-end.
- SumoCode does not register `Ctrl+P`, `Ctrl+K`, or `Ctrl+Shift+K`, which avoids Pi's built-in shortcut conflict diagnostics.
- Other Pi defaults unchanged: `Ctrl+P` / `Shift+Ctrl+P` model cycle, `Ctrl+T` thinking cycle, `Ctrl+M` model selector, `Ctrl+E` expand tools.

Full SumoCode keybind table after Element 8:

```
Ctrl+/             open command palette  (Element 8)
Ctrl+P             model cycle forward    (Pi default)
Ctrl+Shift+P       model cycle backward   (Pi default)
Ctrl+K             delete to line end     (pi-tui default)
Ctrl+T             thinking level cycle   (Pi default)
Ctrl+M             model selector         (Pi default)
Ctrl+E             expand tools           (Pi default)
Ctrl+\\             bash sub-shell overlay (Element 2)
Ctrl+,             settings overlay       (Element 2)
Ctrl+1             sidebar CONTEXT tab    (Element 1)
Ctrl+2             sidebar MEMORY tab     (Element 1)
```

### Q8.2 — Modes: **A + THEME (5 rows)**

```
SESSION        ▶ CURRENT: refactor-auth-flow      → opens session selector
MODEL          ▶ CURRENT: claude-opus-4-7          → opens model selector
THINKING       ▶ CURRENT: xhigh                    → opens thinking-level selector
MEMORY         ▶ 55 FACTS                          → opens memory editor (Element 7)
THEME          ▶ CURRENT: cathedral                → opens theme selector
```

Future v1.x candidates (not in v1): TOOLS, SETTINGS, ARCHIVE.

### Q8.3 — Selection behavior: **a (drill-down)**

Enter on a row closes the palette and opens the matching sub-overlay. No in-place cycling.

### Q8.4 — Visual: **A (flat-hybrid matching Elements 6, 7)**

```
                              COMMAND PALETTE
   ────────────────────────────────────────────────────────────────────────

   │ search…                                                          │

     SESSION        ▶ CURRENT: refactor-auth-flow
   █ MODEL          ▶ CURRENT: claude-opus-4-7              █
     THINKING       ▶ CURRENT: xhigh
     MEMORY         ▶ 55 FACTS
     THEME          ▶ CURRENT: cathedral

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate    ⏎  select    esc  close
```

- Flat card, no double-line border.
- Title `COMMAND PALETTE` accent, centered.
- Search input filters rows by label substring (case-insensitive).
- Active row filled in `accent` (burnt orange).
- `CURRENT:` value rendered in `foreground`; row label in uppercase `foreground`.
- Footer keybind hints same style as Elements 3, 7.
- Modal width 60% terminal, min 50, max 80, centered.

### Splash hint row update

Element 3's splash hint row now says `TAB · AGENTS  CTRL+/ · COMMANDS` so the on-screen hint matches the conflict-free palette shortcut.

---

## Open follow-ups

- Element 9 (tool pills)
- Element 10 (code blocks)
- Bash sub-shell overlay for the `[terminal]` icon — needs implementation
  spec.
- Settings overlay theming — Pi's built-in `/settings` modal.
- LLM session summarization implementation — model choice, cost cap, error
  handling.
- Package Updates message — confirmed Pi-hardcoded per spike, accepted as known
  limit until upstream changes. Anthropic subscription auth warning is hidden in
  SumoInteractiveMode by the reversible `SUMO_TUI_HIDE_PI_NOISE` filter.

---

*Last updated: ongoing. Append decisions as they're locked.*
