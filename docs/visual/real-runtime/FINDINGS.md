# T1 first-render findings · 2026-04-28

The verification harness found **5 real defects** on its very first run. This is exactly why the spec called for it.

## Defects

### D1 · Splash never renders in `--offline --no-session` mode (KNOWN, now reproduced)

**Tapes**: `01-splash.png`, `03-narrow-60col.png`, `06-clean-exit` (cursor only, no altscreen)

**Symptom**: Boot prints `[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout` to stdout, then sits at a cursor with no altscreen entered, no splash, no sidebar. After 4 seconds VHS captures plain shell output.

**Trigger**: `SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session` from inside the dev checkout cwd.

**Hypothesis**: Either `--no-session` blocks SumoInteractiveMode installation OR the duplicate-extension noop guard from #49 is too aggressive (kills the dev extension instead of just the installed copy).

**Issue**: file as #70

---

### D2 · Crash at 40-col terminal width (NEW)

**Tape**: `04-portrait-40x100.png`

**Symptom**:
```
Error: Rendered line 12 exceeds terminal width (45 > 40).
This is likely caused by a custom TUI component not truncating its output.
Use visibleWidth() to measure and truncateToWidth() to truncate lines.

  at TUI.doRender (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js:906:23)
  at Timeout._onTimeout (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js:350:18)
```

Crash is in `src/sumo-tui/runtime/lifecycle.ts:201` (rethrown). Pi-tui's `doRender` validates row widths and we're producing a 45-cell row at width 40.

**Likely cause**: A static string in our cathedral chrome doesn't truncate when terminal is narrower than expected. Phase 5 sidebar is supposed to switch to overlay below 120 cols but at 40 cols some chrome element still emits a fixed-width string.

**Issue**: file as #71. Severity: HIGH — Mac mini portrait runs at narrow widths in normal use.

---

### D3 · Skill conflict warning leaked into chat area (NEW, low severity)

**Tape**: `02-input-typed.png`

**Symptom**: Top of chat area shows:
```
[Skill conflicts]
  "use-railway" collision:
    ✓ auto (user) ~/.pi/agent/skills/use-railway/SKILL.md
    ✗ ~/.agents/skills/use-railway/SKILL.md  (skipped)
```

Cosmetic — the migration of `use-railway` into sumocode-config left a residue at `~/.agents/skills/` that pi notices. Should be cleaned up by removing the orphaned `~/.agents/skills/use-railway/` dir.

**Issue**: file as #72.

---

### D4 · `stty` mid-tape doesn't propagate to spawned process (TOOLING)

**Tape**: `05-landscape-160x40.png` (6 KB, near-empty)

**Symptom**: We use `Type "stty cols 160 rows 24 && pi ..."` to set dims before launching. `stty` runs in the parent shell but the spawned pi child inherits the original VHS PTY size, not the stty'd size. End result: pi runs at VHS's actual dims, then VHS crops to viewport, capturing mostly emptiness.

**Fix**: VHS has `Set Width / Set Height` pixels — those control the rendered viewport, not the cell grid. To set cell dims correctly, we should use `Set TerminalCols` and `Set TerminalRows` (VHS directives) instead of `stty`.

**Issue**: file as #73, fix in T1.5 follow-up tape pass.

---

### D5 · Post-Ctrl+C `Screenshot` directive doesn't fire on 06-clean-exit

**Tape**: `06-clean-exit.tape` (no PNG, only GIF)

**Symptom**: Tape script has `Screenshot` after exit and an `echo` command. PNG missing. Likely the post-Ctrl+C shell prompt timing combined with VHS's screenshot directive lost coordination.

**Fix**: Move `Screenshot` directive earlier (before exit). Verify clean exit by inspecting the GIF tail frames or by parsing stdout for raw escape codes via the integration-test harness.

**Issue**: file as #74.

---

## Summary

| Tape | Bug | Severity |
|---|---|---|
| 01 | Splash regression in `--offline --no-session` | HIGH |
| 02 | Skill conflict cosmetic banner | LOW |
| 03 | Same as 01 (splash regression) | HIGH |
| 04 | Crash at 40-col width | HIGH |
| 05 | `stty` doesn't propagate (tooling) | MEDIUM |
| 06 | Screenshot directive timing | MEDIUM (tooling) |

**ROI of T1**: 6 tapes, 80 seconds to render, immediately caught 4 product bugs + 2 tooling bugs the previous 30-tape demo-driven harness completely missed.

This is exactly the gap the spec identified.

---

## Next steps

1. Land T1 (this PR). Tapes + harness + this findings doc.
2. File issues #70-#74.
3. Fix D4 (stty / VHS terminal sizing) so D2 reproducer is reliable. Re-render.
4. Triage D1, D2 — both are blocking before T2 (no point committing goldens of broken renders).
5. Begin T2 (golden-image diff via odiff-bin) once D1/D2 are fixed and tapes show clean baseline.
