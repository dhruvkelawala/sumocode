# Plan 038: Wire the declared-but-inert app.* keybindings

> **Executor instructions**: Follow step by step, commit per action wired.
> Base on the current `integrate/track-d` tip; commit to
> `fix/wire-app-actions` and hand the reviewer the SHA.

## Status

- **Priority**: P0 (root cause of the repeatedly-reported "keybindings are
  broken" — now proven from a real diagnostic capture, not inferred)
- **Effort**: S/M
- **Depends on**: none (plans 035/036's KeybindingsManager work already
  built the table this plan wires up)
- **Category**: bug
- **Planned at**: `149f58c`, 2026-07-03
- **Source**: live diagnostic capture (`/tmp/sumocode-manual.jsonl`,
  2026-07-03) decoded and root-caused in-session

## Why this matters

The user reported keybindings were broken across three separate rounds. The
first two investigations (029: Kitty release filtering; the pi-tui
`parseKey` capture) were real fixes but didn't address this. A live
diagnostic capture (raw bytes + routing verdict, added this session) finally
gave ground truth: the user pressed `Shift+Tab` and `Ctrl+Shift+P`
repeatedly, both decoded correctly by pi-tui as CSI-u sequences, both routed
to `target: "editor"` — and **nothing happened**. No error, no visible
effect, no garbage inserted. Silent no-op.

Root cause, traced to the exact line: `CustomEditor.handleInput`
(`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js:59-64`):

```js
// Check all other app actions
for (const [action, handler] of this.actionHandlers) {
    if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
        handler();
        return;
    }
}
```

`this.actionHandlers` is populated ONLY by calling `editor.onAction(name, handler)`
(`custom-editor.js:21-22`). `app.exit`/`app.interrupt` work because SumoCode
sets the *dedicated* `onCtrlD`/`onEscape` properties
(`src/sumo-tui/rpc/editor.ts:145-146`), which `custom-editor.js` checks as a
fallback before consulting `actionHandlers`. But `grep -rn "\.onAction(" src/sumo-tui/rpc/`
returns **zero matches** — the RPC host never registers a handler for ANY of
the other actions plan 035/036 declared in the mirrored keybindings table.
So the loop above is permanently empty for them, matches nothing, falls
through to `super.handleInput(data)` (pi-tui's base `Editor`), which has no
special meaning for these chords either — hence total silence.

The mirrored table (`src/sumo-tui/rpc/editor.ts:345-355`) declares 11 actions;
only 2 (`app.interrupt`, `app.exit`) actually do anything:

| Action | Default keys | Wired? |
|---|---|---|
| `app.interrupt` | Escape | yes (`onEscape`) |
| `app.clear` | Ctrl+C | **no** |
| `app.exit` | Ctrl+D | yes (`onCtrlD`) |
| `app.suspend` | Ctrl+Z | no (known-deferred, see plan 030/draft-rebuild notes — needs a runtime pause/resume pair, ~80-120 lines, separate item, NOT this plan) |
| `app.thinking.cycle` | Shift+Tab | **no** ← the user's exact repro |
| `app.model.cycleForward` | Ctrl+P | **no** |
| `app.model.cycleBackward` | Shift+Ctrl+P | **no** ← the user's exact repro |
| `app.model.select` | Ctrl+L | **no** |
| `app.tools.expand` | Ctrl+O | **no** |
| `app.thinking.toggle` | Ctrl+T | **no** |
| `app.session.toggleNamedFilter` | Ctrl+N | **no** |

## Current state

Host-side implementations ALREADY EXIST for most of these — this is wiring,
not new feature work:

- `RpcHostControls.cycleModel()` (`src/sumo-tui/rpc/controls.ts:79`) and
  `.cycleThinkingLevel()` (`:89`) — ready for `app.model.cycleForward`/
  `app.thinking.cycle`. `app.model.cycleBackward` needs a "previous" direction;
  check `cycle_model`'s RPC command shape (`rpc-types.d.ts`) for a direction
  param, or call `cycleModel()` N-1 times against the available-models list
  if the RPC verb is forward-only — verify before assuming.
- `RpcHostActions.openModelSelector()` (`host-actions.ts:547`) — ready for
  `app.model.select`.
- `ChatPager.setToolExpansion(expanded)` (`src/sumo-tui/widgets/chat-pager.ts:191`)
  — ready for `app.tools.expand` (toggle, so track current expansion state
  and flip it).
- `app.clear` — trivial: clear the editor's current text (the editor
  controller already has `setText`/equivalent).
- `app.thinking.toggle` (hide/show thinking blocks) — Pi's own
  `toggleThinkingBlockVisibility()` (`interactive-mode.js:2967`) exists as a
  reference for the semantic, but the RPC host has no equivalent
  transcript-wide "hide thinking" flag today. INVESTIGATE first (see Step 2)
  — may need new state in the transcript controller.
- `app.session.toggleNamedFilter` — no host-side equivalent found at all.
  INVESTIGATE what this even means in the RPC/sidebar context before
  building anything (may not translate — Pi's session list UI has a concept
  SumoCode's sidebar may not).

## Scope

**In scope**: `src/sumo-tui/rpc/editor.ts` (wire `.onAction()` calls),
`src/sumo-tui/rpc/host.ts` (thread the action callbacks through, same pattern
as `onExit`/`onInterrupt`), `src/sumo-tui/rpc/controls.ts` only if
`cycleModel` needs a direction param added, colocated tests.

**Out of scope**: `app.suspend` (separately tracked, needs runtime
pause/resume — do not attempt here); the KeybindingsManager mirrored table
itself (already correct, don't change the declared defaults); pi-tui/Pi
internals (read-only reference).

## Steps

1. **`app.clear`** (Ctrl+C clears editor draft) — wait, note: Ctrl+C already
   has host-level interrupt-tier meaning (plan 025) at the ROUTER level,
   before it ever reaches the editor. Verify: does `containsCtrlCToken`
   intercept Ctrl+C before the editor sees it as `app.clear`? If the router
   already handles Ctrl+C-clears-draft via the interrupt tier, `app.clear`
   reaching the editor's actionHandlers may be dead code by design (the
   router consumes it first) — confirm with a trace, and if so, mark this
   row "N/A — already handled upstream" rather than wiring a duplicate path.
2. **`app.model.cycleForward` / `app.model.cycleBackward`** — wire both via
   `editor.onAction(...)` to `controls.cycleModel()` (verify direction
   support; if RPC only cycles forward, implement backward as "cycle forward
   (N-1) times" against `getAvailableModels()`'s list length, or file it as a
   partial-only note if that's too fragile). On completion, trigger the same
   state-change/notify path `openModelSelector` uses. Test: pressing the
   bound key calls `cycleModel`/notifies with the new model name.
3. **`app.model.select`** — wire to `openModelSelector()`. Test.
4. **`app.thinking.cycle`** — wire to `controls.cycleThinkingLevel()`. Test.
5. **`app.tools.expand`** — wire to `ChatPager.setToolExpansion`, tracking
   and flipping current expansion state host-side. Test.
6. **`app.thinking.toggle`** — INVESTIGATE first: does the transcript
   controller/chat-message rendering have (or need) a global
   "hide thinking blocks" flag? If small (~20 lines), implement; if it needs
   new transcript-controller state, STOP and report scope instead of
   improvising.
7. **`app.session.toggleNamedFilter`** — INVESTIGATE what this action means
   in Pi's model (grep `interactive-mode.js` for its usage/effect) and
   whether SumoCode's sidebar has an equivalent concept. If it doesn't map
   cleanly, mark as "not applicable to this UI" in the report rather than
   forcing an implementation — do not fabricate a feature.
8. **Verify the swallow behavior**: after wiring, confirm the previously
   dead chords now produce a visible/notified effect, AND that a genuinely
   unbound key (not in the table) still safely falls through to normal
   editor text insertion — the fix must not accidentally swallow ordinary
   typing.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm vitest run src/sumo-tui/rpc/` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual w/ diagnostics | `sumocode -d .`, press each chord, `sumocode diag` or grep `/tmp/sumocode-manual.jsonl` for `route_verdict` | each chord now produces a visible effect, not silent |

## Done criteria

- [ ] `grep -c "\.onAction(" src/sumo-tui/rpc/editor.ts` (or wherever wired)
  → ≥ 6 (one per action actually implemented; document any left unwired with
  a reason, per the investigate-first items)
- [ ] Pressing Shift+Tab and Ctrl+Shift+P (the user's exact reported chords)
  now visibly cycles thinking level / cycles model backward
- [ ] A genuinely unbound key still reaches the editor as normal text
  (regression guard — the fix must not over-swallow input)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0; `pnpm test:integration` exit 0
- [ ] Only in-scope files modified

## STOP conditions

- `cycle_model`'s RPC verb has no backward/direction support and the N-1
  workaround is fragile with a large model list — report instead of
  shipping something flaky.
- `app.thinking.toggle` or `app.session.toggleNamedFilter` need new
  transcript-controller/sidebar state beyond a small addition — report the
  scope, don't improvise a half-built feature.
- Any verification fails twice.

## Maintenance notes

- This is the second time a keybinding report traced back to "declared in
  the mirrored table but never wired to an action." When plan 031 (keybinding
  matrix) executes, its PTY suite must assert an actual OBSERVABLE EFFECT for
  every action-bound key, not just that the KeybindingsManager *matches* the
  chord — matching without wiring is exactly this bug, and a matrix that only
  checks matching would have missed it too.
- Re-check this wiring on every Pi version bump alongside the mirrored
  defaults table (per plan 030/036's existing bump-checklist note).
