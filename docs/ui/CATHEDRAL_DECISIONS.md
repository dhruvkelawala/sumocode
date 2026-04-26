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

   └─ AWAITING DIVINE INVOCATION              TAB · AGENTS  CTRL+P · COMMANDS
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
- Right (dim keybinds): `TAB · AGENTS  CTRL+P · COMMANDS`

---

## Element 4 — Active-state input frame

**Locked: minimal — no label, no flavour text, keybinds always shown, no placeholder.**

```
   ┌──────────────────────────────────────────────┐
   │ > █                                          │
   └──────────────────────────────────────────────┘
                                                  TAB · AGENTS  CTRL+P · COMMANDS
```

### Q4.1 — Active-state input label: **b** — drop the `DIVINE INVOCATION` label in active state

The label is splash-only ceremony. Active state has just the carved frame.

### Q4.2 — Active-state hint row: **b** — keep keybinds only, drop cathedral flavour

`TAB · AGENTS  CTRL+P · COMMANDS` on the right of the row below the frame.
No `AWAITING DIVINE INVOCATION` flavour text.

### Q4.3 — Active-state placeholder: **b** — no placeholder

Empty active-state input is just `> █`. Onboarding is a one-time concern
served by splash.

---

## Element 5 — Footer + bottom version line

**Pending — see CATHEDRAL_UX_SPEC.md for follow-up grill.**

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
10. Command palette (TBD) — `Ctrl+K` + custom overlay.
11. Tool pills (TBD) — `pi.registerTool()` overrides.
12. Code blocks audit (TBD) — verify `cathedral.json` covers all syntax slots.

---

## Open follow-ups

- Element 5 (footer style + version line)
- Element 6+ (approval modal, memory editor, command palette, tool pills, code blocks)
- Bash sub-shell overlay for the `[terminal]` icon — needs implementation
  spec.
- Settings overlay theming — Pi's built-in `/settings` modal.
- LLM session summarization implementation — model choice, cost cap, error
  handling.
- Anthropic auth warning + Package Updates message — confirmed Pi-hardcoded
  per spike, accepted as known limit until upstream changes.

---

*Last updated: ongoing. Append decisions as they're locked.*
