# Plan 058: Remove SumoCode's own action-confirmation toasts (match main's silent-on-action UX)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 4f289fb..HEAD -- src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-actions.ts`
> On excerpt mismatch, STOP.

## Status

- **Priority**: P2 (user-reported)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (UX parity with main)
- **Planned at**: commit `4f289fb`, 2026-07-07

## Why this matters

The user reports: an alert/notification banner pops up "whenever any action is
performed" and it was not present on `main`. On `main`, model/thinking/session
actions went through Pi's native in-process UI, which updated the footer
silently — no toast. The RPC host (new this branch) added its own
`notify(..., "info")` confirmation toasts on those actions, so every model
cycle, thinking change, draft clear, etc. now flashes a banner. This removes
those self-confirmation toasts to restore main's quiet UX, while keeping
(a) genuine failure feedback (warning/error) and (b) the extension/agent-driven
`extension_ui` notify path (that is Pi extensions talking, not SumoCode
confirming an action).

## Current state

The `NotificationCenter` (`src/sumo-tui/widgets/notification.ts`) is a generic
toast stack — DO NOT remove or gut it; it also renders `extension_ui` `notify`
requests routed through `extension-ui-responder.ts` (keep that path). Only the
SumoCode-self action-confirmation call sites are in scope.

Action-confirmation calls to REMOVE (info/success toasts fired by SumoCode's
own handlers on a successful user action):

- `src/sumo-tui/rpc/host.ts:393` — `deps.notifications.notify(\`model: ${state.modelLabel}\`, "info")` in the cycle-forward handler.
- `src/sumo-tui/rpc/host.ts:430` — same `model: ...` toast in the cycle-backward handler.
- `src/sumo-tui/rpc/host.ts:454` — `thinking: ${state.thinkingLevel}` toast in the thinking-cycle handler.
- `src/sumo-tui/rpc/host.ts:350` — `notify("draft cleared", "info")`.
- `src/sumo-tui/rpc/host.ts:356` — `notify("abort requested", "info")`.
- `src/sumo-tui/rpc/host-actions.ts:563` — `notify(..., \`model: ${provider}/${id}\`, "info")` in `openModelSelector`.
- `src/sumo-tui/rpc/host-actions.ts:676` — `notify(..., "session resumed", "info")`.
- `src/sumo-tui/rpc/host-actions.ts:770` — `notify(..., \`approval selected: ${choice}\`, ...)` — remove ONLY the info (allow) case; see Step 2 for the deny case.

Calls to KEEP (NOT action-confirmations — do not touch):

- Every `warning`/`error` notify (failure feedback): `unknown command`,
  `no models available`, `unknown model`, `no forkable messages`,
  `no session file available...`, `no sessions found`, `session tree unavailable`,
  `session has no entries yet`, `CHANGELOG.md not found`, `memory unavailable...`,
  and `host.ts:250` `RPC child exited unexpectedly` (error).
- `host.ts:361` `press ctrl-c again to quit` — functional quit-discoverability
  hint, not a confirmation. KEEP (Pi shows an equivalent). If the user later
  wants it gone that's a trivial follow-up; do not remove it here.
- `host-actions.ts:809`-area `/memory status` output — that IS the command's
  result, not an incidental confirmation. KEEP.
- The `extension_ui` `notify` path in `extension-ui-responder.ts`. KEEP.

The `notify` helper is `host-actions.ts:140-142`; handler notify calls in
host.ts use `deps.notifications.notify(...)` directly.

Conventions: tabs, strict TS, colocated tests.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |

Full `pnpm test` is a valid gate here too (fast) but the two targeted files
are the primary check.

## Scope

**In scope**:
- `src/sumo-tui/rpc/host.ts` (the enumerated notify removals only)
- `src/sumo-tui/rpc/host-actions.ts` (the enumerated notify removals only)
- `src/sumo-tui/rpc/host.test.ts`, `src/sumo-tui/rpc/host-actions.test.ts`
  (update/remove assertions that asserted the removed toasts)

**Out of scope**:
- `src/sumo-tui/widgets/notification.ts` — the widget stays.
- `extension-ui-responder.ts` — the extension notify path stays.
- Any warning/error notify call.
- The footer/chrome that shows the current model/thinking (those already
  reflect the change — that is the point: the toast was redundant).

## Git workflow

- Branch: `advisor/058-remove-action-confirmation-toasts` off `4f289fb`
- Conventional commits (`fix(rpc): ...`). Do NOT push.

## Steps

### Step 1: Remove the info action-confirmation toasts

Delete the exact call sites listed in "Current state" (model fwd/back/selector,
thinking, draft cleared, abort requested, session resumed). Leave the
surrounding logic (`onStateChange`, state application, control calls) intact —
only the `notify(...)` statement goes. After each removal confirm the handler
still returns/awaits correctly (no dangling `await notifyOnError` wrapper left
empty — if a removed notify was the whole body of a `notifyOnError` callback,
keep the control call, drop only the notify).

**Verify**: `pnpm exec tsc --noEmit` → 0.

### Step 2: Approval feedback — remove allow toast, keep deny as warning

At `host-actions.ts:770`, the approval overlay currently notifies
`approval selected: ${choice}` (info when allowed, warning when denied). Remove
the toast for the ALLOW path (the command proceeds — visible). For the DENY
path, KEEP a terse `warning` toast (e.g. `command blocked`) — a silent denial
is confusing and deny feedback is security-relevant and low-frequency. If the
current code uses one notify with a computed level, split so allow → no toast,
deny → warning.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts` → pass.

### Step 3: Fix the tests

Update `host.test.ts` / `host-actions.test.ts`: any assertion that the removed
toasts fired must be removed or inverted (assert the notify was NOT called for
the action-confirmation cases). Keep assertions for the retained
warning/error notifications. Add one test asserting a successful model cycle
fires NO notification (the regression this fixes).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` → all pass.

## Test plan

- New: "cycle model fires no confirmation toast" (host.test.ts), "model
  selector applies without a toast" (host-actions.test.ts).
- Update: remove/inverse any existing assertions on the removed toasts.
- Keep: assertions for warning/error notifications and the deny warning.
- Pattern: existing notify assertions in those two test files.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` exits 0
- [ ] The eight enumerated info toasts are gone; a test proves a model cycle is toast-free
- [ ] All warning/error notifications, the quit hint, and the extension_ui notify path are untouched
- [ ] `git status` — only the 4 in-scope files changed

## STOP conditions

- A removed notify turns out to be the only thing keeping a `notifyOnError`
  wrapper meaningful (then keep the wrapper's control call, drop only the toast).
- Removing a toast would also remove failure feedback (you're touching a
  warning/error by mistake).
- The approval notify cannot be cleanly split into allow/deny (report the
  actual shape).

## Maintenance notes

- Rule going forward: SumoCode does not toast on its own successful actions
  (the footer/transcript already reflects them); toasts are for failures and
  extension/agent messages only.
- If the user later wants the quit hint or memory-status output gone too,
  those are one-line follow-ups.
