# Sumo-Tui Implementation Plan

**Decisions locked** (from grill questions):
- Q1 = A with B prepared as fallback (PiEditorLeaf + cursor remap; native textarea fallback if drift > 1 frame per input)
- Q2 = C (sumo-tui supports SumoCode's extensions only in v1; 3rd-party Pi extensions degrade gracefully with warning; full compat in Phase 7)
- Q3 = D (adaptive frame scheduler — 60fps batch when streaming, event-driven when idle)
- Q4 = A then C (pin to Pi 0.70.x via fork; Phase 6+ attempt no-fork via public API)
- Q5 = A + B (unit + VHS tapes + headless integration tests for fragile bits)
- Q6 = A (macOS only v1; cross-platform when extracted as public package)

Read alongside: `SUMO_TUI_RESEARCH_AND_SPEC.md` (the spec) and `EDGE_CASES.md` (every edge case enumerated).

---

## Total effort: ~5-7 weeks, calendar 8-10 weeks

| Phase | Days (est) | Dependencies |
|---|---|---|
| Phase 0: Research checkpoint + ADR | 1 | — |
| Phase 1: Terminal lifecycle + mouse | 3 | Phase 0 |
| Phase 2: Layout + compositor MVP | 6 | Phase 1 |
| Phase 3: ScrollBox / ChatPager | 5 | Phase 2 |
| Phase 4: SumoInteractiveMode fork | 7 | Phase 3 |
| Phase 5: Cathedral parity | 6 | Phase 4 |
| Phase 6: Hardening + extraction decision | 10 (daily-drive) | Phase 5 |
| Phase 7: 3rd-party Pi extension support | 4 (deferred) | Phase 6 |
|  |  |  |
| **Subtotal (Phase 0-6)** | **~38 working days** | — |

Buffer: 30% for unknowns → calendar 8-10 weeks.

---

## Phase 0 — Research checkpoint + ADR (1 day)

### Goals
- Lock in the architecture decisions in a written ADR.
- Open Phase 1-5 GitHub issues with acceptance criteria.
- Set up worktree + branch model.

### Deliverables
- [ ] `docs/adr/0001-sumo-tui-framework.md` (Mario Heinemeier Hansen ADR style: Status, Context, Decision, Consequences, Alternatives Considered)
- [ ] GitHub issues filed for Phases 1-5 with acceptance criteria + edge case IDs from `EDGE_CASES.md`
- [ ] Worktree `worktrees/sumocode-sumo-tui/` on branch `feat/sumo-tui-phase-1` (or per-phase branches)
- [ ] `package.json` audit — pin `@mariozechner/pi-coding-agent: 0.70.x`, `@mariozechner/pi-tui: 0.70.x`

### Acceptance gate
ADR merged. Phase 1 issue clearly defines what "done" looks like.

### Files touched
- `docs/adr/0001-sumo-tui-framework.md` (new)
- `package.json` (pin Pi versions)

---

## Phase 1 — Terminal lifecycle + mouse SGR proof (3 days)

### Goals
The single thing that proves sumo-tui can own the terminal cleanly: enter altscreen, enable mouse SGR, handle every signal exit path, restore terminal state perfectly.

This phase has NO new UI. Pi's existing UI keeps running. We just intercept the terminal lifecycle and prove cleanup is rock-solid.

### Tasks
1. Create `src/sumo-tui/runtime/terminal-controller.ts` (~250 lines)
   - `enterAltscreen()` — `\x1b[?1049h\x1b[H`
   - `enableMouseSGR()` — `\x1b[?1000h\x1b[?1006h\x1b[?1003h`
   - `exitTerminal()` — pops every mode in correct order:
     - `\x1b[<u` (kitty pop)
     - `\x1b[>4;0m` (modifyOtherKeys off)
     - `\x1b[?2004l` (paste mode off)
     - `\x1b[?1003l\x1b[?1006l\x1b[?1000l` (mouse off)
     - `\x1b[?1049l` (altscreen off)
     - `\x1b[?25h\x1b[0m` (cursor + SGR reset)
   - Signal handlers: SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTSTP, SIGCONT
   - `uncaughtException` handler
   - `process.on('exit')` final-fallback
   - `restored` flag to prevent double-cleanup
2. Create `src/sumo-tui/runtime/lifecycle.ts` (~150 lines)
   - `installLifecycle(pi)` registers session_start (enter altscreen) and session_shutdown (exit)
   - Composes with Pi's existing terminal management — runs BEFORE Pi's own cleanup
3. Replace current `src/cathedral/altscreen.ts` with calls to the new controller.
4. Wire mouse SGR events to a no-op handler initially. Just prove the terminal stops translating scroll → arrows.

### Tests (unit)
- `terminal-controller.test.ts`: each enter/exit method emits expected escape bytes.
- `lifecycle.test.ts`: signal handlers register exactly once, cleanup runs exactly once even if called twice.
- Edge cases covered: 5.1 (SIGINT), 5.3 (uncaughtException), 5.4 (SIGTSTP/CONT), 5.5 (EPIPE), 8.3 (no mouse).

### Tests (headless integration — Q5:B)
- New harness: `test/integration/spawn-pi-pty.ts` — spawn `pi` via node-pty, send escape sequences, assert stdout output.
- `test/integration/altscreen-cleanup.test.ts`:
  - Spawn sumocode in pty
  - Send SIGINT
  - Probe terminal mode — must show altscreen exited, kitty popped, cursor visible.
- `test/integration/mouse-scroll.test.ts`:
  - Send SGR mouse scroll events
  - Verify Pi's editor does NOT receive arrow-key cycling.

### Tests (VHS)
- `cathedral-altscreen-clean-exit.tape` — record clean exit, verify final terminal state.

### Visual approval gate
- User runs sumocode, presses Ctrl+C, types `asd` in shell — clean output, no escape leakage. Approves.

### Risk mitigation
- **Risk**: mouse SGR + Pi keyboard handling collision (we enable mouse, Pi might re-disable it).
  - Mitigation: Hook `pi.on('session_start')` and emit AFTER Pi's own setup. Verify with strace-equivalent.
- **Risk**: altscreen on a non-TTY environment.
  - Mitigation: Check `process.stdout.isTTY` first. (Edge case 10.1.)

### Rollback strategy
Branch `feat/sumo-tui-phase-1`. If broken: revert merge, use commit before. Pi continues working as before.

### File structure created
```
src/sumo-tui/
├── runtime/
│   ├── terminal-controller.ts
│   ├── terminal-controller.test.ts
│   ├── lifecycle.ts
│   └── lifecycle.test.ts
└── README.md  (sumo-tui v0.1)

test/integration/
├── spawn-pi-pty.ts
├── altscreen-cleanup.test.ts
└── mouse-scroll.test.ts
```

### Deliverables (acceptance criteria)
- [ ] All edge case 5.x and 8.3 tests passing
- [ ] Headless integration: `pnpm test:integration` green
- [ ] VHS: `cathedral-altscreen-clean-exit.tape` matches expected
- [ ] User Ctrl+C → shell input clean (manual screenshot)
- [ ] User mouse-scrolls in sumocode → Pi editor does NOT cycle history (manual)
- [ ] All 231 existing unit tests still passing

---

## Phase 2 — Layout + compositor MVP (6 days)

### Goals
Build the core retained renderer: Yoga-laid-out tree of nodes, cell buffer compositor, ANSI line output, frame diff. Plus the `PiComponentLeaf` and `PiEditorLeaf` adapters so we can mount Pi's components inside our flex tree.

### Tasks

#### Day 1 — Yoga setup + node primitive
1. Add `yoga-wasm-web` to dependencies (decision per edge case 11.1; faster install, no native module concerns).
2. `src/sumo-tui/layout/yoga.ts` — singleton init, type re-exports, `freeRecursive` helper.
3. `src/sumo-tui/layout/node.ts` — SumoNode class:
   - Constructor takes Yoga node, parent, optional handlers
   - Props: width, height, flex, padding, margin, etc.
   - `addChild`, `removeChild`, `markDirty`
   - `using` keyword support for auto-cleanup (TC39 explicit resource management)

#### Day 2 — Cell buffer + ANSI compositor
1. `src/sumo-tui/render/cell.ts` — Cell type (`{char, fg, bg, attrs}`).
2. `src/sumo-tui/render/buffer.ts` — 2D cell grid; `setCell`, `getCell`, `clear`, `paint(rect, cell)`.
3. `src/sumo-tui/render/ansi-writer.ts` — convert cell buffer to ANSI rows (RLE compressed).
4. `src/sumo-tui/render/compositor.ts` — walk Yoga tree, fill cell buffer.

#### Day 3 — Frame diff
1. `src/sumo-tui/render/diff.ts` — diff two cell buffers, return changed-line list.
2. Borrow algorithm from opentui-island's `frame-diff.ts` (cite source in code comment).
3. Optimization: scroll detection (lines shifted up/down) → emit DECRTC scroll regions instead of repaint.

#### Day 4 — Pi component leaf
1. `src/sumo-tui/widgets/pi-component-leaf.ts`:
   - Wraps any pi-tui `Component`.
   - Yoga measureFunc returns `super.render(width).length` for height.
   - Render: call `Component.render(width)`, paint each row's text into our cell buffer at the leaf's Yoga-computed origin.
   - Strip ANSI for measureFunc, preserve for render.

#### Day 5 — Pi editor leaf (most fragile)
1. `src/sumo-tui/widgets/pi-editor-leaf.ts`:
   - Extends `PiComponentLeaf`.
   - Adds CURSOR_MARKER scanning post-render.
   - Maps `(leaf_row, leaf_col)` to `(frame_row, frame_col)` using leaf's Yoga origin.
   - Emits hardware cursor position to compositor.
2. Edge case 1.1, 1.2, 1.3, 1.4 unit tests.

#### Day 6 — Frame scheduler + integration smoke
1. `src/sumo-tui/runtime/frame-scheduler.ts` (Q3:D — adaptive):
   - `requestRender()` — sets dirty flag.
   - Idle: render on next tick (event-driven).
   - Streaming flag: render at 60fps batches.
   - `enterStreamingMode()` / `exitStreamingMode()`.
2. Plug into Phase 1's lifecycle.
3. End-to-end smoke: render a "hello world" Yoga tree with a Pi text component leaf in altscreen.

### Tests (unit)
- `node.test.ts` — Yoga node lifecycle.
- `buffer.test.ts` — paint, clear, intersect.
- `ansi-writer.test.ts` — row generation, RLE compression.
- `compositor.test.ts` — tree walk, no overlap, full coverage.
- `diff.test.ts` — change detection, scroll-region detection.
- `pi-component-leaf.test.ts` — wrap pi-tui Spacer + Text, verify rendering identical.
- `pi-editor-leaf.test.ts` — CURSOR_MARKER remap with various leaf origins.
- `frame-scheduler.test.ts` — adaptive timing.

### Tests (headless integration)
- `test/integration/yoga-flex-layout.test.ts` — splash component using flex layout, verify output rows.
- `test/integration/cursor-positioning.test.ts` — type 50 chars in editor leaf, verify cursor in correct frame cell every frame.

### Tests (VHS)
- `sumo-tui-flex-splash.tape` — splash with vertical centering via Yoga (no manual padding math).
- `sumo-tui-editor-leaf.tape` — basic editor leaf interaction.

### Visual approval gate
User screenshots a SumoCode boot showing splash centered, footer pinned, no padding-math hacks. Approves.

### Edge cases covered
- 1.1, 1.2, 1.3, 1.4, 1.5 (cursor)
- 2.1, 2.2 (streaming early)
- 3.1 (resize basic)
- 9.2, 9.3 (memory)
- 11.1 (yoga-wasm-web binding)
- 12.x (wide chars via Pi reuse)
- 15.1, 15.2, 15.3 (measureFunc)

### File structure
```
src/sumo-tui/
├── runtime/  (from Phase 1)
│   └── frame-scheduler.ts
├── layout/
│   ├── yoga.ts
│   ├── node.ts
│   └── flex.ts
├── render/
│   ├── cell.ts
│   ├── buffer.ts
│   ├── ansi-writer.ts
│   ├── compositor.ts
│   └── diff.ts
├── widgets/
│   ├── pi-component-leaf.ts
│   └── pi-editor-leaf.ts
└── (tests beside each)
```

### Acceptance criteria
- [ ] All Phase 2 edge case unit tests passing
- [ ] Headless integration green
- [ ] VHS shows splash centered + footer pinned via Yoga, not manual padding
- [ ] Cursor in editor leaf renders in correct frame cell when leaf is at any Yoga-computed position
- [ ] All Phase 1 + existing 231 tests still passing
- [ ] Manual screenshot approval

### Phase 2 fallback (if Q1:A doesn't work)
If by Day 5 the cursor remap proves unreliable:
- Pause Phase 2.
- Spike a sumo-tui native textarea (Q1:B path) for 2-3 days.
- If native textarea works: drop PiEditorLeaf, use sumo-tui textarea, accept loss of Pi autocomplete (regress on slash commands).
- If native textarea also has issues: re-evaluate the entire framework decision with user.

---

## Phase 3 — ScrollBox / ChatPager (5 days)

### Goals
The OpenCode trick: in-app chat scrollback that works inside altscreen with sticky-bottom + mouse wheel + PgUp/PgDn.

This is the single feature that makes sumo-tui worth building. Phase 1+2 fixes the immediate cursor/exit bugs; Phase 3 is the architectural payoff.

### Tasks

#### Day 1 — ScrollBox primitive
1. `src/sumo-tui/widgets/scrollbox.ts`:
   - Yoga node with `flexGrow=1`.
   - Internal `scrollOffset` (lines from top).
   - `scrollHeight` (total content height).
   - `viewportHeight` (visible rows).
   - `scrollTo(offset)`, `scrollBy(delta)`, `scrollToBottom()`.

#### Day 2 — Sticky-bottom logic
1. `stickyBottom: boolean` prop.
2. `manualScroll: boolean` flag.
3. When new content arrives:
   - If `stickyBottom && !manualScroll` → snap to bottom.
   - Else: preserve current `scrollOffset` (subtract added lines so view doesn't jump).
4. When user scrolls: set `manualScroll=true` if not at bottom.
5. When user scrolls back to bottom: clear `manualScroll`.

#### Day 3 — Mouse wheel + keyboard
1. Mouse wheel in scrollbox bounds → `scrollBy(±3)` (configurable acceleration).
2. PgUp/PgDn → `scrollBy(±viewportHeight/2)` (OpenCode pattern).
3. Home/End → `scrollTo(0)` / `scrollToBottom()`.
4. Wire to keybindings registry.

#### Day 4 — Streaming integration
1. ChatMessage component (renders one message).
2. ChatPager wraps ScrollBox, holds an array of messages.
3. On `pi.on('message_start')` → add message.
4. On streaming chunk → update last message's text.
5. ScrollBox auto-resnaps via stickyBottom.
6. Q3:D adaptive frame scheduler kicks in during streaming.

#### Day 5 — "Scrolled up" indicator
1. When `manualScroll=true && scrollOffset !== bottom` → render a dim banner: `↓ N new messages — Press End to jump`.
2. Banner overlays bottom of scrollbox area.
3. Click banner → scrollToBottom + clear manualScroll.

### Tests (unit)
- `scrollbox.test.ts`: scroll mechanics, sticky-bottom snap, manualScroll flag transitions.
- `chatpager.test.ts`: 100 messages, scroll up, simulate streaming, verify viewport stable.
- `keyboard-scroll.test.ts`: PgUp/PgDn/Home/End each scroll correct amount.
- Edge cases covered: 2.1, 2.2, 2.3, 2.4, 2.5 (streaming), 9.1 (10k messages), 13.1 (mouse hit-test), 13.2 (drag selection deferred), 17.4 (splash transition).

### Tests (headless integration)
- `test/integration/streaming-stream.test.ts`: feed 1000 chunks/sec, verify FPS, verify scrollbox stable.
- `test/integration/chat-history-scroll.test.ts`: load 200 messages, scroll up, verify oldest visible.

### Tests (VHS)
- `cathedral-streaming.tape` — streaming response, verify smooth.
- `cathedral-scroll-up-banner.tape` — manual scroll, verify banner appears.

### Visual approval gate
User runs daily session, asks LLM 3 questions, scrolls up to read first answer mid-streaming, scrolls back to see live response. Verifies feel matches OpenCode.

### Edge cases covered
- 2.1-2.5 (streaming)
- 9.1 (memory, 10k messages — virtualize after 200)
- 13.1, 13.2 (mouse routing)
- 17.4 (splash → chat transition)

### File structure
```
src/sumo-tui/widgets/
├── scrollbox.ts
├── chat-message.ts
├── chat-pager.ts
└── scrolled-up-banner.ts
```

### Acceptance criteria
- [ ] Mouse wheel scrolls chat (NOT cycles history)
- [ ] PgUp/PgDn/Home/End work
- [ ] Sticky-bottom holds during streaming
- [ ] Scroll up + new message → preserves position + shows banner
- [ ] 10k message session loads, scrolls smooth, RSS < 300MB
- [ ] User approval

---

## Phase 4 — SumoInteractiveMode fork (7 days)

### Goals
Fork pi-coding-agent's interactive-mode (Q4:A) to inject our renderer. Preserve every Pi feature: editor, autocomplete, slash commands, MCP, sessions, extension API.

This is the highest-risk phase. We're modifying private Pi code.

### Tasks

#### Day 1 — Read interactive-mode source
1. Map every responsibility in `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2*/dist/modes/interactive/interactive-mode.js`.
2. Identify the seam where pi-tui is constructed.
3. Document in `docs/research/interactive-mode-map.md`.

#### Day 2 — Vendor + minimize fork
1. Vendor only the parts we need into `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`.
2. Replace pi-tui TUI construction with sumo-tui Runtime construction.
3. Keep the rest (session bind, agent, extensions) unchanged.
4. License compliance: pi-mono is MIT, copy LICENSE notice.

#### Day 3 — Region registry
1. `src/sumo-tui/pi-compat/region-registry.ts`:
   - Maps Pi's `setHeader/setFooter/setEditorComponent/setWidget` calls to named slots in our Yoga tree.
   - Each slot is a sumo-tui SumoNode. Pi extension's content becomes a PiComponentLeaf inside the slot.

#### Day 4 — Extension UI adapter
1. `src/sumo-tui/pi-compat/extension-ui-adapter.ts`:
   - Implements ExtensionUIContext interface (from pi-coding-agent types).
   - `setHeader(component)` → mount in header slot.
   - `setFooter(component)` → mount in footer slot.
   - `setEditorComponent(factory)` → instantiate via factory, mount as PiEditorLeaf.
   - `setWidget(key, factory, opts)` → mount in placement-specific slot.
   - `notify(text, level)` → toast via sumo-tui notification.
   - `confirm`, `select`, `custom` → modal layer.

#### Day 5 — Slash command + autocomplete pipe
1. Pi's slash command registry → sumo-tui editor's autocomplete provider.
2. Slash matches → command palette overlay.
3. Verify Ctrl+P opens our palette (currently broken in Pi due to conflict; we own the keybind now).

#### Day 6 — Session lifecycle
1. Session start → boot Yoga tree, mount editor + chat + chrome.
2. Session shutdown → cleanup terminal, dispose Yoga tree, free Yoga nodes.
3. New session (`/sumo:tabs new`) → reset chat, reset editor.

#### Day 7 — Extension warning for non-SumoCode (Q2:C)
1. `src/sumo-tui/pi-compat/foreign-extension-warning.ts`:
   - Detect 3rd-party extensions on session_start.
   - Emit one-shot warning notification.
   - Their setHeader/setFooter/etc. become no-ops with logged debug message.
2. Edge case 6.1, 6.2 covered.

### Tests (unit)
- `region-registry.test.ts`: slot routing.
- `extension-ui-adapter.test.ts`: every Pi extension UI method tested.
- `foreign-extension-warning.test.ts`: warning fires once per foreign extension.

### Tests (headless integration)
- `test/integration/sumo-interactive-boot.test.ts`: boot sumocode in pty, verify all elements render.
- `test/integration/slash-commands.test.ts`: type `/res`, verify suggestions.
- `test/integration/session-lifecycle.test.ts`: start, send message, shutdown, verify cleanup.

### Tests (VHS)
- `cathedral-full-boot.tape` — full session with all elements.
- `cathedral-slash-commands.tape` — autocomplete dropdown.

### Visual approval gate
User runs full daily session — sends messages, runs slash commands, opens command palette, switches sessions. Confirms feature parity with pre-sumo-tui SumoCode.

### Edge cases covered
- 6.x (3rd-party extensions — warning + no-op)
- 14.x (slash commands)
- 16.1 (Pi 0.70.x patch versions — pin tested)

### File structure
```
src/sumo-tui/pi-compat/
├── sumo-interactive-mode.ts (vendored fork ~500 lines)
├── region-registry.ts
├── extension-ui-adapter.ts
└── foreign-extension-warning.ts
```

### Acceptance criteria
- [ ] All SumoCode extensions work identically
- [ ] All slash commands work
- [ ] Ctrl+P opens our palette (no conflict)
- [ ] Foreign Pi extensions warn + no-op cleanly
- [ ] Pi 0.70.0, 0.70.1, latest 0.70.x all pass smoke tests
- [ ] User daily-drive approval

### Risk register update
- **Risk**: Pi's interactive-mode internal API changes in 0.70.x patch release. Probability: med. Mitigation: pinned + smoke tests.
- **Risk**: Pi's extension API has hidden assumptions about pi-tui. Probability: med. Mitigation: extensive `extension-ui-adapter` tests against all current Pi extensions in user's `~/.pi/agent/extensions/`.

---

## Phase 5 — Cathedral parity (6 days)

### Goals
Migrate every cathedral element to sumo-tui's flex layout. Splash, top chrome, footer, sidebar, modals, input frame, hint row.

By end of Phase 5: SumoCode looks identical to current state but ALL layout is via Yoga. No more manual padding math.

### Tasks

#### Day 1 — Splash via Yoga flex
1. `src/sumo-tui/cathedral/splash-tree.ts`:
   - Root: column flex.
   - TopSpacer: flexGrow=1.
   - SplashContent (cat + wordmark + quote): fixed height.
   - BottomSpacer: flexGrow=1.
   - Result: vertical centering. No CHROME_RESERVED_ROWS hack.

#### Day 2 — Top chrome + footer pin
1. `src/sumo-tui/cathedral/top-chrome.ts` — fixed-height header at top.
2. `src/sumo-tui/cathedral/footer.ts` — fixed-height footer at bottom.
3. Root tree: column flex with [top, content (flexGrow=1), footer]. Footer naturally pinned.

#### Day 3 — Sidebar dock + overlay
1. `src/sumo-tui/cathedral/sidebar-tree.ts`:
   - Width >= 120: row flex with chat (flexGrow=1) + sidebar (49 cols fixed).
   - Width < 120: chat full-width, sidebar overlay via absolute positioning + backdrop dim.
2. Adaptive based on `useTerminalDimensions` hook.
3. Edge case 3.2 covered.

#### Day 4 — Modal layer (approval, palette, memory editor)
1. `src/sumo-tui/widgets/modal-layer.ts`:
   - Absolute-positioned overlay above all other content.
   - Backdrop dim via half-step bg color.
   - Centered content with rounded border.
   - Focus trap.
2. Migrate approval modal, command palette, memory editor.

#### Day 5 — Input frame + hint row
1. `src/sumo-tui/cathedral/input-frame.ts`:
   - Carved frame with `┌─ SCRIPTOR INPUT ─┐` label (splash) or `┌─ INPUT ─┐` (active).
   - Inner padding row above/below editor leaf (mirrors Stitch p-4).
   - Recess background via Yoga node bg color.
2. `src/sumo-tui/cathedral/input-hints.ts`:
   - `┌─ INPUT PROTOCOL AWAITING COMMAND        TAB · AGENTS  CTRL+P · COMMANDS`.
   - Active state: just keybind hints.

#### Day 6 — Theme integration + polish
1. CATHEDRAL_TOKENS feed into all Yoga nodes' colors.
2. Theme switching (`/sumo:theme`) full repaint via cache invalidation.
3. State-driven colors (READY/MEDITATING/ILLUMINATING/etc.) propagate.
4. Edge cases 4.x covered.

### Tests (unit)
- `splash-tree.test.ts`: vertical centering at various heights.
- `sidebar-tree.test.ts`: dock vs overlay based on width.
- `modal-layer.test.ts`: focus trap, escape, result emission.
- `input-frame.test.ts`: label + carved frame at various widths.
- Edge cases covered: 3.x, 4.x, 17.x.

### Tests (headless integration)
- `test/integration/cathedral-full.test.ts`: full session boot, verify every element.

### Tests (VHS)
- `cathedral-portrait.tape` — Mac mini portrait
- `cathedral-landscape.tape` — MacBook landscape
- `cathedral-narrow.tape` — < 120 cols (sidebar overlay)
- All 19 existing tapes still pass.

### Visual approval gate
User runs sumocode in portrait + landscape + narrow. Per-tape screenshot approval. Should match Stitch mockups.

### Edge cases covered
- 3.x (resize)
- 4.x (theme)
- 11.x (distribution sanity)
- 17.x (sneaky ones)

### File structure
```
src/sumo-tui/cathedral/
├── splash-tree.ts
├── top-chrome.ts
├── footer.ts
├── sidebar-tree.ts
├── input-frame.ts
├── input-hints.ts
└── (tests)

src/sumo-tui/widgets/
└── modal-layer.ts
```

### Acceptance criteria
- [ ] Splash centered at any terminal height
- [ ] Footer pinned to last row at any terminal height
- [ ] Sidebar adaptive (dock ≥ 120, overlay < 120)
- [ ] All cathedral modals migrate cleanly
- [ ] All 19 VHS tapes pass at expected screenshots
- [ ] User daily-drive approval

---

## Phase 6 — Hardening + extraction decision (10 days, daily-drive)

### Goals
Live with sumo-tui for 1-2 weeks. Find what breaks. Decide whether to extract as `@sumodeus/sumo-tui` package.

### Tasks

#### Week 1 — Daily drive on Mac mini + MacBook
- Use SumoCode for all coding for 5+ days.
- Track issues in `docs/research/sumo-tui-daily-drive.md`.
- Fix P0 issues immediately (cursor regressions, crashes).
- Note P1/P2 for backlog.

#### Week 2 — Performance profiling + fixes
- Profile cold-start (target < 200ms after Pi boot).
- Profile streaming render (target 60fps with no frame drops).
- Profile RSS over time (target < 300MB after 1h session).
- Fix any perf P0s.

#### Day 9 — No-fork attempt (Q4:C)
- Audit Pi 0.70 public API for clean injection point.
- If `setRenderer` or similar exists: spike replacing the fork with extension-only path.
- If success: delete fork, use extension. If fail: continue with fork.

#### Day 10 — Extraction decision
- Check criteria:
  - Daily-drove for 7+ days without breaking changes ✓
  - Other consumers asking? (probably no)
  - We want community feedback? (decide)
- If extract: `@sumodeus/sumo-tui` package + npm publish + README.
- If not extract: stay bundled. Document re-evaluation date.

### Tests
- All previous tests pass.
- Add: `test/perf/cold-start.bench.ts`, `test/perf/streaming.bench.ts`.

### Visual approval gate
N/A — this is the gate itself. User decides after daily drive.

### Edge cases covered
- 9.x (memory)
- 11.x (distribution)
- 16.x (Pi version) — final pinning decision
- All P3 edge cases triaged

### Acceptance criteria
- [ ] 7 days daily drive without P0 issues
- [ ] Cold start < 200ms post-Pi-boot
- [ ] Streaming 60fps no drops
- [ ] RSS < 300MB after 1h session
- [ ] Extraction decision documented (extract or not + why)

---

## Phase 7 (deferred) — 3rd-party Pi extension support (4 days)

Triggered when:
- A 3rd-party Pi extension's user complains about SumoCode.
- We want to publish sumo-tui as public package.

### Tasks
1. Audit current SumoCode foreign-extension-warning logs.
2. Implement full `setHeader/setFooter/setWidget/custom` for foreign extensions.
3. Test with all current Pi extensions in `~/.pi/agent/extensions/`.
4. Document compat matrix.

---

## Cross-phase concerns

### Branch strategy
- `feat/sumo-tui-phase-N` per phase.
- Merge to `main` after acceptance gate.
- `main` always works for daily drive.
- Phase rollbacks: revert merge commit.

### Test strategy summary
- **Unit**: every layout/render/diff function. Vitest. ~150 new tests by Phase 5.
- **Headless integration** (Q5:B): pty harness for fragile bits — terminal lifecycle, cursor, streaming, autocomplete. ~30 new tests.
- **VHS**: visual regression. ~25 new tapes by Phase 5.
- **Manual**: per-phase user screenshot approval gate.

### Documentation deliverables
- `docs/adr/0001-sumo-tui-framework.md` (Phase 0)
- `docs/sumo-tui/architecture.md` (after Phase 2)
- `docs/sumo-tui/pi-compat-api.md` (after Phase 4)
- `docs/sumo-tui/cathedral-tokens.md` (after Phase 5)
- `docs/sumo-tui/CHANGELOG.md` (Phase 6)

### Memory / cache strategy
- Cell buffer: pool of reusable Cell objects, reset between frames.
- Yoga nodes: explicit `using` blocks for auto-cleanup. Periodic leak audit.
- Frame diff: O(W·H) per frame. Acceptable.
- ScrollBox content: virtualize after 200 messages (edge 9.1).

### Performance budgets
- Cold start: < 200ms (post-Pi-boot)
- Idle frame: 0fps (event-driven)
- Streaming frame: 60fps target, 30fps acceptable
- RSS at idle: < 150MB
- RSS at 1h session: < 300MB

### Extension migration risk
Other Pi extensions might be using SumoCode-as-extension while we rewire. Phase 4 risk. Mitigation: foreign-extension-warning + maintain a list of known extensions to test against.

### Telemetry / debugging
- `~/.sumocode/sumo-tui.log` for verbose layout/render logs (gated by `DEBUG=sumo-tui`).
- `Ctrl+Shift+D` (Pi's debug key) → dump current Yoga tree to log.
- `--inspect-tree` CLI flag for layout debugging.

---

## What to file as GitHub issues for Phase 0

After ADR is merged, file these issues (one per phase) on `dhruvkelawala/sumocode`:

### Issue: feat: sumo-tui Phase 1 — terminal lifecycle + mouse SGR
Acceptance criteria from Phase 1 above + edge case IDs 5.1, 5.3, 5.4, 5.5, 8.3, 10.1.
~3 days. Blocks: Phase 2.

### Issue: feat: sumo-tui Phase 2 — layout + compositor MVP
Acceptance criteria from Phase 2 + edge case IDs 1.x, 9.2-3, 11.1, 12.x, 15.x.
~6 days. Blocks: Phase 3.

### Issue: feat: sumo-tui Phase 3 — ScrollBox / ChatPager
Acceptance criteria from Phase 3 + edge case IDs 2.x, 9.1, 13.1-2, 17.4.
~5 days. Blocks: Phase 4.

### Issue: feat: sumo-tui Phase 4 — SumoInteractiveMode fork
Acceptance criteria from Phase 4 + edge case IDs 6.x, 14.x, 16.1.
~7 days. Blocks: Phase 5.

### Issue: feat: sumo-tui Phase 5 — Cathedral parity
Acceptance criteria from Phase 5 + edge case IDs 3.x, 4.x, 11.x, 17.x.
~6 days. Closes: all current cathedral element issues that depend on layout.

### Issue: meta: sumo-tui Phase 6 — daily drive + extraction decision
Tracking issue, kept open during daily drive. Closed when extraction decision made.

### Issue: feat (deferred): sumo-tui Phase 7 — 3rd-party Pi extension full compat
Open but deferred. Activated when triggered.

---

## Bottom line

**Total realistic effort: 5-7 working weeks across 8-10 calendar weeks.**

**End state**: SumoCode owns the terminal like OpenCode does — full altscreen, in-app scroll, mouse, modals, sidebar reflow, vertical-centered splash, footer pinned to last row, no escape leakage on exit. All while keeping Pi's editor + agent + extension API as battle-tested utilities.

**Next concrete step**: Phase 0 deliverables. Two pieces:
1. Write ADR.
2. File 5 GitHub issues with acceptance criteria.

I can do both as the next session's work.
