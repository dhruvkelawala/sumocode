# 004 — Phase 3: Editor internalization (re-host pi-tui Editor)

**Written against commit:** `ae03bc0`
**Size:** L · **Depends on:** 003 · **Blocks:** 006 (parallel with 005)
**Issue:** [#292](https://github.com/dhruvkelawala/sumocode/issues/292)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

In the RPC model the host owns the terminal and therefore the input editor. The full editor
(IME, paste, kill-ring, undo, multiline, autocomplete state machine, cursor marker) must run
host-side. The key de-risk: **this is a library re-host, not a rebuild** — pi-tui's `Editor`
and `CombinedAutocompleteProvider` are public exports, and keystrokes never cross RPC (no
per-keystroke latency). The Cathedral chrome is a pure string-transform wrapper around the
editor's render output.

## Background facts (verified)

- pi-tui exports `Editor` and `CombinedAutocompleteProvider` (public — direct sumocode dep).
  `@earendil-works/pi-coding-agent` exports `CustomEditor` and `BorderedLoader` (public).
- SumoCode's Cathedral editor chrome: `src/cathedral/cathedral-editor.ts` (and the
  draft-state added in 0.4: `src/cathedral/editor-draft-state.ts`). The cursor marker is
  scanned via the `PiEditorLeaf` mechanism in `src/sumo-tui/`.
- Slash-command completion source over RPC is `get_commands` — **but it omits Pi's builtin
  slash commands.** The ~22 builtins (e.g. `/model`, `/compact`, `/new`, `/resume`, `/help`,
  `/theme`, …) must be hardcoded host-side. `/model` argument completion is reconstructable
  from `get_available_models`.
- Known losses (accept or mitigate): extension-command *argument* completion
  (`getArgumentCompletions`/`argumentHint`) cannot cross JSON; `pi.addAutocompleteProvider`
  (third-party autocomplete) is a no-op over RPC.
- File-mention completion uses `fd`/`readdirSync` host-locally in
  `CombinedAutocompleteProvider` — discover `fd` host-side (`which fd`).

## Scope

**In scope:** constructing pi-tui `Editor` + `CombinedAutocompleteProvider` in the host;
re-wrapping the Cathedral chrome (top border, active-row wrap, autocomplete-row alignment);
emitting/positioning the cursor marker; slash completion from `get_commands` + hardcoded
builtins; `/model` arg completion from `get_available_models`; preserving the Divine
Invocation frame + placeholder injection.

**Out of scope:** overlays/approval (Plan 005); the transcript/chrome (Plan 002). Do not
attempt to recover third-party autocomplete providers in this phase (decide in step 5).

## Steps

1. **Construct the editor in-process.** Instantiate pi-tui `Editor` +
   `CombinedAutocompleteProvider` in the host, mounted in the SumoTUI input region. Route key
   events to it directly (no RPC).
   - **Verify:** typing, multiline (shift-enter), paste, and undo behave identically to the
     patched build in a headless TestBackend test.

2. **Re-wrap Cathedral chrome.** Apply `src/cathedral/cathedral-editor.ts`'s render transforms
   (border, active-row, autocomplete alignment) around the editor's render output, preserving
   the Divine Invocation frame and placeholder injection. Port the 0.4 draft-state
   (`editor-draft-state.ts`) behavior.
   - **Verify:** `pnpm visual:ci` crop-matches the editor in every state: empty, typing,
     multiline, autocomplete-dropdown-open, paste, mention.

3. **Cursor marker.** Emit and position the hardware cursor marker via the existing
   `PiEditorLeaf` scan path.
   - **Verify:** the cursor is byte-identical in position to the patched build across the
     states in step 2.

4. **Slash completion.** Feed completion from `get_commands` (extension/prompt/skill) plus a
   hardcoded list of the ~22 Pi builtins. Reconstruct `/model` argument completion from
   `get_available_models`.
   - **Verify:** typing `/` shows the full command set (builtins + extension + skills); `/mod`
     filters to `/model`; `/model ` offers model ids. Assert the builtin list matches Pi's
     actual builtins (cross-check against `pi --help` / interactive completion).

5. **Decide third-party autocomplete.** Either (a) accept the regression (extension-command
   arg completion + `addAutocompleteProvider` lost) and surface a host-side notice for
   unsupported methods, or (b) load extension autocomplete factories host-side (dents the
   clean split). Record the decision in the plan's status and `docs/research/pi-rpc-migration.md`.
   - **Verify:** the chosen behavior is implemented and tested; the loss (if accepted) is
     documented.

## Done criteria

- `pnpm exec tsc --noEmit && pnpm build` clean.
- `pnpm test` + `pnpm test:integration` green, incl. headless editor behavior tests.
- `pnpm visual:ci` green for the editor in all states (THE parity gate for this phase).
- The builtin slash-command list is asserted complete by a test.

## Escape hatches — STOP and report

- If the public `Editor` export cannot be driven without private internals (a behavior the
  patched `CustomEditor` relied on), STOP and document exactly what is missing — this would
  re-open the "rebuild" risk.
- If cursor-marker positioning drifts and cannot be made byte-identical, STOP — cursor parity
  is non-negotiable for "same-or-better".

## Test plan

- Headless TestBackend tests for typing/multiline/paste/undo/autocomplete (follow
  `docs/SUMO_TUI_TEST_BACKEND.md`).
- Visual fixtures for each editor state.
- A test asserting the hardcoded builtin list equals Pi's builtin set.

## Maintenance note

The hardcoded builtin slash list is a maintenance liability — a Pi version bump can
add/rename builtins. Add a CI check (or a doctor check) that diffs the hardcoded list against
Pi's actual builtins so drift is caught at upgrade time (tie into the smoke matrix in
`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`).
