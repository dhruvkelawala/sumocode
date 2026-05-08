## Polish pass — chat UI + sidebar parity per CATHEDRAL_UX_SPEC.md + htop HUD

The actual UX spec (`docs/ui/CATHEDRAL_UX_SPEC.md`, restored on main at commit `0ca0c32`) defines explicit ASCII templates per region. This issue pulls everything together with VHS verification baked in.

**Spec hierarchy**: where `CATHEDRAL_DECISIONS.md` and `CATHEDRAL_UX_SPEC.md` conflict, DECISIONS wins (newer, locked v1 scope). UX_SPEC is canonical for things DECISIONS doesn't cover.

## Four deliverables

### 1. Sidebar polish — match `CATHEDRAL_UX_SPEC.md §4.2`

Spec template (active state, MEMORY active):
```
                                   REGISTRY
                                   v 1.0.0

                                   ▢ CONTEXT
                                   ◆ MEMORY     ← active

                                   ┌ ACTIVE_MEMORY ────
                                   ❧ prefers TypeScript strict
                                   ❧ pnpm not npm
                                   ❧ based in London
                                   ❧ BigCo → main-app
```

Current screenshot shows the sidebar rendering but with these deltas vs spec:

| Spec | Current | Fix |
|---|---|---|
| Section header `┌ ACTIVE_CONTEXT ────` (accent label, divider chars) | `─── CONTEXT ───` plain divider | Update sidebar-tree to render `┌ NAME ────` style |
| Token meter `[██████░░░] 42k/200k` (visual bar with cathedral fill color) | `15k/272k` text only | Add bar widget — sage if <50%, amber 50-80%, accent 80%+ |
| `$0.23 spent · session` line (foregroundDim) | already present ✓ | (no change) |
| MCP entries: `● stitch          ok` `● figma          down` (`●` colored by state, label dim, status right-aligned dim) | `● github idle` (no state coloring) | Color the dot per state |
| `❧ <fact text>` bullets when MEMORY tab active | empty MEMORY panel | Wire ChatPager-style view of memory facts |
| Sub-tabs CONTEXT + MEMORY only (DECISIONS Element 1 v1 scope) | already 2 tabs ✓ | Don't add SCRIPTOR/FILES (they're v2 per DECISIONS) |
| Stacked vertically with marker `◆`/`▢` (UX_SPEC §4.2 sketch) | already vertical ✓ | (no change) |
| Sub-tab labels uppercase, active=foreground, inactive=foregroundDim (UX_SPEC §4.2) | already correct ✓ | (no change) |
| Hidden when terminal width < 120 cols (DECISIONS Element 1) | already wired ✓ | (no change) |

### 2. Chat UI — limited per UX_SPEC §4.6 + §4.7 v1 scope

**Spec is explicit**: in v1, we do NOT replace Pi's tool rendering or markdown parser. From UX_SPEC §4.6: "in v1 of this rework we do NOT replace Pi's tool rendering. We accept Pi's renderer + our theme colors."

So current chat UI is mostly correct. What we DO need:

- **Verify cathedral theme is applied to Pi's markdown renderer** — read `cathedral.json` theme, ensure all syntax slots (keyword, string, comment, function, number, operator) map to spec colors per UX_SPEC §4.7
- **Empty-chat quote** (UX_SPEC §4.4): when active session has 0 messages (e.g. immediately after `/resume` of empty session, or `/new` followed by waiting), render the centered Saint-Exupéry quote in the chat region. Different from splash — sidebar visible, top chrome visible. Currently doesn't exist.

Don't try to migrate USER/SUMO/TOOL prefixes to custom pills — that's v2 per spec.

### 3. NEW: htop HUD — sidebar METRICS panel

Not in either spec doc, but useful for daily-drive debugging. Add as a 3rd panel below MCP:

```
┌ METRICS ──────
CPU  ▁▂▃▂▁▁▁▂▃▁  0.4%
MEM  ▂▂▂▃▃▃▃▃▃▃  178M
FPS  ▁▁▁▁▁▁▁▁▁▁  0
```

- Sample every 1000 ms (single setInterval)
- CPU: `process.cpuUsage()` delta vs wall clock
- MEM: `process.memoryUsage().rss` MiB
- FPS: `FrameScheduler.getRendersPerSecond()` (instrument scheduler to expose)
- Sparkline: 10 cells of `▁▂▃▄▅▆▇█` from a 10-sample circular buffer
- Color rules:
  - CPU < 5% → foregroundDim, 5-20% → state.thinking (amber), >20% → state.approval (terracotta)
  - MEM < 200MB → foregroundDim, 200-300MB → amber, >300MB → terracotta
  - FPS = 0 idle → foregroundDim (good, event-driven), >5 → amber, >30 → terracotta (running hot)
- Polling overhead must be < 0.5% CPU (verify via diagnostic)

### 4. VHS verification baked in

Three new tapes:
- `docs/visual/sumo-tui-chat-ui.tape` — 5-message exchange showing USER/SUMO/TOOL prefixes + cathedral-themed code block
- `docs/visual/sumo-tui-sidebar-spec.tape` — fully-populated sidebar with ALL panels (REGISTRY, sub-tabs, ACTIVE_CONTEXT with token bar, ❧ memory bullets, MCP with state dots, METRICS HUD)
- `docs/visual/sumo-tui-empty-chat-quote.tape` — empty-active-session showing the centered quote

All existing 19+ VHS tapes must still pass at expected screenshots.

## Acceptance criteria

- [ ] Sidebar matches UX_SPEC §4.2: `┌ ACTIVE_CONTEXT ────` headers, `[██████░░░] N/M` token bar, `❧` memory bullets, MCP `●` colored by state
- [ ] Empty-chat quote (UX_SPEC §4.4) renders when active session has zero messages
- [ ] Cathedral theme applied to Pi's markdown renderer (verify code block colors per UX_SPEC §4.7)
- [ ] htop HUD panel renders with CPU/RAM/FPS sparklines, updates 1Hz
- [ ] HUD adds < 0.5% CPU at idle (verify in diagnostic)
- [ ] All 353 unit + 14 integration tests still pass
- [ ] New unit tests for sidebar widgets + HUD + empty-chat quote
- [ ] All existing VHS tapes still pass; 3 new tapes added
- [ ] PR opened with `Closes #56`

## Constraints

- **Worktree**: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56/` (already created)
- **Don't push to main directly**
- **Git identity**: `dhruvrk2000@gmail.com`
- **Time-box: 2 working days**
- **Spec discipline**: don't expand scope beyond UX_SPEC. We're polishing, not redesigning.

## Required reading (~30 min)

1. `docs/ui/CATHEDRAL_UX_SPEC.md` §4.2 (sidebar), §4.4 (empty-chat quote), §4.6 (tool pills v1=theme-only), §4.7 (code blocks v1=theme-only)
2. `docs/ui/CATHEDRAL_DECISIONS.md` Element 1 (sidebar v1: 2 sub-tabs only), Element 5 (footer F1 — already shipped, don't change)
3. `src/sumo-tui/cathedral/sidebar-tree.ts` — current sidebar
4. `src/sidebar.ts` — Pi-tui original sidebar (reference for fact rendering, MCP rendering)
5. `src/sumo-tui/runtime/frame-scheduler.ts` — FPS exposure
6. `scripts/diagnose-sumo-tui-cpu.mjs` — CPU/RAM polling pattern (reuse for HUD)
7. `pi-agent/themes/cathedral.json` — cathedral theme tokens for markdown/syntax
8. `src/tokens.ts` — palette
