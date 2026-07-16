# Plan 037: Cathedral-style the in-place selector

> **Executor instructions**: Follow step by step, commit per punch-list item.
> Base on the current `integrate/track-d` tip; commit to
> `feat/cathedral-selector-styling` and hand the reviewer the SHA.

## Status

- **Priority**: P2 (visual polish, not a defect — the surface works, it just
  looks unfinished next to the rest of the product)
- **Effort**: M
- **Depends on**: plan 036 (in-place selectors — done)
- **Category**: UX / design consistency
- **Planned at**: `138ed98`, 2026-07-03
- **Source audit**: workflow findings 2026-07-03 (agent a7c3e188a14696069)

## Why this matters

Plan 036 correctly moved `/model`, `/thinking`, `/sessions`, `/settings`,
`/fork`, `/theme` off the full-screen modal onto an in-place surface — but it
explicitly deferred content richness, and nobody picked that half back up.
The result, captured directly from a real render at width 60:

```
Choose model
→ anthropic/claude-opus-4-7
  anthropic/claude-sonnet-5
  openai/gpt-5.1
```

One dim title, an accent `→ ` on the active row, everything else plain
terminal-default text — no background, no border, no footer hint, no
description column. Compare the **same codebase's** command palette (which
the user has never complained about) at the same width:

```
[bg-fill]         ✾  COMMAND PALETTE  ✾
[bg-fill]     ──────────────────────  ·  ──────────────────────
[bg-fill]     ❯  what shall we attend to…
[bg-fill]     ❈   MODEL                          claude-opus-4-7   ← focused
[bg-fill]     ·   THINKING                                 xhigh
[bg-fill]     ──────────────────────  ·  ──────────────────────
[bg-fill]             ↑↓ wander    ⏎ attend    ⎋ retreat
```

The gap is the whole Cathedral vocabulary: panel background, border, focus
glyph, current-value column, footer hint. `inline-selector.ts` also
hand-rolls raw ANSI (`rgb()`/`fg()` helpers) instead of building on
`src/sumo-tui/render/primitives.ts`, which AGENTS.md's Cathedral-rendering
section requires for new surfaces — this plan fixes that violation as part
of the redesign, not as a separate cleanup.

## Current state

- `src/sumo-tui/rpc/inline-selector.ts`: `InlineSelectorComponent.render()`
  (~L87-91) wraps pi-tui's stock `SelectList` with only a 5-hook
  `SelectListTheme` (~L41-50: `selectedPrefix`, `selectedText`, `description`,
  `scrollInfo`, `noMatch`) — no background/border/header/footer hooks exist
  in that theme shape, and none are supplied. Hand-rolled ANSI helpers at
  ~L25-39.
- pi-tui's `SelectList.renderItem` (`select-list.js` ~L90-116) hard-codes the
  selected prefix as `"→ "` vs `"  "` — generic, not Cathedral.
- Call sites in `src/sumo-tui/rpc/host-actions.ts` (~L554, 567, 573, 578, 593,
  612, 648, 685) construct items from plain `string[]` — no `description`,
  no current-value marker, even though `SelectItem.description` exists and
  `SelectList` already lays out a two-column description field
  (`select-list.js` ~L90-108, `getPrimaryColumnWidth`/`MIN_DESCRIPTION_WIDTH`).
- `inline-selector.test.ts` never asserts styling (only plain-substring
  `.toContain`) — a coverage gap this plan must close alongside the redesign.
- **Reference to build toward** (ranked, per the audit):
  1. `src/command-palette.ts` `renderCommandPalette` (~L130-166) — same
     interaction shape, `activeThemeColors()`-sourced, the target look.
     Reusable pieces: `panelLine`/`panelBg` (persistent bg fill, ~L57-59,
     103-105), the `❈`/`·` focused-vs-unfocused marker (~L151), the
     right-aligned current-value column (`displayPaletteValue`, ~L153-157),
     title + rule dividers (~L139-141, 162), footer hint constant
     `COMMAND_PALETTE_HINT_ROW` (~L27).
  2. `src/approval-modal.ts` + `src/sumo-tui/cathedral/scriptorium-chrome.ts`
     — the shared Cathedral panel helper module (`panelRow`/`wrapPanelRow`,
     `splitRule`, `center`, `persistentBg`, `sgr`). Likely the actual
     dependency to pull in, rather than reimplementing command-palette's
     bespoke functions.
  3. `src/sumo-tui/cathedral/sidebar-rendering.ts` — `sectionLabel()`
     (~L76-81, glyph + letter-spacing), `renderMcpServerRow`'s colored status
     dot (~L177), `mcpStatusColor` (~L157-169) — the reference for a
     per-row current-selection/state marker.
- **The mandated foundation**: `src/sumo-tui/render/primitives.ts`
  `renderBox`/`padLine`/`renderRule`/`span`/`textLine` (~L164-199) already
  implement borders, backgrounds, and rules generically — build on these
  instead of hand-rolling more ANSI.

## Scope

**In scope**: `src/sumo-tui/rpc/inline-selector.ts` (+ test), the eight
`host-actions.ts` call sites (add `description`/current-value data only — not
their command logic), colocated styling assertions.

**Out of scope**: pi-tui's `SelectList` internals (bypass/wrap, don't patch
the dependency); the command palette itself (reference only, don't touch);
`035`'s command-family logic; fuzzy search-as-you-type (not in the audit's
punch-list; a possible future item, not this plan).

## Steps (punch-list, priority order from the audit)

1. **P0 — Panel background + border.** Rebuild `InlineSelectorComponent.render()`
   on `primitives.ts`'s `renderBox`/`padLine` (or `scriptorium-chrome.ts`'s
   `persistentBg`/`panelRow` if that composes better with the editor-region
   Yoga leaf sizing) instead of raw ANSI. This satisfies AGENTS.md's
   "no hand-rolled ANSI on Cathedral surfaces" rule as a side effect — treat
   that as done here, not a separate cleanup item. Test: rendered frame
   contains the panel background SGR on every row, not just the title.
2. **P0 — Cathedral focus glyph + dim unfocused rows.** Bypass
   `SelectList.renderItem`'s hard-coded `"→ "`/`"  "` — hand-render rows in
   `InlineSelectorComponent` the way `renderCommandPalette` does (full control,
   consistent with `primitives.ts`'s "own the render" model): `❈` + accent on
   the focused row, `·` + `dim()` on the rest. Test: focused row uses the
   Cathedral glyph, not `→`; unfocused rows carry a dim SGR, not raw text.
3. **P1 — Header treatment.** Centered, accent-colored title with the
   codebase's ornamental glyph convention (see command-palette's `✾ … ✾`) and
   a rule divider beneath, replacing the current left-aligned dim string.
4. **P1 — Footer hint row.** `↑↓ choose  ⏎ select  ⎋ cancel` in the project's
   established voice (model on `COMMAND_PALETTE_HINT_ROW`), appended after
   the list.
5. **P1 — Description / current-value column.** Thread a `description`
   (or right-aligned current-value) into `SelectItem` construction at each of
   the 8 `host-actions.ts` call sites — `/model` shows the active model,
   `/thinking` the active level, `/theme` the active theme, etc. `SelectList`
   already lays this out; only the call sites need the data.
6. **P2 — Current-selection marker distinct from hover.** A small accent dot
   or `(current)` tag on whichever option matches the live value, independent
   of cursor position — mirrors `sidebar-rendering.ts`'s colored-dot pattern.
7. **P2 — Theme the scroll-overflow indicator** once P0's panel wrapper
   exists, so pi-tui's generic `(N/M)` text picks up the panel background and
   an explicit `foregroundDim` color rather than an unstyled default.
8. **P3 — Styling regression tests.** Extend `inline-selector.test.ts` beyond
   plain-substring assertions: at least one test per punch-list item
   asserting the actual SGR/background/glyph is present in the rendered
   frame (e.g. `rows[0]).toContain("[48;2;")` for the panel background).
   This closes the coverage gap the audit flagged — right now nothing would
   notice if the styling regressed.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm vitest run src/sumo-tui/rpc/inline-selector.test.ts src/sumo-tui/rpc/host-actions.test.ts` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual | `bin/sumocode.sh -d .` → `/model` | Cathedral-styled panel, not plain text |

## Done criteria

- [ ] `InlineSelectorComponent` builds on `primitives.ts` (or
  `scriptorium-chrome.ts`), zero hand-rolled `rgb()`/raw-ANSI helpers remain
  in `inline-selector.ts`
- [ ] Focused row uses the Cathedral `❈` glyph; unfocused rows are dimmed,
  not raw terminal-default text
- [ ] Title, rule dividers, footer hint row all present
- [ ] At least `/model`, `/thinking`, `/theme` show the currently-active
  value/description column
- [ ] Styling assertions exist in `inline-selector.test.ts` (not just
  substring checks)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0; `pnpm test:integration` exit 0
- [ ] Only in-scope files modified

## STOP conditions

- `SelectList`'s internals can't be bypassed for row rendering without
  forking pi-tui (report the API gap — don't vendor pi-tui code).
- The editor-region Yoga leaf sizing (measured from `render(width).length`)
  breaks when the selector grows taller with a border/footer — report the
  layout conflict rather than shrinking content to fit.
- Any verification fails twice.

## Maintenance notes

- Once this lands, a future selector command (035 Phase 2's `/trust` picker,
  say) should build on the same styled `InlineSelectorComponent` from day
  one — no more bare-`SelectList` surfaces.
- This is a candidate for the visual-parity harness once demoted-Bible work
  (032) resumes: a scenario capturing an open selector would guard this
  styling the way command-palette/approval-modal are already guarded.
