# Cathedral Visual Parity Pass

> **Goal:** make SumoCode visually 100% aligned with `docs/ui/DESIGN.md` and the
> Cathedral mockups under `docs/ui/stitch/cathedral/`. Stop adding features
> (memory commands, sync, etc.) until parity is reached. Verify each step
> with the new `pnpm visual` harness before merging.

## Source of truth

1. `docs/ui/DESIGN.md` — canonical design system, 9-section format.
2. `docs/ui/stitch/cathedral/*.png` — generated mockups for idle, streaming,
   tool-running, approval, memory editor, command palette.
3. `docs/ui/claude-design/Sidebar.jsx`, `Terminal.jsx`, `tokens.css` —
   reference React/CSS implementations of the same design system.
4. `docs/prd.md` — original PRD.

## Verification rule

Every slice in this pass:

1. RED → GREEN → refactor under `pnpm test`.
2. Render a `vhs` scenario via `pnpm visual` and compare PNG against the
   matching mockup.
3. Only then mark the slice done and move on.

No more "tests pass therefore done".

---

## Layered plan

The work is layered. Earlier layers must land before later ones because they
are foundations.

### Layer 0 — Hygiene (must be done first)

Anything that competes with Cathedral on first paint, or contradicts the
design rules, is removed before we redesign the surfaces.

- **0.1** Remove `zeus-splash` extension. _(done)_
- **0.2** Remove `zeus-working` extension. _(done)_
- **0.3** Resolve skill conflicts (`commit`, `github`) so they don't print
  warnings on boot. Pick one provider and uninstall the other in
  `sumocode-config/pi-agent/settings.json`.
- **0.4** Resolve theme conflict (`nightowl`) the same way.
- **0.5** Resolve `/exit` extension command conflict (config's
  `exit-alias.ts`).
- **0.6** Quiet the "Anthropic subscription auth is active" Pi warning,
  either by configuring auth differently or by suppressing this specific
  notification in the SumoCode startup flow.
- **0.7** Drop the `ctx.ui.notify("SumoCode loaded · v0.2.0", "info")`
  call from `src/extension.ts`. The footer already shows version-implicit
  state; the notification is design-anti-pattern noise.

### Layer 1 — Cathedral Pi theme

Pi has its own theme schema (see `~/.pi/agent/themes/*.json`). The current
theme is `ghostty-sync-XXXX`, auto-generated from whatever cmux/Ghostty
palette is active. That is why warning text, markdown headings, syntax
highlighting, and chat backgrounds all look foreign to Cathedral.

We replace it with a hand-authored `cathedral.json` Pi theme.

- **1.1** Author `sumocode-config/pi-agent/themes/cathedral.json` mapping
  every Pi token slot to the Cathedral palette:
  - `bg` → `#1A1511` aged walnut
  - `fg` → `#F5E6C8` vellum
  - `accent` → `#D97706` burnt orange
  - `muted` → `#8B7A63` oxidized paper
  - `dim` → `#3A2F25` divider
  - `border`, `borderAccent`, `borderMuted` → divider/accent
  - chat backgrounds (`userMessageBg`, `customMessageBg`,
    `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `selectedBg`) →
    derived shades of `#241D17` mahogany
  - markdown (`mdHeading`, `mdCode`, `mdCodeBlock`, etc.) → accent and
    syntax tokens
  - syntax tokens (`syntaxKeyword`, `syntaxString`, `syntaxNumber`,
    `syntaxFunction`, `syntaxComment`) → DESIGN.md syntax palette
  - thinking levels (`thinkingMinimal`, `thinkingLow`, etc.) → accent
    ramp
  - states (`success`, `warning`, `error`) → state palette
- **1.2** Set this theme as the active Pi theme by default in
  `sumocode-config/pi-agent/settings.json`. Stop letting `ghostty-sync`
  override on every boot.
- **1.3** Document how `ghostty-sync` interacts with this. We probably
  want to disable that extension while Cathedral is the contract; it
  was a placeholder.

### Layer 2 — Sidebar parity

Current sidebar renders a 32-col mahogany card with banners but does not
match the planned 49-col, 3-section layout from `Sidebar.jsx`.

- **2.1** Widen `SIDEBAR_WIDTH` from `32` to `49`.
- **2.2** Update the auto-hide threshold so the sidebar still fits
  alongside the chat pane (likely `SIDEBAR_MIN_TERMINAL_WIDTH ≈ 160`).
- **2.3** Anchor responsive to terminal aspect ratio (#13):
  landscape → `right-center`; portrait → `top-right`.
  Persist override in per-machine `~/.sumocode/local-config.json`.
- **2.4** CONTEXT section parity:
  - row 1: `argent-x (main)` (project + branch)
  - row 2: `[██████░░░░░░░░░░░░░░░░░░] 42k/200k`
    (filled+empty progress bar, dim brackets, foreground fill, divider
    empty cells, dim suffix)
  - row 3: `$0.42 spent · session` in dim text
- **2.5** MCP section parity:
  - per server: `● name             status`
  - dot color from real Pi MCP health (or placeholder until #11 wires
    it)
  - status pills `ok` / `idle` / `down` right-aligned, color from state
    palette
- **2.6** MEMORY section parity:
  - bullet `❧` in burnt orange
  - body in vellum
  - cap at 5 visible facts
  - footer line `48 more · ⌘M` in dim (where `48` is real total minus
    visible)
- **2.7** Distinct empty/unavailable states already in: `no memory match` /
  `memory unavailable` (done in `06a6a01`).

### Layer 3 — Footer parity

Current footer:

```
/Volumes/.../sumocode (chore/visual-harness) · ↑0 ↓0 · $0.00 · 0%/1.0M · ● ready · claude-opus-4-7
```

Mockup footer:

```
~/argent-x (main) · ↑12k ↓8k · $0.42 · 42%/200k · ● ready · claude-opus-4-7
```

Differences to fix:

- **3.1** Path display: collapse `$HOME` to `~`, hide `/Volumes/.../`
  prefix when project lives there. Display only the meaningful path.
- **3.2** Separator color: `·` should render in `--divider` (`#3A2F25`),
  not the default fg.
- **3.3** Token / cost / context groups: render in `--foreground-dim`
  (`#8B7A63`), not full vellum.
- **3.4** Path: full vellum `#F5E6C8`.
- **3.5** State dot: keep its state color, label in vellum.
- **3.6** Model name: `--foreground-dim`.

### Layer 4 — Tab bar

Currently absent.

Mockup:

```
║ ● work-20260424 · idle ║   │ readyx-20260423   │ + new
```

- **4.1** Add `src/tab-bar.ts` that renders Pi's session tabs in
  Cathedral style.
- **4.2** Active tab wrapped in burnt-orange `║…║`, contains the state
  dot + label.
- **4.3** Inactive tabs separated by dim `│`, in dim color.
- **4.4** Trailing `│ + new` in dim.
- **4.5** Mount above the chat area on `session_start`.
- **4.6** Optional: react to Pi's tab events if supported; otherwise
  static-from-`SessionManager` snapshot like the footer.

### Layer 5 — Tool pills

Currently Pi renders tool calls in its default style (boxed multiline). The
mockup uses one-row "tool pills":

```
━━━ [read]  src/argent-x/balance.ts            ━━━ ✓
━━━ [bash]  pnpm test                          ━━━ ▶ running
━━━ [edit]  src/argent-x/balance.ts            ━━━ ✓
```

Pi exposes a `MessageRenderer`-style hook for tool result customization. We
override per-tool with the Cathedral pill renderer.

- **5.1** Decide whether Pi extension API supports replacing the tool
  result block. If yes, implement; if not, file a Pi-side issue and skip
  this layer for v0.2.x.
- **5.2** Add `src/tool-pill.ts` rendering `━━━ [name] target ━━━ status`.
- **5.3** Map status icons:
  - running → `▶` in `--state-tool`
  - success → `✓` in `--state-idle`
  - error → `✗` in `--state-approval`

### Layer 6 — Code blocks & markdown

Pi already has markdown rendering. With the Cathedral Pi theme (Layer 1),
it should mostly match. Verify:

- **6.1** Code blocks use double-line `╔═╗` framing or a fallback that
  matches DESIGN.md. May require a Pi extension hook.
- **6.2** Inline code uses `--accent`.
- **6.3** Headings `--mdHeading` mapped to accent.
- **6.4** Syntax highlighting inside code blocks uses Cathedral syntax
  tokens (already in Layer 1).

### Layer 7 — Approval modal

Mockup: double-line frame, terracotta accent, dim underlying terminal.

- **7.1** If Pi supports approval prompt customization, render
  Cathedral-styled approval card.
- **7.2** Otherwise: file as future extension, since approval prompts
  are core Pi flow.

### Layer 8 — Command palette

Mockup: `Ctrl+K` style overlay with bordered card, search input,
selectable rows (SESSION, MODEL, THINKING, MEMORY).

- **8.1** Decide if SumoCode wraps Pi's existing command palette or adds
  a parallel one. Likely wraps.
- **8.2** Implement Cathedral-styled overlay via `ctx.ui.custom`.

### Layer 9 — Input frame

Mockup:

```
┌──────────────────────────────────────────────────────────────────┐
│ > _                                                                │
└──────────────────────────────────────────────────────────────────┘
```

Carved-into-canvas (`--surface-recess`). Cursor block in `--accent`.

- **9.1** If Pi exposes input-frame customization, override.
- **9.2** Otherwise: defer to Pi-side feature request.

### Layer 10 — Memory editor screen

Mockup: full-screen Cathedral-styled editor for facts, with framed cards
per category (IDENTITY, PREFERENCES, STACK, PROJECTS).

- **10.1** This is `/sumo:memory edit`. Reuses `RemnicMemoryClient` from
  #8.
- **10.2** Lower priority than the always-visible surfaces. Schedule
  after sidebar/footer/tab-bar are done.

---

## Slicing into GitHub issues

Each issue is one or two layers. Each issue gets a `vhs` scenario before it
merges.

### Shipped

| Issue | Layer | Status |
|---|---|---|
| #15 first-paint hygiene | 0 | ✅ closed |
| #16 cathedral pi theme | 1 | ✅ closed |
| #17 sidebar parity | 2 | ✅ closed (superseded by #22 layout fix) |
| #18 footer parity | 3 | ✅ closed |
| #19 cathedral tab bar | 4 | ✅ closed |
| #21 cathedral splash | 5 (added) | ✅ closed retroactively |

### Open

| Issue | Layer / fix | Priority | Notes |
|---|---|---|---|
| **#22** sidebar static | layout fix on #17 | **P0 — highest** | Floating overlay covers chat. Must reserve columns. |
| **#23** footer thinking level | small fix on #18 | P1 | Append `xhigh` etc. to footer. |
| **#24** tool pills | layer 6 | P1 | Most visually dense remaining gap. |
| **#25** code blocks + markdown audit | layer 7 | P2 | Mostly theme-driven; verify only. |
| **#26** approval modal | layer 8 | P2 | Pi-API permitting. |
| **#27** command palette overlay | layer 9 | P3 | Quality of life. |
| **#28** input frame | layer 10 | P3 | Pi-API permitting. |
| **#29** memory editor screen | layer 11 | P3 | Depends on #8 (already shipped). |

*(Issues #24–#29 above will be filed when we approach each one.)*

---

## Visual scenarios for `pnpm visual`

Each scenario corresponds to one of the Cathedral mockups. Add `.tape` files
to `docs/visual/`:

- `cathedral-idle.tape` (in repo, baseline) — pairs with `01-idle.png`
- `cathedral-streaming.tape` — pairs with `02-streaming.png`
- `cathedral-tool-running.tape` — pairs with `03-tool-running.png`
- `cathedral-approval.tape` — pairs with `04-approval.png`
- `cathedral-memory-editor.tape` — pairs with `05-memory-editor.png`
- `cathedral-command-palette.tape` — pairs with `06-command-palette.png`
- `cathedral-portrait.tape` — landscape→portrait variant

Each `.tape` drives Pi into the matching state and screenshots. The agent
reads both PNGs side by side and compares structurally.

---

## Reusable cathedral-asset pipeline

For any new ASCII / pixel-art asset (alternate cat poses, theme-specific
mascots, animation frames):

1. Generate PNG via the `claude-art-skill` we installed:

   ```bash
   bun ~/sumocode-config/pi-agent/skills/art/tools/generate-image.ts \
     --prompt "<spec>" --size 1K --aspect-ratio 1:1 --thinking high \
     --output X.png
   ```
2. Convert to ANSI via `chafa`:

   ```bash
   chafa --format=symbols --symbols=block --fg-only --colors=full \
         --size=24x14 X.png > src/assets/X.ans
   ```
3. Print the `.ans` file verbatim from the SumoCode component.

The whole pipeline is unit-tested via the splash component (`src/splash.test.ts`).

## Definition of done for the parity pass

The parity pass is done when, for each layer:

1. The matching `vhs` scenario PNG is structurally indistinguishable from
   the Cathedral mockup (allowing for font / scale differences inherent to
   `vhs` headless render).
2. `pnpm test` passes.
3. `pnpm exec tsc --noEmit` passes.
4. You have personally seen and approved a screenshot.
