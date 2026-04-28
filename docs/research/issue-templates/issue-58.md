## Cathedral background not painted behind chat text + cursor wrong color

User screenshot from cmux/Ghostty on MacBook shows:

1. **Sidebar has cathedral surface bg painted** — the panel column shows `surface` (#241D17) tinted background distinct from main bg.
2. **Chat region has NO cathedral bg painted** — empty cells show terminal default (raw black `#000000`), NOT cathedral `bg` (#1A1511).
3. **Cursor is magenta/pink** — terminal default cursor color, NOT cathedral accent (#D97706).
4. **Token meter shows >100% (`3.2M/1.0M`)** — bar should turn terracotta when over budget; currently still shows accent.

The visual delta between sidebar (filled with surface) and chat (raw terminal default) makes the layout look broken/incomplete. Per UX_SPEC §2 token mapping, the entire viewport in altscreen should be painted with cathedral `bg`.

## Three fixes

### 1. Fill entire viewport with cathedral `bg` color

Currently `Compositor.composite()` walks the Yoga tree and paints cells where widgets exist. Cells outside any widget = unpainted = terminal-default bg.

Fix: before painting widgets, **fill the entire cell buffer with `{ char: ' ', fg: foreground, bg: bg }`**. Then widgets paint on top.

In `src/sumo-tui/render/buffer.ts`:
- Add `setDefaultBackground(hex: string)` method
- `clear()` paints every cell with the default bg

In `src/sumo-tui/render/compositor.ts`:
- Before walking the tree, call `buffer.clear()` with cathedral `bg`

In `src/sumo-tui/render/ansi-writer.ts`:
- Emit `\x1b[48;2;26;21;17m` (cathedral bg) for cells with that bg; ensure no cells emit "no bg" (empty bg) which would let terminal default show through

### 2. Set cursor color via OSC to cathedral accent

In `src/sumo-tui/runtime/terminal-controller.ts`:
- `enterAltscreen()` → also emit `\x1b]12;#D97706\x1b\\` (OSC 12 set cursor color)
- `exitTerminal()` → also emit `\x1b]112\x1b\\` (OSC 112 reset cursor color)

This makes the cursor cathedral accent everywhere it shows (input box, command palette, modals).

### 3. Token meter color when over 100%

In `src/sumo-tui/cathedral/sidebar-tree.ts` token bar:
- < 50% → state.idle (sage)
- 50-80% → state.thinking (amber)
- 80-100% → accent
- **>100% → state.approval (terracotta)** — NEW threshold

When over budget, also show `OVER` label or `+N%` indicator.

### 4. Surface differentiation (visual hierarchy)

Per UX_SPEC §2 + DESIGN.md:
- main bg: `#1A1511` (chat region)
- sidebar surface: `#241D17` (slightly elevated)
- input frame inner: `#120D0A` (recessed)
- modals: `#3A342F` (lifted)

Verify the compositor respects these tier values. Sidebar should look subtly elevated; chat should be the base bg; input frame should look slightly recessed.

## Acceptance criteria

- [ ] Chat region fills with cathedral `bg` (#1A1511) — visible in cmux/Ghostty screenshot
- [ ] Cursor renders cathedral accent orange (NOT terminal-default magenta)
- [ ] Token meter shows terracotta when usage > 100% of budget
- [ ] Sidebar surface tinted distinct from chat bg (verify both visually + in code)
- [ ] All 366 unit + 14 integration tests still pass
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] VHS screenshot of full session shows cathedral bg painted everywhere
- [ ] Manual verification on user's cmux/Ghostty session
- [ ] PR opened with `Closes #58`

## Constraints

- Worktree: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58/` (create from main at `e300299`)
- Don't push to main directly
- Git identity: `dhruvrk2000@gmail.com`
- Time-box: 1 working day

## References

- `src/sumo-tui/render/buffer.ts` — cell buffer + paint logic
- `src/sumo-tui/render/compositor.ts` — tree walk + painting
- `src/sumo-tui/render/ansi-writer.ts` — ANSI emission
- `src/sumo-tui/runtime/terminal-controller.ts` — altscreen + mode escapes
- `src/tokens.ts` — cathedral palette
- `docs/ui/CATHEDRAL_UX_SPEC.md` §2 (token mapping)
- `docs/ui/DESIGN.md` — surface hierarchy
- User screenshot: cmux/Ghostty on MacBook showing the bg gap
