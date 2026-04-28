## Two regressions after #53

### 1. Colors stripped from splash render

**Before**: cat was multi-color BSH (cream face, brown markings, amber eyes), SUMOCODE wordmark was burnt orange `#D97706`.

**After**: cat is monochrome cream/white, wordmark is monochrome cream/white.

Hypothesis: the CellBuffer ANSI parser in `src/sumo-tui/render/buffer.ts` (or `src/sumo-tui/render/ansi-writer.ts`) doesn't handle 24-bit truecolor escape sequences (`\x1b[38;2;r;g;b m` for foreground, `\x1b[48;2;r;g;b m` for background). It probably only handles basic 16-color SGR codes, so truecolor ranges are stripped or mis-parsed.

The cat ANSI art is generated via `chafa --format=symbols --colors=full` which emits 24-bit truecolor. The wordmark uses cathedral tokens emitting truecolor.

**Diagnose**:
- Read `src/sumo-tui/render/buffer.ts` `paintRow()` parser
- Read `src/sumo-tui/render/ansi-writer.ts` ANSI emitter
- Test with a known truecolor row (e.g., `\x1b[38;2;217;119;6mORANGE\x1b[0m`) — does it round-trip?
- Add unit test for truecolor preservation

**Fix**: extend the ANSI parser to handle:
- `\x1b[38;5;Nm` (256-color fg)
- `\x1b[48;5;Nm` (256-color bg)
- `\x1b[38;2;r;g;b m` (24-bit fg)
- `\x1b[48;2;r;g;b m` (24-bit bg)
- Multi-parameter SGR sequences (`\x1b[1;38;2;r;g;b;48;2;r;g;b m`)

### 2. CPU pegging is back (system slow again)

User reports the same Mac-wide sluggishness. PR #53 fixed FrameScheduler's idle re-arm bug. Diagnostic confirmed 0.27% avg CPU at idle in #53's verification.

But user sees lag at runtime. Possible new cause:
- The splash bypass added in #53 (when ChatPager is empty, render splash directly) might trigger a render on every Pi tick
- The placeholder cursor preservation logic might call `requestRender` repeatedly
- A Pi event handler we hooked in #51 (`message_start`/`message_update`/`message_end`) might fire on every poll

**Diagnose**: re-run `node scripts/diagnose-sumo-tui-cpu.mjs` after PR #51+53 are merged. Compare avg CPU + frame-scheduler render rate.

If the diagnostic shows CPU < 1% but user still feels lag, the issue might be:
- Pi's own internal render loop (we don't control)
- A subprocess we spawn (e.g., bench script accidentally left running)
- `pi update` actually pulled an older binary that still has the bug

**Fix**: depends on diagnosis. Likely need to find the new render-loop culprit.

## Acceptance criteria

- [ ] Splash renders with full truecolor (cat multi-color, wordmark accent orange) — visual screenshot proof
- [ ] Idle CPU < 1% sustained 30s (verified via diagnostic)
- [ ] User confirms Mac no longer sluggish (manual verification)
- [ ] All 346 unit + 14 integration tests still pass
- [ ] Add unit test for ANSI truecolor parser preservation
- [ ] PR opened with `Closes #54`

## Constraints

- Worktree: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-54/` (create from main at `b450bd1`)
- Don't push to main directly
- Git identity: `dhruvrk2000@gmail.com`
- Time-box: 1 working day

## References

- PR #53 (just merged): scheduler fix + splash centering + cursor preservation
- PR #51: ChatPager wiring (suspect for new CPU regression)
- `src/sumo-tui/render/buffer.ts` and `src/sumo-tui/render/ansi-writer.ts` — ANSI parsing/emission
- `scripts/diagnose-sumo-tui-cpu.mjs` — the diagnostic harness
- `docs/research/sumo-tui-cpu-diagnosis.md` — last diagnostic findings
