# Phase 4b postmortem — Pi fork activation

Date: 2026-04-27
Branch: `feat/sumo-tui-phase-4b`
Issue: `#44` (also closes parent `#38`)

## What landed

- Created Dhruv's `pi-mono` fork branch `sumocode/0.70.2-fork` from upstream tag `v0.70.2`.
- Patched `packages/coding-agent/src/main.ts` with a 16-line non-breaking switch:
  - default path remains `new InteractiveMode(...)`;
  - `SUMO_TUI=1` or `--sumo-tui` loads `SumoInteractiveMode`;
  - `SUMO_TUI_MODULE` can point at a local file URL for worktree development.
- Added `sumo-interactive-mode.js` as SumoCode's runtime-loadable public bridge.
- Added `bin/sumocode.sh`, which sets `SUMO_TUI=1`, points `SUMO_TUI_MODULE` at the worktree bridge, and runs the local patched Pi binary.
- Added a pnpm patch for `@mariozechner/pi-coding-agent@0.70.2` so the installed `dist/main.js` contains the same fork behaviour.
- Updated `SumoInteractiveMode` so the forked entry point starts real sumo-tui primitives before delegating to Pi's existing session loop:
  - `TerminalController`
  - Yoga root `SumoNode`
  - `ChatPager`
  - `FrameScheduler`
  - `CellBuffer` + compositor + diff writer path

## What went smoothly

- The upstream constructor seam was exactly where Phase 4a documented it: `dist/main.js` around the interactive-mode construction block.
- The source patch is tiny and non-breaking when `SUMO_TUI` is unset.
- `SUMO_TUI_MODULE` made worktree development viable without requiring SumoCode to be installed as an npm package.
- SumoCode's existing unit and integration test suite stayed green.

## What was painful

- pnpm GitHub subdirectory installs did not produce a usable `@mariozechner/pi-coding-agent` package from the monorepo fork because the package `files` list includes `dist/`, but `dist/` is not committed upstream.
- Adding `prepare` to the fork was explored and rejected:
  - pnpm requires explicit build-script allowlisting for git-hosted dependencies;
  - running prepare from a workspace package caused root/package lifecycle confusion;
  - attempting a root build from prepare risked recursion and excessive install cost.
- The practical solution is a local pnpm patch against the published `0.70.2` package, with the source-of-truth fork commit retained for audit and future rebases.
- Upstream `v0.70.2` tests are not fully green in this environment before or after the patch. Failures are in model/default-provider expectations and auth-copy expectations unrelated to the SumoCode switch.

## Current limitations

- `SumoInteractiveMode` is now the live class loaded by the patched Pi binary, and it starts the retained runtime, but the full private `InteractiveMode` event loop is still delegated to upstream Pi.
- Region-registry-backed extension UI remains available and tested, but it is not yet wired into Pi's private `bindCurrentSessionExtensions()` path in production because that requires a deeper fork of `createExtensionUIContext()` and per-extension caller identity.
- Visual output is therefore still mostly Pi's existing TUI plus SumoCode's existing extension chrome, with the retained runtime active as the Phase 4b entry point.

## Verification notes

- `npm run check` in the fork passed.
- `cd packages/coding-agent && npm run build` in the fork passed.
- `pnpm test` in SumoCode passed: 315 tests.
- `pnpm test:integration` in SumoCode passed: 11 tests.
- `pnpm exec tsc --noEmit` passed.
- `SUMO_TUI_DEBUG=1 PI_STARTUP_BENCHMARK=1 ./bin/sumocode.sh ...` in a pty printed:
  - `[sumo-tui] SumoInteractiveMode retained runtime started`
  - `[sumo-tui] SumoInteractiveMode retained runtime stopped`

## Recommendations for Phase 6 no-fork attempt

1. Ask upstream for a public interactive-mode factory hook or renderer injection hook instead of carrying a deeper private fork.
2. If no public hook exists, keep the source fork patch tiny and move deeper experimentation into SumoCode only.
3. Treat pnpm's monorepo-subdirectory packaging behaviour as a distribution constraint: either use a published package or keep using a pnpm patch against the published package.
4. Do not port the full Pi event loop in one step. Port one private seam at a time:
   - extension UI context factory,
   - chat container event rendering,
   - editor focus/input,
   - session lifecycle.
5. Keep `SUMO_TUI_MODULE` permanently; it is useful for local worktrees, bisects, and smoke tests.
