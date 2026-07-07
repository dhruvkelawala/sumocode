# Plan 029: Filter Kitty key-release events in the shared input router

> **Executor instructions:** Work in a worktree based on
> `codex/plan024-real-runtime-ui-parity-rerun-20260703-092057` (`7d213e9`).
> Follow the steps; run every verification; on a STOP condition, stop and
> report. Do not update `plans/README.md` — the reviewer maintains the index.

## Status

- **Priority:** P0 (user-blocking: every keypress registers multiple times in
  Kitty-protocol terminals — Ghostty/cmux, the primary dev terminals)
- **Effort:** S
- **Risk:** LOW
- **Depends on:** 023 (the shared router this fixes)
- **Category:** correctness
- **Planned at:** `7d213e9`, 2026-07-03

## Why this matters

In Ghostty/cmux, typing in the RPC host inserts each character two (or more)
times. Root cause, verified:

1. SumoCode's terminal controller pushes Kitty keyboard flags 1+2+4 —
   `src/sumo-tui/runtime/terminal-controller.ts:25`:
   `"\x1b[>7u" + // kitty keyboard push (flags 1+2+4, matches pi-tui terminal.js)`.
   Flag 2 = **report event types**: the terminal sends key RELEASE (and
   repeat) events as CSI-u sequences (`\x1b[<codepoint>;<mods>:3u`).
2. On `main`, stdin flows through pi-tui's TUI input loop, which drops
   releases — `node_modules/@earendil-works/pi-tui/dist/tui.js:565`:
   `// Filter out key release events unless component opts in`.
3. The RPC host bypasses pi-tui's loop (stub TUI) and routes stdin through
   `src/sumo-tui/input/shared-input-router.ts` (Plan 023), which has **no
   release filtering** — so a press inserts the character and its release
   sequence decodes to the same key and inserts it again.

The PTY integration tests never caught this because they inject plain bytes;
only a real Kitty-protocol terminal emits `:3u` release sequences.

## Current state

- `src/sumo-tui/input/shared-input-router.ts` (282 lines at `7d213e9`) — the
  single stdin choke point from Plan 023. It already splits coalesced chunks
  into discrete events (the split-ESC / trailing-Escape handling from 023's
  review rounds). Zero occurrences of `isKeyRelease` / `:3` / `release`.
- pi-tui exports the exact tools needed, from its package index:
  `isKeyRelease`, `isKeyRepeat`, `decodeKittyPrintable`, `parseKey`,
  `isKittyProtocolActive`, `setKittyProtocolActive`
  (`node_modules/@earendil-works/pi-tui/dist/index.js:22`).
- `isKeyRelease(data)` (pi-tui `keys.js:363-380`) checks for `:3u`/`:3~`/
  `:3A`…`:3F` patterns and explicitly guards against bracketed-paste content
  (a pasted MAC address like `90:62:3F:A5` must not be treated as a release).

Conventions: tabs, strict TS, colocated tests. Repo path contains a space —
quote it.

## Scope

**In scope:**

- `src/sumo-tui/input/shared-input-router.ts`
- `src/sumo-tui/input/shared-input-router.test.ts` (or the router's existing
  colocated test file)
- ONE new integration test: `test/integration/rpc-kitty-release.test.ts`

**Out of scope:**

- `terminal-controller.ts` (the flag push is correct — matches pi-tui/main)
- The editor, key-router bindings, interrupt tiers, mouse parsing
- Everything Plan 028 owns (shell/chrome/visual drift)

## Steps

### Step 1: Filter releases per split event

At the point where the router has split the incoming chunk into discrete
events (after mouse extraction and ESC handling, before dispatch to any
target), drop events for which `isKeyRelease(event)` is true. Import it from
`@earendil-works/pi-tui`. Requirements:

- Apply **per split event**, never to the raw coalesced chunk — a chunk can
  contain `"h\x1b[104;1:3u"` (press + release together); the press must still
  be delivered.
- Key **repeat** events (`:2`) must still be delivered — holding a key must
  keep typing (that is pi-tui/main behavior; only releases are filtered).
- Bracketed-paste blocks pass through untouched (pi-tui's `isKeyRelease`
  already guards this, but the router must not split paste blocks in a way
  that defeats the guard — assert it in a test).
- The filter runs before ALL targets: modal layer, overlay, interception
  point, editor — a Ctrl-C release must not reach the interrupt tiers.

**Verify:** `pnpm vitest run src/sumo-tui/input/shared-input-router.test.ts` → pass.

### Step 2: Unit tests (in the router's test file)

1. `"h"` then `"\x1b[104;1:3u"` as separate chunks → editor target receives
   exactly one `h`.
2. Coalesced `"h\x1b[104;1:3u"` in one chunk → exactly one `h`.
3. Repeat event (`"\x1b[104;1:2u"` or equivalent) → IS delivered.
4. Arrow-key release variants (`:3A`, `:3D` forms) → dropped.
5. Bracketed paste containing `":3F"` inside `\x1b[200~ … \x1b[201~` → full
   paste content delivered unmodified.
6. Ctrl-C press+release pair → interception point sees exactly one event.

### Step 3: PTY regression test

New `test/integration/rpc-kitty-release.test.ts` (model after
`test/integration/rpc-host-shell.test.ts`, spawn via `spawnSumocodePty`):
type a word as Kitty press+release pairs (inject the release sequences
explicitly, e.g. send `"h"` then `"\x1b[104;1:3u"`, etc.), wait for render,
assert the editor row contains the word exactly once (no doubled letters).

**Verify:** `pnpm vitest run test/integration/rpc-kitty-release.test.ts` → pass.

### Step 4: Full battery

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm vitest run src/sumo-tui/input/ src/sumo-tui/rpc/host-actions.test.ts
pnpm test:integration
```

All pass (known unrelated `task-manager.test.ts` `output.log` ENOENT caveat
on full `pnpm test` — record, don't chase).

## Done criteria

- [ ] `grep -n "isKeyRelease" src/sumo-tui/input/shared-input-router.ts` → ≥1 match
- [ ] All Step 2 unit cases exist and pass
- [ ] `test/integration/rpc-kitty-release.test.ts` exists and passes
- [ ] `pnpm test:integration` exit 0 (including 023/025's existing input and
  interrupt tests — unchanged)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `git diff 7d213e9 --stat` touches only in-scope files

## STOP conditions

- The router's event-splitting cannot distinguish paste blocks from key
  sequences (fixing that is a bigger change — report, don't improvise).
- Filtering releases breaks an existing 023/025 test — report which and why
  instead of weakening the filter or the test.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a future component needs release events (pi-tui supports opt-in), add an
  opt-in flag on the target interface — do not remove the default filter.
- Pi version bumps: re-check pi-tui still exports `isKeyRelease` and that the
  flag push in `terminal-controller.ts` still matches pi-tui's.
