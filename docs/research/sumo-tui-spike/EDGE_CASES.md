# Sumo-Tui Edge Cases Catalog

Comprehensive enumeration of edge cases we'll hit building sumo-tui.
Organized by subsystem, each entry has: **Description**, **Phase** (when it
will hit us), **Mitigation**, **Test**.

---

## 1. Cursor positioning (PiEditorLeaf)

### 1.1 CURSOR_MARKER offset under Yoga layout
- **Description**: Pi emits `\x1b_pi:c\x07` at the cursor position. pi-tui scans for it and computes hardware cursor at `(row, visibleWidth(beforeMarker))`. When the editor is a leaf inside a flex box, the leaf's origin is `(box.top, box.left)` per Yoga; cursor must be remapped by adding the box origin.
- **Phase**: 2 (compositor MVP).
- **Mitigation**: `pi-editor-leaf.ts` re-scans rendered rows for CURSOR_MARKER, computes `(leaf_row, leaf_col)`, then the compositor adds the leaf's Yoga-computed `(top, left)` to produce frame coordinates.
- **Test**: unit — CURSOR_MARKER at known position inside a leaf with known origin produces expected frame coordinates. Integration — type characters, screenshot the cursor location.

### 1.2 Editor row count varies (1-N rows)
- **Description**: Pi's editor can be 1 row (single line, no autocomplete), or N+5 rows (multi-line text + autocomplete dropdown). Yoga must respect this dynamic height.
- **Phase**: 2.
- **Mitigation**: PiEditorLeaf exposes a `measureFunc` that calls `super.render(width)` and returns `lines.length`. Yoga calls measureFunc when it needs a flex node's intrinsic height.
- **Test**: unit — empty editor returns 1 row, multi-line returns 3 rows, with autocomplete returns 6 rows.

### 1.3 Cursor in scrolled-off content
- **Description**: Pi's editor can scroll within itself (`─── ↑ N more ───`). The CURSOR_MARKER might be in a row that's hidden in Pi's editor's own scroll offset.
- **Phase**: 2.
- **Mitigation**: Pi's editor only emits CURSOR_MARKER on visible rows. Trust super.render output as authoritative.
- **Test**: unit — paste 100 lines, cursor on line 50, marker should be on visible row reflecting Pi's scroll offset.

### 1.4 Cursor on wide character (CJK, emoji)
- **Description**: A wide char counts as 2 cells visually but 1 grapheme. visibleWidth must use Pi's `visibleWidth()` not `String.length`.
- **Phase**: 2.
- **Mitigation**: Reuse Pi's `visibleWidth` from `@mariozechner/pi-tui/utils`. Don't reimplement.
- **Test**: unit — input "日本" with cursor after "日", visibleWidth = 2, cursor lands at column 2.

### 1.5 Cursor in IME pre-edit
- **Description**: IME pre-edit string shows underlined chars before commit. Pi handles this; we must not break it by re-scanning.
- **Phase**: 2.
- **Mitigation**: Don't strip ANSI from Pi's row output — IME uses underline `\x1b[4m`. Just find the cursor marker and pass through.
- **Test**: manual on macOS Japanese IME (no CI for this).

### 1.6 Fallback to Option B
- **Description**: If CURSOR_MARKER remap proves unreliable (multi-line + autocomplete + IME interactions cause drift > 1 frame per input), fall back to a sumo-tui native textarea (Q1 fallback path).
- **Phase**: 2-3 if needed.
- **Mitigation**: Build the editor leaf behind a feature flag `SUMO_TUI_EDITOR=pi|native`. Default `pi`. If problems persist, switch to `native` (lose autocomplete, regress).
- **Test**: integration — run a 30-character typing test with autocomplete, measure how many frames the cursor is wrong.

---

## 2. Streaming / race conditions

### 2.1 Sub-frame chunk arrival
- **Description**: LLM emits 50-100 chunks/sec. Chunk → state update → render request. Naive: 50 renders/sec.
- **Phase**: 3 (ChatPager).
- **Mitigation**: Q3:D — adaptive frame scheduler. Coalesce render requests within 16ms when streaming, idle event-driven otherwise. Pi's `requestRender()` already debounces; we extend.
- **Test**: integration — feed 100 fake chunks in 1s, count actual frames written. Should be ~60.

### 2.2 Mid-render state mutation
- **Description**: A chunk arrives while we're walking the Yoga tree to compute layout. State changes mid-frame.
- **Phase**: 3.
- **Mitigation**: Snapshot state at frame start. Render against snapshot. New mutations queue for next frame.
- **Test**: unit — render starts at t=0, mutation at t=5ms, render finishes at t=10ms — final frame must reflect t=0 state, not t=5ms.

### 2.3 Tool-call result arrives during typing
- **Description**: User typing input. Tool result arrives, chat updates, scrollbox sticky-bottom kicks in. User's cursor jumps.
- **Phase**: 3.
- **Mitigation**: Editor leaf's row position is fixed by Yoga (flex layout). Scrollbox content scrolls behind it. Cursor frame position recalculates each render but its leaf origin doesn't move.
- **Test**: integration — type 5 chars, fire a fake tool result, verify cursor still at end of typed text.

### 2.4 Backpressure on slow terminal
- **Description**: User on flaky SSH. Stdout writes block. Render queue fills. Memory grows.
- **Phase**: 3.
- **Mitigation**: Drop-the-oldest queue with max depth 3. If queue > 3, drop the oldest pending render. Always render the latest.
- **Test**: unit — fill queue with 10 renders, verify only latest 3 retained.

### 2.5 Streaming + scroll-up interaction
- **Description**: User scrolled up to read history. New chunk arrives. Should NOT auto-snap to bottom.
- **Phase**: 3.
- **Mitigation**: Track `manualScroll` flag (OpenCode pattern). If user scrolled away from bottom, sticky-bottom is disabled until they scroll back.
- **Test**: integration — scroll up 5 lines, fire 10 chunks, verify viewport stays put.

---

## 3. Resize

### 3.1 SIGWINCH during render
- **Description**: User resizes terminal mid-render. Yoga tree must invalidate.
- **Phase**: 1-2.
- **Mitigation**: `process.stdout.on('resize')` triggers Yoga `markDirty()`. Wait for current render to finish, then schedule new.
- **Test**: unit — fire resize event mid-render, verify next frame uses new dimensions.

### 3.2 Resize below minimum width
- **Description**: User shrinks terminal to 40 cols. Sidebar (49 cols) doesn't fit.
- **Phase**: 5 (cathedral parity).
- **Mitigation**: Adaptive sidebar (OpenCode `routes/session/index.tsx:1209-1226`). Width >= 120: dock. < 120: overlay with backdrop.
- **Test**: VHS tape — render at 80 cols, verify sidebar overlays not docks.

### 3.3 Resize during autocomplete dropdown
- **Description**: Autocomplete has computed positions based on old width. Resize shifts everything.
- **Phase**: 4 (interactive mode).
- **Mitigation**: Pi's autocomplete recomputes on render. Yoga reflows. Edge case is fine.
- **Test**: manual.

### 3.4 Vertical shrink below content
- **Description**: User shrinks terminal vertically. Chat content > viewport. Scrollbox kicks in.
- **Phase**: 3.
- **Mitigation**: ScrollBox with `flexGrow=1` consumes available height. Overflow scrolls. Sticky-bottom keeps newest visible.
- **Test**: VHS tape — render long chat at 30 rows, verify last message visible.

---

## 4. Theme switching

### 4.1 Mid-session theme change
- **Description**: User runs `/sumo:theme amber-crt`. All chrome must redraw with new tokens.
- **Phase**: 5.
- **Mitigation**: Theme tokens are reactive. On change, fire a `theme_changed` event, force-invalidate the Yoga tree's painted state, full repaint.
- **Test**: integration — switch theme, screenshot before/after, verify color values.

### 4.2 Cached frame buffers from old theme
- **Description**: ScrollBox caches rendered messages. Theme change must invalidate cache.
- **Phase**: 3-5.
- **Mitigation**: Cache keyed on `(content, themeVersion)`. Theme bump increments version, invalidates all entries.
- **Test**: unit — render message under theme A, switch to B, verify re-render not stale.

### 4.3 Theme load failure during boot
- **Description**: User's theme JSON is malformed. Boot would crash.
- **Phase**: 5.
- **Mitigation**: Validate theme on load. Fall back to `cathedral` default with warning notification.
- **Test**: unit — load malformed JSON, verify fallback triggered.

---

## 5. Crash recovery / signals

### 5.1 SIGINT during altscreen
- **Description**: Ctrl+C must restore terminal: kitty pop, modifyOtherKeys off, mouse off, altscreen exit, cursor show, SGR reset. In that order.
- **Phase**: 1.
- **Mitigation**: `terminal-controller.ts` registers signal handlers BEFORE Pi's. Our handler emits the cleanup sequence then re-raises the signal so Pi's own handler runs.
- **Test**: integration — spawn sumocode in pty, send SIGINT, verify terminal escape state via `stty -a` style probes.

### 5.2 SIGKILL (un-catchable)
- **Description**: OOM-killed or `kill -9`. Cleanup never runs.
- **Phase**: 1.
- **Mitigation**: We can't catch SIGKILL. Document that user can run `reset` to restore terminal. Also: `~/.sumocode/recover.sh` script generated on first run.
- **Test**: manual — `kill -9 $pi_pid`, verify recover script works.

### 5.3 uncaughtException mid-frame
- **Description**: Compositor throws. Terminal half-rendered. User stuck in altscreen with broken state.
- **Phase**: 1-2.
- **Mitigation**: Wrap compositor in try/catch. On error, emit cleanup, log to `~/.sumocode/crash.log`, re-throw so Node prints stack.
- **Test**: unit — inject error in compositor, verify cleanup ran before re-throw.

### 5.4 Process backgrounded (Ctrl+Z)
- **Description**: User suspends. We must release stdin raw mode. On resume (`fg`), we must re-enable.
- **Phase**: 1.
- **Mitigation**: Handle SIGTSTP — restore terminal state, then re-raise. Handle SIGCONT — re-enter altscreen + raw mode.
- **Test**: manual — Ctrl+Z, fg, verify rendering resumes correctly.

### 5.5 Terminal disconnect (SSH drop)
- **Description**: stdout broken pipe. Writes throw EPIPE.
- **Phase**: 1.
- **Mitigation**: Catch EPIPE on writes, exit cleanly with code 0. Don't try to re-write cleanup (pipe is already gone).
- **Test**: manual — `ssh remote sumocode`, drop connection mid-render, verify clean exit on remote.

---

## 6. Pi extension compatibility (deferred per Q2:C)

### 6.1 3rd-party extension calls setHeader
- **Description**: User has another Pi extension installed that calls `ctx.ui.setHeader(...)`. In v1 Phase 1-5 we don't support this.
- **Phase**: 5 (visible behavior); 7 (full support).
- **Mitigation**: Detect non-SumoCode extensions on session_start. Emit a one-shot warning notification. Their `setHeader` is a no-op. Track which extensions tried.
- **Test**: unit — install a fake 3rd-party ext, verify warning fires + no-op confirmed.

### 6.2 3rd-party extension calls setEditorComponent
- **Description**: A 3rd-party extension wants to replace the editor. We've already mounted PiEditorLeaf.
- **Phase**: 5.
- **Mitigation**: `setEditorComponent` from non-SumoCode extension is no-op + warning. SumoCode reserves the slot.
- **Test**: unit.

### 6.3 3rd-party extension uses pi-tui internals (e.g., `tui.children`)
- **Description**: opentui-island and opencode-pi-extension might access `tui.children` directly for advanced layouts.
- **Phase**: 7.
- **Mitigation**: Phase 7 builds a compat shim that exposes a Pi-tui-like Container view of our Yoga tree. Phase 1-5: just don't support this.
- **Test**: deferred to phase 7.

---

## 7. Image rendering in chat

### 7.1 Kitty image protocol passthrough
- **Description**: Pi can render PNG images via kitty graphics protocol. ANSI escapes leak through but multi-row.
- **Phase**: 3.
- **Mitigation**: ScrollBox content rows are opaque strings. Image escapes pass through unchanged. Just don't slice mid-escape.
- **Test**: integration — render a kitty-encoded image inside chat, verify visible in screenshot.

### 7.2 Image position after scroll
- **Description**: Kitty images are positioned by terminal at write time. If we scroll, the image stays where the terminal drew it (NOT where our content moves to).
- **Phase**: 3.
- **Mitigation**: Use kitty image IDs + `\x1b_Ga=d,d=I,i=N\x1b\\` to delete + redraw on scroll. Pi already does this in `terminal-image.js`.
- **Test**: integration — render image, scroll up, verify image is redrawn at correct row.

### 7.3 iTerm2 image protocol
- **Description**: iTerm2 uses different escape (`\x1b]1337;File=...`). Different positioning semantics.
- **Phase**: 3.
- **Mitigation**: Detect terminal capability via Pi's `terminal-image.js`. Use appropriate protocol per terminal.
- **Test**: manual on iTerm2 + Ghostty + Apple Terminal.

---

## 8. Terminal capability detection

### 8.1 No truecolor support
- **Description**: Apple Terminal still doesn't fully support 24-bit truecolor. Cathedral palette uses `#1A1511`.
- **Phase**: 1.
- **Mitigation**: Pi already detects via `terminal-image.js#detectCapabilities`. If `trueColor: false`, fall back to nearest 256-color or basic 16. Cathedral palette has documented fallbacks in `tokens.ts`.
- **Test**: unit — set `COLORTERM=` (empty), verify fallback colors used.

### 8.2 No kitty keyboard support
- **Description**: Older terminals don't support `\x1b[>1u`. Pi falls back to modifyOtherKeys.
- **Phase**: 1.
- **Mitigation**: Pi's `keys.js` already handles fallback. We don't reimplement.
- **Test**: deferred — Pi's tests cover this.

### 8.3 No mouse support
- **Description**: Some pty multiplexers strip mouse events.
- **Phase**: 1.
- **Mitigation**: If mouse mode enable returns no events within 5s, log warning. Scroll wheel becomes effectively keyboard-only (PgUp/PgDn).
- **Test**: integration in screen/tmux.

---

## 9. Memory growth in scrollback

### 9.1 10k message session
- **Description**: Long-running session accumulates messages. Each is a Yoga node + rendered string + cached frame.
- **Phase**: 3 + 6.
- **Mitigation**: Limit visible messages to 200 (OpenCode does 100). Older messages collapsed to "── 5234 earlier messages ──" placeholder. Real archive in session DB.
- **Test**: unit — push 5000 messages, verify only 200 in tree, memory < 100MB.

### 9.2 Yoga node leak
- **Description**: Yoga nodes are native FFI resources. Forgot to call `freeRecursive()`.
- **Phase**: 2.
- **Mitigation**: ScopedYogaNode wrapper. Constructor allocates, `using` keyword (TC39 explicit resource management) auto-frees.
- **Test**: unit + leaks — run 1k allocate/free cycles, verify RSS stable.

### 9.3 Frame buffer growth
- **Description**: Diff cache stores previous frame. Frame is W × H cells. For 200×60 = 12000 cells. Each cell is `{char, fg, bg, attrs}` ~32 bytes = 384 KB per frame.
- **Phase**: 2.
- **Mitigation**: Store one frame buffer, not history. Use cell pool to recycle objects.
- **Test**: memory profiling — render 1000 frames, verify steady-state RSS.

---

## 10. Test / headless mode

### 10.1 No TTY (CI environment)
- **Description**: Running in GitHub Actions, no TTY. Altscreen would fail. Mouse modes fail.
- **Phase**: 1.
- **Mitigation**: `terminal-controller.ts` checks `process.stdout.isTTY`. If false, render to stderr or skip altscreen. CI uses `headlessFrame()` API that returns string[] without writing.
- **Test**: unit — set isTTY=false, verify graceful degradation.

### 10.2 VHS tape doesn't render images
- **Description**: VHS uses xterm.js which doesn't fully support kitty graphics. Visual VHS will show empty boxes for images.
- **Phase**: 3.
- **Mitigation**: VHS tapes test layout; manual screenshots test images. Document in DEV_LOOP.md.
- **Test**: VHS tape with image confirmed broken; manual screenshot in real terminal confirms image renders.

### 10.3 Different VHS terminal width vs daily-driver
- **Description**: VHS at 240×80 might render fine; daily Ghostty at 100×40 reflows. Visual approval per slice catches this.
- **Phase**: all.
- **Mitigation**: Run VHS tapes at multiple sizes (`portrait` 100×80, `landscape` 240×60).
- **Test**: VHS tape suite covers 3 sizes per element.

---

## 11. Distribution / packaging

### 11.1 Yoga binding native module loading
- **Description**: `yoga-layout` (FFI native) must build native binary on `pnpm install`. May fail on user's machine.
- **Phase**: 0-2.
- **Mitigation**: Use `yoga-wasm-web` (pure WASM, no native deps) for v1. Later evaluate `yoga-layout` for performance.
- **Test**: unit — fresh `pnpm install` on Mac mini and MacBook, verify works.

### 11.2 Pi version drift
- **Description**: User runs `pi update`, pi-coding-agent jumps to 0.71.0, our fork breaks.
- **Phase**: 6 + ongoing.
- **Mitigation**: Per Q4 — pin to 0.70.x in `package.json`. Document upgrade procedure. Smoke-test on Pi version bumps before merging.
- **Test**: CI matrix on Pi 0.70.x.

### 11.3 Bundled vs extracted package conflict
- **Description**: User installs `@sumodeus/sumo-tui` from npm AND has SumoCode repo cloned. Two copies of sumo-tui in the load path.
- **Phase**: 7 (extraction).
- **Mitigation**: Per Q3:B — bundled first. No public package until month 1+. When extracted, bundle drops.
- **Test**: deferred.

---

## 12. IME / wide chars / RTL

### 12.1 RTL text (Arabic, Hebrew)
- **Description**: Bidirectional text — visual order ≠ logical order. visibleWidth math wrong.
- **Phase**: deferred (post-v1).
- **Mitigation**: Pi's `utils.js` doesn't currently handle RTL. We don't either in v1. Document as known limitation.
- **Test**: manual when relevant.

### 12.2 Combining characters (é = e + ́)
- **Description**: Grapheme cluster spans multiple codepoints. visibleWidth must use Intl.Segmenter or grapheme-splitter.
- **Phase**: 2.
- **Mitigation**: Pi already uses Intl.Segmenter. Reuse.
- **Test**: unit — input "é" (decomposed), verify visibleWidth = 1.

### 12.3 Surrogate pairs (emoji)
- **Description**: 😀 is one grapheme but two UTF-16 code units. JS string.length = 2.
- **Phase**: 2.
- **Mitigation**: Pi's `visibleWidth` handles this. Reuse.
- **Test**: unit.

---

## 13. Mouse routing

### 13.1 Click in scroll-shadow region
- **Description**: User clicks on a row that's between the chat scrollbox and the editor. Where does the click go?
- **Phase**: 3.
- **Mitigation**: Hit-test uses Yoga-computed bounds. Empty space → no handler.
- **Test**: integration — click on padding row, verify no event fired.

### 13.2 Drag selection across chat messages
- **Description**: User drags to select text. Selection must span multiple message boxes.
- **Phase**: 3-5.
- **Mitigation**: OpenCode pattern: top-level selection state, message components highlight selected ranges. We adopt.
- **Test**: integration — drag from message N to N+3, verify selection shows.

### 13.3 Right-click context menu (terminal sends OSC52?)
- **Description**: Right-click in altscreen depends on terminal. Some send OSC sequences, some popup terminal's own menu.
- **Phase**: 3.
- **Mitigation**: Don't rely on right-click for v1. Use Ctrl+keybinds. Document.
- **Test**: manual.

---

## 14. Slash command interception

### 14.1 Slash command typed during streaming
- **Description**: User types `/sumo:` while LLM is streaming. Editor disabled? Buffered?
- **Phase**: 4.
- **Mitigation**: Editor stays editable. Submit blocked until streaming done. UI shows "MEDITATING" footer.
- **Test**: integration — type during stream, hit Enter, verify queued.

### 14.2 Slash command conflicts with autocomplete
- **Description**: User types `/res` — both `/research` (Pi) and `/sumo:research` (us) match.
- **Phase**: 4.
- **Mitigation**: Pi's autocomplete already handles ranking. Our extensions register with `priority`. SumoCode commands prefer `/sumo:` namespace.
- **Test**: unit — register conflicting commands, verify priority order.

### 14.3 Command palette (Ctrl+P) intercepted by Pi
- **Description**: Pi has built-in Ctrl+P. We register too — Pi flags conflict, our handler skipped.
- **Phase**: 4-5.
- **Mitigation**: Currently flagged as known issue. Phase 5: switch to Ctrl+/ or Ctrl+Space.
- **Test**: integration — verify our palette actually opens.

---

## 15. PiEditorLeaf measurement

### 15.1 measureFunc called during layout (re-entrant?)
- **Description**: Yoga calls measureFunc to get a leaf's intrinsic size. measureFunc calls Pi's editor render. Render might trigger another layout?
- **Phase**: 2.
- **Mitigation**: PiEditor render is stateless given input width. No recursive render path. Yoga measureFunc is safe.
- **Test**: unit — fire 100 measureFunc calls in a layout cycle, verify no stack overflow.

### 15.2 Editor row count > available height
- **Description**: Multi-line text + autocomplete = 10 rows. Flex container has 5 rows available.
- **Phase**: 2.
- **Mitigation**: Pi's editor handles its own scroll (`─── ↑ N more ───`). We respect that — give it the height Yoga assigns; it scrolls internally.
- **Test**: VHS — paste 50 lines into editor at 5-row container, verify scroll indicators show.

### 15.3 measureFunc called with width=0
- **Description**: During initial layout, Yoga may probe with width=0.
- **Phase**: 2.
- **Mitigation**: Pi's editor returns reasonable output for any width >= 1. We clamp width=max(1, width).
- **Test**: unit.

---

## 16. Pi version compatibility (Q4)

### 16.1 Patch releases (0.70.x)
- **Description**: Pi ships 0.70.3 with internal change to interactive-mode. Our fork breaks.
- **Phase**: 4 + ongoing.
- **Mitigation**: Pin to 0.70.0 in package.json. Document upgrade procedure. Monthly smoke test on latest 0.70.x.
- **Test**: CI on 0.70.0, 0.70.1, 0.70.2, latest.

### 16.2 Minor release (0.71.0)
- **Description**: Pi ships 0.71.0 with breaking interactive-mode rewrite.
- **Phase**: 6+.
- **Mitigation**: Stay on 0.70.x. Evaluate 0.71 in a separate worktree. If we can rebase, ship. Otherwise stay pinned.
- **Test**: manual evaluation per Pi minor release.

### 16.3 Public TUI binding API
- **Description**: After Phase 6, attempt no-fork approach via Pi's public extension API. If Pi exposes `setRenderer` or similar, we use it.
- **Phase**: 6+.
- **Mitigation**: Audit Pi's public API at each Pi release. If a clean injection point appears, switch from fork to extension.
- **Test**: dual-implementation test — both fork and extension paths produce identical output for Phase 1-5 acceptance tests.

---

## 17. The sneaky ones

### 17.1 Bracketed paste mode + autocomplete
- **Description**: Paste 100 lines while autocomplete dropdown open. Each line might trigger a fuzzy search.
- **Phase**: 4.
- **Mitigation**: Pi handles paste atomically (`?2004h`). Autocomplete debounces. Should be fine.
- **Test**: integration — paste 100-line code block, verify no perf collapse.

### 17.2 Streaming in code block
- **Description**: LLM streams a fenced code block. Markdown renderer must keep state across chunks (we're inside a ``` fence).
- **Phase**: 5 (chat renderer).
- **Mitigation**: Phase 5 implements incremental markdown parser. State machine remembers fence-open state across chunks.
- **Test**: unit — feed code block one char at a time, verify final render correct.

### 17.3 ANSI colors in user input
- **Description**: User pastes terminal output with ANSI colors into prompt. Pi's editor strips? Renders?
- **Phase**: 4.
- **Mitigation**: Pi's `decodePasteBytes` strips ANSI by default. We keep that.
- **Test**: integration — paste colored ls output, verify plain text only.

### 17.4 Splash → first message transition
- **Description**: Splash centered, vertical fill. User types first message and submits. Splash collapses, chat appears. Layout shifts.
- **Phase**: 5.
- **Mitigation**: Splash has `flex: hasMessages ? 0 : 1`. ScrollBox has `flex: 1`. When first message arrives, splash vanishes, scrollbox fills.
- **Test**: VHS — record splash, submit, verify smooth transition.

### 17.5 Unicode title bar
- **Description**: Title bar `SUMOCODE | session-name` with UTF-8 session name. Width math.
- **Phase**: 5.
- **Mitigation**: All width math uses Pi's `visibleWidth`. Reuse.
- **Test**: unit — title with emoji + Chinese, verify correct truncation.

### 17.6 Sidebar overlay on splash
- **Description**: Sidebar shows on splash too? Or only after messages?
- **Phase**: 5.
- **Mitigation**: Per current cathedral spec — sidebar hidden on splash. `dockStaticSidebar` predicate already checks this.
- **Test**: VHS — splash should not show sidebar.

### 17.7 Cost / token counter overflow
- **Description**: Long session, cost = $1234.56. Tokens = 12.5M. Footer right-side overflow.
- **Phase**: 5.
- **Mitigation**: Footer uses `flexShrink: 1` on metrics span; truncate with ellipsis if needed.
- **Test**: unit — render footer with $9999.99 / 99M tokens, verify fits or truncates cleanly.

---

## Edge case priority matrix

| Severity | Likelihood | Examples |
|---|---|---|
| **P0 (must fix in phase)** | High | 1.1 cursor offset, 5.1 SIGINT, 9.1 memory growth, 17.4 splash transition |
| **P1 (should fix in phase)** | Med | 2.1 sub-frame chunks, 3.1 SIGWINCH, 8.1 no truecolor, 13.2 drag select |
| **P2 (defer to next phase)** | Low | 6.x 3rd-party ext, 12.1 RTL, 13.3 right-click |
| **P3 (document, don't fix)** | Very low | 5.2 SIGKILL, 5.5 SSH drop, 12.x post-v1 |

---

## How to use this catalog

1. Each phase's verification checklist references the relevant edge case IDs (e.g., Phase 2 must cover 1.1, 1.2, 9.2, 9.3, 15.x).
2. Test plans cite edge case IDs.
3. New edge cases discovered during implementation get appended here with phase + mitigation + test.
4. Quarterly review: anything in P3 that bit us → upgrade to P1.
