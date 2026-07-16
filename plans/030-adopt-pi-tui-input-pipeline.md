# Plan 030: Adopt pi-tui's input pipeline in the RPC host

> **Executor instructions:** Base your worktree on the reviewed tip of
> `codex/plan029-kitty-release-filter` (or the Track D integration branch if
> plan 033 has produced one — ask the reviewer prompt which). Follow the
> steps; run every verification; on a STOP condition, stop and report. Do not
> update `plans/README.md`.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** 029 (its Kitty regression tests are this plan's safety net)
- **Category:** architecture / correctness
- **Planned at:** `7d213e9` + plan-029 result, 2026-07-03
- **Decision context:** Dhruv delegated direction decisions 2026-07-03. Chosen:
  adopt pi-tui's input pipeline wholesale (main is the oracle; main runs this
  exact pipeline). OpenTUI's stdin-parser was considered and rejected for the
  input path — see `docs/research/OPENTUI_COMPARISON.md` and the decision
  trail in `plans/README.md`.

## Why this matters

The RPC host re-implements pi-tui's input front-end in fragments: our
`shared-input-router.ts` hand-rolls chunk splitting, split-ESC handling, and
(since plan 029) Kitty release filtering — all behavior pi-tui's own
`StdinBuffer` + keys module already implement and that `main` already runs.
Every re-implemented fragment is a class of bugs we rediscover one terminal
at a time (the doubled-keypress bug was exactly this). Adopting the pipeline
wholesale makes host input behavior identical to main **by construction** and
deletes our custom parsing code.

## Current state

- `src/sumo-tui/input/shared-input-router.ts` — plan 023's router: hand-rolled
  chunk splitting/coalescing + (post-029) an `isKeyRelease` filter, then
  routing to modal layer → overlay → interception point → editor.
- pi-tui exports the full pipeline from its package index
  (`@earendil-works/pi-tui`): `StdinBuffer` (event splitting/coalescing,
  paste-block integrity), `parseKey`/`matchesKey`/`Key`, `isKeyRelease`/
  `isKeyRepeat`, `setKittyProtocolActive`/`isKittyProtocolActive`,
  `parseKeyboardProtocolNegotiationSequence`, `KeybindingsManager`,
  `TUI_KEYBINDINGS`, `normalizeAppleTerminalInput`.
- How pi-tui itself consumes the pipeline is the reference implementation:
  `node_modules/@earendil-works/pi-tui/dist/tui.js` (release filtering at
  ~line 565, StdinBuffer consumption, kitty negotiation response handling)
  and `dist/terminal.js` (flag push — which our
  `src/sumo-tui/runtime/terminal-controller.ts:25` already mirrors).

## Design constraints

1. **Session ownership stays with SumoTUI.** Do NOT instantiate
   `ProcessTerminal` — our `terminal-controller.ts` owns raw mode, altscreen,
   and the kitty push/pop. Adopt `StdinBuffer` + keys as the *parsing* layer
   fed by the router's existing data source.
2. **Routing semantics stay ours.** Focus order (modal → overlay →
   interception point → editor), the pre-editor interception point (plan 025
   wires interrupt tiers there), mouse handoff, and submit callbacks are
   unchanged. This plan swaps the *front-end* (bytes → discrete filtered
   events), not the dispatch.
3. **Mirror TUI's consumption, including:** release filtering (drop `:3`
   events by default), repeat delivery, bracketed-paste block integrity,
   kitty negotiation response parsing (`parseKeyboardProtocolNegotiationSequence`),
   and `setKittyProtocolActive` state so `matchesKey` behaves as on main.
4. **Delete, don't wrap.** Once StdinBuffer covers chunk splitting/ESC
   handling/paste, remove the custom implementations from the router. Code
   that remains must be routing, not parsing.

## Scope

**In scope:** `src/sumo-tui/input/shared-input-router.ts` (+ test),
`src/sumo-tui/rpc/runtime.ts` wiring (+ test), small adapter module if needed
under `src/sumo-tui/input/`.

**Out of scope:** `terminal-controller.ts` semantics (push sequences stay),
interrupt tier logic (025), mouse SGR parsing (keep `parseSgrMouseStream` for
now — OpenTUI's parser lift is a separate backlog item), editor internals,
anything plan 028 owns.

## Steps

1. Study `tui.js`'s StdinBuffer consumption + filtering; write a short note
   in your report on what main's pipeline does that ours didn't.
2. Introduce the StdinBuffer-based front-end behind the router's existing
   interface; route discrete, release-filtered events into the unchanged
   dispatch order. Commit.
3. Delete the superseded custom splitting/coalescing/filter code. The plan-029
   unit + PTY tests MUST pass unchanged — they pin the behavior this swap
   preserves. Commit.
4. Add negotiation-response handling (`parseKeyboardProtocolNegotiationSequence`
   → `setKittyProtocolActive`) so key matching switches modes exactly like
   main. Test with simulated negotiation responses. Commit.
5. Full battery.

## Verification

```bash
pnpm vitest run src/sumo-tui/input/
pnpm vitest run test/integration/rpc-kitty-release.test.ts
pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-scroll.test.ts
pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
```

## Done criteria

- [ ] `grep -n "StdinBuffer" src/sumo-tui/input/shared-input-router.ts` (or the adapter) → ≥1 match
- [ ] Custom chunk-splitting/coalescing code removed (state what was deleted in the report)
- [ ] All plan-023/025/029 input and interrupt tests pass **unchanged**
- [ ] Negotiation-response test exists and passes
- [ ] Full battery green; only in-scope files touched (`git diff <base> --stat`)

## STOP conditions

- StdinBuffer's event model cannot express something the router needs (name
  it — do not fork or vendor pi-tui code).
- Any 023/025/029 test can only pass by modification — that means the swap
  changed pinned behavior; report which test and the observed difference.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Pi version bumps: the input pipeline now tracks pi-tui — re-run the
  keybinding matrix (plan 031) on every bump; that is the whole re-verify.
- OpenTUI A5 mouse-parser lift (backlog) would slot in behind the same router
  interface without touching this front-end.
