# Verification Harness Spec

**Status**: proposal · 2026-04-28
**Author**: Zeus
**Context**: User reports "UX is 50% there. Many things broken." Existing harness ships broken UX to user despite green CI. This spec closes the gap.

---

## TL;DR

We have **good foundations** (376 unit tests, 14 integration tests via spawn-pi-pty, 31 VHS tapes, diagnostic CPU harness) but **bad coverage** of the actual UX surface. Of 31 VHS tapes, **only 1 drives the real runtime** (`sumo-tui-real-runtime.tape`, just landed in #66). The rest drive demo extensions through code paths users never hit. That's how 8 fix-PRs in a row "looked good in CI" while the real UX stayed broken.

**The fix is a 6-tier verification harness**, ordered by ROI given the current state. Tier 1–3 close the user-visible gap in ~5 days. Tiers 4–6 are hardening that pay off over weeks.

---

## What we have today

| Layer | Count | Status | Real value |
|---|---|---|---|
| Unit (`vitest run`) | 376 tests, 74 files | ✅ green, fast | High for isolated logic. Zero for rendered UX. |
| Integration (`spawn-pi-pty`) | 14 tests, 12 files | ✅ green | High for terminal-control invariants (altscreen enter/exit, escape leakage, cursor visibility). Limited for visual layout. |
| VHS tapes | 31 tapes | mostly demo-driven | **Low**. 30/31 drive `pnpm exec tsx demo/*.ts` not `./bin/sumocode.sh`. False confidence. |
| Real-pty VHS (#66) | 1 tape | ✅ in tree | **High**. Boots actual runtime, captures splash/active/exit. Canonical pre-merge check. |
| `diagnose-sumo-tui-cpu.mjs` | 1 script | ✅ in tree | High for CPU/RSS regressions. Caught the 100% CPU peg in #53. |
| `scripts/visual.mjs` | 1 batch runner | ✅ in tree | Renders all tapes. No diffing. |
| Performance benches | ad-hoc | scattered | Low. No baseline tracking. |

### Gaps that explain "50% broken"

1. **No golden-image diff.** A render regression has to be eyeballed in PR review. Eyes are tired at 1am. Bugs ship.
2. **Demo extensions ≠ real runtime.** Demos render through a different code path (no `chatContainer.render` override, no Pi widget mounts). They missed the ghost-shell architectural bug entirely.
3. **No scenario library.** Each fix lands one tape. The "happy path" of users (10 messages with code blocks, mouse selection, /think cycle, narrow terminal during an approval modal) is uncovered.
4. **No daily-drive telemetry.** When the user hits a bug we lose evidence: terminal scrollback rolls off, RSS/CPU snapshots aren't captured, exact escape sequences aren't logged. Reproducing means asking the user to re-trigger.
5. **No record-replay.** A bug seen once on the user's MacBook can't be deterministically reproduced on the Mac mini.
6. **No fuzz.** ANSI parser bugs, mouse-event edge cases, resize-during-stream — all currently caught only when a user happens to hit them.

---

## Proposed harness — six tiers

Ordered by ROI. Each tier is independent, ships behind a single PR, and is gated in CI once added.

### Tier 1 — Real-runtime smoke matrix (1 day)

**Premise**: The real-pty tape is the canonical pre-merge check; one tape isn't enough. Build the matrix.

**Deliverables**:
- `docs/visual/real-runtime/` directory of tapes that ALL drive `./bin/sumocode.sh`:
  - `01-splash.tape` — splash visible, cursor visible, theme bg painted
  - `02-active-empty.tape` — input box ready, sidebar dock visible
  - `03-after-one-message.tape` — single user message rendered cleanly
  - `04-after-five-messages.tape` — 5 messages, no scrollback ghosts (#67 reproducer)
  - `05-with-code-block.tape` — fenced code rendered, no layout break
  - `06-narrow-60col.tape` — sidebar overlay mode at 60 cols
  - `07-portrait-40x100.tape` — Mac mini portrait dims
  - `08-landscape-160x40.tape` — MacBook landscape dims
  - `09-after-resize.tape` — start at 80x24, resize to 120x40 mid-session
  - `10-clean-exit.tape` — Ctrl+C → no escape leakage
- `pnpm test:visual` → runs all, dumps PNGs to `docs/visual/out/real-runtime/`
- CI gate: `pnpm test:visual` must produce all 10 PNGs without errors

**Tools**: VHS, existing `scripts/visual.mjs` (extend to handle the matrix).

**Why first**: Costs the least. Surfaces 80% of the broken UX immediately. The user can eyeball 10 PNGs in 30 seconds.

---

### Tier 2 — Golden-image diff (1.5 days)

**Premise**: PNG diffing turns "eyeball every render" into "CI fails on visual change."

**Deliverables**:
- Add `odiff-bin` (Rust pixel-diff, ~10ms per image, anti-aliasing-aware): `pnpm add -D odiff-bin`
- `docs/visual/golden/real-runtime/*.png` — committed reference images for each Tier 1 scenario
- `scripts/visual-diff.mjs`:
  - For each tape in Tier 1, render → diff against golden
  - Threshold: `--antialiasing --threshold 0.02` (2% pixel tolerance for font hinting variance)
  - Output: `docs/visual/diff/<scenario>.png` highlighting changed pixels
  - Exit non-zero if any diff > threshold
- `pnpm test:visual --update` updates goldens (with confirmation prompt to prevent accidents)
- CI gate: `pnpm test:visual` must show zero diffs

**Tools**: VHS + `odiff-bin` + node script. Optionally `pixelmatch` as fallback (slower but pure JS).

**Edge cases handled**:
- Font metric variance across macOS versions → 2% threshold
- Cursor blink phase → tape captures at fixed timestamp via `Sleep` directive
- Terminal-default-bg variance → all goldens render with our explicit OSC 11

**Why second**: Turns Tier 1 from "manual review" into "automated gate." Catches every cathedral-bg / overflow / sidebar-bleed regression we shipped in the last week.

---

### Tier 3 — Scenario DSL + scripted PTY (2 days)

**Premise**: VHS is great for snapshot moments, terrible for sequences with assertions. Build a scenario runner that drives real PTY with input timeline + per-frame assertions.

**Deliverables**:
- `test/scenarios/` directory of `.scenario.ts` files. Each scenario is:
  ```ts
  scenario("ghost-shell-issue-67", async (pty) => {
    await pty.expect(/SumoCode/);                   // splash visible
    await pty.send("hello\r");                       // first message
    await pty.send("write a code block\r");          // triggers code render
    await pty.expect(/```/);
    await pty.send("/clear\r");
    await pty.assertNoGhostShells();                 // custom matcher
    await pty.assertScrollbackContains(["SumoCode"]).only(1); // exactly one shell
  });
  ```
- Custom matchers in `test/scenarios/matchers.ts`:
  - `assertNoGhostShells()` — counts `INPUT` boxes in scrollback, fails if > 1
  - `assertScrollbackContains(token).only(N)` — token frequency assertion
  - `assertCellAt(row, col, { fg, bg, ch })` — pixel-level
  - `assertCursorAt(row, col)`
  - `assertNoEscapeLeak()` — scrollback has no raw `\x1b[` after exit
  - `assertRSSBelow(MiB)`
  - `assertCPUIdleBelow(percent, durationMs)`
- `xterm-headless` parses PTY output into a virtual screen for cell-level assertions
- `pnpm test:scenarios` — runs all scenarios, parallelized
- CI gate: green required for merge

**Tools**:
- `node-pty` (already used) — direct PTY spawn
- `@xterm/headless` — terminal emulator without DOM, exposes buffer API
- `vitest` runner with custom matchers
- `strip-ansi` for plain-text assertions

**Sample scenario set (initial)**:
1. `splash.scenario.ts` — splash boot + cursor
2. `single-message.scenario.ts` — type + send + see response
3. `ghost-shell.scenario.ts` — #67 reproducer, hardened
4. `code-block.scenario.ts` — fenced render, no overflow
5. `mouse-selection.scenario.ts` — drag → OSC 52 emitted
6. `narrow-resize.scenario.ts` — 60→120 cols mid-stream
7. `slash-think.scenario.ts` — /think cycles thinking levels
8. `ctrl-t-keybind.scenario.ts` — Ctrl+T cycles thinking (currently broken, this catches it)
9. `approval-modal.scenario.ts` — tool call → modal → approve → tool runs
10. `clean-exit.scenario.ts` — Ctrl+C → altscreen exit + no leakage

**Why third**: Catches *behavioral* bugs that visual diffs can't. The Ctrl+T bug we know exists today would fail `slash-think` → `ctrl-t-keybind` would fail differently → triage is automatic.

---

### Tier 4 — Daily-drive telemetry (1 day)

**Premise**: Most bugs are seen once, hard to reproduce. Capture forensics automatically.

**Deliverables**:
- `SUMO_TELEMETRY=1` env opts in (default off for privacy; on locally for self)
- Runtime hooks log to `~/.sumocode/telemetry/<session-id>.jsonl`:
  - `frame_render { width, height, durationMs, dirtyRows }`
  - `pty_write { bytes, escapes }` (escape sequences only, content redacted)
  - `mouse_event { type, button, x, y }`
  - `key_event { key, modifiers }`
  - `error { stack, context }`
  - `rss_sample { rssMiB, ts }` (1Hz)
  - `cpu_sample { cpu, ts }` (1Hz)
- `scripts/telemetry-summarize.mjs <session.jsonl>`:
  - Frame p50/p95/p99
  - Render rate over time (sparkline)
  - Mouse/key event rate
  - Error log
  - Render-vs-RSS correlation
- Auto-rotate after 100 sessions, max 50 MiB on disk
- `~/sumocode-config/handoffs/` snapshot when user runs `/snapshot` slash command

**Tools**: Existing diagnostic infra extended. `pidusage` for CPU sampling.

**Why fourth**: Turns user-reported "it broke" into reproducible forensics in 5 seconds. Makes Tier 5 (record-replay) possible.

---

### Tier 5 — Record-replay (2 days)

**Premise**: A bug seen once on MacBook should be reproducible 10× on Mac mini.

**Deliverables**:
- `pnpm sumocode:record <name>` — wraps `./bin/sumocode.sh` in a recording PTY:
  - Captures input timeline (timestamped keys/mouse)
  - Captures resize events
  - Captures terminal output stream (full byte log)
  - Saves to `recordings/<name>/{inputs.jsonl, output.bin, env.json}`
- `pnpm sumocode:replay <name>` — replays input into a fresh `./bin/sumocode.sh`:
  - Resizes PTY to recorded dims
  - Sends inputs at recorded timestamps
  - Captures replay output stream
  - Diffs replay output vs original output
  - Exit non-zero if mismatch (modulo timestamps and random IDs)
- `pnpm sumocode:replay <name> --golden` — promotes the original output as golden, future replays must match
- Integration with Tier 3 scenarios: a recording can BE a scenario via `import.recording("name")`

**Tools**:
- `node-pty` for record + replay
- `tmate-style` deterministic replay (we own the PTY so this is straightforward)
- `serialize-javascript` for inputs.jsonl

**Use cases**:
- User screenshots a bug → asks me to repro → I ask for a 30-second recording → I have deterministic repro → fix → assert replay passes
- Catch flaky bugs by running replay 100×
- Library of "bugs we've seen" as regression scenarios

**Why fifth**: High value but expensive to build. Tier 4 is a prerequisite (need timeline format).

---

### Tier 6 — Property-based + fuzz (1 day)

**Premise**: Cover the input space we don't think to write tests for.

**Deliverables**:
- `test/property/` — fast-check based properties:
  - **No-leak property**: for any sequence of N keystrokes followed by Ctrl+C, scrollback after exit contains no `\x1b[?` byte sequences
  - **Width invariant**: for any width W in [40, 240], `chatRender.width + sidebarWidth === W`
  - **ANSI parse property**: for any pseudo-random byte sequence written to compositor, `bufferToAnsiLines()` output is parseable by xterm-headless without errors
  - **Mouse event idempotency**: for any sequence of mouse events, internal selection state matches what would be computed from final state alone
  - **RSS bound**: for any sequence of N messages where N ∈ [0, 1000], RSS stays under 250 MiB
- Fuzz scripts:
  - `scripts/fuzz-stdin.mjs` — random byte streams into a real PTY, assert no crash for 10k iterations
  - `scripts/fuzz-resize.mjs` — random resize events at random intervals, assert no layout exception
- CI: 1000 iterations per property, escalate to 100k weekly

**Tools**:
- `fast-check` (already a common Node lib)
- `@xterm/headless` (Tier 3)

**Why sixth**: Catches bugs you don't know exist. Lower priority than Tier 1–3 because we know plenty of bugs DO exist that Tiers 1–3 will surface immediately.

---

## Tooling additions summary

| Tool | Purpose | Tier | Cost |
|---|---|---|---|
| `odiff-bin` | Pixel-diff for golden images | 2 | npm install |
| `@xterm/headless` | Virtual terminal for cell assertions | 3, 6 | npm install |
| `fast-check` | Property-based testing | 6 | npm install |
| `pidusage` | CPU/RSS sampling | 4 | npm install |
| `strip-ansi` | Plaintext assertions | 3 | already a transitive dep |

All are macOS/Linux compatible, no native build issues on Apple Silicon.

---

## Proposed sequencing (1 week of focused work)

| Day | Tier | Outcome |
|---|---|---|
| Day 1 | T1 | 10-tape real-runtime matrix, eyeball check |
| Day 2 morning | T2 | Golden images committed |
| Day 2 afternoon | T2 | `pnpm test:visual` CI gate |
| Day 3 | T3 | Scenario DSL + 5 scenarios |
| Day 4 | T3 | 5 more scenarios, CI gate |
| Day 5 morning | T4 | Telemetry capture |
| Day 5 afternoon | T4 | Telemetry summarize + handoff snapshot |
| Day 6–7 | T5 | Record-replay (next week) |
| Later | T6 | Fuzz + properties |

**By end of Day 4**, the harness is comprehensive enough that the user shouldn't be filing UX bugs anymore — CI catches them first.

---

## What this REPLACES vs ADDS

**Replaces**:
- 30 demo-driven VHS tapes → archive to `docs/visual/legacy-demos/`, leave for reference but never run in CI
- Manual eyeball PR review → automated visual diff

**Adds**:
- 10 real-runtime tapes (T1)
- Golden image diff (T2)
- Scenario DSL with 10+ scenarios (T3)
- Telemetry (T4)
- Record-replay (T5)
- Property/fuzz (T6)

**Keeps**:
- Existing 376 unit tests (high signal for isolated modules)
- Existing 14 integration tests via spawn-pi-pty (good for terminal-control invariants)
- `diagnose-sumo-tui-cpu.mjs` (specialized CPU harness)

---

## Open questions

1. **CI runner**: GitHub Actions macOS runners can render VHS but are slow (~2-3 min per tape). For 10 tapes that's 30 min CI. Acceptable? Alternative: self-hosted Mac mini runner.
2. **Golden update workflow**: how aggressive should `--update` confirmation be? Each scenario individually, or batch?
3. **Telemetry retention**: 50 MiB / 100 sessions sane? Privacy: ensure no session content captured, only metadata + escapes.
4. **Property test runtime**: 1000 iterations × 5 properties × ~100ms = ~10 min. Run on PR or only nightly?

---

## Acceptance criteria for declaring "verification harness complete"

- [ ] Tier 1: 10 real-runtime tapes, all green, eyeball-reviewed by user once
- [ ] Tier 2: 10 goldens committed, `pnpm test:visual` gates CI
- [ ] Tier 3: 10+ scenarios, custom matchers documented, CI gate
- [ ] Tier 4: telemetry capturing, summarize script working
- [ ] Tier 5: at least 3 recordings → replays as regression scenarios
- [ ] Tier 6: 5+ properties, 1k iterations green nightly
- [ ] **Real test**: ship 5 fixes back-to-back without a single user-reported regression. If we hit that, the harness is doing its job.

---

## Risks

| Risk | Mitigation |
|---|---|
| Goldens drift from intentional UI changes | `--update` workflow, PR description must call out visual changes |
| VHS rendering differs across macOS versions | Pin VHS version, document macOS test version |
| Scenario flakiness (timing) | Use `expect(/regex/)` not `sleep` — wait for content |
| Telemetry leaks user content | Redact at capture time; never log message content, only metadata |
| Record-replay non-determinism | Pin time/random sources, use deterministic IDs in test mode |
| CI cost (long runs) | Start with PR-only Tier 1+2, gate Tier 3 on label, run Tier 6 nightly only |

---

## What I'm asking the user

1. **Approve the tiers + sequencing.** Or reject specific ones.
2. **Pick CI runner**: GitHub Actions macOS, or self-hosted Mac mini?
3. **Confirm telemetry privacy stance**: metadata only, never content?
4. **Open issue #69 and commit?** I'll scaffold T1 immediately if greenlit.
