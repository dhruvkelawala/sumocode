# SumoTUI Pi Patch Strategy

**Status:** accepted maintenance decision for P0-D / #103  
**Date:** 2026-04-29  
**Parent:** #98 SumoTUI consolidation  
**Related:** `docs/SUMO_TUI_CONSOLIDATION_PLAN.md`, `docs/research/pi-fork-upgrade.md`

## Decision

Keep the private Pi constructor patch for now, but treat it as an explicit maintenance contract instead of an incidental hack.

Current public Pi extension APIs are not sufficient to replace the patch while preserving SumoTUI's retained chat/runtime behavior. The patch remains acceptable because it is tiny, default-off for normal Pi, runtime-gated by `SUMO_TUI`, and checked by the wrapper before use.

Revisit removal when Pi exposes a public interactive-mode/runtime injection API, or when SumoCode no longer needs to replace/bridge Pi's chat viewport.

## Audited seam

### `patches/@earendil-works__pi-coding-agent@0.79.1.patch`

The patch changes Pi's `dist/main.js` constructor site from direct `new InteractiveMode(...)` to:

- build `interactiveOptions`
- compute `useSumoTui` from `SUMO_TUI` or `--sumo-tui`
- dynamically import `SUMO_TUI_MODULE` or `@dhruvkelawala/sumocode/sumo-interactive-mode`
- instantiate `new SumoInteractiveMode(runtime, interactiveOptions)` when enabled
- leave the upstream `new InteractiveMode(...)` path untouched when disabled

This is the only place SumoCode currently gains control before Pi's interactive loop is constructed.

### `bin/sumocode.sh`

The wrapper is the user-facing activation contract. When the package is linked or installed, it is exposed as the `sumocode` binary.

Core responsibilities:

- defaults `SUMO_TUI=1`
- accepts `sumocode [options] [path]`, forwarding the optional project path to Pi unchanged
- resolves the repo-local Pi binary first
- inspects Pi's `dist/main.js` for `loadSumoInteractiveMode`
- sets `SUMO_TUI_MODULE=file://.../sumo-interactive-mode.js` for checkout-local runtime loading
- falls back to `SUMO_TUI=0` with a warning if the selected Pi binary is not patched
- executes Pi with `-e src/extension.ts`

CLI/operator features:

- `sumocode -h` / `sumocode --help` — full launcher reference
- `sumocode -v` / `sumocode --version` — package version + git commit when available
- `sumocode doctor` — validates Node, Pi binary, Pi main file, retained-TUI patch, Sumo module, diagnostics path, and TTY status
- `sumocode diag [file]` — summarizes diagnostics JSONL via `scripts/diag-summary.mjs`
- `sumocode -d` / `sumocode --debug` — enables manual-test diagnostics
- `sumocode --diag-file <path>` — custom diagnostics path and implies debug mode
- `sumocode --no-clear-diag` — append to the diagnostics file instead of starting fresh
- `sumocode --dry-run` — print the resolved launch config without starting Pi
- `sumocode --no-sumo-tui` — per-launch fallback equivalent to `SUMO_TUI=0`

Debug mode writes JSONL diagnostics to `/tmp/sumocode-manual.jsonl` by default and clears that file at startup unless `--no-clear-diag` is set. Diagnostics are intentionally no-op unless `SUMO_TUI_DIAG_FILE` is set.

This wrapper prevents accidental use of stale installed SumoCode code during local development and avoids hard failure when the patch is missing.

### `sumo-interactive-mode.js`

The shim uses `jiti` to load the TypeScript source implementation:

- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
- exports `SumoInteractiveMode`
- exports `sumoInteractiveMode`

This keeps the patch independent from TypeScript compilation and lets worktree runs use current source.

### `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`

`SumoInteractiveMode` wraps upstream `InteractiveMode` and starts Sumo's retained runtime before upstream initialization. It also installs private bridges before/after upstream init:

- retained terminal/runtime startup
- Pi noise filtering
- hardware cursor visibility forcing
- chat viewport bridge installation
- extension UI adapter seam

`installChatViewportBridge()` currently depends on private upstream instance fields/methods such as `chatContainer`, `handleEvent`, `renderSessionContext`, and `ui.addInputListener()`. That is outside Pi's public extension contract.

## Public API replacement assessment

Pi's public extension APIs are good for extension surfaces, but not for replacing the interactive runtime constructor.

Available public APIs include:

- lifecycle/session events
- commands and shortcuts
- custom tools
- `ctx.ui.setHeader()`
- `ctx.ui.setFooter()`
- `ctx.ui.setWidget()`
- `ctx.ui.setEditorComponent()`
- `ctx.ui.custom()` overlays/modals
- theme and editor helpers
- custom renderers for extension-owned content

These APIs can host much of SumoCode's chrome, editor frame, sidebar widget, command palette, and modals. They do **not** currently provide a public way to:

- replace the `InteractiveMode` implementation selected by Pi's CLI
- start Sumo's retained runtime before Pi interactive initialization
- own the chat viewport render loop
- intercept/replace `chatContainer.render()` through a supported API
- route mouse wheel input into a retained chat pager with correct coordinates
- observe/bridge upstream `handleEvent()` and `renderSessionContext()` without private field access

Therefore, removing the patch today would regress retained ChatPager/mouse-scroll/runtime ownership or force SumoCode back to public-extension chrome only.

## Strategy options considered

| Option | Decision | Reason |
| --- | --- | --- |
| Remove patch now | Reject | Public APIs cannot replace the constructor/runtime/chat seam yet. |
| Replace with public extension APIs only | Reject for V1 daily-driver | Would lose retained chat viewport control and the consolidation work already landed. |
| Keep private patch as-is, undocumented | Reject | Pi version bumps would remain ambiguous and fragile. |
| Keep patch with maintenance contract | Accept | Minimal diff, explicit smoke matrix, clear fallback behavior, and revisit trigger. |
| Upstream a public hook | Track later | Best long-term option, but outside this repo's immediate consolidation scope. |

## Maintenance contract

The private patch is allowed only under these rules:

1. **Patch stays tiny.** Keep the Pi diff limited to the interactive constructor switch and dynamic loader. Target under ~30 changed lines.
2. **Default path stays upstream.** When `SUMO_TUI` is unset/false and `--sumo-tui` is absent, Pi must instantiate upstream `InteractiveMode` normally.
3. **Wrapper validates activation.** `bin/sumocode.sh` must keep checking for `loadSumoInteractiveMode` before exporting `SUMO_TUI_MODULE`.
4. **Patch file tracks exact Pi package version.** A Pi bump must create a new `patches/@earendil-works__pi-coding-agent@<version>.patch` and update `package.json` `pnpm.patchedDependencies` in the same PR. If Pi raises its Node engine floor, SumoCode's `engines.node` must move with it.
5. **No silent major drift.** If the constructor site moves or the patch stops applying cleanly, stop and update the strategy before shipping.
6. **No upstream default behavior change.** The patch must remain opt-in and non-breaking for normal Pi users.
7. **Smoke matrix is mandatory for Pi bumps.** Every Pi version change must run the matrix below and record results in the PR body.
8. **Prefer a public hook when available.** If Pi adds a supported runtime/mode injection or chat viewport API, create a removal plan instead of carrying the patch forward by default.

## Pi bump smoke matrix

For every Pi bump PR:

### Patch presence

```bash
pnpm install
rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@earendil-works/pi-coding-agent/dist/main.js
```

Expected: both markers exist for the patched target version.

### Default Pi path still works

```bash
SUMO_TUI=0 ./bin/sumocode.sh --offline --no-session --no-extensions
```

Expected: no Sumo retained runtime activation; Pi remains usable or exits according to normal offline behavior.

### Sumo wrapper activation

```bash
./bin/sumocode.sh --offline --no-extensions --no-session
```

Expected:

- no `ERR_MODULE_NOT_FOUND`
- no `Skipping installed SumoCode extension...` warning in normal wrapper path
- `DIVINE INVOCATION` appears
- clean Ctrl+C restores altscreen and cursor

### Integration and unit suite

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
```

Expected: all pass.

### V2 visual smoke

```bash
pnpm visual:ci
```

Expected: no hard failures and no required crop drift.

### Cross-version install smoke

```bash
./scripts/smoke-pi-versions.sh <new-version>
```

Expected:

- install succeeds
- patched target version contains loader markers
- `pi --version` runs

If older supported versions are tested without the patch, the script should continue documenting that fork activation is intentionally pinned to the patched version.

## Removal trigger and follow-up plan

Create a patch-removal issue when either condition becomes true:

1. Pi exposes a public API to select/replace interactive mode at CLI startup.
2. Pi exposes enough public chat viewport/render-loop APIs that SumoCode can run retained chat without private `InteractiveMode` field access.

Removal plan:

1. Add a compatibility layer that uses the public API and preserves the current `SUMO_TUI_MODULE` worktree override for local development if still useful.
2. Port `SumoInteractiveMode` constructor activation to the public API.
3. Replace private `installChatViewportBridge()` field hooks with public chat/runtime hooks.
4. Run the full smoke matrix with the patch removed.
5. Delete `patches/@earendil-works__pi-coding-agent@*.patch` and remove `pnpm.patchedDependencies` from `package.json`.
6. Update `bin/sumocode.sh` so missing patch is no longer a fallback condition.
7. Update this document and close the patch maintenance issue.

## Operational fallback

If a Pi bump breaks the patch and there is no immediate fix, ship a fallback with `SUMO_TUI=0` through `bin/sumocode.sh`. This preserves public-extension SumoCode chrome where possible and avoids bricking the CLI, but it is not visually equivalent to retained SumoTUI.

This fallback is acceptable only for emergency restore-to-service releases. It does not satisfy V2 retained runtime parity.
