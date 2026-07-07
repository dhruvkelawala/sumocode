# Plan 039: Search-as-you-type in the in-place selector

> **Executor instructions**: Follow step by step, commit per sub-step.
> Base on the current `integrate/track-d` tip; commit to
> `feat/selector-search` and hand the reviewer the SHA.

## Status

- **Priority**: P1 (the styled selector from 037 is unusable at real scale —
  531 models, no way to narrow the list except scrolling)
- **Effort**: S
- **Depends on**: plan 037 (done — this extends `InlineSelectorComponent`)
- **Category**: bug / UX
- **Planned at**: `149f58c`, 2026-07-03
- **Source**: user screenshot (`/model` with 531 entries, unfiltered scroll,
  `(119/531)` position indicator) + direct code investigation this session

## Why this matters

Plan 037 correctly gave the selector Cathedral styling, but its report says
it "fully stopped using pi-tui's `SelectList` for rendering... not just its
theme hooks" and reimplemented "selection/scroll-window math" — but never
mentioned filtering, and a grep confirms it: `grep -n "search\|filter\|query" src/sumo-tui/rpc/inline-selector.ts`
returns nothing. With `/model` listing 531 entries (verified from the
screenshot: `(119/531)`), the only way to reach most of them is scrolling
one-by-one — Pi's real model picker supports type-to-search.

The fix is small because the exact working pattern already exists in this
codebase: `src/command-palette.ts` implements search-as-you-type today
(`searchQuery` state, `filterPaletteRows`, backspace/append handling in its
own `handleInput` ~L204-207, the `❯ what shall we attend to…` prompt row
~L143). Confirmed `SelectList` itself never auto-filters — its `handleInput`
(`node_modules/@earendil-works/pi-tui/dist/components/select-list.js:64-88`)
only handles up/down/confirm/cancel; a caller must call `.setFilter(query)`
externally as the user types, exactly the shape `command-palette.ts` already
does against its own row list. `InlineSelectorComponent` (rewritten by 037 to
bypass `SelectList`'s rendering, but reusing its filter-then-render data
shape) needs the same search-input-row + filter-as-you-type mechanism added.

## Current state

- `src/sumo-tui/rpc/inline-selector.ts` (post-037): `InlineSelectorComponent`
  hand-renders rows (Cathedral panel/glyphs/header/footer from plan 037) and
  reimplements selection/scroll-window math to match `SelectList`'s
  algorithm — but has no search/filter state, so all `SelectItem`s are always
  shown, scroll-only.
- Reference pattern already in this codebase, `src/command-palette.ts`:
  - `searchQuery: string` in the snapshot (~L16).
  - `filterPaletteRows(rows, searchQuery)` (~L119-131) — the filter function
    itself (case-insensitive substring/fuzzy match over row content).
  - A visible search row rendered above the list (~L134,143): shows the
    typed query, or a dim placeholder (`"what shall we attend to…"`) when
    empty.
  - `handleInput` (~L204-207): backspace pops the last char and resets
    `activeIndex` to 0; any other printable char appends to `searchQuery` and
    resets `activeIndex` to 0.
- `pi-tui`'s `fuzzyFilter` (already imported elsewhere in this tree, per
  plan 035's `/fork` polish note) is available if substring matching isn't
  fuzzy enough for 531-entry model lists — consider it for better ranking on
  partial/out-of-order typed queries (e.g. typing "seed16" should still find
  "bytedance-seed/seed-1.6").

## Scope

**In scope**: `src/sumo-tui/rpc/inline-selector.ts` (+ test) — add search
state, a filter function, a rendered search row, and input handling for
typed characters/backspace. `src/sumo-tui/rpc/host-actions.ts` only if a call
site needs to pass per-item searchable text beyond the label (e.g. including
provider name so "openrouter" narrows correctly).

**Out of scope**: `command-palette.ts` itself (reference only, don't
modify); `SelectList`'s internals (already correctly bypassed by 037, stays
bypassed); the styling/glyphs/header/footer 037 added (preserve them —
this plan only adds the search row + filter, not a redesign).

## Steps

1. **Add search state** to `InlineSelectorComponent`: a `query: string`
   field, reset to `""` when the selector opens for a new list.
2. **Filter function**: filter the item list by `query` before computing the
   scroll window/selection. Case-insensitive substring match as the
   baseline (matching `filterPaletteRows`'s approach); if it doesn't feel
   good against real model names (verify manually with a long list fixture),
   swap to `fuzzyFilter` — justify the choice in the report either way.
   Reset selection to index 0 whenever the filtered set changes (matches
   `SelectList.setFilter`'s own behavior at select-list.js:25-30).
3. **Render a search row** above the list, following the palette's pattern:
   typed query in normal text, or a dim placeholder when empty (e.g.
   "type to search…"), using the same accent `❯`-style prompt glyph
   convention 037 established for this surface — reuse `wrapPanelRow`/the
   Cathedral helpers already in `inline-selector.ts` post-037, don't
   reintroduce raw ANSI.
4. **Wire input handling**: in whatever now receives raw `handleInput` calls
   for the selector, printable characters append to `query` (reset selection
   index), backspace pops the last character (reset selection index),
   up/down/enter/escape keep their existing (post-037) behavior operating on
   the FILTERED list, not the full list.
5. **No-match state**: when the filtered list is empty, render a clear
   "no matches" row instead of an empty panel (mirrors `SelectList`'s own
   `filteredItems.length === 0` handling, select-list.js:38-44).
6. **Preserve the current-value marker (037's `●`)**: it should still mark
   the active item if it survives filtering; don't break that feature.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm vitest run src/sumo-tui/rpc/inline-selector.test.ts src/sumo-tui/rpc/host-actions.test.ts` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual | `bin/sumocode.sh -d .` → `/model`, type a few letters | list narrows live |

## Done criteria

- [ ] Typing narrows the visible list in real time; backspace widens it back
- [ ] Selection/scroll operate on the filtered set, not the full list
- [ ] Empty-query state shows the full list with a dim search-prompt hint
  (matching the palette's placeholder pattern)
- [ ] No-match state renders a clear message, not a blank panel
- [ ] The 037 styling (panel, glyphs, header, footer, current-value marker)
  is unchanged in appearance for the non-search parts
- [ ] Test with a 500+ item fixture list confirms filtering + scroll-window
  math stay correct together (not just each in isolation)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0; `pnpm test:integration` exit 0
- [ ] Only in-scope files modified

## STOP conditions

- Wiring raw keystrokes into the selector conflicts with how 037's
  `InlineSelectorHost` currently routes input to the active surface (report
  the conflict — don't fork a second input path).
- Any verification fails twice.

## Maintenance notes

- If `/fork`'s planned fuzzy-filter polish (plan 035, item 13) lands
  separately, make sure both converge on the same filter approach
  (`fuzzyFilter` vs substring) rather than the codebase ending up with two
  different search behaviors across selector commands.
