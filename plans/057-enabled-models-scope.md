# Plan 057: Scope model cycling + the /model selector to enabledModels (match main)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/058-remove-action-confirmation-toasts..HEAD -- src/sumo-tui/rpc/controls.ts src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-actions.ts`
> Your base branch is `advisor/058-remove-action-confirmation-toasts` (it
> already removed the model/thinking confirmation toasts from the same
> handlers you edit here). On excerpt mismatch, STOP.

## Status

- **Priority**: P1 (user-reported)
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/058-remove-action-confirmation-toasts.md (same handlers)
- **Category**: bug (parity with main)
- **Planned at**: commit `4f289fb`, 2026-07-07

## Why this matters

On `main`, model cycling and the `/model` list respected the user's
`enabledModels` setting (a curated subset, e.g. ~12 models). Under the RPC
host, **Ctrl+Shift+P (cycle backward) and the `/model` selector cycle/list all
531 available models** instead of the enabled subset. Diagnosed live
(2026-07-07):

- Pi seeds a session "scoped models" ring from `settingsManager.getEnabledModels()`
  at startup for ALL modes incl. RPC (Pi `dist/main.js:522-523,543`:
  `modelPatterns = parsed.models ?? settingsManager.getEnabledModels()` →
  `resolveModelScope(...)` → session `scopedModels`).
- So Pi's own `cycle_model` RPC command (used by cycle-FORWARD) already
  respects `enabledModels` — verified live: forward cycling stayed within the
  user's enabled set.
- BUT SumoCode's cycle-BACKWARD (`host.ts`) and `/model` selector
  (`host-actions.ts`) bypass `cycle_model` and instead call
  `get_available_models` (Pi `dist/modes/rpc/rpc-mode.js`:
  `session.modelRegistry.getAvailable()` — the FULL 531, unscoped). There is
  no RPC command that returns the scoped/enabled set (confirmed: only
  `set_model`, `cycle_model`, `get_available_models`; scoped state is private,
  per the 2026-07-03 DF-5 note). So the host must resolve `enabledModels`
  itself, the same way `main.js` does.

Fix: resolve the enabled-model list host-side (read `enabledModels` off disk,
filter the available list by those patterns, preserving pattern order) and
drive cycle-forward, cycle-backward, and the `/model` selector from that one
list. Empty/unset `enabledModels` → fall back to the full available list
(exactly Pi's behavior when `scopedModels` is empty).

## Current state

- `src/sumo-tui/rpc/controls.ts`:
  - `getAvailableModels()` (~:77-83) sends `get_available_models` and returns
    `modelOptionsFrom(data.models, currentLabel)` — the full list; it now
    caches `availableModelsCache` (added by plan 041).
  - `RpcModelOption` = `{ provider, id, label, active }` (~:15-20).
  - `modelOptionsFrom(models, currentModel)` (~:49-60) marks `active`.
- `src/sumo-tui/rpc/host.ts`:
  - cycle-forward handler (`createModelCycleForwardHandler`, ~:388-395) calls
    `controls.cycleModel()` (the `cycle_model` RPC — already enabled-scoped).
  - cycle-backward handler (`createModelCycleBackwardHandler`, ~:418-431)
    calls `controls.getAvailableModels()` (FULL list), finds the active index,
    steps back, and `controls.setModel(...)`. THIS is the primary bug.
  - `RpcHostModelCycleDependencies` (~:373-377).
- `src/sumo-tui/rpc/host-actions.ts` `openModelSelector` (~:547-564) lists
  `controls.getAvailableModels()` (FULL list) in the inline selector.
- The config-dir resolver pattern already exists:
  `src/sumo-tui/rpc/shell-adapter.ts` `resolvePiAgentDir(env) =
  env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`. Settings live
  at `<agentDir>/settings.json`; the field is `enabledModels?: string[]`.
  `src/sumo-tui/rpc/session-reader.ts` is the precedent for reading Pi's
  on-disk files directly (Node `fs` only, no `@earendil-works/pi-coding-agent`
  import).
- Pi's resolver semantics to replicate (`dist/core/model-resolver.js`
  `resolveModelScope`, lines ~209-255): for each pattern in order — if it
  contains `*`/`?`/`[`, treat as a glob matched (case-insensitive) against
  BOTH `${provider}/${id}` AND `${id}`, appending all matches; otherwise treat
  as an exact `provider/id` (or bare id) selection; dedupe by identity;
  preserve first-seen order. An optional `:level` thinking suffix may trail a
  pattern (e.g. `anthropic/*:high`) — strip it for matching (the host does not
  need to apply the level; `cycle_model`/`set_model` handle thinking).
  `minimatch` is NOT available in this package — implement a small glob→RegExp
  helper covering `*` (→ `.*`), `?` (→ `.`), and `[...]` character classes,
  anchored, case-insensitive. This is the only novel logic.

Conventions: tabs, strict TS, colocated tests, DI-for-tests params are
idiomatic (`readGitBranch(cwd, execFileFn)`), voice lowercase/terse.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |

## Scope

**In scope**:
- A new module `src/sumo-tui/rpc/enabled-models.ts` (+ test) — reads
  `enabledModels` from settings.json and filters an available list.
- `src/sumo-tui/rpc/controls.ts` (+ test) — expose an enabled-scoped model
  list accessor built on the new module + `getAvailableModels`.
- `src/sumo-tui/rpc/host.ts` (+ test) — cycle-forward/backward drive the
  scoped list.
- `src/sumo-tui/rpc/host-actions.ts` (+ test) — `/model` selector lists the
  scoped list.

**Out of scope**:
- Pi's RPC protocol (no new commands; no fork).
- Thinking-level application from pattern suffixes (Pi handles it on
  set_model/cycle_model).
- `/scoped-models` command (blocked upstream — untouched).
- The `--models` CLI override edge case (settings `enabledModels` is the
  target; note `--models` as deferred if you see it in argv handling).

## Git workflow

- Branch: `advisor/057-enabled-models-scope` off
  `advisor/058-remove-action-confirmation-toasts`
- Conventional commits (`fix(rpc): ...`). Do NOT push.

## Steps

### Step 1: `enabled-models.ts` — read patterns + faithful filter

Create `src/sumo-tui/rpc/enabled-models.ts` with:
- `readEnabledModelPatterns(env = process.env): string[]` — read
  `<agentDir>/settings.json` (agentDir via the same
  `PI_CODING_AGENT_DIR ?? ~/.pi/agent` resolution used in shell-adapter.ts;
  factor a shared helper or duplicate the two-line resolver), parse JSON,
  return `enabledModels` if it's a non-empty string array, else `[]`. Never
  throw (missing/malformed file → `[]`).
- `filterToEnabled(models, patterns)` — replicate `resolveModelScope`
  ordering/matching over `RpcModelOption[]` (glob subset + exact, dedupe,
  pattern order, `:level` suffix stripped). `patterns` empty → return `models`
  unchanged (fallback).
- Keep it dependency-free (Node/TS only; no `@earendil-works/*` import).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/enabled-models.test.ts` — cases:
exact `provider/id` entries select exactly those in pattern order; a glob
(`anthropic/*`) expands to all anthropic models in available order; `:high`
suffix is stripped for matching; unknown pattern is skipped; empty patterns →
full list; malformed/missing settings.json → `[]` patterns → full list.

### Step 2: controls — an enabled-scoped list accessor

In `controls.ts`, add `getEnabledModels(env?): Promise<RpcModelOption[]>` that
calls the existing `getAvailableModels()` then `filterToEnabled(list,
readEnabledModelPatterns(env))`, preserving the `active` flag. Reuse the
plan-041 `availableModelsCache` (patterns can be read each call — cheap — or
cached alongside; if cached, invalidate with the same triggers as the model
cache). Keep `getAvailableModels()` as-is for any caller that truly needs the
full list.

**Verify**: controls.test.ts — with a fake client returning a known
`get_available_models` set and a fake settings reader (inject the env or a
patterns function), `getEnabledModels()` returns only the enabled subset in
order; empty patterns → full list.

### Step 3: cycle-backward + forward drive the scoped list

In `host.ts`:
- cycle-backward handler: replace `getAvailableModels()` with
  `getEnabledModels()`; keep the find-active-index / step-back / `setModel`
  logic (it already applies via the plan-041 optimistic path). Single-entry
  list → no-op; zero → the existing "no models available" warning.
- cycle-forward handler: for consistency with backward (so both traverse the
  SAME ordered set the user sees), switch it to step FORWARD within
  `getEnabledModels()` and `setModel(...)`, INSTEAD of `cycleModel()`. This
  removes the risk of forward (child scope) and backward (host scope) diverging
  if the glob port differs from Pi's minimatch. If `getEnabledModels()` is the
  full-list fallback (empty enabledModels), forward-via-setModel still behaves
  identically to cycle_model over the full ring.
  - STOP-check: confirm the enabled list order is stable across calls (it is —
    derived from the cached available list + deterministic filter); if not,
    keep forward on `cycleModel()` and only fix backward + selector, and note
    the divergence risk in your report.

**Verify**: host.test.ts — forward and backward over a fake 3-model enabled
set (from a 6-model available set) stay within the 3 and move in opposite
directions with wraparound; a repeated backward press sends at most one
`get_available_models` (cache) and one `set_model` per press.

### Step 4: /model selector lists the enabled set

In `host-actions.ts` `openModelSelector`, list `controls.getEnabledModels()`
instead of `getAvailableModels()`. Keep search-as-you-type (plan 039) and the
current-value marker. Zero enabled → existing "no models available" warning.

**Verify**: host-actions.test.ts — the selector is populated from the enabled
subset; full-list fallback when enabledModels empty.

## Test plan

Per steps. New file `enabled-models.test.ts` (matching/ordering/fallback);
updates to controls/host/host-actions tests. Include a test mirroring the
user's real shape: exact `provider/id` enabledModels entries →
cycle/selector traverse exactly those in order. Pattern: existing fake-client
tests in controls.test.ts + tmpdir/settings fixtures like session-reader.test.ts.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/enabled-models.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.test.ts` exits 0
- [ ] cycle-backward + forward + /model selector all traverse the enabledModels subset (test-proven), matching forward `cycle_model`'s live-verified set
- [ ] Empty/missing enabledModels → full-list fallback (test-proven)
- [ ] `enabled-models.ts` has no `@earendil-works/*` import
- [ ] `git status` — only in-scope files changed

## STOP conditions

- The glob subset can't reproduce a pattern shape present in the user's real
  settings.json (inspect it read-only; if it uses a construct beyond `*?[`,
  report before implementing).
- Switching forward to the host list changes observable order vs the live
  `cycle_model` set (then keep forward on `cycleModel()`, fix backward+selector
  only, report).
- Resolving enabledModels requires importing Pi internals (it must not — read
  settings.json directly).

## Maintenance notes

- The host now mirrors Pi's `getEnabledModels() → resolveModelScope` locally.
  If Pi ever exposes the scoped set over RPC, replace `enabled-models.ts` with
  that command and delete the glob port.
- Reviewer: confirm the filter order matches `resolveModelScope` (pattern
  order, glob expansion in available order, dedupe) and the empty-patterns
  fallback; confirm no divergence between forward and backward traversal sets.
- Deferred: `--models` CLI override (settings `enabledModels` is the shipped
  path); thinking-level pattern suffixes (Pi applies those).
