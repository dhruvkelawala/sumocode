## Phase 6 daily-drive blockers (post-#49)

#49 fixed cursor visibility + Pi noise suppression + added perf bench. Daily-drive screenshot still shows three live problems:

### 1. Chat is not scrollable (BLOCKER)

The ChatPager from Phase 3 is implemented + unit-tested + integration-tested with sticky-bottom + mouse wheel + PgUp/PgDn. **But at runtime, mouse wheel does not scroll the chat.** Long responses (e.g., 500-word essay) render the full content inline; user has no way to scroll up.

Likely cause: `SumoInteractiveMode.run()` mounts Pi's chat content into the layout but is NOT routing through sumo-tui's `ChatPager` widget. The ScrollBox infrastructure exists but isn't wired into the actual chat region. Phase 5's region-registry has a `chat` slot — need to mount `ChatPager` there and route Pi's message stream into it.

Fix:
- In `SumoInteractiveMode.run()`, mount a `ChatPager` widget in the chat region instead of letting Pi append Text components directly to chatContainer
- On `message_start` / streaming chunks / `message_end` events, call `chatPager.addMessage()` / `chatPager.appendToLast()` instead of letting Pi's chatContainer handle it
- Mouse wheel events in the chat region should now route to `ScrollBox.scrollBy()` via the input router from Phase 3

Add headless integration test: spawn sumocode in pty, send 50 messages, mouse-scroll up via SGR mouse events, verify scroll offset changes.

### 2. Sidebar layout incomplete vs spec

Sidebar IS rendering (MEMORY + CONTEXT + MCP visible) but missing:
- `REGISTRY` header at the top with `v 1.0.0` version line
- `◆ active` / `▢ inactive` session markers
- Sub-tab indicator showing which of CONTEXT/MEMORY is active (Ctrl+1 / Ctrl+2)
- ❧ memory bullets when memory facts exist (empty Remnic = empty list, OK)

Compare current render against `docs/ui/CATHEDRAL_DECISIONS.md` Element 1 spec.

Fix: in `src/sumo-tui/cathedral/sidebar-tree.ts`, add the missing header rows and active/inactive logic. Should be ~30 lines.

### 3. Performance: cold start + idle RSS misses

From `node scripts/measure-sumo-tui.mjs` (PR #49):

| Metric | Measured | Target | Status |
|---|---|---|---|
| Cold start to first frame | 1023 ms | < 200 ms post-Pi-boot | Miss (includes Pi boot) |
| Idle RSS after 5s | 190.9 MiB | < 150 MiB | Miss |
| Frame p50/p95 | 1.13/1.49 ms | < 8 ms | Pass |
| Streaming RSS peak | 127.7 MiB | < 300 MiB | Pass |
| Streaming render p95 | 9.33 ms | < 16 ms | Pass |

Cold start: the budget was "post-Pi-boot" but the bench measures full spawn-to-first-frame including Pi's startup (model registry load, extension scan). Need to:
- Modify bench script to subtract Pi's bare-boot time (measure `pi --print "hello"` cold start, subtract from total)
- OR document that the 1023ms includes Pi boot and is acceptable

Idle RSS: 190 MiB is over 150 MiB target. Investigate:
- Yoga-wasm-web baseline (likely ~50-80 MiB)
- Pi's own resident set (likely ~80-100 MiB)
- Our retained tree + cell buffer (?)

Profile via Node's `--inspect` heap snapshot. If our delta over Pi's idle RSS is > 50 MiB, that's a real regression to fix. If most of the 190 is Pi's own footprint, raise the target to 200 MiB and document.

## Acceptance criteria

- [ ] Mouse wheel scrolls chat (manual + integration test)
- [ ] PgUp/PgDn scroll chat (manual + integration test)
- [ ] Streaming sticky-bottom still works
- [ ] Sidebar shows REGISTRY header + version + active markers + sub-tab indicator
- [ ] `scripts/measure-sumo-tui.mjs` measures Pi-boot delta separately; documents corrected cold-start delta
- [ ] Idle RSS investigation has concrete attribution; either fix or document raised target
- [ ] All 338 unit + 12 integration tests still pass
- [ ] PR opened with `Closes #50`

## Constraints

- Worktree: `/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-50/` (create from main at `78fd3e8`)
- Don't push to main directly
- Git identity: `dhruvrk2000@gmail.com`
- Time-box: 1 working day

## References

- Phase 3 ScrollBox/ChatPager: PR #42
- Phase 5 cathedral parity (sidebar-tree): PR #46
- #49 cursor + noise + bench: just merged
- Sidebar spec: `docs/ui/CATHEDRAL_DECISIONS.md` Element 1
- ChatPager source: `src/sumo-tui/widgets/chat-pager.ts`
- SumoInteractiveMode: `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
