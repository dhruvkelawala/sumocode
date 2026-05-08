# SumoTUI Audit — 2026-04-29

> Scope: current `sumocode` worktree, `src/sumo-tui/**`, Cathedral runtime/UI code, SumoTUI research docs, V2 visual spec, and a quick survey of other production TUI frameworks.
>
> Revision log: v1 (2026-04-29) → v2 (2026-04-29, post-review). v2 leads with the spine, adds effort buckets, promotes the Pi-patch question to P0, names a fallback product, picks one app-model direction, and adds a decision section for in-flight V2 UI work.
>
> Post-#100 note: P0-C introduced `TerminalSessionOwner`, shared it across lifecycle/runtime startup, and moved OSC 12 cursor color behind an explicit opt-in hook. Findings below that mention duplicate terminal owners or unconditional OSC 12 describe the pre-#100 state.

---

## 0. The spine (read this first)

**The risk is the hybrid phase, not the SumoTUI decision.**

SumoTUI as a direction is correct and already proven: real primitives exist (Yoga, CellBuffer, lifecycle, scheduler, ScrollBox, ChatPager), perf is in budget, and the ADR is sound. What is not stable is the seam: today Pi owns root vertical flow, SumoTUI owns chat rows inside that flow, sidebar is a non-capturing overlay outside flow, chat width is reduced by hardcoded sidebar constants, and mouse events translate retained chat coordinates through a Pi-rendered shell. **Neither renderer has full authority** — every new surface compounds drift.

The fastest path to a daily-driver SumoCode is four moves, in order:

1. **Stop the bleed.** Pause new Cathedral surfaces. Make integration green. Pick V2 spec / V1 tests / runtime constants — only one survives.
2. **Single owner for terminal lifecycle.** One state machine, one place altscreen/mouse/cursor-color toggle. OSC 12 cursor color off by default (V2 contract).
3. **Centralize commands and keybindings.** Remove the duplicate `/sumo:memory` registration. Add a startup conflict inspector.
4. **Deepen the kernel.** Pick *one* app-model pattern (recommendation in §6), add typed style primitives, add a headless TestBackend, then resume surface work on the new spine.

Everything else is in service of those four. If you only have a week, do moves 1–3.

---

## 1. Current health snapshot

### Verification commands

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration
pnpm visual:ci
```

### Results

| Check | Result | Notes |
|---|---:|---|
| `pnpm exec tsc --noEmit` | pass | TypeScript clean. |
| `pnpm build` | pass | Build is `tsc --noEmit`. |
| `pnpm test` | pass | 68 files / 399 tests on HEAD `6097b23`. |
| `pnpm test:integration` | **fail** | `cursor-visibility.test.ts` PTY timeout. 13/14 passing. |
| `pnpm visual:ci` | review-compatible | 7 scenarios. `footer-ready`, `sidebar-editorial`, `active-portrait` pass; `input`, `top-bar`, `splash`, `active-landscape` review-only. |

### Read-out

Type-safe and unit coverage green, but **not fully green** — one PTY test times out and that test happens to cover cursor visibility, which is the most basic correctness invariant for an interactive TUI. The remaining failure is a runtime contract issue, not a renderer or TS issue. Daily-driver readiness is gated on this and on the V2 contract drift.

---

## 2. Strengths to preserve

- **ADR + research quality.** `docs/adr/0001-sumo-tui-framework.md` and `docs/research/sumo-tui-spike/**` capture the architectural lessons (altscreen requires app-owned scrollback) and the edge-case catalog. Keep this discipline; reference it when seam bugs reappear.
- **Real primitives, real tests.** `TerminalController`, `LifecycleRuntime`, `FrameScheduler`, `SumoNode`+Yoga, `CellBuffer`+ANSI writer+diff, `ScrollBox`+`ChatPager`, `PiEditorLeaf` cursor remap, `RegionRegistry`, `SumoExtensionUIAdapter`. This is a real terminal app framework in progress.
- **Perf is in budget.** Retained render p50 ~1.08 ms / p95 ~1.41 ms, streaming p95 ~9 ms, idle CPU ~0.30 %, idle RSS delta ~19 MiB vs bare Pi. (See `docs/research/sumo-tui-performance.md` and `sumo-tui-cpu-diagnosis.md`.)
- **Visual harness.** Terminal UIs regress in ways unit tests miss (stray bg cells, line overflow, missing cursor, stale ANSI). `pnpm visual:ci` already catches these classes. Worth keeping.

---

## 3. Risks, ranked

### P0-A — Two renderers, neither has authority *(effort: 1w+, mostly design)*

Evidence in code:

- `SumoInteractiveRuntime` starts SumoTUI primitives, then delegates the session loop to upstream `InteractiveMode`.
- `installChatViewportBridge()` overrides `upstream.chatContainer.render`, `clear`, `invalidate`, `handleEvent`, `renderSessionContext`.
- Chat updates force `target.ui?.requestRender?.(true)` because Pi's differential scroll smears the hybrid layout.
- Chat geometry is computed by rendering Pi chrome components to count rows.
- Sidebar overlay reduces chat width via a hardcoded constant.

That is not a final architecture. **Define modes explicitly and stop blurring them**:

| Mode | Owner | Use |
|---|---|---|
| **Hybrid-safe (fallback)** | Pi owns terminal/editor/chat. SumoCode = header/footer/sidebar overlays only, no altscreen takeover. | The off-ramp. Always shippable. |
| **Owned-shell (target)** | SumoTUI owns terminal, root layout, chat, footer, sidebar, modals, input routing. Pi provides agent/session/editor utilities through adapters. | Daily-driver target. |
| **Full-owned (post-v1)** | Owned-shell + native editor replacement. | Experimental; only if `PiEditorLeaf` fails. |

Daily-driver work goes to owned-shell. Hybrid-safe stays as fallback so the project can ship even if the kernel rewrite stalls.

### P0-B — V2 contract drift between spec, tests, runtime *(effort: 2–3d)*

- V2 says active input has no label; integration test still references it.
- V2 says command palette has 6 modes incl. `SETTINGS`; `PaletteMode` has 5.
- V2 says cursor color respects terminal; `TerminalController` unconditionally emits `OSC 12 ; #D97706`.
- V2 references `src/sumo-tui/render/truecolor.ts`; only `truecolor.test.ts` exists.
- V2 says command palette active-state opening / drill-down is broken; current code still writes slash text for some selections.

This kills velocity because every new surface has to choose between code, tests, and spec. **Acknowledge contract realignment is a precondition for the P1 kernel work**, not "item 1 of P0" — the kernel work is unsafe until the tests stop being a liability.

Realignment PR scope:

1. Lock `docs/ui/CATHEDRAL_UX_SPEC_V2.md` + Bible HTML as the only visual source of truth.
2. Update or delete stale V1 assertions whenever they reappear.
3. Lock constants to V2: sidebar width 30, thresholds recomputed, terminal dim line dynamic.
4. Update integration tests to wait for durable runtime markers, not obsolete labels.
5. Add `docs/visual/parity/CONTRACT.md` defining review-only vs required crops.

### P0-C — Terminal lifecycle has duplicate owners *(effort: 1–2d)*

- `src/extension.ts` calls `installAltscreen(pi)`.
- `installAltscreen()` calls `installLifecycle(pi)`.
- `LifecycleRuntime` enters altscreen + mouse on `session_start`, restores on `session_shutdown`.
- `SumoInteractiveRuntime.start()` *also* calls `TerminalController.startRetainedSession()` before upstream init.
- The two controllers are different instances.

Idempotent-ish today, fragile under `/resume`, `SIGTSTP`, `SIGCONT`, uncaught exceptions, no-session/no-TTY tests. Plus OSC 12 cursor color is emitted unconditionally, against V2:

```ts
export const CURSOR_COLOR_SET = "\x1b]12;#D97706\x1b\\";
```

Introduce one `TerminalSessionOwner` singleton with a state machine:

```txt
idle → starting → active → suspending → suspended → active → stopping → stopped
```

Rules: exactly one place enters/leaves altscreen, exactly one place toggles mouse, OSC 11 bg paint feature-flagged (`/sumo:bg paint|none`), OSC 12 cursor color off by default and only set by explicit `/sumo:cursor`, no-TTY paths no-op but testable through a headless backend.

### P0-D — The Pi patch is the real version-drift seam *(effort: 1–2d to evaluate, 1w+ to remove)*

`patches/@earendil-works__pi-coding-agent@0.74.0.patch` + the `loadSumoInteractiveMode` hook in `bin/sumocode.sh` and `sumo-interactive-mode.js` are how SumoTUI injects the retained renderer. **This is the seam Pi-version drift will break first.** Every Pi minor bump risks invalidating the patch.

This was missing from v1. It is P0 because:

- Owning the patch means SumoTUI's stability is bounded by patch maintenance forever.
- Removing it means finding a clean injection via Pi's public API or accepting a fork.
- Either way the decision belongs at the same layer as "two renderers" and "single terminal owner".

Action: spend 1–2d evaluating whether `setEditorComponent` / `setHeader` / `setFooter` / a future `setRootRenderer` covers the injection. If yes, plan the patch removal as a milestone. If no, document the patch maintenance contract (what to verify on each Pi bump, when to upstream).

### P0-E — Command and keybinding conflicts already visible *(effort: 1–2d)*

- `src/command-palette.ts` registers `sumo:memory` as a stub.
- `src/memory-editor.ts` registers `sumo:memory` again with real behavior.
- V2 says command palette trigger is `Ctrl+/`, active-state opening is broken, Enter should drill down rather than insert slash text.
- V2 flags `Ctrl+T` thinking-cycle as possibly intercepted.

Centralize:

```ts
src/commands/register.ts
src/keybindings/register.ts
```

Add a startup conflict inspector that emits a structured dev warning (`keybind conflict: ctrl+/ owned by command-palette, skipped by X`). Borrow from Textual's event/message routing and Bubble Tea's central message loop.

### P0-F — Portrait policy is implicit *(effort: 0.5–1d for Option C)*

Mac mini = portrait (the dev box), MacBook = landscape. V2 currently says: sidebar hidden on splash, hidden when `W < 120`, otherwise right pane. Portrait often means `W < 120`, which silently removes ambient memory/context — one of SumoCode's stated value props.

Three options:

- **A** — V1 portrait hides sidebar, footer/hint absorbs context. Simple, less personal.
- **B** — V1 portrait has a bottom registry band. More work, aligns with PRD.
- **C** — V1 portrait has a command-toggled overlay only. Middle ground.

Honest framing: Mac mini is the dev box, so Option C is already the de-facto today. Recommending C "now, B later" is recommending the status quo. **Pick: ship B in V1 (work the user already has to do), or admit portrait richness is V2.** Don't punt with C.

### P0-G — Workers (cancelable async) *(effort: 1–2d, ships against current code)*

This was P1 in v1; promoting to P0 because it is cheap and ships *without* the kernel rewrite. Memory cache, MCP health probe, sidebar refresh, and session summary all currently race. Borrow Textual's `Worker` with `exclusive`:

```ts
type WorkerOptions = { exclusive?: boolean; group?: string };
runWorker(name, options, async () => { ... });
```

Cancels stale fetches when a new one starts, removes the entire class of "memory loaded after sidebar swapped" bugs.

---

### P1 — Kernel deepening (gated on P0)

**P1-A — Pick one app-model pattern** *(effort: 2–4w)*

Three substitutes, not complements:

| Pattern | Cost | Benefit | Cost vs Pi events |
|---|---|---|---|
| **Bubble Tea / Elm** — `Model + Update + View`, all events become `AppMsg` | High. Every Pi event has to translate to/from `AppMsg`. Hybrid-safe mode harder to keep working. | Deterministic transitions, replayable bug reports, headless tests. | Largest divergence from Pi idioms. |
| **Textual reactive properties** — declared reactive fields auto-invalidate the right widget | Medium. Adds a small reactive runtime; events update fields directly. | Locality of behavior preserved; tests still readable. | Smallest divergence; Pi events update fields naturally. |
| **Status quo + state-mutation discipline** — keep direct event hooks, gate mutations through a single `dispatch()` | Low. Mostly convention. | Quickest. | None. |

**v2 recommendation: Textual-style reactive properties.** Lower divergence from Pi's event idioms, keeps the hybrid-safe fallback viable, gives you locality + invalidation correctness without rebuilding the event system. Bubble Tea is the right answer if SumoTUI eventually extracts as a public framework; it is overkill for SumoCode today.

Worker API (P0-G) integrates cleanly into either pattern.

**P1-B — Typed style/render primitives** *(effort: 1w)*

Repeated ad hoc helpers (`fg(hex)`, `bg(hex)`, `color()`, `visibleLength()`, `padToWidth()`) cause the bg-fall-through and stale-ANSI bugs already seen.

```ts
type Style = { fg?: Token; bg?: Token; bold?: boolean; italic?: boolean; dim?: boolean };
type Span = { text: string; style?: Style };
type Line = Span[];

renderLine(line, width, options): string
box({ title, width, style, children }): Line[]
rule(width, style): Line
pad / truncate
```

Then build `MessageFrame`, `ToolPill`, `ToolLedger`, `CodeBlock`, `ScriptoriumModal`, `RegistrySidebar`, `FooterLine`, `InputFrame` from these primitives. The Charm / Lip Gloss lesson: make styling/layout primitives pure, reusable, boring.

**P1-C — Headless `TestBackend` + Pilot API** *(effort: 1w)*

Borrow Ratatui / Textual:

- `TestBackend` exposes current/previous buffers + cursor state.
- Pilot API can press keys, send mouse events, resize, assert visible cells.
- Visual goldens promoted only after human approval.

Test layers:

1. Pure render — `renderFoo(snapshot, width)` returns styled lines.
2. Headless SumoTUI — app model + backend + input events, no PTY.
3. PTY smoke — real Pi/Sumo integration, terminal lifecycle, cursor, mouse.
4. Visual Bible — component/runtime crops.
5. Long-session soak — 10k messages, 1h idle, resize storm, streaming-while-scrolled.

**P1-D — Structured transcript model** *(effort: 1w)*

Required for chat message frames, skill pills, tool pills, code blocks, scroll/scribe delegation, Divine Query, future live bash. Stop inferring V2 surfaces from plain text rows.

```ts
type ChatBlock =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string; source: string; collapsed?: boolean }
  | { type: "tool"; tool: ToolCallViewModel }
  | { type: "skill"; name: string; expanded: boolean }
  | { type: "question"; question: QuestionViewModel }
  | { type: "delegation"; scroll: ScrollViewModel };

type ChatMessageViewModel = {
  id: string; role: "user" | "sumo" | "system";
  displayName: string; timestamp?: Date;
  blocks: ChatBlock[];
};
```

**P1-E — Focus / modal stack + keybinding priority** *(effort: 0.5w)*

Already most of the way there with `RegionRegistry`. Wrap into a single `InputRouter` with focus, modal-stack, priority, trace logging.

**P1-F — Selection manager + OSC 52 copy** *(effort: 0.5w)*

SGR mouse capture weakens native terminal selection; daily-driver users will copy text dozens of times an hour. Either implement in-app selection + OSC 52, or accept users will hold modifier to bypass mouse capture. Pick one and document.

**P1-G — Debug overlay** *(effort: 2–3d)*

`Ctrl+Shift+D`: mode (hybrid/owned), terminal dims, frame p50/p95, dirty queue depth, focused widget, modal stack, scroll offset/manualScroll/unread, active keybindings, Pi event rate, memory worker status. Plus `SUMO_TUI_TRACE=1` writes replayable event logs and `sumocode replay <trace>` runs them headlessly. Pays for itself fast — terminal bugs are hard to describe.

### P2 — Visual / product surfaces (after P0 + P1 land)

Element 13 chat message frames · Element 11 Divine Query · Element 9 tool pills/ledgers · Element 10 code blocks · Element 9a skill pill · Element 12 scroll/scribe delegation · Element 6 approval modal via Pi risk policy · Element 7 Memory Scriptorium · top-bar LLM summaries + recent sessions.

### P3 — Extraction (only after 30 days stable)

Decide whether `src/sumo-tui` becomes `@sumodeus/sumo-tui` · publish architecture docs · third-party Pi extension compatibility tier · React/Solid adapter.

### Demoted

- **CellBuffer optimization (was P1).** Perf is acceptable today. Trigger gate: 10k-msg synthetic transcript p95 > 33 ms, *or* drag-selection / animated splash / split-pane lands. Until then, `Uint16Array` chars + `Map<number, string|number>` style storage is fine.

### Removed

- **Ink reference.** v1 itself said "do not start there." Cut.
- **Section 6 feature ideas (25 items).** Moved to `docs/IDEAS.md` so this audit stays a roadmap, not a buffet.

---

## 4. Patterns to borrow (and not borrow)

### OpenCode / OpenTUI

Already covered in `docs/research/sumo-tui-spike/01-opencode.md` and `02-opentui.md`. Steal: app-owned `ScrollBox` with sticky-bottom, prompt outside scrollbox, snap-to-bottom after async load/submit, message-boundary navigation, responsive sidebar (dock wide / overlay narrow), theme tokens for every semantic surface, central renderer lifecycle, hit grid + focus manager + mouse dispatcher, selection-aware mouse handling. Don't copy: Bun/OpenTUI as direct runtime dep; fixed-FPS loop as default.

### Bubble Tea

Considered as the app-model pattern in P1-A and **rejected as primary** in favor of Textual-style reactivity, on cost-vs-Pi grounds. Still steal the small lesson: keep update/view fast, all blocking work becomes a command.

### Ratatui

Steal: immediate-draw-into-buffer + diff prev/current, `TestBackend` for integration tests with no terminal, widget authors render into a `Frame` not strings, modular core vs app-facing split when API stabilizes. The TestBackend lesson is the biggest — stop relying on PTY parsing for correctness.

### Textual

Steal: reactive properties auto-invalidate the right widget (P1-A), Worker API with `exclusive` for cancelling stale tasks (P0-G), message pump with selector-style handlers, headless `run_test()` + Pilot, devtools console that doesn't corrupt terminal output (P1-G), styling separated from logic (P1-B).

### Charm Lip Gloss / Bubbles

Maps directly to P1-B (`Span/Line/Style`).

---

## 5. Recommended architecture target

```txt
┌─────────────────────────────────────────────────────────┐
│ SumoCode product shell                                  │
│  Cathedral surfaces · palette · memory · sidebar · footer │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│ SumoTUI kernel                                           │
│  1. AppModel + reactive props (Textual-style)            │
│  2. TerminalSessionOwner (state machine)                 │
│  3. InputRouter + FocusManager + SelectionManager        │
│  4. LayoutTree / Yoga                                    │
│  5. CellBuffer + diff + ANSI writer                      │
│  6. Widget primitives (Box/Text/ScrollBox/Modal/TextInput)│
│  7. Headless TestBackend + TraceReplay                   │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│ Pi adapter (the patch lives here)                       │
│  agent/session events · editor leaf · UI shim · bridges │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│ Pi runtime — LLMs, tools, MCP, auth, sessions, skills   │
└─────────────────────────────────────────────────────────┘
```

### Deep modules (carve out, treat as units)

| Module | Responsibility | Why deep |
|---|---|---|
| `terminal-session-owner` | Terminal mode state machine | Prevents cleanup/cursor/mouse regressions |
| `app-runtime` | Reactive model + commands/workers | Locality for state/race bugs |
| `input-router` | Key/mouse/focus/modal/selection routing | Stops keybinding conflicts and lost focus |
| `style` | Tokens → spans → ANSI/cells | Prevents bg/reset/width bugs |
| `transcript` | Structured messages + virtualization | Enables frames/tool/code/search |
| `pi-adapter` | All private Pi seams isolated, **including the patch** | Contains Pi drift risk |
| `test-backend` | Headless terminal + pilot | Makes runtime testable without PTY flake |

### Stay shallow

Cathedral renderers built on primitives, slash command wrappers, static tokens, demo extensions, Bible scenario fixtures.

---

## 6. Non-goals (V1 contract)

Hold the line on these until v1 daily-drives for 30 days:

- **No tabs / multi-pane / split editors.**
- **No native editor replacement.** `PiEditorLeaf` is the contract; native textarea is fallback only.
- **No React reconciler.** Imperative + reactive props is the v1 API.
- **No public package extraction.** `src/sumo-tui` stays bundled.
- **No third-party Pi extension UI compat.** Foreign extensions get a one-shot warning + no-op.
- **No theme configurability beyond the 3 hardcoded themes.**
- **No proactive behaviors / hooks / auto-summarize.**
- **No portrait Option B** unless explicitly chosen in P0-F (otherwise = V2).

If a feature request reaches into this list, it's V2.

---

## 7. The fallback product

If owned-shell mode does not reach daily-driver quality in N weeks, **hybrid-safe mode is a complete product**:

- No altscreen takeover.
- Pi owns terminal, editor, chat, scrollback.
- SumoCode contributes: persona (Zeus), custom footer, sidebar overlay, working indicator, splash, slash commands, memory widget, voice/copy module, theme tokens applied to Pi's renderer.

That ships today and is meaningfully different from stock Pi. Naming the off-ramp prevents the kernel rewrite from becoming existential.

Trigger to fall back: P0-A redesign + P1-A app-model rewrite together exceed 6 weeks without integration green, *or* the Pi patch (P0-D) becomes unmaintainable on a Pi minor bump.

---

## 8. Acceptance gates for v1 daily-driver

### Correctness

- `pnpm test` passes.
- `pnpm test:integration` passes (incl. `cursor-visibility`).
- `pnpm exec tsc --noEmit` passes.
- `pnpm visual:ci` no hard failures, required crops pass.
- Zero V2 contract contradictions between docs / tests / constants.

### Runtime

- Ctrl+C exits cleanly, no escape leakage.
- Ctrl+Z / fg works.
- No-TTY (`pi --print`, ACPX) no-op cleanly.
- Mouse wheel scrolls chat, not editor history.
- Cursor visible and correctly placed during typing, autocomplete, resize.
- Streaming while scrolled-up preserves viewport + shows jump-to-bottom.
- `/resume` active transition < 500 ms or root cause documented.
- Pi version smoke matrix (pinned + latest compatible) green.
- Patch (P0-D) verified or removed.

### Performance

- Idle CPU < 1 %.
- No retained render loop at idle.
- Streaming p95 render < 16.7 ms target / < 33 ms acceptable.
- 1 h session RSS < 300 MiB.
- 10k-message synthetic transcript only virtualizes active rows.

### UX

- MacBook landscape: balanced sidebar + chat.
- Mac mini portrait: explicit approved behavior (decision per P0-F).
- Visual Bible scenes for active, portrait, tools, code, palette, memory, approval, query, skill all exist and approved by Dhruv.

---

## 9. Sequencing — given V2 UI work in flight (#80)

Issue #80 (V2 UI parity epic) and its children #82, #85, #86, #87, #88, #89, #90 are partially impacted by this audit. **Don't stop or restart wholesale; cut the epic by survivability**:

### Survives the kernel rewrite — finish these now

- **#82 Active input frame parity** — token + render work, lands on existing rails.
- **#85 Editorial sidebar parity** — same.
- **#88 Splash/runtime invocation parity** — splash is a leaf surface; safe.

These exercise the visual harness, validate V2 constants, and keep daily-drive momentum without touching the seam.

### Will be rewritten if done before kernel work — pause these

- **#89 V2 chat message frame parity** — *requires* the structured transcript model (P1-D). Doing it on plain-text rows means doing it twice.
- **#86 Active landscape scene** + **#87 Active portrait scene** — compose every primitive on top of the runtime; landscape blocks until P0-A modes are explicit, portrait blocks until P0-F decides Option B vs V2.
- **#90 Deterministic fixture states** — depends on the structured transcript + headless `TestBackend` (P1-C) to be useful beyond what `pnpm visual:ci` gives today.

### Recommended order

1. **Now (1 week):** finish #82, #85, #88. They are mostly token + render work and bank measurable V2 progress.
2. **In parallel (sequencing-light, ~1 week):** P0-B contract realignment, P0-C single terminal owner, P0-E command/keybind centralization, P0-G Workers. These don't block #82/#85/#88 and they remove the contradictions the next slice would otherwise inherit.
3. **Then (3–6 weeks):** P0-A modes decision + P0-D patch decision + P0-F portrait decision + P1-A reactive app model + P1-B style primitives + P1-C TestBackend + P1-D structured transcript.
4. **Then unblock:** #89, #86, #87, #90 on the new spine.

The point is *don't pause the epic* — pause the parts of the epic that would be rewritten.

---

## 10. Score

**Current: 6 / 10.** Bones are right (3 pts: ADR, primitives, perf). Working extension with several Cathedral elements (2). Clean TS, test discipline, visual harness (1). Loses 4 to: hybrid seam fragility, contract drift, integration red, no headless test backend, command/keybind conflicts, duplicate terminal owners, OSC 12 unconditional override, Pi patch unaddressed, no devtools.

**After P0 + P1: 8.5 / 10.** Daily-drivable owned-shell SumoCode with stable contracts, single terminal owner, structured transcript, TestBackend, devtools, workers. Capped at 8.5 because: extraction deferred (P3), portrait Option B may still be V2, public API absent, Pi patch may still be in place unless P0-D removes it. Ninth point unlocks with 30 stable days + patch removed; tenth with extraction + a second consumer.

---

## 11. Final recommendation

Keep going with SumoTUI. Pause the parts of #80 that would be rewritten. Spend the next slice on **consolidation, not new polish**:

1. Align V2 spec / constants / tests / README.
2. Single terminal owner.
3. Centralize commands + keybindings.
4. Pi patch decision (remove or formalize).
5. Workers for cancellable async.
6. Then: typed style primitives, headless TestBackend, reactive app model, structured transcript.

After that the Cathedral elements that survive the rewrite become straightforward surface work.

> **North star.** SumoCode feels like OpenCode-level terminal ownership, with Pi's agent engine and editor intelligence underneath, and a Cathedral product identity stable enough to daily-drive in cmux on both portrait and landscape machines.
