# ADR 0001 — Build Sumo-Tui as a Node-native retained renderer for SumoCode

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-27 |
| **Deciders** | @dhruvkelawala |
| **Supersedes** | (none) |
| **Superseded by** | (none) |

## Context

SumoCode is a Pi extension that wraps `@mariozechner/pi-coding-agent` with a custom UI. After ten cathedral elements shipped against Pi's render model, we hit a structural ceiling. The pi-tui rendering library is a vertical line-concatenation `Container` (no flex layout, no in-app scroll, no sticky-bottom, no mouse routing). Workarounds keep accumulating:

- Manual padding math for splash centering (`CHROME_RESERVED_ROWS = 16`) that fails at unknown terminal heights.
- Footer floats wherever Pi's linear renderer puts it instead of pinning to the last row.
- Mouse scroll wheel translates to arrow keys in altscreen → Pi binds arrows to history → user can't scroll chat.
- Wrapping Pi's `CustomEditor` in chrome breaks `CURSOR_MARKER` positioning subtly.
- Cleanup escape sequences (kitty keyboard pop, modifyOtherKeys off) leak into the shell on signal exit.

We want SumoCode to "own the terminal" the way [anomalyco/opencode](https://github.com/anomalyco/opencode) does — full altscreen takeover, in-app chat scrollback with sticky-bottom, mouse routing, modal layers, sidebar reflow. None of that is possible with pi-tui's render model. We need a layout-aware retained renderer.

Three competing paths were evaluated in `docs/research/sumo-tui-spike/`:

| Path | What | Effort | Trade-off |
|---|---|---|---|
| Stay on pi-tui + workarounds | Padding math, padding hacks | Per-element forever | Polish ceiling; incumbent regressions |
| Use [opentui-island](https://github.com/benvinegar/opentui-island) as runtime dep | OpenTUI components inside pi-tui via Bun sidecar IPC | Days for prototype, weeks for full coverage | ~120ms cold start / island, ~100MB RSS, fixed-height surface limit, bus factor 1 |
| Build sumo-tui (this ADR) | Node-native retained renderer with Yoga layout, owns altscreen + scroll + mouse, wraps Pi's editor as a leaf | ~38 working days, 8–10 calendar weeks | Maintenance ownership; correctness depends on Pi internals stability |

Four codebases were studied in detail for patterns to adopt or avoid (`docs/research/sumo-tui-spike/01-opencode.md`, `02-opentui.md`, `03-opentui-island.md`, `04-pi-tui.md`).

## Decision

**Build `sumo-tui` as a Node-native retained renderer bundled inside SumoCode (`src/sumo-tui/`)** with this scope:

1. **Sumo-tui owns**: altscreen lifecycle, signal cleanup, mouse SGR routing, layout (Yoga flex), cell buffer compositor, ANSI line writer, frame diff, in-app scroll (ScrollBox), modal layer, splash centering, footer pinning, sidebar dock/overlay.

2. **Sumo-tui reuses Pi as battle-tested utilities**: `keys.js` kitty/modifyOtherKeys parser (1500 lines), `terminal-image.js` capability detection + image protocols, `ProcessTerminal` raw mode + paste handling, `CustomEditor` wrapped as a `PiEditorLeaf` (autocomplete + slash commands + IME + history all preserved), `kill-ring`, `undo-stack`, `fuzzy`.

3. **Sumo-tui forks `interactive-mode.js`** from `pi-coding-agent` to inject the new renderer at the TUI boundary. The fork is small and pinned (Q4:A). Phase 6+ attempts a no-fork path via Pi's public API if a clean injection point exists (Q4:C).

4. **API style**: imperative core (Pi-tui-compatible Component contract) for v1. React reconciler optional Phase 6+ (deferred).

5. **Distribution**: bundled inside `src/sumo-tui/` for v1. Extract as `@sumodeus/sumo-tui` only when (a) 30+ days of API stability, (b) a second consumer requests it, or (c) we want community feedback.

6. **Pi extension API**: SumoCode's own extensions work in v1 (Q2:C). Foreign Pi extensions get a one-shot warning notification + no-op for `setHeader/setFooter/setEditorComponent/setWidget`. Phase 7 adds full compat when triggered.

7. **Cross-platform**: macOS only for v1 (Q6:A — Mac mini portrait + MacBook landscape). Linux/Windows when extracted as public package.

8. **Streaming render budget**: adaptive frame scheduler — 60fps coalescing during streaming, event-driven (idle 0fps) otherwise (Q3:D).

9. **Verification**: unit tests + VHS visual tapes + headless integration tests via `node-pty` (Q5:A+B).

10. **Cursor model**: `PiEditorLeaf` re-scans Pi's render output for `CURSOR_MARKER`, remaps `(leaf_row, leaf_col)` → `(frame_row, frame_col)` using the leaf's Yoga-computed origin. If drift > 1 frame per input becomes unacceptable, fall back to a sumo-tui native textarea (Q1:B fallback) — losing autocomplete but recovering correctness.

## Consequences

### Positive

- Fixes the unsolved problems: footer pinning, splash centering, mouse scroll, in-app chat scrollback, clean signal exit.
- Brings cathedral chrome to OpenCode-tier polish without rewriting Pi's editor / agent / extension API.
- Yoga flex layout means terminal-resize handling is correct by construction.
- `~/.sumocode/sumo-tui.log` + `Ctrl+Shift+D` debug overlay give us layout introspection.
- Sumo-tui bundled inside SumoCode means we control velocity. No external API stability commitments in v1.
- Retained tree + cell pool + adaptive scheduler give us a clear performance budget (cold start < 200ms, streaming 60fps, RSS < 300MB after 1h).
- The "Pi as utility" approach means we inherit Pi's keyboard parser, image protocols, paste handling — code we'd otherwise have to write and maintain ourselves.

### Negative

- **Ownership burden**: ~38 working days of focused work to reach v1. Maintenance burden continues after.
- **Pi version drift risk**: forking `interactive-mode` means Pi 0.70.x patch releases could break our fork. Mitigation: pin to specific Pi patch, monthly smoke tests, Phase 6 attempt to remove fork.
- **Foreign extension regression**: Pi extensions other than SumoCode's lose their UI hooks in v1 (warning + no-op). Phase 7 deferred.
- **Editor cursor risk**: if PiEditorLeaf cursor remap is unreliable, fallback path (Q1:B) loses autocomplete + slash commands. Mitigation: feature flag, daily-drive validation.
- **Cross-platform lag**: macOS only v1. Users on Linux/Windows wait for public package release.
- **Test surface growth**: adds ~150 unit tests + ~30 headless integration tests + ~25 VHS tapes. Slower CI.
- **Bun sidecar option ruled out**: although Dhruv has Bun installed everywhere, the sidecar pattern's per-island ~120ms boot delay + ~100MB RSS doesn't scale to our 4+ chrome regions. We took the OpenCode lesson (own the terminal in-process) over the opentui-island lesson (sidecar islands).

### Neutral

- We become a contributor to the OpenCode pattern playbook. If/when we extract sumo-tui, we'll publish architecture notes referring back to anomalyco/opencode and sst/opentui as our intellectual lineage.
- ScrollBox + sticky-bottom + manual-scroll flag is OpenCode's exact pattern (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1058-1075`). We're adopting it verbatim with citations in code comments.

## Alternatives Considered

### Alternative 1 — Stay on pi-tui with padding hacks

**Why rejected**: After 10 cathedral elements + multiple footer/splash regressions, the workaround cost per element is high and accumulating. Hard ceiling at the absence of flex / in-app scroll. Mouse scroll vs altscreen is fundamentally unsolvable without us implementing scroll routing.

### Alternative 2 — Use opentui-island as runtime dependency

**Why rejected**: 

- Each island spawns a Bun sidecar with ~120ms cold start. Four chrome regions = 4 sidecars = ~500ms boot delay.
- ~100MB RSS per island. Daily-driver budget exceeded.
- `PiTuiSurface` is fixed-height — opentui-island does not own viewport layout. Footer pinning still requires our own height management.
- Bus factor 1 (one contributor, 2 stars). Maintenance risk.
- Pattern is good (we steal the `Surface` bridge concept). Runtime as dependency is overkill.

### Alternative 3 — Fork pi-mono and patch pi-tui

**Why rejected**: 

- Adds flex layout + in-app scroll to pi-tui upstream. Touches code Mario maintains.
- Pi-mono blocks AI-filed PRs by policy. Patches would have to go through Dhruv manually.
- Rebase tax forever, every Pi release.
- Doesn't solve the "we need to own the renderer" architectural goal — we'd still be a Pi extension at the mercy of Pi's render model.

### Alternative 4 — Replace Pi entirely (build sumocode-cli on pi-agent-core + OpenTUI)

**Why rejected**:

- pi-agent-core + pi-ai are excellent (LLM + sessions + tools + MCP). Replacing pi-coding-agent would mean re-implementing the entire extension API surface, which is what binds SumoCode to the broader Pi ecosystem.
- 3-4 weeks for a barely-functional replacement. Months to match feature parity.
- Loses Pi extension distribution (`pi update && pi`).
- High risk for low marginal gain over the chosen sumo-tui approach.

### Alternative 5 — Wait for Pi to add flex layout upstream

**Why rejected**:

- Speculative. No public roadmap from Mario indicates flex is planned.
- Even if added, our cursor / scroll / mouse routing requirements likely exceed what an upstream patch would satisfy.
- Time spent waiting is time SumoCode has the ceiling problem.

## References

### Research artifacts

- `docs/research/sumo-tui-spike/01-opencode.md` — anomalyco/opencode chat scrollbox + altscreen + mouse + sidebar reflow + textarea + autocomplete (~32 KB, file:line citations)
- `docs/research/sumo-tui-spike/02-opentui.md` — `@opentui/core` renderer + Yoga + Bun FFI/Zig dependencies
- `docs/research/sumo-tui-spike/03-opentui-island.md` — Surface bridge + Bun sidecar JSON-lines IPC + frame transport
- `docs/research/sumo-tui-spike/04-pi-tui.md` — pi-tui internals + integration boundary
- `docs/research/sumo-tui-spike/SUMO_TUI_RESEARCH_AND_SPEC.md` — synthesis + roadmap
- `docs/research/sumo-tui-spike/EDGE_CASES.md` — 52 edge cases across 17 categories
- `docs/research/sumo-tui-spike/IMPLEMENTATION_PLAN.md` — phase-by-phase breakdown with daily tasks, tests, gates
- `docs/research/CANONICAL_REPOS.md` — reference repo URLs

### External sources

- anomalyco/opencode — `https://github.com/anomalyco/opencode`
- sst/opentui — `https://github.com/sst/opentui`
- benvinegar/opentui-island — `https://github.com/benvinegar/opentui-island`
- Dhruv's fork of opentui-island — `https://github.com/dhruvkelawala/opentui-island`
- badlogic/pi-mono — `https://github.com/badlogic/pi-mono`

### Cathedral product context

- `docs/ui/CATHEDRAL_DECISIONS.md` — 10 cathedral elements locked in grill-me
- `docs/ui/CATHEDRAL_UX_SPEC.md` v2 — mockup-anchored spec
- `docs/ui/stitch/cathedral/v1-html/splash.html` — Stitch HTML mockup ground truth

### Visual

- `~/.agent/diagrams/sumo-tui-implementation-plan.html` — phase grid + verification matrix + perf budgets

## Decisions matrix (locked)

| ID | Question | Answer | Rationale |
|---|---|---|---|
| Q1 | Editor leaf cursor | A (PiEditorLeaf + remap) | Pi editor is years of edge cases; cursor remap is ~50 lines |
| Q1-fallback | If A fails | B (native textarea) | Lose autocomplete to recover correctness |
| Q2 | Pi extension API | C (SumoCode-only v1, Phase 7 deferred) | Bound v1 scope; expand on demand |
| Q3 | Streaming budget | D (adaptive 60fps/idle) | OpenCode pattern; Pi already event-driven |
| Q4 | Pi version + fork | A then C (pin 0.70.x; no-fork after Phase 6) | Predictability first, simplification later |
| Q5 | Verification | A + B (unit + VHS + headless integration) | Catch fragile bits via pty harness |
| Q6 | Cross-platform | A (macOS v1) | Daily-drive both machines; cross-platform when public |

## Implementation phases

| Phase | Days | What ships |
|---|---|---|
| 0 | 1 | This ADR + 5 GitHub issues + Pi version pin |
| 1 | 3 | Terminal lifecycle + mouse SGR proof |
| 2 | 6 | Layout + compositor + PiEditorLeaf MVP |
| 3 | 5 | ScrollBox + ChatPager (the OpenCode trick) |
| 4 | 7 | SumoInteractiveMode fork + extension UI adapter |
| 5 | 6 | Cathedral parity (all 10 elements via Yoga) |
| 6 | 10 (drive) | Hardening + perf + extraction decision |
| 7 | 4 (deferred) | 3rd-party Pi extension full compat |

Total: ~38 working days across ~8–10 calendar weeks.

## Status notes

- 2026-04-27 — Drafted, accepted by @dhruvkelawala. Phase 0 issues filed. Phase 1 sprint begins.
- (revisit dates / re-evaluations to be appended below)
