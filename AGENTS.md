# AGENTS.md

This file is the canonical instruction file for AI coding agents working in this repository. `CLAUDE.md` intentionally points here so all agents share the same guidance.

## What this repo is

SumoCode is a **Pi extension** for `@earendil-works/pi-coding-agent`. It owns the UX layer — splash, top chrome, footer, sidebar, working indicator, slash commands, theme, retained terminal renderer — while Pi keeps the agent loop, LLM, sessions, MCP, skills, and provider/runtime machinery.

User-specific state (persona, memory, settings, MCP, skills) lives in the separate private repo `sumocode-config` and is symlinked into `~/.pi/agent/`. **Never put user state in this repo.**

## Non-negotiables

- Do not delete branches, force-push, merge PRs, remove files, or run destructive cleanup unless Dhruv explicitly approves it.
- Always quote paths with spaces. The primary dev tree is `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode`.
- Preserve the public/private split: this repo is public MIT; secrets and personal config belong in `sumocode-config`.
- Visual UI work is not done until the relevant capture/review evidence is produced and Dhruv approves any golden promotion.
- Use the project's existing patterns before introducing new abstractions.

## Commands

```bash
pnpm install                       # installs Pi peer deps + applies pi-coding-agent patch
pnpm typecheck                     # tsc --noEmit
pnpm build                         # alias for typecheck — Pi runs TS via jiti; no emitted dist
pnpm test                          # vitest run, src/**/*.test.ts
pnpm test:integration              # vitest run test/integration/** — spawns real Pi via node-pty
pnpm vitest                        # targeted/watch Vitest runner
pnpm render:bible                  # regenerate Visual Bible HTML/PNG targets
pnpm visual:review                 # build V2 Bible/runtime review pack
pnpm visual:ci                     # V2 visual CI gate; required crops gate against runtime goldens
pnpm visual:promote                # promote runtime crop status/golden; requires explicit human approval
pnpm test:visual:real-runtime      # legacy real-runtime smoke harness

pi -e .                            # ephemeral install of THIS checkout — classic Pi extension dev loop
bin/sumocode.sh                    # local SumoCode CLI wrapper (retained SumoTUI by default)
bin/sumocode.sh -h                 # full CLI help
bin/sumocode.sh -d .               # debug/diagnostics mode for manual testing
bin/sumocode.sh doctor             # check Pi patch/module/diagnostics health
bin/sumocode.sh diag               # summarize /tmp/sumocode-manual.jsonl
```

Run a single test file:

```bash
pnpm vitest run src/footer.test.ts
```

Run a single test name:

```bash
pnpm vitest run -t "renders branch"
```

Before declaring done on code changes, run the relevant suite and always include:

```bash
pnpm exec tsc --noEmit && pnpm build
```

For SumoTUI/runtime/visual changes, also run:

```bash
pnpm test
pnpm test:integration
pnpm visual:ci
```

## Dev loop

The canonical workflow lives in `DEV_LOOP.md`.

Short version: edit in this checkout → `pi -e .` for classic extension-only checks or `bin/sumocode.sh` / globally linked `sumocode` for retained SumoTUI checks → commit → for releases bump `package.json` version + `VERSION` in `src/extension.ts`, tag, push tags, then `pi update git:github.com/dhruvkelawala/sumocode` on consumer machines. Tagged releases are the only thing that propagates; pushes to `main` do not.

Never edit `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` — that is the installed clone, not the source of truth.

## Architecture

### Extension entry point

`src/extension.ts` exports a default `(pi: ExtensionAPI) => void` that wires every feature module via its `installX(pi)` / `registerXCommand(pi)` function. The order in that file is the load order — keep it intentional. `package.json#pi.extensions` lists what Pi loads.

`shouldNoopDuplicateInstalledExtension()` runs first: if the installed-from-git copy is loading while the user is inside a SumoCode dev tree, the installed copy bails so the dev tree wins. Do not break this — it is how `pi -e .` coexists with the always-installed copy.

### Two rendering paths

This codebase contains two UI layers at different maturity levels:

1. **Classic Pi extension API** (`src/*.ts`, `src/commands/*`). These call `ctx.ui.setFooter / setHeader / setEditorComponent / custom / notify / registerCommand`. They run inside Pi's existing line-concatenation renderer and are subject to its layout limits.
2. **`src/sumo-tui/` retained renderer**. This is a Node-native retained renderer built to escape those limits. It owns altscreen lifecycle, signal cleanup, mouse SGR routing, Yoga flex layout, cell buffer compositor, frame diff, in-app scroll, modal layer, and compatibility bridges back into Pi.

When adding a feature, decide which layer it belongs to. Anything needing flex layout, in-app scroll, sticky footers, mouse routing, modal layers, deterministic visual capture, or retained state belongs in `src/sumo-tui/`. Simple status text, extension commands, and lightweight classic Pi UI can stay in the classic layer. The `src/sumo-tui/pi-compat/` directory is the only place the two layers should meet.

### Pi patch seam

SumoTUI activation currently requires the tiny Pi constructor patch documented in `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`.

The user-facing wrapper is `bin/sumocode.sh` and, when linked/installed, the `sumocode` command:

- defaults `SUMO_TUI=1`
- accepts `sumocode [options] [path]`, with at most one project path
- supports `-h/--help`, `-v/--version`, `doctor`, `diag [file]`, `-d/--debug`, `--diag-file`, `--no-clear-diag`, `--dry-run`, and `--no-sumo-tui`
- verifies the selected Pi binary contains `loadSumoInteractiveMode`
- sets `SUMO_TUI_MODULE` to the checkout-local `sumo-interactive-mode.js`
- falls back to classic Pi behavior if the patch is missing

Manual-test diagnostics are opt-in via `sumocode -d` / `bin/sumocode.sh -d`. Debug mode writes JSONL to `/tmp/sumocode-manual.jsonl` by default, or to `--diag-file <path>` / `SUMO_TUI_DIAG_FILE`. The launcher clears the diagnostics file at startup unless `--no-clear-diag` is set. Use `sumocode diag` or `node scripts/diag-summary.mjs /tmp/sumocode-manual.jsonl` to summarize a run. Diagnostics must stay no-op unless `SUMO_TUI_DIAG_FILE` is set.

Do not casually change `patches/@earendil-works__pi-coding-agent@*.patch`, `SUMO_TUI`, `SUMO_TUI_MODULE`, or `sumo-interactive-mode.js`. Pi version bumps must follow `docs/research/pi-fork-upgrade.md` and the smoke matrix in `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`.

### Pi ↔ SumoCode tool boundary

Read `docs/PI_TOOL_ARCHITECTURE.md` before adding, overriding, or intercepting tools. Key rules:

- **Built-in tools** (`bash`, `read`, `write`, `edit`, `mcp`, `task`): never re-register. Intercept via `pi.on("tool_call")` for gating; render via transcript view-model pipeline.
- **Pi example extensions** (e.g. `question`): override by registering a tool with the same `name` in SumoCode. SumoCode's version replaces Pi's.
- **Pi internal UI** (`showExtensionSelector`, `showExtensionConfirm`): cannot be intercepted without upstream changes. SumoCode-owned code calls `showDivineQuery()` directly instead of `ctx.ui.select`.

## Cathedral rendering

`src/cathedral/` and `src/sumo-tui/cathedral/` hold Cathedral-themed adapters and retained UI nodes. The visual canon is:

- `docs/ui/CATHEDRAL_UX_SPEC_V2.md`
- `docs/ui/bible/*.html`
- `docs/ui/bible/renders/*.png`
- `docs/visual/parity/CONTRACT.md`
- `docs/visual/parity/scenarios.json`

Color and state tokens are centralized in `src/tokens.ts` (`CATHEDRAL_TOKENS`, `SUMOCODE_STATES`). Five preattentive states: `idle / thinking / tool / approval / learning`.

### Do not hand-roll new ANSI for Cathedral surfaces

Before changing Cathedral rendering, read `docs/SUMO_TUI_RENDER_PRIMITIVES.md`.

Use `src/sumo-tui/render/primitives.ts` for new typed `Style`, `Span`, and `Line` rendering. Convert typed lines to ANSI/cells through the shared helpers. This avoids stale foreground/background/reset/width bugs.

Allowed exceptions:

- low-level ANSI parser/writer code
- terminal controller escape sequences
- compatibility shims that must mirror Pi byte-for-byte
- legacy surfaces that have not yet been migrated
- tests that intentionally assert ANSI escapes

If adding a production Cathedral rendering exception, leave a comment explaining why typed primitives are not appropriate yet.

## Visual harness

The canonical V2 path is documented in `docs/visual/parity/CONTRACT.md`.

### Three scenario lanes

| Lane | Input | Purpose |
|---|---|---|
| `component` | Deterministic fixture → ANSI | Isolated TUI component captures |
| `fixture` | `TranscriptViewModel` fixture → full scene ANSI | Deterministic completed/tool/overlay states without live Pi |
| `runtime` | `./bin/sumocode.sh` via node-pty | Real end-to-end runtime captures |

All three converge into the same pipeline:

```txt
ANSI bytes → @xterm/headless replay → cell snapshot (JSON)
  ├─ styled cell diff (char + fg + bg per cell vs Bible HTML → text report)
  ├─ geometry audit (row categories + column bounds vs spec → text report)
  └─ DOM terminal renderer → Playwright screenshot → crop/mask/diff → review pack
```

### Verification layers

1. **Styled cell diff** (`styled-cell-grid.mjs`) — the primary verification. Parses Bible HTML `<pre class="grid">` spans into a per-cell `{ char, fg, bg, bold, dim }` grid, parses the runtime xterm snapshot into the same shape, and diffs them cell-for-cell. Output is a deterministic text report (`styled-cell-diff.txt`). Known intentional differences (e.g. `--divider-mockup` vs `--divider`) are declared as equivalent pairs and suppressed.
2. **Geometry audit** (`geometry-audit.mjs`) — classifies each row (top-bar, chat-frame-top, hint-row, footer, blank, etc.) and checks column bounds against a `geometrySpec` declared in `scenarios.json`. Catches structural layout drift.
3. **PNG crop/diff** — pixel-level comparison for visual review evidence. Not the primary gate; used for human review packs alongside the text-level reports.

### Commands

```bash
pnpm render:bible                                    # regenerate Bible HTML/PNG targets
pnpm visual:review                                    # review all scenarios
pnpm visual:review -- --scenario <id>                 # review one scenario
pnpm visual:review -- --lane fixture                  # review one lane
pnpm visual:ci                                        # CI gate
```

After a review run, check the text-level reports before inspecting PNGs:

```bash
cat docs/visual/out/parity/<scenario>/raw/styled-cell-diff.txt
cat docs/visual/out/parity/<scenario>/raw/geometry-audit.txt
```

Runtime scenarios invoke:

```bash
./bin/sumocode.sh --offline --no-extensions --no-session
```

`tmux`, cmux/Ghostty screenshots, and live terminal captures are debugging aids only. They must not define CI pass/fail for V2 parity.

Required crops gate against committed approved runtime goldens. Bible diffs remain review evidence. Promote runtime goldens only after Dhruv explicitly approves the capture.

## Current layout decisions

- V2 sidebar width is `30` columns.
- Wide sidebar layout starts at `SIDEBAR_MIN_TERMINAL_WIDTH = 120`.
- Canonical portrait runtime is `60 × 100` and **no-sidebar** for V1. See `docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md`.
- Active V2 input frame is label-less; do not reintroduce `SCRIPTOR INPUT` or legacy input labels.
- Footer right zone is context/window + cost only. Project/branch live in the sidebar when visible or hint row when hidden.
- Top bar active dot is a static session marker; agent state lives in the footer dot.

## Conventions

- No build step. Pi executes TypeScript directly via jiti. Do not add `tsc -b`, bundlers, or emit-to-`dist/`.
- TypeScript is strict with `noUnusedLocals` and `noUnusedParameters`.
- Use tabs for indentation in TypeScript files, matching the existing codebase.
- Tests colocate with source: `foo.ts` next to `foo.test.ts`. Integration tests live under `test/integration/`.
- Pi-bundled deps belong in `peerDependencies`, not `dependencies`. `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are peer-only.
- `ctx.ui.*` calls must happen inside an event handler (`session_start`, `message_start`, etc.). Calling them at module top level fires before Pi's TUI exists and is silently dropped.
- Be TTY-defensive: guard interactive UI so `acpx pi`, `pi --print`, and `--mode rpc` keep working.
- Voice is enforced by `src/voice.ts`. State labels are uppercase Cathedral verbs (`READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING`); other product copy is lowercase, terse, no exclamation marks, no apologies, no decorative emoji.
- `src/spike/` is throwaway exploration. Do not import from `spike/` outside its own directory; promote a spike by moving it into a real module.

## Decision trail

- `PLAN.md` — Q1–Q14 grilling decisions.
- `docs/visual/parity/FIXTURE_STATES_REVIEW.md` — fixture lane design for deterministic completed/tool/overlay states.
- `docs/adr/` — accepted ADRs. ADR 0001 covers the SumoTUI retained renderer.
- `docs/SUMO_TUI_CONSOLIDATION_PLAN.md` — active consolidation sequencing after the deep audit.
- `docs/SUMO_TUI_AUDIT.md` — audit conclusion: SumoTUI is the right direction; the hybrid Pi/SumoTUI seam is the risk.
- `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` — private Pi patch maintenance contract.
- `docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md` — V1 portrait/no-sidebar policy.
- `docs/SUMO_TUI_RENDER_PRIMITIVES.md` — typed render primitive contract.
- `docs/SUMO_TUI_TEST_BACKEND.md` — headless retained-renderer test backend contract.
- `docs/SUMO_TUI_TRANSCRIPT_MODEL.md` — structured transcript view-model contract.
- `docs/cathedral/SCRIPTORIUM_CHROME.md` — shared modal painting contract; read this before adding any new Cathedral overlay (Divine Query / Approval / Memory Scriptorium share it).
- `docs/visual/parity/PORTRAIT_REVIEW.md` — portrait scene composition review.
- `docs/visual/parity/FIXTURE_STATES_REVIEW.md` — fixture lane and deterministic state review.
- `docs/prd.md` / `docs/prd.html` — formal product spec.

## Integration tests

`test/integration/` spawns a real Pi inside a `node-pty` PTY (see `spawn-pi-pty.ts`). These tests verify things that cannot be trusted to unit tests alone: altscreen cleanup on signal, mouse scroll routing, cursor visibility, editor boundary behavior, splash centering, and slash-command dispatch.

Keep PTY integration tests as smoke/contract tests. Prefer unit/headless tests for detailed behavior where possible. For retained renderer behavior, use `src/sumo-tui/testing/test-backend.ts` and read `docs/SUMO_TUI_TEST_BACKEND.md`.
