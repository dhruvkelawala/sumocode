## Three regressions from PR #51 wiring

After `pi update` of #51, daily-drive screenshot shows:

### 1. Splash bottom-anchored instead of centered (visual regression)

The cat + SUMOCODE wordmark + quote sit at the BOTTOM of the viewport (just above the input frame), with the entire upper 70% of the screen empty.

Pre-#51 (Phase 5), the splash centered correctly via `src/sumo-tui/cathedral/splash-tree.ts` with `flexGrow=1` spacers above + below.

#51 wired Pi's chat content through `ChatPager`. Hypothesis: splash content is now rendering INSIDE `ChatPager` which has `stickyBottom: true`. When chat is empty, the splash takes the role of the only "message" and gets pushed to the bottom.

Fix: when chat has zero messages, render the splash-tree content in the chat slot WITHOUT going through ChatPager (or have ChatPager render the empty-state node centered, not sticky-bottom). Splash and chat are mutually exclusive; they shouldn't share the ChatPager scrollbox.

### 2. Cursor invisible in input box (regression)

PR #49 was supposed to fix this via `terminal-controller.enterAltscreen()` emitting `\x1b[?25h`. But latest screenshot still shows no cursor block.

Possible causes:
- The placeholder text rendered by Phase 5's input-frame chrome overlays the cursor cell (Pi's editor emits CURSOR_MARKER but our cell-buffer painter overwrites it with the placeholder span)
- Pi's editor `focused` flag is not being set (so CURSOR_MARKER not emitted)
- Hardware cursor positioning logic in compositor isn't respecting the editor leaf's hardwareCursor output

Fix: trace via `DEBUG=sumo-tui:cursor` log added to the editor leaf + compositor. Check whether marker is found, what `(row, col)` is computed, whether `\x1b[<row>;<col>H\x1b[?25h` is written to stdout.

### 3. System becomes slow after launch (BLOCKER for daily drive)

User reports the entire system gets sluggish after `./bin/sumocode.sh` boots. CPU likely pegged.

Suspects:
- **Frame scheduler stuck in streaming mode**: Q3:D adaptive scheduler should be event-driven idle (0 fps) and only enter 60fps batched during streaming. If something keeps `setStreamingMode(true)` permanent, we burn CPU continuously.
- **Render loop without dirty check**: every tick re-runs full Yoga layout + cell paint + ANSI write even when nothing changed.
- **Pi event leak**: an event listener registered N times = N renders per tick.
- **yoga-wasm-web layout calc on every render** without caching.

Fix:
- Audit `src/sumo-tui/runtime/frame-scheduler.ts` — verify idle path is truly event-driven, not a setInterval
- Add a `dirty` flag check before composite: if no Yoga node markedDirty since last render, skip
- Profile via `node --inspect` and capture flame graph from a 10s idle session
- Document findings in `docs/research/sumo-tui-performance.md`

## Acceptance criteria

- [ ] Splash centered vertically (manual verification via screenshot)
- [ ] Cursor visible in input box during typing (manual + integration test that proves cursor moves)
- [ ] CPU usage at idle (no streaming) < 1% over 30s window (measure via `top -pid <sumocode-pid>`)
- [ ] All 343 unit + 13 integration tests still pass
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] PR opened with `Closes #52`

## Constraints

- Worktree: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-52/` (create from main at `86f5fe5`)
- Don't push to main directly
- Git identity: `dhruvrk2000@gmail.com`
- Time-box: 1 working day. These are surgical fixes, not new features.

## References

- #51 wired ChatPager: PR https://github.com/dhruvkelawala/sumocode/pull/51
- #49 cursor + noise + bench: PR #49
- ChatPager source: `src/sumo-tui/widgets/chat-pager.ts`
- Splash tree: `src/sumo-tui/cathedral/splash-tree.ts`
- Frame scheduler: `src/sumo-tui/runtime/frame-scheduler.ts`
- SumoInteractiveMode: `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
