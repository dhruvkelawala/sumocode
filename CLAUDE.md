# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

SumoCode is a **Pi extension** (not a standalone binary) for `@mariozechner/pi-coding-agent`. It owns the UX layer — splash, top chrome, footer, sidebar, working indicator, slash commands, theme, retained terminal renderer — while Pi keeps the agent loop, LLM, sessions, MCP, skills.

User-specific state (persona, memory, settings, MCP, skills) lives in a separate private repo `sumocode-config` and is symlinked into `~/.pi/agent/`. **Never put user state in this repo.**

## Commands

```bash
pnpm install                       # installs Pi peer deps + applies pi-coding-agent patch
pnpm typecheck                     # tsc --noEmit (strict, noUnusedLocals/Parameters)
pnpm build                         # alias for typecheck — there is NO build step (Pi runs TS via jiti)
pnpm test                          # vitest run, src/**/*.test.ts
pnpm test:integration              # vitest run test/integration/** — spawns real Pi via node-pty
pnpm vitest                        # interactive watch mode
pnpm visual                        # render every docs/visual/*.tape via vhs into docs/visual/out/

pi -e .                            # ephemeral install of THIS checkout — primary dev loop
bin/sumocode.sh                    # wraps `pi -e` and enables the SUMO_TUI retained-renderer patch path
```

Run a single test file: `pnpm vitest run src/footer.test.ts`. Single test name: `pnpm vitest run -t "renders branch"`.

## Dev loop

The canonical workflow lives in `DEV_LOOP.md`. Short version: edit in this checkout → `pi -e .` to test → commit → for releases bump `package.json` version + `VERSION` in `src/extension.ts`, tag, push tags, then `pi update git:github.com/dhruvkelawala/sumocode` on consumer machines. Tagged releases are the only thing that propagates; pushes to `main` do not.

Never edit `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` — that's the installed clone, not the source of truth.

## Architecture

### Extension entry point

`src/extension.ts` exports a default `(pi: ExtensionAPI) => void` that wires every feature module via its `installX(pi)` / `registerXCommand(pi)` function. The order in that file is the load order — keep it intentional. `package.json#pi.extensions` lists what Pi loads (currently just `src/extension.ts`).

`shouldNoopDuplicateInstalledExtension()` runs first: if the installed-from-git copy is loading while the user is `cd`'d into a sumocode dev tree, the installed copy bails so the dev tree wins. Don't break this — it's how `pi -e .` coexists with the always-installed copy.

### Two parallel rendering paths

This codebase contains **two layers** that both render UI, and they are at different maturity levels:

1. **Classic Pi extension API** (`src/*.ts` at the top level: `footer.ts`, `sidebar.ts`, `splash.ts`, `top-chrome.ts`, `working-indicator.ts`, `command-palette.ts`, `memory-editor.ts`, `commands/*`). These call `ctx.ui.setFooter / setHeader / setEditorComponent / custom / notify / registerCommand`. They run inside Pi's existing line-concatenation renderer and are subject to its layout limits.
2. **`src/sumo-tui/`** — a Node-native retained renderer built to escape those limits (ADR `docs/adr/0001-sumo-tui-framework.md`). Owns altscreen lifecycle, signal cleanup, mouse SGR routing, Yoga flex layout, cell buffer compositor, frame diff, in-app scroll, modal layer. Wraps Pi's `CustomEditor` as a `PiEditorLeaf` rather than reimplementing it. Activation is gated behind `SUMO_TUI=1` + a Pi binary patched with `loadSumoInteractiveMode` (see `bin/sumocode.sh` and `sumo-interactive-mode.js`); the bridge lives in `src/sumo-tui/pi-compat/`.

When adding a feature, decide which layer it belongs to. Anything that needs flex layout, in-app scroll, sticky footers, mouse routing, or modal layers belongs in `sumo-tui/`. Simple status text or slash commands stay in the classic layer. The `pi-compat/` directory is the only place the two layers meet.

### Cathedral

`src/cathedral/` and `src/sumo-tui/cathedral/` hold the cathedral-themed adapters (input frame, altscreen takeover, sidebar tree, splash tree, theme bridge, metrics HUD, ANSI helpers). The visual canon is `docs/ui/DESIGN.md` plus the Stitch mockups under `docs/ui/stitch/cathedral/`. Visual parity is tracked in `docs/CATHEDRAL_PARITY_PLAN.md` — the rule there is RED → GREEN → vhs render → compare to mockup, not "tests pass therefore done".

Color and state tokens are centralised in `src/tokens.ts` (`CATHEDRAL_TOKENS`, `SUMOCODE_STATES`). Five preattentive states: `idle / thinking / tool / approval / learning`.

### `src/spike/`

Throwaway exploration tied to specific PRs (overlay variants, alternate renderers, etc.). Do not import from `spike/` outside its own directory; promote a spike to a real module by moving the file out and dropping the `spike/` import path.

## Conventions

- **No build step.** Pi executes TypeScript directly via jiti. Don't add `tsc -b`, bundlers, or emit-to-`dist/`. `pnpm build` is intentionally just typecheck.
- **TS is strict** with `noUnusedLocals` and `noUnusedParameters`. Tabs for indentation (see existing files).
- **Tests colocate**: `foo.ts` next to `foo.test.ts`. Vitest's `include` is `src/**/*.test.ts`; integration tests under `test/integration/` only run when the path appears in argv (see `vitest.config.ts`) or via `pnpm test:integration`.
- **Pi-bundled deps belong in `peerDependencies`**, not `dependencies`. `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox` are peer-only — putting them in `dependencies` creates duplicate module instances and breaks Pi's runtime checks. The `pnpm.patchedDependencies` entry in `package.json` patches `pi-coding-agent@0.70.2` (see `patches/`); leave it alone unless intentionally bumping Pi.
- **`ctx.ui.*` calls must happen inside an event handler** (`session_start`, `message_start`, etc.). Calling them at module top level fires before Pi's TUI exists and is silently dropped.
- **TTY-defensive**: guard interactive UI behind `ctx.ui.isTTY` so `acpx pi`, `pi --print`, `--mode rpc` keep working (Q13 in `PLAN.md`).
- **Voice** is enforced by `src/voice.ts`. State labels are UPPERCASE cathedral verbs (`READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING`); other product copy is lowercase, terse, no exclamation marks, no apologies, no emoji (emoji and dots are preattentive signals, not text decoration).
- **Always quote paths with spaces.** The dev tree on the author's machine is `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode` — shell scripts that don't quote will silently break there.

## Decision trail

`PLAN.md` — Q1–Q14 grilling decisions (architecture, persona, memory backend, theme system, sync strategy, ACPX, theme picker UX). Read this before changing scope.

`docs/adr/` — accepted ADRs. Currently 0001 covers the sumo-tui retained renderer.

`docs/research/sumo-tui-spike/` — implementation plan, edge-case catalog, and the four codebase studies (opencode, opentui, opentui-island, pi-tui) that informed the renderer.

`docs/prd.md` / `docs/prd.html` — formal product spec.

## Visual harness

`pnpm visual` walks `docs/visual/*.tape` and runs each through `vhs` (`brew install charmbracelet/tap/vhs`), writing PNGs to `docs/visual/out/` (gitignored). Use this for visual regression — render before/after a change and diff the PNGs against the corresponding mockup. Tapes that need the retained renderer prefix their commands with `SUMO_TUI=1 bin/sumocode.sh`.

## Integration tests

`test/integration/` spawns a real Pi inside a `node-pty` PTY (see `spawn-pi-pty.ts`). They are skipped during the normal `pnpm test` run and only execute when the `test/integration` path is in argv. Use them for things that can only be verified end-to-end: altscreen cleanup on signal, mouse scroll routing, cursor positioning across the editor leaf boundary, splash centering, slash-command dispatch.
