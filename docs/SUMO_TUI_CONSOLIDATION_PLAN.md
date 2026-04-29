# SumoTUI Consolidation Plan

> Created: 2026-04-29  
> Source audit: [`docs/SUMO_TUI_AUDIT.md`](./SUMO_TUI_AUDIT.md)  
> Audit PR: [#96](https://github.com/dhruvkelawala/sumocode/pull/96)  
> Status: active execution plan for the next SumoTUI/V2 UI slices.

---

## 1. Why this plan exists

The deep audit concluded that **SumoTUI is the right direction**, but the current risk is the hybrid phase: Pi owns parts of terminal/layout flow while SumoTUI owns retained chat/sidebar/runtime pieces. New composed surfaces amplify that seam risk.

This plan turns the audit into an execution sequence:

1. Keep the V2 progress that is already safe.
2. Pause V2 work that would be rewritten by kernel consolidation.
3. Make integration/runtime contracts green.
4. Consolidate the terminal lifecycle, command/keybinding ownership, workers, and Pi patch strategy.
5. Resume composed scenes and transcript-heavy surfaces on the stronger spine.

---

## 2. Current decision

We keep building SumoTUI, but we stop treating every V2 surface as equally safe.

**Decision:** finish leaf surfaces that survive the consolidation, then pause composed scenes/chat-heavy work until the P0 consolidation slices land.

### Already completed leaf primitives

- #82 — V2 active input frame parity
- #83 — V2 footer status row parity
- #84 — V2 top bar parity
- #85 — V2 editorial sidebar parity

### Continue now

- #88 — splash/runtime invocation parity

Splash is mostly a leaf surface and exercises runtime invocation without requiring the transcript model or owned-shell composition.

### Pause until consolidation

- #86 — active landscape scene composition
- #87 — active portrait scene composition
- #89 — chat message frame parity
- #90 — deterministic fixture runtime states

These depend on the unstable seam, structured transcript model, headless backend, or explicit portrait decision. Doing them now risks building surfaces twice.

---

## 3. P0 consolidation sequence

### P0-B — Realign V2 runtime/test/visual contract

**Goal:** one contract across docs, tests, constants, and required visual crops.

Acceptance gate:

```bash
pnpm test:integration
pnpm visual:ci
pnpm test
pnpm exec tsc --noEmit && pnpm build
```

Scope:

- Fix `cursor-visibility.test.ts` so it no longer waits for obsolete V1 input labels.
- Keep active input label-less per V2.
- Lock sidebar width, terminal dimensions, and review/required crop semantics.
- Add `docs/visual/parity/CONTRACT.md`.
- Sweep stale V1 assertions that conflict with the Visual Bible.

### P0-C — Introduce a single terminal session owner

**Goal:** one state machine owns altscreen, mouse, cursor visibility/color, bg paint, suspend/resume, and cleanup.

Scope:

- Add `TerminalSessionOwner` with explicit lifecycle states.
- Remove duplicate lifecycle ownership between classic altscreen setup and retained runtime startup.
- OSC 12 cursor color is off by default; only explicit `/sumo:cursor` changes it.
- No-TTY paths no-op cleanly and remain testable.

### P0-E — Centralize commands and keybindings

**Goal:** one registry owns command/keybinding declarations and detects conflicts at startup.

Scope:

- Remove duplicate `/sumo:memory` registration.
- Add a command registry and keybinding registry.
- Add conflict diagnostics for skipped/overridden shortcuts.
- Preserve existing user-facing commands.

### P0-G — Add cancellable workers

**Goal:** memory/MCP/sidebar/session-summary async work cannot race stale UI state.

Scope:

- Add a small Worker API with `exclusive` groups.
- Move memory refresh and sidebar async probes through workers.
- Cancel stale refreshes when a newer prompt/session supersedes them.

### P0-D — Decide Pi patch strategy

**Goal:** make the private Pi patch seam explicit and maintainable, or remove it.

Decision doc: [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](./SUMO_TUI_PI_PATCH_STRATEGY.md)

Scope:

- Audit `patches/@mariozechner__pi-coding-agent@0.70.2.patch` and `loadSumoInteractiveMode` usage.
- Decide whether public Pi APIs can replace the patch.
- If not, document the patch maintenance contract and Pi bump smoke matrix.

### P0-F — Decide portrait sidebar policy

**Goal:** choose the Mac mini portrait behavior before #87 resumes.

Decision doc: [`docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md`](./SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md)

Chosen V1 policy: **Option A** — hide the sidebar in portrait/narrow layouts; footer/hint absorbs essential context. Portrait richness is explicitly V2/later.

Options evaluated:

- A — hide sidebar in portrait, footer/hint absorbs context. **Accepted for V1.**
- B — bottom registry band in portrait. Deferred to V2/later.
- C — command-toggled overlay only. Deferred to V2/later.

---

## 4. P1 kernel deepening

These are gated on P0. They make resumed V2 scene/chat work durable.

### P1-A — Reactive app model

Adopt Textual-style reactive properties rather than a full Bubble Tea/Elm rewrite. Pi events update local state; reactive fields invalidate the right widgets.

### P1-B — Typed style/render primitives

Create a boring, typed style layer:

```ts
type Style = { fg?: Token; bg?: Token; bold?: boolean; italic?: boolean; dim?: boolean };
type Span = { text: string; style?: Style };
type Line = Span[];
```

Build frames, tool pills, code blocks, modals, footer, sidebar, and input from shared primitives to avoid stale ANSI/background/width bugs.

### P1-C — Headless TestBackend + Pilot API

Add a Ratatui/Textual-style headless backend with current/previous buffers, cursor state, key/mouse input, resize, and assertions. PTY tests remain smoke tests, not the only integration test layer.

### P1-D — Structured transcript model

Introduce typed chat blocks for markdown, code, tools, skills, questions, and delegation. This unblocks #89 and robust fixture-backed #90 states.

### P1-E — Focus/modal/input router

Centralize focus, modal stack, input priority, and keybinding trace logging.

### P1-F — Selection/copy decision

Either implement in-app selection + OSC 52 copy or document terminal-native selection bypass behavior.

### P1-G — Debug overlay and replay traces

Add `Ctrl+Shift+D` debug overlay and `SUMO_TUI_TRACE=1` trace logs replayable through a headless runner.

---

## 5. Issue map

The consolidation epic should track these implementation issues:

| Issue | Slice | Type | Depends on | Notes |
|---|---|---|---|---|
| #98 | Epic: SumoTUI consolidation after deep audit | HITL | none | Owns audit-driven sequencing. |
| #99 | P0-B: Realign V2 runtime/test/visual contract | AFK | #98 | First implementation slice. |
| #100 | P0-C: Introduce single TerminalSessionOwner | AFK | #99 | Runtime lifecycle spine. |
| #101 | P0-E: Centralize commands and keybindings | AFK | #98 | Can run after/alongside P0-C if no conflicts. |
| #102 | P0-G: Add cancellable worker runtime | AFK | #98 | Can run after/alongside P0-C. |
| #103 | P0-D: Decide Pi patch strategy | HITL | #100 | Needs architecture decision and possibly upstream/Pi API path. |
| #104 | P0-F: Decide portrait sidebar policy | HITL | #98 | Blocks #87. |
| #105 | P1-B: Add typed style/render primitives | AFK | #99 | Foundation for future surfaces. |
| #106 | P1-C: Add headless TestBackend + pilot API | AFK | #100 | Makes runtime tests less PTY-flaky. |
| #107 | P1-D: Introduce structured transcript model | AFK | #105, #106 | Blocks #89 and useful #90 fixtures. |

---

## 6. Acceptance gates for daily-driver readiness

### Correctness

- `pnpm test` passes.
- `pnpm test:integration` passes, including cursor visibility.
- `pnpm visual:ci` has no hard failures and required crops pass.
- `pnpm exec tsc --noEmit && pnpm build` passes.
- There are zero known V2 contradictions between docs, tests, constants, and runtime.

### Runtime

- Ctrl+C exits cleanly without escape leakage.
- Ctrl+Z / `fg` works.
- No-TTY paths no-op cleanly.
- Mouse wheel scrolls chat, not editor history.
- Cursor remains visible and correctly placed while typing, autocompleting, and resizing.
- Streaming while scrolled up preserves viewport and shows jump-to-bottom state.
- Pi patch strategy is verified or removed.

### UX

- Landscape: sidebar + chat remain balanced.
- Portrait: explicit policy chosen and reflected in tests/Bible.
- Required V2 crops are promoted only after human visual approval.

---

## 7. Resume criteria for paused V2 issues

Resume #86/#87/#89/#90 only after:

- P0-B is complete.
- P0-C is complete or a documented owned-shell/hybrid-safe decision says it is not required for the specific issue.
- #87 has a portrait policy decision from P0-F.
- #89 has the structured transcript model from P1-D.
- #90 has a headless/backend fixture story from P1-C/P1-D.

Until then, keep V2 work to leaf surfaces and consolidation slices.
