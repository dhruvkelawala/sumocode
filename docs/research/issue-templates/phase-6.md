## Phase 6: Daily-drive + extraction decision

Phases 1–5 shipped the sumo-tui framework. Phase 6 is **daily-drive on real terminals** to surface P0 regressions, then make the extraction decision (`@sumodeus/sumo-tui` public package vs stay bundled).

This is not a code-implementation issue. Treat as a tracking issue for findings.

## How to run

```bash
cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode"
./bin/sumocode.sh
```

(The wrapper sets `SUMO_TUI=1` which activates the patched Pi → sumo-tui retained renderer.)

## What to verify

- [ ] Splash centered (cat + wordmark + quote + carved input frame)
- [ ] Footer pinned to last row of viewport
- [ ] Mouse wheel scrolls chat (not Pi history)
- [ ] Sticky-bottom holds during streaming
- [ ] Scroll up shows `↓ N new — Press End to jump` banner
- [ ] PgUp/PgDn/Home/End navigate chat
- [ ] Sidebar docks ≥ 120 cols, overlays < 120
- [ ] Ctrl+P opens our palette
- [ ] `/sumo:theme amber-crt` redraws cleanly
- [ ] Ctrl+C exits cleanly (`asd` in shell → `command not found`, no escape garbage)

## Performance budgets (measure during daily-drive)

| Metric | Target | Acceptable |
|---|---|---|
| Cold start (post-Pi-boot) | < 200 ms | < 400 ms |
| Streaming render rate | 60 fps no drops | 30 fps |
| Idle frame rate | 0 (event-driven) | 1 fps |
| RSS at idle | < 150 MB | < 200 MB |
| RSS after 1h session | < 300 MB | < 500 MB |
| Frame render p95 | < 8 ms | < 16 ms |

## Findings log

Append issues here as they emerge during daily-drive:

- [ ] (date) — symptom — repro — severity (P0/P1/P2)

## Phase 6 exit criteria

- [ ] 7 consecutive days daily-drive without P0 issues
- [ ] Performance budgets met or documented why not
- [ ] Pi 0.70 public API audit — if a clean `setRenderer` (or equivalent) exists, prepare PR to drop the fork (Q4:C)
- [ ] Extraction decision documented: stay bundled OR extract to `@sumodeus/sumo-tui` public npm package

## When done

Close this issue + write `docs/research/phase-6-postmortem.md` summarizing:
- What broke during daily-drive
- Performance numbers
- Extraction decision + rationale

## References

- ADR-0001: `docs/adr/0001-sumo-tui-framework.md`
- Implementation Plan: `docs/research/sumo-tui-spike/IMPLEMENTATION_PLAN.md` (Phase 6 section)
- Wrapper script: `bin/sumocode.sh`
- Pi fork: `https://github.com/dhruvkelawala/pi-mono/tree/sumocode/0.70.2-fork`
