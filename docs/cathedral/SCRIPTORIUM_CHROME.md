# Scriptorium Chrome — shared modal painting contract

`src/cathedral/scriptorium-chrome.ts` is the single source of truth for the
painting vocabulary used by every Cathedral overlay modal:

| Modal | File | Bible source |
|---|---|---|
| Divine Query (Element 11) | `src/divine-query.ts` | `docs/ui/bible/11-divine-query-*.html` |
| Approval Required (Element 6) | `src/approval-modal.ts` | (V2 spec §6) |
| Memory Scriptorium (Element 7) | `src/memory-editor.ts` | `docs/ui/bible/07-memory-editor*.html`, `scene-memory-scriptorium-overlay.html` |

Pi's overlay host already provides the surrounding chrome (centered box, focus
capture, escape routing). Modals are intentionally unframed at the outer edge
— the lifted background painted through every cell is the visual frame.

## When to add a new modal

1. Read the V2 Bible HTML for the element you are implementing.
2. Compose the modal using the helpers below — never hand-roll
   `\u001b[38;2;...m` escapes for cells inside the panel; that breaks the
   lifted-bg contract.
3. Render the modal as a flat list of inner lines.
4. Wrap each inner line through `wrapPanelRow(line, width)` so the lifted
   background paints through every cell at full content width.
5. Mount through Pi's overlay system (`ctx.ui.custom(..., { overlay: true,
   overlayOptions: { anchor: "center", ... } })`).

## Helpers

### Painting

```ts
fg(text, hex)
//   foreground colour (24-bit). Use for any text that does NOT need a
//   persistent background.

persistentBg(text, fgHex, bgHex)
//   Re-applies fg+bg after every embedded `\x1b[0m` reset so a nested
//   sub-style does not snap back to the underlying scene's background.
//   Use this for `wrapPanelRow` and any inner sub-frame that has its own
//   background (e.g. the approval modal's command box).

wrapPanelRow(line, width)
//   Pads `line` to `width` and paints `foreground` over `surfaceLifted` for
//   every cell. Always the LAST step before pushing into the modal output.

sgr(hex, mode)
//   Low-level: build a single SGR opener for `38` (fg) or `48` (bg). Useful
//   for one-shot composite labels (e.g. inverse-button styling) where
//   `persistentBg`'s reset-restore behaviour is unwanted.

RESET
//   Re-exported `\x1b[0m`. Use sparingly; prefer the higher-level helpers.
```

### Layout

```ts
visibleLength(text)
fitLine(line, width)
padRight(line, width)
center(line, width)
```

All of these strip ANSI before measuring. `fitLine` truncates with `\u2026`
when `line` exceeds `width`. None of them paint colour.

### Cathedral conventions

```ts
splitRule(width)
//   `\u2500\u2500\u2500\u2500\u2500  \u00b7  \u2500\u2500\u2500\u2500\u2500` divider centered to `width`, painted with the
//   active theme's `divider` colour.

titleRow(text, width)
//   `\u273e  TEXT  \u273e` centered, painted with `accent` colour. The floral
//   marks are `TITLE_FLOWER` and use the active theme's `accent`.

focusMarker(focused)
//   `\u2748` (accent) when focused, `\u00b7` (divider) when not.

TITLE_FLOWER · FOCUSED_MARK · UNFOCUSED_MARK
//   Constants if you need the raw glyphs (e.g. for visual diff fixtures).
```

## Render-order recipe

Every Cathedral modal builds its output the same way:

```ts
function renderModal(snapshot, width) {
    const inner: string[] = [];
    inner.push("");                          // top breathing row
    inner.push(titleRow("MY MODAL", width)); // floral title
    inner.push("");
    inner.push(splitRule(width));            // upper divider
    inner.push("");
    // ...modal-specific body rows here, using fg() for any colour...
    inner.push("");
    inner.push(splitRule(width));            // lower divider
    inner.push(center(fg("\u2191\u2193 wander    \u23ce confirm    \u23c4 retreat",
                         activeThemeColors().foregroundDim), width));
    inner.push("");                          // bottom breathing row
    return inner.map(line => wrapPanelRow(line, width)); // lifted bg pass
}
```

The final `.map(line => wrapPanelRow(line, width))` is the part that often
gets forgotten and produces the "broken modal" symptom: text floats over the
underlying chat scene because every cell's background is whatever was beneath
the overlay rather than `surfaceLifted`.

## State machine + Pi component

Each modal exposes:

- a pure `update<Snapshot>(snapshot, key)` reducer for input handling
- a tiny `Component` that owns the snapshot, calls the reducer, and routes
  `done(result)` back to the caller of `ctx.ui.custom()`

Keep the reducer pure so it can be unit-tested without spawning Pi's TUI.
The component should be the only impure layer (calls `notify`, schedules
render via `tui.requestRender()`, etc.).

## Don't

- Don't hand-roll `\u001b[38;2;...m` escapes inside modal bodies. Use `fg()`.
- Don't reach into Pi's terminal controller from inside a modal. Schedule
  render through `tui.requestRender()` so the overlay host stays in charge.
- Don't add a second outer frame (`\u256d\u2500...\u256e`) inside the modal.
  Pi's overlay box is the frame. Inner sub-frames (like the approval modal's
  command box, or the Scriptorium's panel cards) are fine; the OUTER edge
  belongs to Pi.
- Don't bake colours from `tokens.ts`. Always read from
  `activeThemeColors()` so theme switches re-render correctly.
- Don't skip `wrapPanelRow` on any row. Even blank rows must be padded +
  painted, otherwise the lifted background "steps" mid-modal.

## Adding a helper

If a new modal needs a primitive that two modals would share, add it to
`scriptorium-chrome.ts` rather than duplicating it in the modal file. The
goal is that `divine-query.ts`, `approval-modal.ts`, and `memory-editor.ts`
contain only modal-specific composition — never bg-painting plumbing.
