# Plan 041: Make model/thinking changes update chrome instantly (optimistic, one round-trip max)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP updating `plans/README.md` — your reviewer
> maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-actions.ts`
> On any drift, compare "Current state" excerpts against live code; on a
> mismatch, STOP.

## Status

- **Priority**: P1 (user-reported)
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug + perf
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

The user reports model changes are "very slow". Root cause (verified): a
model/thinking change patches `RpcHostStateStore`, but the visible chrome
renders from `RpcHostRuntime`'s own private `state` snapshot, which is only
replaced by `runtime.update({ state })`. Every model/thinking path is wired to
a bare repaint (`requestRender`), so the footer keeps the OLD value until the
next agent event pushes fresh state — i.e. until the user sends a message. The
5s stats poll cannot repair it because `hydrateFromSessionStats` never touches
`modelLabel`/`thinkingLevel`. Additionally, `Shift+Ctrl+P` (cycle backward)
pays a `get_available_models` round-trip (531-model payload) on every press,
and `setThinkingLevel` awaits a response that carries no data before applying
a value it already knows. After this plan: chrome updates synchronously on the
keypress/selection (optimistic, reconciled on the RPC response), and repeated
cycling costs at most one RPC per press.

## Current state

All in `/` = repo root. Read these before editing:

- `src/sumo-tui/rpc/host.ts:552` — `const requestRender = (): void => runtime?.requestRender();`
- `src/sumo-tui/rpc/host.ts:637-651` — the three keybinding handlers are wired
  with `onStateChange: requestRender`:

```ts
const handleModelCycleForward = createModelCycleForwardHandler({
	controls,
	notifications,
	onStateChange: requestRender,
});
const handleModelCycleBackward = createModelCycleBackwardHandler({ ... onStateChange: requestRender });
const handleThinkingCycle = createThinkingCycleHandler({ ... onStateChange: requestRender });
```

- `src/sumo-tui/rpc/host.ts:373-431` — the handlers themselves. Forward:
  `const state = await deps.controls.cycleModel(); deps.onStateChange?.();`.
  Backward: fetches `await deps.controls.getAvailableModels()` on EVERY press
  (doc comment at :398-412 explains the local-computation decision), finds
  `previousIndex`, then `await deps.controls.setModel(...)`, then
  `deps.onStateChange?.()`. The returned patched state is used only for the
  toast text.
- `src/sumo-tui/rpc/host.ts:720-734` — `RpcHostActions` constructed with
  `onStateChange: requestRender` (line 728). Its `/model` selector path
  (`host-actions.ts:547-563`) and `setModelFromText` (`:849-857`) call
  `await this.controls.setModel(...); this.onStateChange();` — same staleness.
- `src/sumo-tui/rpc/host.ts:739-745` — the only place agent activity pushes
  state: `client.onEvent` → `runtime?.update({ state, transcript, ... })`.
- `src/sumo-tui/rpc/host.ts:768-781` — `refreshStats` (5s poll) pushes
  `stateStore.hydrateFromSessionStats(stats)`.
- `src/sumo-tui/rpc/controls.ts:64-103` — `refreshState`, `getAvailableModels`
  (no cache), `setModel`/`cycleModel`/`setThinkingLevel`/`cycleThinkingLevel`
  (each awaits the RPC, then patches the store via `applyModelChange`/
  `applyThinkingLevel`). The comment block at :74-81 documents that the
  mutating responses carry the resulting model/level inline.
- `src/sumo-tui/rpc/state.ts:56-72` — `hydrateFromRpcState` spreads
  `...this.state` and sets session/model/streaming/message fields, but never
  resets `lastEventType` or `taskPartialCount`.
- `src/sumo-tui/rpc/state.ts:100-139` — `handleAgentEvent` bumps
  `taskPartialCount` and sets `lastEventType` per event.
- `src/sumo-tui/rpc/state.ts:146-175` — `applyModelChange(model, thinkingLevel?)`
  and `applyThinkingLevel(level)` patch the store directly (DF-7).
- `src/sumo-tui/rpc/shell-adapter.ts:446-453` — `rpcSessionIsActive` treats
  `state.taskPartialCount > 0` as an active session; `:471-476` — `sumoState`
  returns `"tool"` while `lastEventType` is `tool_call`/`tool_execution_update`.
  This is why stale event-derived fields after a session switch paint wrong
  chrome (fix in Step 5; do NOT edit shell-adapter.ts).
- `src/sumo-tui/rpc/controls.ts:145-156` — `setSessionName`/`setAutoCompaction`
  return `void`; `src/sumo-tui/rpc/host-actions.ts:956-964` — rename and
  auto-compaction actions call `await this.controls.refreshState()` right after
  the mutation (an avoidable `get_state` round-trip).
- Existing test patterns: `src/sumo-tui/rpc/controls.test.ts` (fake
  `RpcCommandClient` returning canned responses), `src/sumo-tui/rpc/state.test.ts`,
  `src/sumo-tui/rpc/host.test.ts` (handler-level tests with fake deps).
  Match them. Tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |

Note: full `pnpm test` currently exits 1 from a known unrelated flake (plan
040 fixes it) — do not use it as your gate.

## Scope

**In scope**:
- `src/sumo-tui/rpc/state.ts`, `src/sumo-tui/rpc/state.test.ts`
- `src/sumo-tui/rpc/controls.ts`, `src/sumo-tui/rpc/controls.test.ts`
- `src/sumo-tui/rpc/host.ts`, `src/sumo-tui/rpc/host.test.ts`
- `src/sumo-tui/rpc/host-actions.ts`, `src/sumo-tui/rpc/host-actions.test.ts`

**Out of scope**:
- `src/sumo-tui/rpc/shell-adapter.ts`, `runtime.ts`, `editor.ts`,
  `inline-selector.ts` — the render/read side must not change.
- The interrupt tier, submit path, transcript pump.
- Pi's RPC protocol usage beyond the commands already sent.

## Git workflow

- Branch: `advisor/041-optimistic-model-thinking-chrome`
- Commits per step, conventional style (`fix(rpc): ...`, `perf(rpc): ...`).
- Do NOT push.

## Steps

### Step 1: Route every state change into the runtime, not just a repaint

In `host.ts`, add next to `requestRender` (:552):

```ts
const pushState = (state?: RpcHostChromeState): void => {
	runtime?.update({ state: state ?? stateStore.getSnapshot() });
};
```

(`runtime.update` schedules a coalesced render itself; see
`runtime.ts:256-263`, so no extra `requestRender` call is needed — verify that
while implementing and add `requestRender()` only if `update` does not.)

Wire it:
- the three handler constructions (:637-651): `onStateChange: pushState`
- `RpcHostActions` construction (:728): `onStateChange: pushState`
- Update the handler dependency types (`RpcHostModelCycleDependencies` etc. at
  :373-377) from `onStateChange?: () => void` to
  `onStateChange?: (state?: RpcHostChromeState) => void`, and make each handler
  pass its patched state: `deps.onStateChange?.(state)`.

**Verify**: `pnpm exec tsc --noEmit` → 0; new host.test.ts case: invoking the
forward-cycle handler with a fake controls whose `cycleModel` resolves a state
with `modelLabel: "x/y"` results in a `runtime.update`-equivalent callback
receiving that state (assert via injected `onStateChange` spy in the handler
test AND a `runRpcHost`-level wiring test if one exists for handlers — follow
existing host.test.ts patterns).

### Step 2: Optimistic apply for locally-known targets

In `controls.ts`:
- `setModel(provider, modelId)`: BEFORE sending, call
  `this.stateStore.applyModelChange({ provider, id: modelId })` and capture the
  pre-change snapshot. Send the RPC; on success, apply the response payload as
  today (authoritative — it may differ); on throw, restore by calling
  `refreshState()` (authoritative rollback) and re-throw.
- `setThinkingLevel(level)`: apply `applyThinkingLevel(level)` before the
  send; on throw, `refreshState()` and re-throw.
- Add an optional `onOptimisticChange?: (state: RpcHostChromeState) => void`
  constructor option to `RpcHostControls` invoked right after each optimistic
  apply, and wire it to `pushState` in `host.ts` construction — this is what
  makes the footer move on the keypress, before the round-trip.
- `cycleModel()`/`cycleThinkingLevel()`: leave response-gated (the child picks
  the next value), but they already patch + now push via Step 1 on response.

**Verify**: new controls.test.ts cases with a deferred fake client (promise
you resolve manually): after calling `setModel` and BEFORE resolving the fake,
the store snapshot already has the new label and `onOptimisticChange` fired;
after resolving, response payload wins; after rejecting, `refreshState` was
called (assert `get_state` sent) and the error propagates.

### Step 3: Cache the model list; make cycle-backward one round-trip

In `controls.ts`, cache `getAvailableModels()`'s result on the instance.
Invalidate the cache in `refreshState()` and in `setModel`/`cycleModel`
response handling when the resulting model is not present in the cached list.
The backward-cycle handler (`host.ts:418-431`) keeps its exact logic but now
hits the cache after the first press. Also make the backward handler
optimistic: it already computes `previous` locally — the Step 2 `setModel`
change gives it optimistic behavior for free (confirm in the test).

**Verify**: controls.test.ts — two consecutive `getAvailableModels()` calls
send exactly one `get_available_models` command; after `refreshState()`, a
third call refetches. host.test.ts — two backward-cycle invocations send
exactly one `get_available_models` total.

### Step 4: Finish DF-7 for rename and auto-compaction

- `state.ts`: add `applySessionName(name: string)` patching `sessionName`.
- `controls.ts`: `setSessionName` applies it after success and returns the
  snapshot; drop the `void` return.
- `host-actions.ts` (:956-964): replace the post-mutation
  `await this.controls.refreshState()` for rename with the returned snapshot +
  `this.onStateChange()`; for auto-compaction, drop the `refreshState()`
  entirely (no chrome field displays it) and keep the notification.

**Verify**: host-actions.test.ts — rename action sends `set_session_name` and
NO `get_state`; chrome snapshot carries the new name.

### Step 5: Reset event-derived chrome on authoritative hydration

In `state.ts` `hydrateFromRpcState` (:56-72), explicitly set
`lastEventType: undefined` and `taskPartialCount: 0` (the fresh `get_state`
is authoritative; event residue from the previous session must not leak).
Do NOT touch `hydrateFromSessionStats`.

**Verify**: state.test.ts — after `handleAgentEvent` with a
`tool_execution_update` (taskPartialCount 1, lastEventType set), a
`hydrateFromRpcState` with a fresh idle session yields
`taskPartialCount === 0` and `lastEventType === undefined`; also assert a
mid-stream hydrate keeps `isStreaming` from the RPC payload.

## Test plan

New tests enumerated per step above; files: `state.test.ts`,
`controls.test.ts`, `host.test.ts`, `host-actions.test.ts`. Pattern: existing
fake-client style in `controls.test.ts`. Must include: optimistic-before-
resolve assertion, error-rollback assertion, cache-invalidation-on-refresh,
hydrate-reset, rename-no-double-fetch.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` exits 0
- [ ] A test proves the store carries the target model label BEFORE the RPC response resolves (optimistic)
- [ ] A test proves backward-cycle sends at most one `get_available_models` across repeated presses
- [ ] A test proves handler state reaches the runtime-update callback (not just a repaint)
- [ ] `git status` shows changes only in the 8 in-scope files

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- `rpc-types.d.ts` (in `node_modules/@earendil-works/pi-coding-agent`) shows
  `set_model`/`cycle_model` responses do NOT carry the resulting model — the
  DF-7 comment would be wrong and reconciliation needs redesign.
- The typing change to `onStateChange` cascades outside the in-scope files.
- An existing test asserts the OLD wiring (`onStateChange` called with no
  runtime update) in a way that contradicts this plan's intent — report it,
  don't silently rewrite its meaning.

## Maintenance notes

- Invariant to preserve in review: EVERY chrome mutation flows store-first
  (`stateStore.apply*` / `hydrate*`) then `runtime.update({state})`. Nothing
  may write chrome state past the store, or the next agent event will revert
  it.
- If Pi later adds a backward `cycle_model` direction field, the local
  computation in the backward handler can be deleted.
- Follow-up deferred: `/model` selector open still awaits a full
  `get_available_models` (cache from Step 3 also speeds this after first use).
