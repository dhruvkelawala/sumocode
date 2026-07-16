# 003 — Phase 2: extension_ui responder + selectors + session/model/compaction controls

**Written against commit:** `ae03bc0`
**Size:** M · **Depends on:** 002 · **Blocks:** 004, 005, 006
**Issue:** [#291](https://github.com/dhruvkelawala/sumocode/issues/291)
**Design doc:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)

## Why this exists

Make every *stock* `extension_ui_request` primitive render host-side at parity, re-host Pi's
own model/theme/resume selectors in-process, and drive session/model/thinking/compaction
controls over typed RPC commands. This is the shared substrate the overlay rewrite (005)
depends on — the full `extension_ui` responder is the back-channel that replaces the missing
`custom()` channel.

## Background facts (verified)

- RPC `extension_ui_request` methods (from `rpc-mode.js` / `rpc-types.d.ts`):
  `select(title, options)`, `confirm(title, message)`, `input(title, placeholder)`,
  `editor(title, prefill)`, `notify(message, type)`, `setStatus(key, text)`,
  `setWidget(key, lines, placement)`, `setTitle(title)`, `set_editor_text(text)`. Each has an
  `id`; the host replies with `extension_ui_response` (`{id, value}` | `{id, confirmed}` |
  `{id, cancelled:true}`).
- **The bare `RpcClient` does not answer `extension_ui_request`** — it only forwards events.
  The host must write the `extension_ui_response` JSONL to the child's stdin, matched by `id`.
  `RpcProcessInstance.setUiRequestHandler(...)` (Pi orchestrator) is the reference for this.
- SumoCode already has host-side renderers to back these: `ModalManager`/modal layer and
  `NotificationCenter` in `src/sumo-tui/` (used today for notify/modals). These survive
  verbatim; only the trigger source changes (from `ctx.ui.*` interception to
  `extension_ui_request`).
- Pi's selectors are **public exports** of `@earendil-works/pi-coding-agent`:
  `ModelSelectorComponent`, `ThemeSelectorComponent`, `SessionSelectorComponent`,
  `ThinkingSelectorComponent`, `SettingsSelectorComponent`. Construct them in-process in the
  host against host-owned state — do not rebuild them.
- RPC control commands: `new_session`, `switch_session`, `fork`, `clone`, `set_model`,
  `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`,
  `compact`, `set_auto_compaction`, `set_auto_retry`.
- SumoCode's slash/shortcut wiring: `src/interaction-registry.ts` (now takes a
  `backgroundTaskManager` as of 0.4).

## Scope

**In scope:** the full `extension_ui` responder backed by `ModalManager`/`NotificationCenter`;
re-hosting Pi's selector components in the host; wiring session/model/thinking/compaction
controls to RPC commands.

**Out of scope:** the 8 bespoke `ctx.ui.custom<>` overlays (Plan 005) — those are NOT stock
primitives and need the host-render + value-round-trip pattern. The editor (Plan 004).

## Steps

1. **Full `extension_ui` responder.** Implement a host handler for every
   `extension_ui_request` method: `select`/`confirm`/`input`/`editor` open the corresponding
   SumoTUI modal and reply with `{id, value}`/`{id, confirmed}`/`{id, cancelled:true}` by
   writing JSONL to the child stdin keyed by request `id`; `notify` → `NotificationCenter`;
   `setStatus`/`setWidget`/`setTitle` → region-registry surfaces; `set_editor_text` →
   editor buffer (coordinate with Plan 004 — until then, stash the text).
   - **Verify:** a test extension under the RPC host that calls each `ctx.ui.*` primitive
     produces the matching host render and a correctly-`id`'d response. Assert `select`
     returns the chosen value and `cancelled` round-trips.

2. **Re-host selectors.** Construct Pi's `ModelSelectorComponent`/`ThemeSelectorComponent`/
   `SessionSelectorComponent`/`ThinkingSelectorComponent` in the host modal layer, fed by
   `get_available_models`/`get_state`. Route their selection to `set_model`/`cycle_model`/
   `switch_session`/`set_thinking_level`.
   - **Verify:** opening the model selector in the RPC build crop-matches the patched build
     (`pnpm visual:ci`), and choosing a model issues `set_model` and updates the footer.

3. **Session/compaction controls.** Wire `new_session`/`switch_session`/`fork`/`clone`/
   `compact`/`set_auto_compaction`/`set_auto_retry` to the corresponding SumoCode commands and
   keymaps in `src/interaction-registry.ts` (RPC path only).
   - **Verify:** `/compact`, new-session, and session-switch behave identically to the patched
     build; the compaction indicator (Plan 002) reflects `is_compacting`.

4. **Fast-mode footer label.** Fast-mode runs as a subprocess extension; surface its footer
   label via the `setStatus` channel so the host renders it.
   - **Verify:** toggling fast mode updates the footer label in the RPC build.

## Done criteria

- `pnpm exec tsc --noEmit && pnpm build` clean.
- `pnpm test` + `pnpm test:integration` green, incl. a new responder round-trip test.
- `pnpm visual:ci` green for selectors/modals/notifications on the RPC runtime lane.
- A test asserts an unanswered/cancelled `extension_ui_request` resolves to `cancelled`, never
  to a spurious value.

## Escape hatches — STOP and report

- If writing `extension_ui_response` to child stdin races with command responses (id
  collisions, interleaving), STOP and document the framing contract needed — get it right
  before 005 builds on it.
- If a selector component's public export does not accept host-owned state cleanly, STOP and
  record the gap rather than forking the component.

## Test plan

- Responder round-trip test per method (follow `src/sumo-tui/pi-compat/extension-ui-adapter.test.ts`
  as the pattern).
- Selector visual fixtures in the fixture lane.

## Maintenance note

The `extension_ui` responder is the foundation 005 reuses for overlays. Keep its `id`-matching
and cancellation semantics strict and well-tested — a dropped or mismatched response hangs the
subprocess tool call.

## Execution review

**Status:** DONE — accepted in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`,
`573248c`), based on approved Plan 002 branch `codex/rpc-host-shell-002-exec`.

**Advisor verdict:** APPROVE. The accepted implementation adds a strict
`RpcExtensionUiResponder`, typed `RpcHostControls`, and host-owned Cathedral modal selectors
for model/thinking/session/settings control. It intentionally uses SumoCode modal selectors
wired to Pi RPC commands instead of embedding Pi selector components directly; this preserves
the host/process split while satisfying the user-facing control requirement.

**Verification rerun by advisor:**

- `pnpm vitest run src/approval-modal.test.ts src/answer-tool.test.ts src/question-tool.test.ts src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/host-actions.test.ts test/integration/rpc-host-shell.test.ts test/integration/spawn-pi-pty.test.ts` — passed, 10 files / 96 tests.
- `pnpm exec tsc --noEmit && pnpm build` — passed.
- `pnpm test:integration` — passed, 20 files / 36 tests.
- `pnpm visual:ci` — exited 0; review pack at `docs/visual/out/parity/index.html` in the worker worktree.
- `pnpm test` — all 119 files / 1112 tests passed, but Vitest exited 1 from the known unrelated background-task temp `output.log` ENOENT unhandled error.

**Scope review:** `git diff --name-only codex/rpc-host-shell-002-exec..HEAD -- plans docs`
was empty; source stack kept `src/sumo-tui/rpc/runtime.ts` and remained descended from the
approved Plan 002 branch.
