# sumo-tui Phase 4 progress

Date: 2026-04-27
Branch: `feat/sumo-tui-phase-4`

## Completed in this increment

- Mapped Pi 0.70.2 `interactive-mode.js` responsibilities in `docs/research/interactive-mode-map.md` with file:line citations.
- Added retained extension UI primitives:
  - `src/sumo-tui/pi-compat/region-registry.ts`
  - `src/sumo-tui/pi-compat/extension-ui-adapter.ts`
  - `src/sumo-tui/pi-compat/foreign-extension-warning.ts`
  - `src/sumo-tui/widgets/notification.ts`
  - `src/sumo-tui/widgets/modal.ts`
- Added Phase 4 boundary file with MIT notice and Pi source citations:
  - `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
- Added `/sumo:theme` slash command so the requested `/sumo:*` set is present.
- Added unit coverage for registry, adapter, notification/modal flows, and foreign extension warnings.
- Added headless integration coverage for slash command registration and retained session lifecycle cleanup.

## Verification run

```bash
pnpm test
# 48 files, 315 tests passed

pnpm test:integration
# 8 files, 11 tests passed

pnpm exec tsc --noEmit
# clean
```

## Blockers / not complete

### Pi binary integration is not wired yet

Pi 0.70.2 constructs `InteractiveMode` inside the package binary, not inside SumoCode extension user code:

- import site: `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2.../dist/main.js:31`
- constructor site: `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2.../dist/main.js:548-571`

Because SumoCode is loaded as a Pi extension, `src/extension.ts` cannot replace the already-imported ESM binding. The actual fork patch still needs to replace that constructor call with `new SumoInteractiveMode(...)` in our pinned Pi fork/package. Until that patch is applied, running `pi -e ./src/extension.ts` still enters upstream pi-tui's `InteractiveMode` and only uses sumo-tui for the Phase 1 lifecycle shim.

### Retained renderer adapter is scaffolded, not yet the full runtime owner

`RegionRegistry` and `SumoExtensionUIAdapter` can mount Pi components into retained Yoga slots, and tests prove slot routing/disposal. The full runtime loop still needs the Pi fork to:

1. instantiate the sumo-tui runtime instead of `new TUI(new ProcessTerminal(), ...)`,
2. calculate Yoga layout per frame,
3. composite to `CellBuffer`,
4. diff/write ANSI frames,
5. route key/mouse input to editor/chat/modal focus.

### Foreign extension no-op is best-effort until per-extension binding exists

Pi's `ExtensionRunner` exposes one shared `uiContext` to all extension handlers (`dist/core/extensions/runner.js:372-411`). The implemented guard supports injected caller identity and no-ops foreign UI hooks defensively, but the Pi fork still needs to pass per-extension identity (or an equivalent stack/caller resolver) during handler invocation for production-grade foreign extension isolation.

### Required reading files were absent from this worktree

The prompt listed these files, but they were not present in either the worktree or read-only main reference:

- `docs/adr/0001-sumo-tui-framework.md`
- `docs/research/sumo-tui-spike/IMPLEMENTATION_PLAN.md`
- `docs/research/sumo-tui-spike/EDGE_CASES.md`
- `docs/research/sumo-tui-spike/04-pi-tui.md`

I proceeded using the shipped Phase 1–3 source/tests, Pi docs, and Pi 0.70.2 installed sources.

## Phase 4b update

Phase 4b added the fork activation path documented here: `SUMO_TUI=1` now causes the patched Pi `dist/main.js` constructor site to load `SumoInteractiveMode` via `SUMO_TUI_MODULE` or `@dhruvkelawala/sumocode/sumo-interactive-mode`. The SumoCode worktree uses a pnpm patch against the published Pi `0.70.2` package because pnpm GitHub subdirectory installs omit Pi's untracked `dist/` output.

## Acceptance criteria still open

- Visual verification via VHS/screenshot of SumoCode running on the retained renderer.
- Real pty slash autocomplete assertion against the forked interactive mode.
- Ctrl+P conflict suppression in Pi diagnostics after forked keybinding ownership.
- Pi 0.70.0 / 0.70.1 / latest 0.70.x smoke matrix.
- Actual Pi fork patch/package integration.
- PR should not claim `Closes #38` until the fork patch is wired and visually verified.
