## Three blockers from Phase 6 daily-drive

Found while running `./bin/sumocode.sh` for the first time:

### 1. No cursor visible in input box (BLOCKER)

Splash renders correctly. `┌─ SCRIPTOR INPUT ─┐` carved frame shows. Placeholder text `> Ask anything... "Refactor the auth flow."` shows. **But no cursor block.** Can't tell where typing lands.

Likely causes (rank by probability):
- Our `terminal-controller.enterAltscreen()` doesn't emit `\x1b[?25h` (cursor visible) — Pi may have hidden it before we entered altscreen
- `PiEditorLeaf` isn't marking the wrapped `CustomEditor` as `focused: true` → Pi's editor logic emits CURSOR_MARKER only when `focused && !autocompleteState`
- The placeholder text we render in Phase 5's input frame overlays the cursor row of Pi's editor render
- The compositor's hardware cursor positioning logic isn't being called on the editor's emitted marker

Fix: trace it. Likely 1-3 lines.

### 2. Pi noise dominates the top of splash

Visible warnings:
- `[Extension issues]` with 5+ shortcut conflicts (ctrl+p, ctrl+k, ctrl+shift+k, ctrl+1, ctrl+2 — both built-in conflicts AND duplicate registrations between dev path and installed copy)
- `Warning: Anthropic subscription auth is active...`

These dominate the top half of the viewport. Splash content is pushed to the middle but the noise makes it ugly.

Two parts:
- **Some conflicts are "built-in" conflicts** (Pi has ctrl+p/ctrl+k baked in). Drop those shortcut registrations — use ctrl+/ or ctrl+space instead.
- **Some are dev/installed double-registration** because user has SumoCode installed via `pi install` AND is running via `pi -e ./src/extension.ts`. Detect this and skip if loading from dev path while installed copy exists, OR (simpler) suppress Pi's chatContainer noise rendering in `SumoInteractiveMode.run()` since we own that loop now.

Recommended: in `SumoInteractiveMode`, skip rendering Pi's `[Extension issues]` and `[Anthropic warning]` Text components. They don't add value to a polished UI.

### 3. Performance benchmarks not measured

Phase 6's exit criteria require:
- Cold start < 200ms post-Pi-boot
- Streaming 60fps no drops
- RSS < 150MB idle, < 300MB after 1h
- Frame render p95 < 8ms

We have a `scripts/measure-opentui-spike.mjs` script from the earlier opentui spike. Need an equivalent for sumo-tui:
- `scripts/measure-sumo-tui.mjs` — measures cold-start, RSS, and frame-render times
- Document results in `docs/research/sumo-tui-performance.md`
- Compare to budgets, flag any miss as P0/P1

## Acceptance criteria

- [ ] Cursor visible in input box during typing (manual + integration test)
- [ ] Pi noise (`[Extension issues]`, Anthropic warning) hidden when running through `SumoInteractiveMode` (suppression at the runtime level, not just visual hide)
- [ ] `scripts/measure-sumo-tui.mjs` runs and produces concrete numbers
- [ ] `docs/research/sumo-tui-performance.md` has measured numbers + comparison to budgets
- [ ] All 330 unit + 11 integration tests still pass
- [ ] PR opened with `Closes #48`

## Constraints

- **Don't push to main directly** — PR + review
- **Time-box: 1 day**. These should be small focused fixes.
- **Git identity**: `dhruvrk2000@gmail.com`
- Worktree: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-48/` (create from main)

## References

- ADR-0001: `docs/adr/0001-sumo-tui-framework.md`
- Phase 5 PR: #46
- Phase 6 tracker: #47
- Phase 1 terminal controller: `src/sumo-tui/runtime/terminal-controller.ts`
- Editor leaf: `src/sumo-tui/widgets/pi-editor-leaf.ts`
- SumoInteractiveMode: `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
