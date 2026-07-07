# Plan 053: Small hardening — cap clipboard payload size, cache selector filtering, bound git branch read

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/042-stable-session-selector-values..HEAD -- src/sumo-tui/input/selection.ts src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/inline-selector.ts src/sumo-tui/rpc/git.ts`
> Your base branch is `advisor/042-stable-session-selector-values` (it edits
> host-actions.ts and inline-selector-adjacent code). On excerpt mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/042-stable-session-selector-values.md
- **Category**: tech-debt / robustness
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Three independent low-risk robustness fixes:

1. Clipboard writes (`/copy`, drag-select copy) build one terminal control
   sequence from the whole assistant response / selection with no size bound.
   Base64 keeps it well-formed, but an arbitrarily large payload can overrun
   terminal/clipboard limits and stall some emulators. A conservative cap with
   a clear "too large to copy" notice is safer than an unbounded write.
2. The inline selector recomputes `fuzzyFilter` over the whole item list twice
   per keypress (once in `handleInput`, once in `render`) — on the keypress
   echo path, scaling with the model list.
3. `readGitBranch` runs `git` with no timeout during host boot; a hung git
   invocation (locked mount, broken shim) blocks the TUI from rendering.

## Current state

- `src/sumo-tui/input/selection.ts:147-149`:

```ts
export function createOsc52Sequence(text: string): string {
	return `${OSC52_PREFIX}${Buffer.from(text, "utf8").toString("base64")}${OSC52_SUFFIX}`;
}
```

  and `:245-252` — `copyCurrentSelection` calls `emitClipboard(createOsc52Sequence(text), text)`.
- `src/sumo-tui/rpc/host-actions.ts:934-944` area — `/copy` fetches the last
  assistant text and calls `writeClipboardSequence(createOsc52Sequence(text))`.
- `src/sumo-tui/rpc/inline-selector.ts:143-146` `filteredItems()` and
  `:154-156`, `:189-192` — `handleInput` and `render` each call
  `this.filteredItems()` (→ `fuzzyFilter`). `invalidate()` at :139-141 is a
  no-op placeholder ("No cached state to invalidate currently.").
- `src/sumo-tui/rpc/git.ts:5-23` — `execFileText` wraps `execFile` with
  `{ cwd }` and no `timeout`; `readGitBranch` awaits up to two calls; callers
  swallow errors (host boot awaits it at `host.ts:~822`).
- Conventions: tabs, strict TS; DI-for-tests parameters are idiomatic
  (`readGitBranch(cwd, execFileFn)`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/input/selection.test.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/inline-selector.test.ts src/sumo-tui/rpc/git.test.ts` | all pass (create git.test.ts) |

## Scope

**In scope**:
- `src/sumo-tui/input/selection.ts`, `src/sumo-tui/rpc/host-actions.ts`,
  `src/sumo-tui/rpc/inline-selector.ts`, `src/sumo-tui/rpc/git.ts`
- Their colocated test files (create `git.test.ts`)

**Out of scope**:
- Clipboard TRANSPORT (`writeClipboardSequence`, terminal owner) — only the
  size guard at construction.
- Selector rendering/scroll math and fuzzy algorithm — only memoization.
- Anything in the host boot sequence beyond passing a timeout to git.

## Git workflow

- Branch: `advisor/053-small-hardening-batch` off
  `advisor/042-stable-session-selector-values`
- Conventional commits (`fix(...)`). Do NOT push.

## Steps

### Step 1: Bound the clipboard payload

Add `const MAX_CLIPBOARD_BYTES = 100_000;` near `createOsc52Sequence`. Add a
safe wrapper `tryCreateOsc52Sequence(text): { ok: true; sequence: string } |
{ ok: false; bytes: number }` that measures `Buffer.byteLength(text, "utf8")`
and refuses over the cap. Update `copyCurrentSelection` and `/copy` to use it:
on refusal, do NOT write; notify (host-actions `/copy`) / invoke `onCopied`
with a failure path or a distinct toast — keep the messages terse and
lowercase per `src/voice.ts`. Keep `createOsc52Sequence` for callers that
already validated, or route everything through the wrapper.

**Verify**: selection.test.ts — text over the cap → no `emitClipboard` call,
returns false; under cap → unchanged behavior. host-actions.test.ts — `/copy`
with an oversized fake last-assistant-text notifies "response too large to
copy" (or similar) and sends no clipboard sequence.

### Step 2: Memoize selector filtering per query

In `inline-selector.ts`, cache `{ query, result }` from `filteredItems()`;
recompute only when `this.query` changed since the cache. Make `setQuery`
and the constructor the invalidation points; implement the previously-no-op
`invalidate()` to clear the cache. `handleInput` and `render` then share one
computation per keypress.

**Verify**: inline-selector.test.ts — spy/count `fuzzyFilter` (inject or wrap)
across one printable keypress: exactly one filter computation; navigation
keys (up/down) with an unchanged query trigger zero recomputation.

### Step 3: Time-bound git branch detection

In `git.ts`, pass `{ cwd, timeout: 2_000, killSignal: "SIGKILL" }` to
`execFile`; on timeout `execFile` invokes the callback with an error → the
existing `resolve(undefined)` path already degrades gracefully. Keep the
`execFileFn` injection parameter.

**Verify**: new git.test.ts — with an injected fake `execFile` that never
invokes its callback but records the options, assert `timeout` is set; with a
fake that calls back with an error, `readGitBranch` resolves `undefined`;
with a success fake, returns the branch. (No real git process in tests.)

## Test plan

Per steps. Patterns: existing `selection.test.ts`, `inline-selector.test.ts`,
`host-actions.test.ts`; new `git.test.ts` uses the `execFileFn` injection like
other DI tests in the repo.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] All four targeted test files exit 0 (git.test.ts created)
- [ ] Oversized clipboard input writes nothing and notifies; under-cap
      unchanged
- [ ] Selector filters once per printable keypress (spy-verified)
- [ ] `readGitBranch` passes a timeout and resolves undefined on timeout/error
- [ ] `git status` — only in-scope files changed

## STOP conditions

- `createOsc52Sequence` has callers outside selection/host-actions that would
  bypass the cap (`grep -rn "createOsc52Sequence" src/`) — report them; route
  all through the wrapper or note why one is exempt.
- The selector cache interacts with the current-value marker or scroll state
  in a way existing tests catch — report; correctness beats the micro-opt.
- `execFile`'s `timeout` option behaves differently than the graceful
  `resolve(undefined)` expects (it shouldn't — error callback path).

## Maintenance notes

- The 100KB cap is deliberately conservative; if a real use case needs more,
  raise the constant, don't remove the guard.
- Reviewer: confirm no clipboard write path bypasses the wrapper; confirm the
  selector cache invalidates on every query mutation.
