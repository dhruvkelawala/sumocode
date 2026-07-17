# Changelog

All notable changes to SumoCode are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is
[SemVer](https://semver.org/spec/v2.0.0.html).

Per the PRD's versioning roadmap (`docs/prd.md` § Versioning), `v0.2.x` and
`v0.3.x` are documented retroactively for the chrome and theme work that
landed between the original scaffold and this release.

## [Unreleased]

### Added
- **Herdr Terminal theme** (`herdr`) — fourth first-party theme, matching the
  approved Herdr/Ghostty operator setup: green-black `#040704` chassis,
  electric-green `#39FF14` phosphor focus/body, amber `#FFB000` execution, red
  `#FF706D` approval, sharp ASCII chrome (`┌ ┐ └ ┘`, `> # @ $ %` sigils), and
  an eight-frame ASCII packet working indicator. Registered fourth after
  Obsidian; Cathedral remains the default.
- **Herdr visual evidence** — deterministic Bible target
  (`theme-herdr-active.html` via `scripts/gen-bible-theme-herdr.mjs`), design
  contract (`docs/ui/stitch/herdr-terminal/DESIGN.md`), and an isolated
  `herdr-theme-active-runtime` review scenario driven by the committed
  `test/fixtures/pi-agent-herdr` fixture (never the developer's live Pi
  config). Review notes in `docs/visual/parity/HERDR_THEME_REVIEW.md`; no
  runtime goldens promoted.

### Changed
- **Theme-aware terminal background/cursor** — the host terminal's OSC 11
  background and OSC 12 cursor accent now follow the active theme at startup,
  on live theme switches, and across suspend/resume, instead of being
  hardcoded to Cathedral. Explicit `/sumo:cursor reset` remains respected
  across theme changes, and exit still restores terminal defaults.
- `/sumo:cursor accent` is theme-neutral: it applies the ACTIVE theme's accent
  (copy now says "theme accent"); the legacy `orange` / `cathedral` aliases
  are deprecated but still resolve the current theme accent.

## [0.4.0] — 2026-06-10

The worktree fan-out release. SumoCode can now run visible background review
jobs, fan out agents into named git worktrees, keep durable task metadata across
reloads, and gate the ship leg through explicit human confirmations.

### Added
- **Orientation-aware `/sumo:diff`** — portrait terminals open hunk in a down
  split; landscape stays right; `--down` / `--right` override.
- **Tracked `/sumo:review`** — review now launches a visible `bg_task`
  `runner=sumocode` pane instead of queueing a main-agent task-tool loop.
- **bg_task hardening** — real process-exit completion for agent panes,
  orchestrator-owned pane lifecycle, agent concurrency backpressure
  (`status=at_capacity`), clear-time task-dir cleanup, startup stale-dir prune,
  and bounded log files.
- **Git worktree module** (`src/git/worktree.ts`) — execFile-based create/list/
  remove helpers, branch slugging, clean/head-advanced checks, and path-with-
  spaces coverage.
- **`bg_task worktree=true`** — named-branch worktree creation, persisted
  worktree refs in `meta.json`, no auto-remove, explicit prune via clear.
- **`/sumo:worktree`** — opens an interactive SumoCode pane inside a new
  worktree with setup action, plus explicit prune listing/removal.
- **`/sumo:ship`** — stages and commits locally, then requires confirmation
  before push and again before `gh pr create`.
- **Image plumbing** — retained transcript image blocks render through Pi TUI's
  Image component with fallback, and editor image paste uses `[Image N]` tokens
  while composing.
- **Fan-out decision docs** — synthesis-vs-production boundary and pi-cmux
  compatibility stance documented under `docs/research/`.

### Changed
- `bg_task` agent harvest waits for the child process exit marker rather than
  first `response.md`, so multi-turn/kept-open child panes are not marked done
  too early.
- Completed agent panes stay open for inspection until explicitly stopped or
  closed.

## [0.3.0] — 2026-05-07

The "feature-complete personal shell" release. Three themes ship, the agent's
memory becomes a real surface you can edit, the bash output finally lives in
the chat, and `/sumo:reload` makes hot iteration safe. Daily-driven for the
last several weeks; the announce release is built on top of this commit.

### Added
- **Three-theme system** with persistent choice and `Ctrl+Shift+T` cycle
  (cathedral → amber-crt → obsidian → cathedral). Order pinned by PRD § Themes.
  - **Cathedral** — 19th-century scriptorium, warm walnut, burnt-orange,
    fleur-de-lis bullets. Default.
  - **Amber CRT** — VGA mission control, warm dark brown chassis, P3 amber
    phosphor (`#FFB000`), double-line `╔╗╚╝═║` chrome, `●`/`○` status circles.
    Palette aligned with the Stitch design ref.
  - **Obsidian Temple** — sacred-tech night mode, deep obsidian background,
    Egyptian section glyphs, gold/cyan/magenta neon focal accents.
- **Memory Scriptorium** (#138, #238) — full V2 chrome on the memory editor.
  Floral title rule, `❯` chevron, group facets, command/search mode separation
  (`/` enters search, Esc/Enter exits), `e` to edit, `d` to optimistic-forget
  with rollback. 29 unit tests + a deterministic fixture scenario.
- **Shared modal chrome** (`src/cathedral/scriptorium-chrome.ts`) — the
  lifted-bg painter shared by Divine Query, Approval, and Memory Scriptorium.
  Documented contract in `docs/cathedral/SCRIPTORIUM_CHROME.md`.
- **Owned-shell bash mirror** (#207, PR #233) — Pi's `BashExecutionComponent`
  output is now mirrored into the SumoCode chat as a structured `BASH` block,
  with structural detection and a session-replay skip.
- **`/sumo:reload`** (#239) — hard-reload the SumoCode shell via launcher loop
  and exit code 100. Strips `--resume`/`-r` on relaunch and replaces with
  `--continue`. Preserves cmux/terminal context.
- **Eager splash paint + transition fade** (#225, PR #230) — splash repaints
  before SumoTUI boots; visual handoff fades through `RetainedShellTransition`
  with a `fading-splash` phase. `SUMOCODE_REDUCED_MOTION=1` and non-TTY bypass.
- **Startup diagnostics** (#231) — `runtime_*`, `terminal_*`, `eager_splash_paint`,
  `upstream_*`, `owned_shell_*` events with `sinceDiagnosticsMs` / `deltaMs` /
  `module_load_slow` provenance for Pi-side bottleneck attribution.
- **Approval modal vertical cap** (#241) — `MAX_COMMAND_ROWS = 12` and
  `MAX_DESCRIPTION_ROWS = 4`. Long bash commands collapse to
  `… N more lines hidden` instead of pushing the modal off-screen.
- **Editor selection metadata** (PR #237) — `PiEditorLeaf.render` marks inner
  cells selectable; per-row dynamic side-column skip; outer rows correctly
  classified as borders (no longer breaks selection on multiline content).
- **Env scrub** (#187, PR #235) — `buildSpawnEnv()` strips `SUMO_TUI*` and
  `SUMOCODE_*` debug env from PTY children in integration tests.
- **Visual CI flake remediation** (#186, PR #236) — empty captures retry,
  `waitForStableOutput`, `awaitChildExit`, `clampPositiveInt(maxAttempts)`,
  diagnostics fields.
- **Real MCP server roster in sidebar** (PR #250) — `src/mcp-config-reader.ts`
  reads `pi-mcp-adapter`'s on-disk config files in documented precedence order
  (`~/.config/mcp/mcp.json` → `<piAgentDir>/mcp.json` → `<cwd>/.mcp.json` →
  `<cwd>/.pi/mcp.json`) and shows the configured roster instead of the
  hardcoded 4-server placeholder. Each server appears once with status `idle`
  — honest given Pi 0.74's `ExtensionAPI` exposes no runtime MCP connection
  state and `pi-mcp-adapter` defaults to lazy lifecycle. Cache keyed by
  `(cwd, piAgentDir)` so session switches inside the same process get a
  fresh read. `PLACEHOLDER_MCP` is retained for the visual-fixture lane only.
  Known gap: `pi-mcp-adapter`'s `imports: ["cursor", "claude-code", ...]`
  field is not resolved here — each host has its own config-path layout per
  platform and reproducing that is several hundred lines of host-aware code.
  When `imports` is present the reader emits an `mcp_imports_unresolved`
  diagnostic to `SUMO_TUI_DIAG_FILE`. Workaround: run `pi-mcp-adapter init`
  which expands imports into `mcpServers` in-place; once expanded, the
  reader picks them up.

### Changed
- **Pi 0.70.2 → 0.74.0** (#222). Patch surface trimmed to 36 lines for the
  SumoTUI seam (`patches/@earendil-works__pi-coding-agent@0.74.0.patch`).
- **Pi packages migrated to `@earendil-works/*` namespace.** Upstream
  rebranding announced May 7, 2026: all `@mariozechner/pi-*` packages on
  npm are deprecated. SumoCode tracks `@earendil-works/pi-coding-agent`,
  `pi-tui`, and `pi-ai` at `0.74.0`. The patch file moved from
  `patches/@mariozechner__pi-coding-agent@0.73.0.patch` to
  `patches/@earendil-works__pi-coding-agent@0.74.0.patch` (same logical
  edits, line offsets shifted from 545/590 to 539/584).
- **`@mariozechner/jiti` dropped** in favour of upstream `jiti@^2.7.0`,
  matching Pi 0.74's peer-dep list.
- **Anthropic extra-usage warning** silenced via Pi 0.73's new
  `warnings.anthropicExtraUsage` setting in private config — closes #20's
  upstream limitation tracker.
- **Cathedral Bible renders** unified per `docs/visual/parity/CONTRACT.md`;
  `divider` token bumped from `#3A2F25` to `#5A4D3C` for runtime/Bible parity.

### Performance
- **P0 launcher rewrite** (#223) — pure-bash launcher + jiti cache. Launcher
  dry-run: 24.2 ms → 17.3 ms (–28%) after removing `pi-web-extension`/`jsdom`
  from the private config.
- **P1 parallel paint** (#224) — Yoga warmup, async git, WASM pre-warm.
- **P2 eager splash** (#225) — splash painted ~400 ms before Sumo bootstrap.

Print-mode and first-frame remain Pi-bound and flat (~6.7 s and ~1.5 s).
Future startup wins live upstream in Pi.

### Fixed
- Long bash commands no longer push the approval modal past the terminal
  height (#241).
- Memory Scriptorium `d` no longer accidentally forgets hidden facts after a
  transient failure — rollback recomputes focus against the active filter.
- `/` and other letters are no longer intercepted by `d`/`e` hotkeys when
  typed inside a Memory Scriptorium search query.

### Internal
- `docs/cathedral/SCRIPTORIUM_CHROME.md` — modal chrome contract.
- `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` — refreshed for Pi 0.73 + smoke matrix.
- `scripts/smoke-pi-versions.sh` — Pi-version compatibility smoke runner.
- 19 integration tests under `test/integration/` covering altscreen cleanup,
  mouse routing, cursor visibility, narrow widths, splash centering, slash
  dispatch, retained lifecycle across session switches, and `/sumo:reload`.

## [0.2.0] — 2026-04 (retroactive)

The "V2 Cathedral chrome" release. The hand-rolled ANSI splash from v0.1
becomes a real retained-renderer surface; the sidebar, footer, top bar, and
input frame are all rebuilt against the V2 spec; modals (approval, memory
editor, divine query, command palette) ship as Cathedral-styled overlays.
Audit consolidation epic #98 lands the kernel: `TerminalSessionOwner`,
`InteractionRegistry`, cancellable workers, typed render primitives, headless
`TestBackend`, structured transcript view-model.

### Added
- **Element 1 — Sidebar** (#85, #95). Right-anchored Cathedral sidebar with
  CONTEXT, MCP, and MEMORY sections. Remnic memory client wired in.
- **Element 2 — Top bar** (#84, #94). Tab bar above the chat area, UUID
  collapsed to the first segment.
- **Element 3 — Splash** (#88, #118, #120). Vertically centred Sumo BSH face,
  wordmark, AWAITING flavour hint, carved cathedral input frame.
- **Element 4 — Input frame** (#82, #92, #121). Cathedral prompt with
  active-state hint row, autocomplete repositioned.
- **Element 5 — Footer** (#83, #93, #122). F1 two-zone footer, cathedral state
  vocabulary (READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING).
- **Element 6 — Approval modal** (#137). Flat-hybrid Cathedral approval gate
  for dangerous bash commands. Configurable patterns; allowlist support.
- **Element 7 — Memory editor** (#29). 6-panel categorization, inline `e`/`d`
  editing, AI write-path. (Re-implemented from scratch in v0.3 as the Memory
  Scriptorium.)
- **Element 8 — Command palette** (#129, PR #130). Ctrl+P, 5 modes,
  drill-down navigation.
- **Element 9 — Tool pills** (#131, PR #144). Compact pills, expanded ledger
  cards, expansion toggle.
- **Element 10 — Code blocks** (#132, PR #146). Frame, line gutter, syntax
  highlighting (keywords, strings, numbers, comments), auto-collapse >20 lines.
- **Element 11 — Divine Query modal** (#152, PR #175). Replaces Pi's
  `ctx.ui.ask` / `ctx.ui.confirm` for SumoCode-owned questions.
- **Element 12 — Scroll/scribe delegation** (#141). Pi task tool rendered as
  `[scroll]` + `scribe`.
- **Element 13 — Chat message frames** (#86, #121). Boxed, refined,
  surfaceRecess body bg.
- **Mouse selection + OSC 52** (#142, PR #145). Auto-copy on mouse-up.
- **Word-boundary chat wrap** (#136, PR #147). `Intl.Segmenter` graphemes,
  CJK fallback, unbreakable token hard-wrap.
- **Cathedral persona + voice** (`src/voice.ts`). Lowercase, terse, no
  decorative emoji, no apologies.
- **Cathedral working indicator** — enso dohyō arc sweep, observability
  command (`/sumo:spinner`).

### Changed
- Layout reaches the sidebar-min terminal width of 120 cols; portrait policy
  documented in `docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md`.
- V2 spec/code drift swept (#133, PR #148). `surfaceLifted` token updated;
  `SETTINGS` palette mode wired to `/settings`.

### Fixed
- Multiline paste (#75) — drafts preserved across paste boundaries (#126).
- Skill-conflict warning (#73) — no longer leaks into chat (#127).
- Ghost UI elements (#67) — no longer stack in scrollback (#128).
- Crash at ≤40 col widths (#72) — narrow-width clamp (#125).
- Multiple Cathedral seam bugs (#154–#159) — autocomplete anchor, tool frame
  merging, sidebar bleed, mouse scroll jerk, mouse selection precision.

### Internal — audit consolidation (epic #98)
- Single `TerminalSessionOwner` (PR #109).
- `InteractionRegistry` (PR #110).
- Cancellable workers (`src/sumo-tui/runtime/worker-runtime.ts`).
- Typed render primitives (PR #114).
- Headless `TestBackend` + Pilot.
- Structured `TranscriptViewModel` with `ChatBlock` types (markdown / code /
  tool / skill / question / delegation).

## [0.1.0] — initial scaffold

The hello-world Pi extension. Persona, custom footer, working indicator,
basic slash commands. Established the public/private split between this repo
and `sumocode-config`.

### Added
- Pi extension scaffold targeting `@earendil-works/pi-coding-agent`.
- `/sumo:persona` slash command.
- `SumoCode loaded · v0.1.0` startup notification.
- MIT license; public repo + private `sumocode-config` companion.
- `PLAN.md` decision log (Q1–Q14 grilling).
- `docs/prd.md` v1.0 PRD.
- Cathedral working indicator + product voice rules.
- Custom footer with model / cost / branch / memory zones.

[0.3.0]: https://github.com/dhruvkelawala/sumocode/releases/tag/v0.3.0
[0.2.0]: https://github.com/dhruvkelawala/sumocode/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/dhruvkelawala/sumocode/releases/tag/v0.1.0
