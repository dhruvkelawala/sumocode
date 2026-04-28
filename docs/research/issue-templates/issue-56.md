## Polish pass — chat UI, sidebar, htop HUD, VHS verification

After Phases 1–5 + a string of fixes (#49, #51, #53, #55), the runtime works but visual polish is below the cathedral spec. Time for a unified polish pass with VHS verification baked in.

## Three deliverables

### 1. Chat UI parity with cathedral spec

Current state (from latest screenshot): chat messages render as raw text with `USER >` / `SUMO >` / `TOOL >` prefixes. No styled framing.

Cathedral spec (`docs/ui/CATHEDRAL_DECISIONS.md`, `docs/ui/CATHEDRAL_UX_SPEC.md`, `docs/ui/stitch/cathedral/v1-html/idle-v3.html` mockup) calls for:

- **USER message**: small accent-bordered card with subtle prefix `▎ USER` (orange left-bar)
- **SUMO message**: distinct card with `▎ SUMO` sage left-bar
- **TOOL invocation**: framed status pill — `━━━ [bash] <command preview> ━━━ ✓` (or `…` while running, `✗` on fail) with sage/blue/red status color
- **Code blocks**: cathedral-framed with mini title bar — `▔▔ filename.ts ▔▔` top + dim divider bottom; preserve syntax colors but in cathedral palette
- **Tool output**: dim recess background, optional `└─ output ──` divider when truncated

Implement these as `ChatMessage` variants in `src/sumo-tui/widgets/chat-message.ts`. Each variant is a sumo-tui leaf that paints into the cell buffer at its row range.

Don't break Pi's underlying message stream — we just visually decorate.

### 2. Sidebar polish — all visual issues from latest screenshot

User says "sidebar is still broken." Looking at the screenshot:

- The `◆ sumocode (main)` session indicator + `◆ CONTEXT` / `▢ MEMORY` sub-tabs are stacked vertically. Per spec they should be:
  - Session list at the top (◆ active, ▢ inactive sessions)
  - Sub-tabs as a HORIZONTAL tab bar inside the panel: `[◆ CONTEXT] [▢ MEMORY]`
  - Then the active sub-tab's panel content below
- The `─── CONTEXT ───` heading appears TWICE (once as sub-tab, once as panel divider). Remove the redundant one — sub-tabs alone serve as the panel header.
- Token meter `15k/272k` should be a visual bar (not just text), with cathedral fill color when under 50%, amber 50–80%, accent 80%+
- Cost line `$0.23 spent · session` — keep
- MEMORY panel should show `❧ <fact text>` bullets when active; when empty + active show dim "no memories yet" hint
- MCP panel formatting OK but consider `●/○` indicators with state color (sage if all green; thinking yellow if any in-flight; approval red if any errored)

### 3. NEW: htop-style HUD panel in sidebar

Add a new sidebar panel — `─── METRICS ───` — with real-time:

- **CPU**: text label `CPU` + horizontal sparkline bar showing last 30 samples + percentage right-aligned
- **RAM**: text label `MEM` + horizontal bar showing RSS / system memory + MiB right-aligned
- **FPS**: text label `FPS` + render count from `FrameScheduler` over last 1s, right-aligned

Implementation:
- Sample every 1000 ms via `setInterval` (single timer, NOT per-metric)
- CPU: read `process.cpuUsage()` delta against wall-clock
- RAM: read `process.memoryUsage().rss`
- FPS: instrument `FrameScheduler` to expose `getRendersPerSecond()` window
- Sparkline: array of 30 values, shifted on each sample, rendered as 8-cell-tall vertical-bar char ladder per sample (`▁▂▃▄▅▆▇█`)
- Sparklines fit in ~30 cols, total panel height ~5 rows
- Panel only shown when sidebar is in `MEMORY` sub-tab? Or always visible at the bottom of the sidebar?
- Recommend: always at the bottom, below MCP panel. Daily-drive debugging requires it visible always.
- Color: dim foregroundDim default; CPU > 5% → thinking yellow; CPU > 20% → approval red

Polling cost: should be negligible (~0.1% CPU at 1Hz). Verify in diagnostic.

### 4. VHS verification baked in

For every change above, add or update a VHS tape:

- `docs/visual/sumo-tui-chat-ui.tape` — 5 message exchange showing USER/SUMO/TOOL pills + code block frames
- `docs/visual/sumo-tui-sidebar-spec.tape` — fully populated sidebar with all panels visible (REGISTRY, sessions, sub-tabs, CONTEXT panel, MEMORY panel with facts, MCP, METRICS)
- `docs/visual/sumo-tui-metrics-hud.tape` — show metrics HUD updating over a few seconds (use a longer Sleep block + screenshot mid-render)
- All existing 19+ VHS tapes must still pass at expected screenshots
- Verify by visually inspecting each PNG (open them, compare to mockup)

## Acceptance criteria

- [ ] USER/SUMO/TOOL messages styled per spec (left-bar prefix, distinct colors)
- [ ] Code blocks cathedral-framed with filename title
- [ ] Sidebar layout fixed: horizontal sub-tab bar, no redundant CONTEXT heading, token meter as bar
- [ ] Memory panel shows ❧ bullets when populated; dim hint when empty
- [ ] htop HUD panel renders with CPU/RAM/FPS + sparklines, updates 1Hz
- [ ] HUD doesn't add measurable CPU (< 0.5% delta in diagnostic)
- [ ] All existing 353 unit + 14 integration tests still pass
- [ ] New tests for chat-message variants + metrics HUD
- [ ] All existing VHS tapes pass; 3 new tapes added
- [ ] PR opened with `Closes #56`

## Constraints

- **Worktree**: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56/` (create from main at `7d0a0fd`)
- **Don't push to main directly**
- **Git identity**: `dhruvrk2000@gmail.com`
- **Time-box: 2 working days** — this is a meaty polish pass
- **VHS for every change**: visual proof or it didn't happen

## Required reading (~30 min)

1. `docs/ui/CATHEDRAL_DECISIONS.md` — Element 1 (sidebar), Element 9+10 (tool pills + code blocks)
2. `docs/ui/CATHEDRAL_UX_SPEC.md` — chat region spec
3. `docs/ui/stitch/cathedral/v1-html/idle-v3.html` — mockup ground truth (chat + sidebar)
4. `docs/ui/stitch/cathedral/03-tool-running.png` — tool pill spec
5. `src/sumo-tui/widgets/chat-message.ts` — current minimal chat-message implementation
6. `src/sumo-tui/cathedral/sidebar-tree.ts` — current sidebar layout
7. `src/sumo-tui/runtime/frame-scheduler.ts` — for FPS exposure
8. `scripts/diagnose-sumo-tui-cpu.mjs` — CPU/RAM sampling pattern (reuse the same approach for HUD)
9. `src/sidebar.ts` — original Pi-tui sidebar render (for spec reference)
10. `src/tokens.ts` — cathedral palette

## References

- Phase 5 sidebar tree: PR #46
- #51 sidebar parity: PR #51
- ChatPager: `src/sumo-tui/widgets/chat-pager.ts`
- Stitch mockups: `docs/ui/stitch/cathedral/`
