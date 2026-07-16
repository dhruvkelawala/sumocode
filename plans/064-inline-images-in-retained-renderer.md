# Plan 064: Inline terminal images in the retained renderer (Kitty/iTerm2 passthrough)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat HEAD -- src/sumo-tui/shell/retained-shell-renderer.ts src/sumo-tui/render/ src/sumo-tui/widgets/chat-message.ts src/sumo-tui/widgets/chat-pager.ts src/sumo-tui/rpc/host.ts src/sumo-tui/transcript/view-model.ts`
> Compare the "Current state" excerpts against live code before proceeding;
> on a mismatch treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: nothing hard; coordinate with any renderer perf plans in flight
- **Category**: feature / renderer
- **Planned at**: 2026-07-08, after the Tier-1 image-chip fix

## Why this matters

Pi's interactive mode renders images (Read tool results on PNGs, screenshots
pasted for review) as real pixels via the Kitty graphics protocol or iTerm2
inline images. SumoCode's RPC host cannot: the retained `CellBuffer` renderer
diffs styled character cells and writes row patches — graphics escape
sequences are not cell content and get stripped (verified empirically at this
plan's writing: with `images: "kitty"` forced, pi-tui's `Image` component
reserves N blank rows and the APC payload never reaches
`terminal.writeFramePatches`). Users see either a blank hole (capabilities
auto-detected) or, after the Tier-1 fix, a `[Image: …]` fallback chip.

Feature parity with pi's chat is a stated product goal; screenshots-in-chat
is a high-visibility gap.

## Current state (as of this plan's writing)

- `src/sumo-tui/rpc/host.ts` (`runRpcHost`, top): pins
  `setCapabilities({ ...getCapabilities(), images: null })` with a comment
  pointing at this plan. This is the switch that Tier 2 flips back.
- `src/sumo-tui/widgets/chat-message.ts` `renderImageRows`: already builds a
  pi-tui `Image` component per image block with `fallbackColor`; when
  capabilities allow it emits an image line (first row = whole escape
  sequence, subsequent rows blank), when not it emits the `[Image: …]` chip.
- `src/sumo-tui/transcript/view-model.ts`: image blocks flow from message
  content parts AND tool results (`imageBlocksFromContent`, added in the
  Tier-1 fix). Data + mime + filename are on the `image` ChatBlock.
- `src/sumo-tui/shell/retained-shell-renderer.ts`: `render()` composes a
  `CellBuffer`, diffs against the previous frame (`diffRowSpan` etc.), and
  writes patches through `terminal.writeFramePatches`. No escape-sequence
  passthrough of any kind. `compositeOverlays` paints overlay rows into the
  same buffer.
- pi-tui public exports available: `Image`, `renderImage`, `isImageLine`,
  `encodeKitty`, `deleteKittyImage`, `deleteAllKittyImages`,
  `getCellDimensions`, `calculateImageCellSize`, `detectCapabilities`,
  `getCapabilities`, `setCapabilities` (see
  `@earendil-works/pi-tui/dist/terminal-image.d.ts`).

## Design

Do NOT try to store escape sequences in cells. Add a **graphics pass** that
runs after cell patches:

1. **Placement collection.** Chat rows that represent an image carry a
   placement marker instead of the raw sequence. Extend the image block
   render path (`renderImageRows`) to emit a sentinel row (e.g. a private-use
   marker string or a side-channel registration on the pager) plus N-1
   reserved blank rows, where N comes from `calculateImageCellSize`. The
   pager/renderer resolves each sentinel to `{ imageId, base64, cols, rows,
   viewportRow, viewportCol }` during composition.
2. **Graphics emission.** After `writeFramePatches`, emit for each visible
   placement: cursor save → move to placement cell → Kitty `encodeKitty`
   (with stable `imageId` per block, `moveCursor: false`) → cursor restore.
   Track live placements; when a placement leaves the viewport (scroll,
   collapse, session switch, modal covering it is fine — Kitty draws under
   text? it does NOT; see risks) emit `deleteKittyImage(imageId)`.
3. **Clipping rule.** Kitty cannot clip an image to a partial row range.
   If the placement's row span is not fully inside the chat viewport, do not
   draw it — render the fallback chip row instead ("image scrolled; fully
   visible only"). This is the pragmatic v1; unicode-placeholder mode
   (U+10EEEE grid) is the eventual full answer and is explicitly out of
   scope here.
4. **Capability gate.** Replace the `images: null` pin in `runRpcHost` with
   real detection (`detectCapabilities()`), but keep a
   `SUMOCODE_NO_INLINE_IMAGES=1` escape hatch env var. tmux passthrough is
   out of scope (detect and fall back).
5. **Overlays above images.** When any overlay/modal intersects a placement,
   delete the image for the duration (text does not reliably render over
   Kitty images across terminals). Simplest correct rule: any active overlay
   → delete all placements for that frame; re-emit when overlays clear.
6. **iTerm2**: only if cheap — iTerm2 protocol lacks IDs/deletion, so v1 may
   be Kitty-only (Ghostty, Kitty, WezTerm cover the user base; cmux is
   Ghostty-based).

## Steps

1. Characterization: reproduce the stripped-APC behavior in a test
   (`retained-shell-renderer.test.ts`) so the passthrough has a red test.
2. Implement placement registry + sentinel emission in `renderImageRows` /
   chat pager (careful: pager virtualizes to 200 messages; placements must
   invalidate on virtualization).
3. Implement the post-patch graphics pass in `retained-shell-renderer.ts`
   behind the capability gate, with imageId lifecycle (allocate once per
   block, delete on hide/dispose/session-switch/reload).
4. Flip the `runRpcHost` pin to detection + env escape hatch.
5. Tests: placement math (full visibility rule), lifecycle (delete on
   scroll-out, re-emit on scroll-in), overlay suppression, capability-off
   fallback unchanged (Tier-1 chip tests keep passing).
6. Manual verification matrix: Ghostty/cmux, Kitty, iTerm2 (fallback),
   Terminal.app (fallback), narrow portrait pane, `/sumo:reload` mid-image,
   session switch, scroll during stream with an image on screen.

## Verification

- `npx vitest run src/sumo-tui/` green.
- `npm run typecheck` green.
- Manual: `sumocode` in cmux → ask the agent to Read a PNG → pixels render
  in the tool card; scroll it off and back; open the command palette over
  it; `/new`; `/sumo:reload`. No ghost images, no blank holes, no garbled
  frames.
- Visual parity suite (`npm run visual:ci`) unaffected (captures run with
  capabilities off).

## STOP conditions

- If `writeFramePatches`'s contract can't accommodate an ordered post-patch
  write (e.g. patches are batched/reordered downstream), STOP and report —
  the terminal writer needs a design change first.
- If Ghostty/cmux does not honor `deleteKittyImage` by ID (ghost images
  persist), STOP and document; the lifecycle design needs rework.
- If chat-pager virtualization makes stable per-block imageIds impossible
  without a larger refactor, STOP and propose the refactor separately.

## Out of scope

- Kitty unicode-placeholder (U+10EEEE) rendering.
- tmux graphics passthrough.
- Rendering images inside user-message cards for pasted paths (the token
  expands to a path; the agent Reads it — the tool card is where pixels
  appear, matching pi).
- Sixel.
