# Plan 022: Share extension regions and chrome publication

> **Executor instructions:** Route RPC extension UI requests into the same region
> and publication model used by the portable shell. Do not hand-paint widgets or
> sidebar data inside the RPC renderer.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** 019, 020
- **Category:** architecture / UX parity
- **Planned at:** `a3966a7`, 2026-07-02
- **Execution status:** DONE, 2026-07-03.
  Executed as `codex/plan022-extension-regions-exec` at `3b4d8c0`, plus the
  narrow follow-up `codex/plan022-modal-label-sanitization-fix` at `457ca33`.
  Reviewer verified focused region/modal/approval/runtime suites,
  integration, runtime visual parity, visual CI, typecheck/build, and clean
  autoreview for the follow-up.

### Execution review notes

Executor commit `3b4d8c0` passed:

```bash
pnpm vitest run src/sumo-tui/widgets/modal.test.ts src/sumo-tui/rpc/extension-ui-responder.test.ts src/approval-modal.test.ts src/sumo-tui/pi-compat/extension-ui-adapter.test.ts src/sumo-tui/pi-compat/region-registry.test.ts src/sumo-tui/widgets/modal-layer.test.ts test/integration/rpc-host-shell.test.ts src/sumo-tui/rpc/runtime.test.ts
pnpm test:integration
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

Final autoreview after two revision rounds still found and the reviewer
accepted this remaining blocker:

- `ModalManager.select()` now keeps sanitized display labels separate from raw
  option values, but it uses the same sanitizer for multiline titles and
  single-row select labels.
- That sanitizer preserves `\n`, which is correct for titles/messages but
  wrong for select option labels. A generic RPC select option like
  `"Allow\nextra"` can place an embedded newline in a rendered option row and
  break the retained frame output.
- The fresh narrow fix must preserve raw option return values while normalizing
  CR/LF to spaces for select option display labels and other single-line fields
  such as placeholders. Keep multiline handling for titles/messages.

`pnpm test` was also run during review and exited 1 only because of the known
unrelated background-task `output.log` ENOENT after all assertions passed.

Fresh follow-up commit `457ca33` fixed that blocker and passed:

```bash
pnpm vitest run src/sumo-tui/widgets/modal.test.ts
pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts src/approval-modal.test.ts
pnpm vitest run src/sumo-tui/pi-compat/extension-ui-adapter.test.ts src/sumo-tui/pi-compat/region-registry.test.ts src/sumo-tui/widgets/modal-layer.test.ts test/integration/rpc-host-shell.test.ts src/sumo-tui/rpc/runtime.test.ts
pnpm test:integration
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

Autoreview of the narrow follow-up against `3b4d8c0` reported no
accepted/actionable findings. Select labels and placeholders now normalize
CR/LF to spaces for display while select promises still resolve the original
raw option values.

## Why this matters

The current RPC responder can accept `setWidget`, `setStatus`, notifications,
and dialogs, but the active host wiring does not feed a shared `RegionRegistry`
or canonical chrome publication path. That means working indicators and sidebar
state can silently disappear or drift.

## Scope

**In scope:**

- `src/sumo-tui/pi-compat/extension-ui-adapter.ts`
- `src/sumo-tui/pi-compat/region-registry.ts`
- `src/sumo-tui/rpc/extension-ui-responder.ts`
- `src/sumo-tui/rpc/host.ts`
- `src/sidebar.ts`
- `src/top-chrome.ts`
- `src/sumo-tui/widgets/modal.ts`, `src/sumo-tui/widgets/modal-layer.ts` + tests (Step 3b)
- `src/approval-modal.ts` — marker export only; gate logic is untouchable (Step 3c)

**Out of scope:**

- Adding a new Pi RPC protocol method.
- Reintroducing `ctx.ui.custom()` over RPC.
- Rebuilding first-party rich overlays; only mount existing components.

## Steps

### Step 1: Define backend-neutral publications

Create small interfaces for:

- top chrome publication,
- sidebar publication,
- footer publication,
- widgets above/below editor,
- status/working indicator state,
- notifications and modal overlays.

The portable shell consumes these interfaces. Pi and RPC both publish into them.

### Step 2: Adapt `SumoExtensionUIAdapter`

Ensure the current adapter can mount into a shell-owned registry without
depending on Pi internals. Keep Pi-specific behavior behind the Pi adapter.

### Step 3: Adapt RPC `extension_ui_request`

Wire `RpcExtensionUiResponder` with a real region registry, status sink,
notification center, modal layer, and editor text controller used by the shared
shell.

Map Pi RPC methods as follows:

- `select`, `confirm`, `input`, `editor`: modal layer,
- `notify`: notification region,
- `setStatus`: status/working publication,
- `setWidget`: region registry with placement,
- `setTitle`: terminal title,
- `set_editor_text`: shared editor text controller.

### Step 3b: Fix the modal layer itself before routing dialogs into it

Routing dialogs to the modal layer is not enough — the base `ModalManager`
(`src/sumo-tui/widgets/modal.ts`, which `ModalLayer` extends) has four verified
defects (evidence in `plans/draft-rpc-host-main-brain-rebuild.md`). Fix them in
the base class so both layers inherit:

1. **Queueing, never clobbering** (`modal.ts:77-99`): `select/confirm/input`
   overwrite `this.active`; the displaced modal's promise never resolves — a
   displaced `extension_ui_request` means the child extension awaits forever
   and the agent wedges. Worse, the displaced modal's still-armed timeout later
   calls `finish()` on the wrong (new) modal. Queue requests FIFO; make each
   dismissal timer belong to its own modal entry. A queued request's timeout
   must count from enqueue time, or a stuck modal wedges the child anyway.
2. **Multi-line titles** (`modal.ts:141`): the title is painted as one
   truncated row. RPC approvals arrive as a `select` whose title is
   `"APPROVAL REQUIRED\n\n<command>\n\n<description>"`
   (`src/approval-modal.ts:265-270`) — the user currently approves a command
   they mostly cannot see. Split on `\n` and wrap to the modal width (use
   `visibleWidth` from `@earendil-works/pi-tui`).
3. **Sanitization**: strip ANSI/control sequences from title, message, and
   option strings before painting (a model-generated command can carry escape
   sequences — display-spoofing vector on the approval surface). Preserve
   multiline wrapping for title/message only; option labels and placeholders
   are single-line UI fields and must normalize CR/LF to spaces while still
   resolving raw option values to callers.
4. **Paste** (`modal.ts:172-176`): the input modal accepts single printable
   chars only; pasted text and bracketed-paste payloads are dropped ("switch
   session by path" is unusable). Accept multi-char printable chunks; strip
   `[200~` / `[201~` markers and control chars.

### Step 3c: Route real approvals through the Cathedral approval component

The polished Cathedral approval surface (`renderApprovalModal` +
`updateApprovalSnapshot` in `src/approval-modal.ts`) is currently used only by
the `/sumo:approval` preview; real RPC approvals get the bare generic select.
Export a stable marker from `src/approval-modal.ts` (the title already begins
`APPROVAL REQUIRED`); when a `select` request's title starts with that marker
and its options match the approval options, render the Cathedral component via
the overlay host and map the result (`yes`/`no`/`always`) back to the select
response. Any mismatch → fall back to the (now legible) generic select.
**Do not touch the gate decision logic** — cancel/timeout/error must keep
normalizing to "no" (fail-closed, verified; see plans/README.md rejected
findings).

### Step 4: Restore chrome/sidebar publication

Make `top-chrome.ts` and `sidebar.ts` publish to a backend-neutral runtime
accessor rather than a Pi-only runtime global. RPC should receive the real
component or snapshot through that publication path.

### Step 5: Verify visible regions

Add tests proving that RPC `setWidget` appears in the above-editor or sidebar
region, `setStatus` updates the intended status surface, and notifications
render through the overlay layer.

## Verification

```bash
pnpm vitest run src/sumo-tui/pi-compat/extension-ui-adapter.test.ts
pnpm vitest run src/sumo-tui/pi-compat/region-registry.test.ts
pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts
# Step 3b (modal fixes) — queueing, per-modal timers, multi-line wrap,
# sanitization, paste, and modal focus while queued:
pnpm vitest run src/sumo-tui/widgets/modal.test.ts
pnpm vitest run src/sumo-tui/widgets/modal-layer.test.ts
# Step 3c (approval routing) — marker route + gate untouched:
pnpm vitest run src/approval-modal.test.ts
pnpm vitest run test/integration/rpc-host-shell.test.ts
pnpm visual:review -- --scenario active-landscape-runtime
pnpm exec tsc --noEmit && pnpm build
```

Step 3b must add its cases to `src/sumo-tui/widgets/modal.test.ts` (queue
order, displaced-timer isolation, wrap, strip, paste) and a queue/focus test
to `src/sumo-tui/widgets/modal-layer.test.ts` (input routes to the visible
modal while others are queued). `src/approval-modal.test.ts` must pass
without modification to its gate-behavior assertions.

## Done criteria

- [x] RPC extension UI requests mount into shared shell regions.
- [x] Top chrome and sidebar use shared publication instead of RPC-only
  fabrication.
- [x] Working/status widgets are visible in RPC runtime captures.
- [x] No new RPC-only visual language is introduced.
- [x] Unit tests: two concurrent selects both resolve, in order; a queued
  modal's timeout dismisses only itself; a multi-line approval title renders
  every line; ANSI/control chars are stripped from painted dialog text; paste
  works in the input modal.
- [x] An approval-marked `select` renders the Cathedral approval component and
  round-trips `yes`/`no`/`always`; `src/approval-modal.test.ts` still passes
  unchanged (gate logic untouched).

## STOP conditions

- A required first-party overlay cannot be represented with Pi RPC's fixed
  `extension_ui_request` methods.
- Region mounting changes the current main TUI layout.
