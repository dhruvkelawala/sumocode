# SumoTUI Portrait Sidebar Policy

**Status:** accepted V1 policy for P0-F / #104  
**Date:** 2026-04-29  
**Parent:** #98 SumoTUI consolidation  
**Blocks/resumes:** #87 active portrait scene composition  
**Related:** `docs/SUMO_TUI_CONSOLIDATION_PLAN.md`, `docs/ui/CATHEDRAL_UX_SPEC_V2.md`, `docs/visual/parity/CONTRACT.md`

## Decision

Ship **Option A** for V1: hide the sidebar in portrait/narrow layouts and let the footer + hint row absorb essential context.

Portrait richness is explicitly **V2/later**. Do not build a bottom registry band or command-toggled portrait overlay before #87 resumes.

In practice:

- The canonical portrait runtime size is `60 × 100`.
- The V2 editorial sidebar remains a `30`-column landscape/wide-layout component.
- The sidebar is visible only when the runtime policy says the wide layout is available: currently `W >= 120`, the session has messages, and the user has not hidden it.
- Portrait and other narrow layouts are chat-first, full-width surfaces.
- Project/branch/context hints move to the hint row/footer when the sidebar is hidden.
- `/sumo:memory`, command palette entries, and future shortcuts remain the access path for rich registry detail while portrait is collapsed.

## Options evaluated

| Option | Decision | Notes |
| --- | --- | --- |
| A — hide sidebar in portrait; footer/hint absorbs context | **Accept for V1** | Matches current runtime behavior, current Bible portrait scene, and the existing `W < 120` sidebar visibility rule. Lowest seam risk during hybrid Pi/SumoTUI consolidation. |
| B — bottom registry band in portrait | Defer to V2/later | Visually attractive for Mac mini portrait, but introduces a new composed surface, new height budgeting, new crop policy, and likely new scroll/input edge cases before the root renderer is fully consolidated. |
| C — command-toggled overlay only | Defer to V2/later | Useful as a future optional affordance, but overlay focus/capture behavior is currently one of the fragile Pi/SumoTUI seams. It should not block #87. |

## Rationale

The deep audit concluded that the risk is not SumoTUI itself; it is the hybrid phase where Pi still owns parts of terminal/layout flow while SumoTUI owns retained runtime pieces. Portrait-specific registry surfaces would expand that seam at exactly the point where #87 needs a stable, reviewable target.

Choosing Option A keeps the portrait target simple:

```txt
portrait = top bar + full-width chat + input + hint row + footer
```

That lets #87 validate portrait fundamentals:

- no 40/60-column crash
- no rendered line wider than terminal width
- no sidebar overlap/smear
- footer and input stay pinned
- chat wraps at full terminal width
- Cathedral breathing rows remain intact

## V1 contract

### Visibility

Sidebar is hidden when any of these is true:

1. Splash/zero-message state.
2. Terminal width is below `SIDEBAR_MIN_TERMINAL_WIDTH` (`120`).
3. The user has explicitly hidden it through the sidebar command path once that command is implemented.
4. The runtime has no session messages to contextualize.

Portrait is not detected by aspect ratio for V1 sidebar visibility; width is the hard rule. A very wide portrait terminal can still use the wide sidebar if `W >= 120`.

### Layout

When hidden, the sidebar reserves **no columns**. Chat, tool output, and the input frame use the full terminal width.

For the canonical `60 × 100` portrait scene:

- chat wraps to full width minus its own internal padding
- no right sidebar crop exists
- the hint row carries project/branch context when available
- the footer right zone remains context window + session cost, not project/branch duplication

### Visual harness

`active-portrait-runtime` remains a no-sidebar scene. It should not add a sidebar crop or bottom-registry crop in V1.

Future V2 portrait richness must get its own issue, Bible target, scenario manifest update, and human visual approval before becoming required.

## Deferred V2 follow-ups

Open a new issue before implementing either deferred option:

- bottom registry band for portrait
- command-toggled registry overlay for portrait
- portrait-specific registry crop/golden promotion
- keyboard/focus policy for any portrait overlay

Do not implement these inside #87. #87 should resume with the Option A no-sidebar portrait contract.
