# Plan 046: extension_ui protocol hardening — multiline editor(), teardown drain, visible handler errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/rpc/extension-ui-responder.ts src/sumo-tui/rpc/host-overlays.ts src/sumo-tui/rpc/client.ts src/sumo-tui/widgets/modal.ts src/sumo-tui/rpc/host.ts`
> On excerpt mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Three defects on the host↔child extension-UI seam:

1. **`editor()` corrupts multiline prefill.** The responder promises Pi's
   contract — "return the edited text verbatim on submit" — but implements it
   with the single-line input modal, which flattens every `\n` to a space in
   the seeded value. A child extension that opens an editor over a config
   snippet or commit message gets back a single line even if the user presses
   Enter immediately.
2. **Child-exit teardown mis-drives the overlay queue.** The exit path calls
   `overlays.close()` once; `close()` resolves the ACTIVE overlay and then
   ACTIVATES the next queued one — during a crash teardown. Queued overlay
   promises dangle and a new overlay can briefly replace the fatal banner.
3. **Handler exceptions vanish.** `client.handleUiRequest` catches any
   uiRequestHandler throw and replies `cancelled: true` without logging — a
   broken host UI path is indistinguishable from the user pressing cancel.

## Current state

- `src/sumo-tui/rpc/extension-ui-responder.ts:164-172`:

```ts
case "editor": {
	// Pi's editor() contract: open an editor prefilled with `request.prefill`, return
	// the edited text verbatim on submit. The modal's value (not just its placeholder)
	// must be seeded so pressing Enter immediately round-trips the prefill unchanged.
	// ... clobbering it would silently discard whatever the user was mid-typing.
	const value = await this.modals.input(request.title, request.prefill, { initialValue: request.prefill });
	return valueResponse(request.id, value);
}
```

- `src/sumo-tui/widgets/modal.ts:90-92` — `sanitizeSingleLineModalText`
  replaces `\n` with a space; `:170-178` — the input modal stores
  `value: sanitizeSingleLineModalText(opts.initialValue)`; `:94-98` —
  `sanitizeInputChunk` strips `\n` from typed input. `modal.test.ts:~149`
  codifies "line one line two" for seeded multiline input.
- `src/sumo-tui/rpc/host-overlays.ts` (85 lines, read all of it):
  `show()` queues when active (:27-34); `close(value?)` resolves the active
  entry then calls `activateNext()` (:37-46); `activate` installs a `finish`
  that also promotes the queue (:66-77).
- `src/sumo-tui/rpc/host.ts:244` area — `createRpcExitHandler` deps call
  `deps.overlays.close()` exactly once during child-exit teardown (see the
  wiring at `host.ts:752-766`; the handler closes modals, overlays, selector,
  clears streaming state, notifies, and stops the host).
- `src/sumo-tui/rpc/client.ts:308-323`:

```ts
private async handleUiRequest(request: RpcExtensionUIRequest): Promise<void> {
	try {
		const response = await this.uiRequestHandler?.(request, this);
		// ... (doc comment about unconditional cancelled response)
		this.sendUiResponse(response ?? { type: "extension_ui_response", id: request.id, cancelled: true });
	} catch {
		this.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
	}
}
```

  Note the existing logging convention in this file: `console.error(
  "[sumocode-rpc] child stdin error: ..." )` at `client.ts:172-174`.
- Cathedral overlay/modal painting contract: read
  `docs/cathedral/SCRIPTORIUM_CHROME.md` before changing modal rendering —
  all Cathedral overlays share that chrome.
- Approval flows use this same overlay manager
  (`extension-ui-responder.ts:215-241` maps approval select via
  `approvalOverlay.show()`; every non-Yes dismissal must keep normalizing to
  deny). Do not change approval semantics.
- Conventions: tabs, strict TS, colocated tests; render primitives per
  `docs/SUMO_TUI_RENDER_PRIMITIVES.md` for any new modal painting.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/host-overlays.test.ts src/sumo-tui/rpc/client.test.ts src/sumo-tui/widgets/modal.test.ts src/sumo-tui/rpc/host.test.ts` | all pass |

Full `pnpm test` currently exits 1 from a known unrelated flake — not a gate.

## Scope

**In scope**:
- `src/sumo-tui/rpc/extension-ui-responder.ts`, `src/sumo-tui/rpc/host-overlays.ts`,
  `src/sumo-tui/rpc/client.ts`, `src/sumo-tui/widgets/modal.ts`,
  `src/sumo-tui/rpc/host.ts` (exit-handler wiring line only)
- Their five colocated test files

**Out of scope**:
- Approval OPTION semantics (Yes/No/Always normalization) — read-only.
- `src/sumo-tui/widgets/modal-layer.ts` and the retained renderer — if the
  multiline editor needs layer changes, STOP.
- The single-line `input()` modal behavior for its existing callers (prompts
  stay single-line).

## Git workflow

- Branch: `advisor/046-extension-ui-protocol-hardening`
- Conventional commits (`fix(rpc): ...`). Do NOT push.

## Steps

### Step 1: Log swallowed handler errors (smallest first)

In `client.handleUiRequest`, bind the catch (`catch (error)`) and
`console.error` a bounded line following the file's existing style:
`[sumocode-rpc] extension_ui handler failed for method "<method>": <msg>`
(use the existing `toError` helper; truncate with the existing
`truncateForNotification` if the message can be long). Still send the
fail-closed cancelled response.

**Verify**: client.test.ts — a throwing handler produces (a) the cancelled
response on the wire (existing assertion) and (b) a `console.error` spy call
containing the method name.

### Step 2: Add `drain()` to the overlay manager; use it on child exit

In `host-overlays.ts`, add `drain(value?: unknown): void` — resolves the
active overlay AND every queued entry with `value`, clears the queue, never
activates anything, single `onChange()` at the end. Keep `close()` exactly
as-is for interactive dismissal. In `host.ts`'s exit handler wiring, replace
the teardown `overlays.close()` with `overlays.drain()`.

**Verify**: host-overlays.test.ts — with one active + two queued overlays,
`drain()` settles all three promises (resolved `undefined`), `getActiveKind()`
is `undefined`, and no queued component's `create` was invoked after the
drain. host.test.ts — the child-exit test now asserts drain semantics (no
promotion during teardown).

### Step 3: Multiline-preserving `editor()`

Add a dedicated multiline path so `editor()` round-trips `\n` verbatim:

- In `modal.ts`, add a new modal kind `editor` (method
  `ModalManager.editor(title: string, prefill: string): Promise<string | undefined>`):
  value sanitized with `sanitizeModalText` (control chars stripped) but NOT
  the single-line collapse; typed input accepts newline insertion via the
  Enter-with-modifier convention already used elsewhere if one exists —
  otherwise keep editing minimal: the modal displays the multiline value
  (render one row per line, clipped to the modal box) and supports
  submit/cancel plus plain character append/backspace on the LAST line. The
  contract that matters and is tested: **submit-without-editing returns the
  prefill exactly, including newlines**; cancel returns `undefined`.
- In `extension-ui-responder.ts`, route `case "editor"` to
  `this.modals.editor(request.title, request.prefill ?? "")`, keep the
  host-draft-untouched property (it's a separate dialog; nothing writes to
  the chat editor).
- Update the modal test at `modal.test.ts:~149` ONLY if it addresses the new
  `editor` kind; the single-line `input` behavior it pins stays valid for
  `input`.

Keep the painting inside `modal.ts`'s existing render approach (Scriptorium
chrome, typed primitives). If multiline rendering cannot be expressed without
touching `modal-layer.ts` or the renderer, STOP and report.

**Verify**: extension-ui-responder.test.ts — an `editor` request with
`prefill: "a\nb\nc"` submitted immediately responds with value `"a\nb\nc"`
(this must FAIL before the change; note it); cancel responds cancelled and
the host editor draft (fake `editorText`) is unchanged. modal.test.ts — new
`editor` kind: multiline value retained; control characters still stripped.

## Test plan

Enumerated per step. Patterns: existing tests in the same five files. The
Step 3 responder test is the contract test — it encodes Pi's editor()
"verbatim" promise.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] All five targeted test files exit 0
- [ ] Responder editor() multiline round-trip test exists and passes
- [ ] Drain test (no promotion on teardown) exists and passes
- [ ] client.test.ts asserts the handler-error log line
- [ ] Approval-related tests untouched and green
- [ ] `git status` — only in-scope files changed

## STOP conditions

- Multiline modal needs `modal-layer.ts`/renderer changes.
- Any approval test needs weakening.
- The overlay manager is consumed somewhere that relies on close()-promotes
  semantics during teardown (search `overlays.close(` call sites first;
  report if a non-exit caller needs drain).

## Maintenance notes

- Plan 051 (approval dismissal test battery) builds on `drain()` — its tests
  assert teardown resolves pending approvals as deny; keep drain's resolved
  value `undefined` (the responder maps undefined → "No"/cancelled).
- Reviewer: scrutinize the editor modal's input handling for escape-sequence
  leakage (bracketed paste markers must still be stripped — see
  `sanitizeInputChunk`).
