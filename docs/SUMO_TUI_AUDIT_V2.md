# SumoTUI Audit V2 — 2026-04-30

> Companion to `docs/SUMO_TUI_AUDIT.md` (v1, 2026-04-29). v1 framed strategy; v2 audits the *current* state of `origin/main` (HEAD `828e890`) and recommends a hard convergence.
>
> Scope: code as it exists now, not as the audit-roadmap aspires to be. Includes a survey of OpenCode (anomalyco), Crush (Charm), Claude Code, Aider, Continue, and Cursor CLI to ground the recommendations.
>
> **Explicit non-goal: do not generate new issues.** v1 generated work; v2 subtracts it. If anything in this audit could be filed as an issue, it isn't filed. The point is to declare a finish line, not extend it.

---

## 0. The honest read

In the ~30 hours since v1 audited the kernel as 60% complete, the project shipped:

- #144 structured tool pills (E9)
- #145 mouse selection + OSC 52 (initial)
- #146 code block frames (E10)
- #147 chat word wrap
- #148 V2 spec drift sweep
- #149 skill pills (E9a)
- #150 resume perf < 500ms (closes #143)
- #151 scroll/scribe delegation (E12)
- #152 Divine Query modal (E11) — bugs filed as #162
- #160 layout fixes (closes #157)
- #163 fold tool results into SUMO messages (closes #155)
- #164 transparent message interiors
- approval gate reactivation (closes #137)
- Pi patch strategy doc + portrait policy doc (P0-D, P0-F decisions)
- #72 narrow-width crash closed

Eleven of thirteen surface issues filed in this morning's planning session shipped within the same day. The audit's "P0 + P1 = 7–10 weeks" estimate has been compressed into hours. **The output velocity is not the problem. The methodology produces output faster than feedback can catch its bugs.**

That is the entire content of v2. Everything below is in service of that finding.

---

## 1. Current state, grounded

### Numbers

| Metric | Value |
|---|---:|
| Non-test source files | 93 |
| Test files | 84 |
| Total LOC (excl. tests) | 15,256 |
| Unit tests | 543/543 pass |
| Integration tests | 18/18 pass |
| TypeScript strict | clean |
| Build (`tsc --noEmit`) | clean |
| `pnpm visual:ci` | green (per recent CI runs) |
| Open code-level issues | 6 |
| Open epics / trackers / roadmaps | 4 |
| Spike-debt files | 24 (in `src/spike/`) |

### Directory shape — already clean

```
src/
├── cathedral/        ← legacy hybrid surfaces (input frame, altscreen)
├── commands/         ← slash commands
├── spike/            ← 24 files of debt; many superseded
├── sumo-tui/         ← the kernel (8 well-organized subdirs)
│   ├── cathedral/    ← cathedral renderers using kernel primitives
│   ├── demo/         ← isolated demos
│   ├── input/        ← key router, mouse, selection
│   ├── layout/       ← Yoga + SumoNode
│   ├── pi-compat/    ← Pi seam (chat-viewport-controller, sumo-interactive-mode, region-registry)
│   ├── render/       ← buffer, compositor, diff, primitives, ansi-writer
│   ├── runtime/      ← terminal-controller, frame-scheduler, lifecycle, worker-runtime, resume-profiler
│   ├── testing/      ← TestBackend + Pilot
│   ├── transcript/   ← view-model
│   └── widgets/      ← chat-pager, scrollbox, modal-layer, pi-editor-leaf, notification, chat-message
└── (top-level surfaces: footer, sidebar, splash, top-chrome, command-palette, divine-query, etc.)
```

The kernel directory layout is **as good as anything in the field** (see §4 — Crush, OpenCode, Claude Code all converge on similar shapes). What's missing isn't structure; it's discipline at the seams.

### Open issues — precisely

| # | Type | Honestly: |
|---|---|---|
| **#162** | Bug | Real. Divine Query broken in display + edit modes. Filed today. |
| **#161** | Roadmap | Architectural. Not a v1 blocker. Inventory only. |
| **#159** | Bug | In-flight via PR #165 (UNSTABLE). |
| **#158** | Bug | Real. Jerky scroll. Methodology-bound (force-redraw masks seam). |
| **#156** | Bug | Cosmetic. Tilde leak in hint row. |
| **#154** | Bug | Cosmetic. Autocomplete anchor at col 0. |
| **#138** | Enhancement | Memory editor visual fixture. Editor works; this is verification. |
| **#80** | Epic | V2 parity epic. Mostly already done; close-out task. |
| **#98** | Epic | Audit consolidation. Mostly done; close-out task. |
| **#124** | Tracker | Daily-drive readiness. Should be the closing instrument. |
| **#11, #14, #20, #12** | Pre-V2 | Stale. Either close or migrate. |

**Total real, daily-drive-blocking bugs: two — #162 and #158.** Everything else is either cosmetic, architectural-aspirational, or stale.

---

## 2. What works (no caveats)

This list deserves to exist before any criticism. These are clean, finished, durable:

- **`sumo-tui/runtime/terminal-controller.ts`** — `TerminalSessionOwner` state machine. Single owner, idempotent transitions, OSC 11/12 gated, no-TTY safe. Done.
- **`sumo-tui/runtime/worker-runtime.ts`** — cancellable, exclusive workers. Memory cache, MCP probe ready to use. Done.
- **`sumo-tui/runtime/frame-scheduler.ts`** — event-driven idle, streaming coalescing. Verified no idle-loop wakes. Done.
- **`sumo-tui/runtime/resume-profiler.ts`** — five-stage timing, p95 < 500ms enforced in CI. Done.
- **`sumo-tui/render/{buffer,compositor,diff,primitives,ansi-writer}.ts`** — typed render kernel. Primitives layer used by Cathedral surfaces. Done.
- **`sumo-tui/layout/{node,yoga}.ts`** — Yoga wrapper, SumoNode. Done.
- **`sumo-tui/widgets/chat-pager.ts`** — bulk hydration via `replaceViewModels`, virtual archived count, ring-buffer window. Done.
- **`sumo-tui/widgets/scrollbox.ts`** — sticky-bottom, manual-scroll preservation. Done.
- **`sumo-tui/transcript/view-model.ts`** — `ChatBlock` union covers markdown / code / tool / skill / question / delegation. Done.
- **`sumo-tui/testing/test-backend.ts`** — headless backend + Pilot API. Done.
- **`sumo-tui/input/{key-router,mouse,selection}.ts`** — key dispatch, SGR mouse, OSC 52 copy. Selection precision in flight via #165, otherwise done.
- **`interaction-registry.ts`** — single command/keybind owner with conflict diagnostics. Done.
- **`approval-modal.ts`** — reactivated for dangerous bash patterns; configurable. Done.
- **`memory.ts`, `memory-editor.ts`** — Remnic client and panel editor. Working.
- **Cathedral surfaces:** sidebar, footer, top-chrome, splash, input frame, command palette (Scriptorium). All render to V2 spec at the static fixture level.

This is a substantial codebase. ~15k LOC of typed, tested, mostly-clean TypeScript with a reasonable kernel/surface split. **The bones are good.** That is the difference between v2 and v1.

---

## 3. The methodology gap (the actual finding)

The kernel landed clean. The surfaces are buggy. Why is asymmetric.

### Why the kernel is solid

Every kernel module is **testable in isolation**. `TerminalSessionOwner` has no UI dependency — pure state machine, fully covered by 543 unit tests. `Worker-runtime` mocks the clock. `chat-pager` runs against fake `ScrollBox`. `resume-profiler` has injectable clock + fake stages. The LLM writing this code can run the tests, see them pass, iterate. **The feedback loop is closed.**

### Why the surfaces are fragile

Surface modules — modals, sidebar bleed, autocomplete anchor, tool-event merging, hint row leak — **only fully exercise in real runtime**. Pi events arrive in shapes the LLM hasn't seen. The terminal cursor is at a position only `pi -e .` can produce. Pi's editor consumes mouse events the test backend doesn't emit. The fixture renders the *initial* frame of a modal but never the post-keypress edit-mode frame.

The LLM produces code that:
- Compiles
- Passes 540 unit tests
- Renders correctly in static fixtures
- Has a polished commit message

…and ships broken on the first manual smoke. PR #152 (Divine Query) is the canonical example: 1211 additions, 540 tests passing, fixture green, then the user opens it and the question text bleeds past the modal frame.

**The feedback loop is open.** The LLM never saw the runtime fail.

### What this implies, concretely

Three changes — *methodology, not code* — would catch ~80% of the seam-bug class:

**1. Manual smoke is a hard merge gate for any UI-touching PR.**
Author runs `pi -e .`, exercises the feature once, attaches a screenshot or a "smoke ✓" note to the PR. Costs 5 minutes per PR. Catches: #162, #156, the tilde class, modal-bleed class. Not optional. (For agent-driven PRs: the agent does this *before* declaring done — runs the dev server and at least describes what it observed.)

**2. UI PRs are capped at ~300 lines / 3 files.**
PR #152 was 1211 additions. Bugs hide in surface area no one looked at. Smaller PRs force the author (human or agent) to actually exercise the slice end-to-end. Refactors and kernel work can be larger; UI surfaces cannot.

**3. Fixtures must drive interaction states, not just initial paint.**
`fixture-divine-query-overlay` renders one frame. The display-mode bug from #162 is in that frame, so a fixture *should* have caught it — meaning the fixture either isn't running or isn't asserting on the bg-paint contract. The edit-mode bug requires `Pilot` events. Both gaps are addressable in the existing `TestBackend`.

These three changes are worth more than any P1 architectural slice in #161. They convert the "ships polished + buggy" loop into "ships polished + actually correct."

---

## 4. Three patterns to copy from outside (concrete, low-cost)

The audit's v1 surveyed Bubble Tea / Ratatui / Textual at the abstract level. v2 looks at *actual modern terminal coding agents* (April 2026) and picks the patterns SumoCode would benefit from most.

### A. OpenCode's transport seam (highest leverage)

OpenCode (canonical: `anomalyco/opencode`) decoupled its TUI from its agent runtime via a Hono HTTP server + SSE. The TUI imports zero session/agent code; it only knows a small transport interface. Same renderer drives a Tauri desktop, a web UI, and a VS Code extension.

SumoCode currently couples its renderer directly to Pi's call shapes — `chat-viewport-controller.ts` reaches into `sessionContext`, `installChatViewportBridge` overrides `chatContainer.render`, etc. **The renderer cannot exist without Pi.**

**The cheap version of this pattern:** define a small TypeScript transport interface (pure types, no implementation), implement *one* adapter today against in-process Pi:

```ts
// src/sumo-tui/transport/agent-transport.ts (NEW, ~80 lines)
export interface AgentTransport {
  submitPrompt(text: string): Promise<void>;
  cancelTurn(): Promise<void>;
  subscribeEvents(handler: (event: AgentEvent) => void): () => void;
  getCurrentSession(): SessionSnapshot | undefined;
  // …
}

export type AgentEvent =
  | { type: "message_start"; message: ChatMessageViewModel }
  | { type: "message_chunk"; messageId: string; chunk: string }
  | { type: "tool_call"; toolCall: ToolCallViewModel }
  | { type: "tool_result"; toolCallId: string; result: ToolResult }
  | { type: "session_loaded"; messages: ChatMessageViewModel[] }
  | { type: "approval_required"; request: ApprovalRequest };

// src/sumo-tui/transport/pi-adapter.ts — single implementation today
```

Cost: ~1 week. Touches: ~5 files. No runtime change. No new process. **Zero new dependencies.** What it buys: the renderer becomes Pi-version-drift-resistant (Pi changes its event shape → only `pi-adapter.ts` updates), the test backend becomes a fake adapter (no PTY), and a future remote/headless mode is one new adapter.

This is the **single highest-leverage architectural change** SumoCode could make. It does not require owned-shell mode. It does not invalidate any existing work. It compounds with everything that comes after.

### B. Crush's typed-PubSub message bus

Crush (`charmbracelet/crush`) — the closest agent in shape to SumoCode — runs the agent on a separate goroutine and emits typed events through `internal/pubsub`. A single adapter translates them into `tea.Msg`. SumoCode's equivalent today is direct callbacks from Pi events into renderer methods, sometimes through 2–3 hops of binding.

If pattern A lands, pattern B follows for free: `AgentTransport.subscribeEvents` is a typed pub/sub. Every renderer reaction becomes "handle this `AgentEvent` variant." Removes the implicit ordering dependencies between Pi event handlers (which currently cause the force-redraw used in #158).

**Cost:** subsumed by A. Zero additional work.

### C. Claude Code's StylePool / cached style transitions

Claude Code's leaked Ink fork includes a `StylePool` that caches the ANSI string for transitioning between any two styles. With ~12 cathedral tokens × 12 tokens = 144 transitions, the cache lookup replaces ~50 ANSI byte concatenations per cell. SumoCode's `render/diff.ts` doesn't cache transitions — it emits transitions per cell every frame.

This is a perf optimization, not a correctness fix. **Low priority. Defer indefinitely.** Listed only for completeness; do not pursue until the resume-profiler shows transition cost > 5ms p95 on a 10k-message session, which it currently does not.

---

## 5. What to STOP doing

This is the section v1 didn't have and the project most needs.

- **Stop filing "perfect Bible parity" issues.** The Bible was the design canon for a fresh codebase. The codebase is now mostly there. The remaining gaps (recess bg shading variants, dim color drift, exact gutter widths) are the kind of polish that only matters if a daily-drive shows them as friction. They are not v1.

- **Stop treating fixture failure on cosmetic tokens as P0.** `pnpm visual:ci` is excellent infrastructure but its current default-required crops are too strict. The styled-cell-diff for Bible parity should be a review-only signal until v1 ships, then re-enabled as a regression gate.

- **Stop generating audits, roadmaps, and architecture docs until v1 ships.** This document is the last one until daily-drive lands. v1 gave the project five planning docs (`SUMO_TUI_AUDIT.md`, `SUMO_TUI_CONSOLIDATION_PLAN.md`, `SUMO_TUI_PI_PATCH_STRATEGY.md`, `PI_TOOL_ARCHITECTURE.md`, plus the V2 spec); each was useful in isolation, cumulatively they are tax. Pause.

- **Stop reopening closed surfaces.** The Divine Query was filed → designed → mocked → implemented → closed → broken on smoke → re-filed (#162). If a surface ships and breaks, fix the bug; do not re-design the surface. Resist the urge to grill the design again.

- **Close out aspirational issues that have outlasted their relevance.** Specifically: #11 (parallel-agent UX), #12 (Neovim migration), #14 (cathedral parity parent), #20 (Pi/rhubarb-pi limitations) — these are pre-V2 and either won't-fix or already-satisfied. Closing them removes mental load.

- **Delete `src/spike/`.** 24 files. Most are superseded. Audit each in one sitting: keep what's still imported anywhere, delete the rest. ~1h, removes a real maintenance distraction.

- **Stop launching agents to "audit" or "plan" or "survey".** This audit is the last one. Use the agent tool only for code search, code review, and code generation against a specific scoped task.

---

## 6. The real v1 gate (smallest possible)

Three things actually block daily-drive. Two of them are real bugs; the third is a methodology fix that pays back on every future PR.

### (a) Fix #162 — Divine Query broken (1 day)
Display-mode and edit-mode failures, both rooted in `divine-query.ts`'s overlay sizing + `question-tool.ts`'s edit-mode line padding. Concrete acceptance criteria already in the issue. One sitting.

### (b) Fix #158 — jerky scroll (1–2 days)
Methodology-heavy: the force-redraw masking seam fragments has to be scoped, and event coalescing has to be added at the SGR mouse parser level. Worth doing because scroll is a constant interaction. If it can't ship cleanly in 2 days, defer.

### (c) Adopt the methodology gate (immediate, no code change)
Manual smoke is a merge requirement; UI PRs cap at 300/3; fixtures drive Pilot states. Document this in `CONTRIBUTING.md` once and link it from PR templates.

That's v1. Everything else — including #161, including the OpenCode transport seam, including #154/#156/#138/#159 — is post-v1 polish. They land when they land. They do not block ship.

---

## 7. Score

**Today: 7.5 / 10.** Up from v1's "6/10 today / 8.5/10 after P0 + P1." Most of the P0 + P1 work has shipped (kernel state-machine, interaction registry, workers, primitives, TestBackend, transcript model, drift sweep, resume perf, approval reactivation, Pi patch decision, portrait policy, structured chat blocks). The remaining gap to the audit's 8.5 ceiling is the methodology gate (§3) and one or two surface bugs.

**Two days of work to 8 / 10.** Fix #162 + #158 + adopt the gate. Tag v0.5. Daily-drive for a week.

**The gap from 8 to 9 is dogfood time, not code.** A real daily-driver week reveals which deferred items actually friction (vs which were imagined to). Apply OpenCode's transport seam (§4 A) when energy returns. The 9 → 10 step is extraction, public API, second consumer — explicitly v2+.

---

## 8. Suggested final shape

A concrete plan to ship and walk away (or ship and pause):

1. **Day 0 (today / tomorrow):** Fix #162. Close #156 with a one-line fix or wontfix label. Close #154 with a one-line "Pi-side issue, deferred to upstream" label. Close #138 with a "verified in fixture" label or wontfix. Close stale aspirational issues (§5). Delete `src/spike/`.
2. **Day 1:** Fix #158 OR defer with a clear note. Adopt the methodology gate; write `CONTRIBUTING.md`.
3. **Day 2:** Tag `v0.5.0`. Update README to remove "v0.1 scaffold" framing — the README still says it. Write a 200-word changelog. Push tags.
4. **Day 3 onward:** Daily-drive. Track frustrations in `.local/frustrations.md` (a private file, intentionally low-stakes). Don't open new issues for cosmetic gripes — let them accumulate and decide later if they're real.
5. **Week 2 / Week 3:** Reassess. If real friction shows up, take exactly one slice from #161 (most likely §4 A — the transport seam). Otherwise, leave the codebase alone.

The audit ends here. The rest is execution at whatever pace serves you.

---

## Appendix A — files / modules referenced

| Reference | Status |
|---|---|
| `src/sumo-tui/runtime/terminal-controller.ts` | done (P0-C) |
| `src/sumo-tui/runtime/worker-runtime.ts` | done (P0-G) |
| `src/sumo-tui/runtime/frame-scheduler.ts` | done |
| `src/sumo-tui/runtime/resume-profiler.ts` | done (#143) |
| `src/sumo-tui/widgets/chat-pager.ts` | done (#150 perf) |
| `src/sumo-tui/transcript/view-model.ts` | done (P1-D) |
| `src/sumo-tui/render/primitives.ts` | done (P1-B) |
| `src/sumo-tui/testing/test-backend.ts` | done (P1-C) |
| `src/sumo-tui/input/selection.ts` | in flight (#159 / PR #165) |
| `src/divine-query.ts` | shipped, broken at runtime (#162) |
| `src/spike/**` | debt; delete |

## Appendix B — comparison to other agents

| Agent | Owns altscreen | Renderer | TUI:server seam | What SumoCode should consider |
|---|---|---|---|---|
| OpenCode (anomalyco) | yes | Solid + OpenTUI (Bun) | HTTP + SSE | **Transport seam (§4 A)** |
| Crush (Charm) | yes | Bubble Tea + Lipgloss | typed PubSub | Typed message bus (§4 B) |
| Claude Code | inline | Custom Ink fork + Yoga port | direct in-process | StylePool cache (defer) |
| Aider | inline (no altscreen) | prompt_toolkit + Rich | direct | Validates hybrid-mode value |
| Continue.dev | inline (thin) | Ink | thin | Two-stage SIGINT (cheap) |
| Cursor CLI | yes | proprietary | unknown | Plan/Ask/Build mode separation |
| **SumoCode today** | yes | sumo-tui (custom) | direct in-process Pi callbacks | — |

Closest match: **Crush.** Single root model, dumb sub-component structs, external agent loop, golden-file snapshot tests. SumoCode is one transport-interface refactor away from this shape.

---

*v2 audit: 2026-04-30. Grounded in `origin/main` `828e890`. Methodology > scope. Ship the small thing. The bones are good.*
