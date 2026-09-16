# Changelog

All notable changes to SumoCode are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is
[SemVer](https://semver.org/spec/v2.0.0.html).

Per the PRD's versioning roadmap (`docs/prd.md` § Versioning), `v0.2.x` and
`v0.3.x` are documented retroactively for the chrome and theme work that
landed between the original scaffold and this release.

## [Unreleased]

## [0.7.2] — 2026-09-16

Inline images arrive in the retained terminal, landscape gives another row back
to the transcript, and model/account controls stay independent. Delegated
children can carry the parent's MCP gateway in source installs.

### Added
- **Inline Kitty images** — prompt and tool-result images render in place in
  Kitty-compatible retained terminals, with viewport cropping and deterministic
  cleanup; other terminals retain the image-chip fallback. #560 #567
- **Claude account cycle key** — `Alt+A` cycles signed-in Claude accounts while
  preserving the active Claude model. #558 #563
- **MCP-enabled delegated children** — source-mode children inherit an active MCP
  gateway; roles can opt out or fence access to named servers. #568 #569

### Changed
- **One more landscape transcript row** — when the sidebar is visible, the
  permanent hint row is removed and `CTRL+/ · COMMANDS` moves into the footer;
  portrait layout is unchanged. #559 #566
- **Tag-driven native releases** — pushing a `vX.Y.Z` tag starts the native
  release workflow; manual dispatch remains available as a fallback. #556

### Fixed
- **Large native screenshots** — supported image sources are resized before the
  RPC transport limits are applied, while the existing decoded-payload caps
  remain enforced. #561 #564
- **Escape aborts a turn that is waiting on a tool** — SumoCode tools stop
  waiting as soon as the turn is interrupted. Started subagents, terminals and
  worktrees continue in the background; an open question prompt is dismissed.
  #570
- **Logical model cycling** — `Ctrl+P` / `Ctrl+Shift+P` no longer switch between
  Claude accounts registered as `anthropic`, `anthropic-2`, and later clones.
  #558 #563
- **Single-source version banner** — the splash derives its version from
  `package.json`, so future releases only bump the manifest and changelog. #556

## [0.7.1] — 2026-09-14

Steering becomes a named, switchable choice instead of a keybinding and a
permanent badge.

### Added
- **`/queue` delivery command** — `/queue` toggles how a busy-turn submission
  is delivered between steering the running turn (`steer`, the default) and
  queueing a new turn (`follow-up`); `/queue steer` and `/queue follow-up` set
  it explicitly for the session. The selection is named once through the
  transient hint-row notice, and `Command+Enter` routes through the same path.
  #557

### Changed
- **No permanent delivery badge** — the hint row no longer paints `STEER` /
  `FOLLOW-UP` ahead of project and branch context, so the row is
  character-identical to the Bible target. #557

### Fixed
- **Native release notes** — the release workflow reads the tagged version's
  own changelog section first and only falls back to `Unreleased`, so a
  promoted `## [x.y.z]` heading no longer fails the build. #555

## [0.7.0] — 2026-09-12

Native Pi RPC and one delegation path. Prompt delivery, direct bash and images
now ride Pi 0.85's own queues and commands instead of a host-side emulation;
the `task` tool is gone and role-first subagents are the only way to delegate;
and the host stops burning a core on long transcripts. Twenty-five pull
requests across five stacks, every one CI-green and reviewer-gated before
merge; eighteen built by `implement-cheap`, seven by `implement-smart`.

### Added
- **Pi-native direct bash** — `!` commands run through Pi's `bash` /
  `abort_bash` as their own activity lifecycle, never disguised as a prompt
  or a tool call. #378 #549
- **Native RPC images** — attachments are sent as `ImageContent[]` when Pi can
  accept the prompt immediately; busy or compacting submissions with
  attachments fail visibly closed instead of dropping a file (3 MiB / 5 MiB
  caps, no base64 in logs). #379 #550
- **Conversational children** — a visible child that has finished its turn
  can take a follow-up prompt in place, and `subagent_reply` resumes a settled
  headless child's private session for another turn. Headless sessions are
  retained for replyability (no cleanup policy yet). #384 #552
- **Role-first delegation prompt** — the spawn recipe names
  `implement-smart` / `implement-cheap`, every role prints its resolved model
  and worktree default, and an empty `subagent_list` prints the role table.
  #514 #526
- **Tiling placement for visible children** — the next pane splits the
  largest pane along its longer axis, so four children form a 2×2 grid
  instead of nested halves. #519 #546
- **Claude account chip** — the footer shows which Claude account is active
  at every width and repaints after every account, login and sync action.
  #512 #535
- **Cached model and thinking rings** — model/thinking cycle keys work before
  hydration from the last-known ring and reconcile against the live list once
  hydration commits. #448 #542
- **Host heap diagnostics** — a `heap` line every 10 s under
  `SUMO_TUI_DIAG_FILE` and an on-demand `v8.writeHeapSnapshot()`; steady-state
  RSS on a 766 KB session measured at 54 MB median. #521 #543

### Changed
- **Pi owns the prompt queue** — the host's own FIFO and force-send are
  removed; Enter and Alt+Enter map to Pi's `steer` / `followUp`, `queue_update`
  renders the queue truthfully, `clear_queue` restores steering, follow-up,
  then compaction-local text, then the draft, and Escape clears before it
  aborts. A process-local steer-default toggle replaces the old behaviour.
  #377 #541
- **Truthful RPC lifecycle** — `agent_settled` is the only ordinary idle
  boundary (`agent_end` is a low-level run boundary), `messageCount` no longer
  derives from `agent_end`, thinking levels come from
  `get_available_thinking_levels` and are reconciled after `set_thinking_level`
  rather than trusted from a void success, and malformed state payloads are
  contained. #376 #532
- **RPC contract locked on Pi 0.85.1** — `clear_queue`,
  `get_available_thinking_levels` and `abort_bash` are classified and pinned by
  `test/integration/rpc-contract.test.ts`; Plan 088 is done. #375 #525
- **Subagent identity is readable** — ids are `sa-<slug>-<n>` (plus a 4-char
  suffix only under retention), the Herdr agent name is the id itself, every
  `subagent_*` output prints `id · pane` once, and the status strip compacts
  the id. #515 #536 #537 #547
- **Visible children return to the caller tab** — once the caller tab has a
  free slot it is preferred over overflow tabs; concurrent `git worktree add`
  is serialised so parallel spawns no longer race on `.git/config`. #518 #538
- **`/sumo:sync` streams step output** — noisy steps no longer die at
  `execFile`'s `maxBuffer`; a bounded tail is kept for diagnostics and split
  UTF-8 sequences are decoded correctly. #259 #524

### Removed
- **The `task` tool** — delegation runs only through `subagent_*`. The isolated
  Pi subprocess task tool, its skill-wrapper system-prompt patch, its
  `SUMOCODE_NATIVE_TASK` override, and its native-task transcript/Activity
  adapter are deleted. The visible-child launcher command and the child-side
  task-mode watcher remain. #513 #523
- **Readiness aliases** — `input_ready` and `app_ready` are gone; consumers
  read `editor_ready`, `command_ready`, `boot_screen_frame` and
  `stable_chrome_ready`. #424 #545

### Fixed
- **Idle host no longer pegs a core** — an overlay forced a full render on
  every working-indicator tick (62,400 segmenter calls per 200 ticks on a long
  transcript); overlays now render into the narrow repaint (200 calls), and
  each fallback branch is named in diagnostics. #520 #534
- **Streaming is history-independent** — per-delta work no longer scales with
  transcript length or the size of the message being streamed; peak RSS on a
  689 KB message drops from 470 MB to 266 MB. #383 #551
- **Visible children settle promptly** — a child whose final report exists is
  marked turn-finished and its result delivered without waiting for the pane
  to auto-close; `subagent_check` shows last progress and turn state instead
  of `unknown`. #488 #548
- **Sticky errors show on the splash** — the splash mounts the above-editor
  leaf so a sticky failure has a surface before the first message. #511 #522
- **Resume picker rows fit** — labels yield to the id/age suffix at narrow
  widths and the pinned current session is named in the all-sessions tab.
  #504 #528
- **Integration waits match the replayed screen** — rendered-text waits use
  the screen matcher instead of the raw PTY stream, ending the frame-split
  flake; raw-byte guards stay on the byte stream. #324 #531
- **Harness evidence for non-timeout failures** — an unexpected PTY exit
  between waits retains diagnostics (deliberate termination, including
  SIGINT, stays evidence-free), and a focused dry-run rejection persists the
  evidence directory it reports. #423 #539
- **Dependency audit is clean** — `pnpm audit` reports zero findings on the
  0.85.1 lockfile and redundant overrides are retired. #396 #530

## [0.6.1] — 2026-09-11

The stabilization release. No new UI surfaces land; this closes defects where the
agent runtime, the child protocol, or the feedback chrome misreported what they
were doing. Ten pull requests, all reviewed by an independent agent pass before
merge.

### Added
- **Long-lived Claude token sign-in** — `/accounts` can sign an account in with
  a static token minted by `claude setup-token` instead of a browser login,
  which Pi never refreshes and which does not expire on the 30-day refresh
  window. Falls back to a masked paste modal when the CLI is missing or the
  mint fails, and validates the token against Anthropic before storing it.
  #506 #508
- **All-sessions scope in `/resume`** — Tab switches the resume picker between
  the current project and every session under the sessions root, matching Pi.
  The all-sessions rows lead with the project directory, the window is bounded
  and labelled `recent` when it is capped, the current session is always
  present, and a flat custom `--session-dir` is scanned directly rather than
  through its parent. #495 #501
- **Shared launcher CLI contract** — one spec table (`src/cli/launcher-spec.ts`)
  owns every SumoCode command, alias, option, help line and exit code, consumed
  by both `sc` and `bin/sumocode.sh`, with a parity matrix that runs every
  spelling through both binaries so a one-sided addition fails CI. #484 #494
- **Effect v4 adoption campaign (Plan 118)** — the umbrella plan, feasibility
  study and per-track evidence for adopting Effect at the launcher-free seams,
  plus the Wave 0.6 tsc baseline. #462 #463 #490 #491

### Changed
- **Feedback surfaces replace the top-right toast** — notification toasts are
  removed. Transient hints (`press ctrl-c again to quit`, session switches,
  queue acknowledgements, "nothing happened" lines) render in the hint row for
  their lifetime; failures render as a sticky row above the input frame until
  Escape or the next host action. Roughly twenty noise confirmations
  (`model:`, `thinking:`, `theme:`, `copied`, `session name:`, …) are deleted
  outright rather than re-homed. #481 #500
- **A clean exit is quiet** — `/exit` shuts the child down with code 0, which
  the host previously reported as `RPC child exited unexpectedly`. Deliberate
  exits (0 and the reload code 100) now exit the host immediately, with no
  crash notice and no shutdown delay; genuine crashes are unchanged. #505 #507

### Fixed
- **Producer-controlled stream indices are bounded** — an assistant
  `message_update` carrying an out-of-range, fractional or negative
  `contentIndex` is treated as a protocol error instead of driving an
  unbounded allocation on the render thread. #460 #496
- **Malformed RPC frames are observable** — the host now passes
  `onProtocolError` to the client, so a malformed frame below the consecutive
  error threshold reaches the diagnostics sink instead of vanishing. #461 #497
- **Child termination needs an owned PID** — TERM/KILL is attempted only when
  the child handle owns a positive PID, so an abort racing a failed spawn can
  no longer signal the caller's process group; the no-op escalation timer on
  that path is gone. #431 #498
- **Child message shapes are validated before retention** — a frame whose role
  is known but whose content has the wrong shape fails deterministically
  through the bounded protocol-error path instead of throwing while stdout is
  processed. #427 #499
- **Extra Claude accounts are reachable** — a signed-in account no longer reads
  as inactive, base-`anthropic` enabled-model patterns also enable the
  `anthropic-N` clones, and account switching can no longer land on a model the
  registry reports as unavailable. #440 #442
- **Visible subagent panes are reclaimed** — a closed visible pane no longer
  leaves the orchestrator unable to spawn the next one, the retained path is
  accounted for on both success and failure, and Herdr's failure taxonomy
  reaches the operator as `pane_unavailable` rather than a generic error.
  #470 #471
- **Footer subagent strip is readable** — rows show the human title and a short
  id (`sa-2`) instead of a raw namespaced UUID, with colliding short ids
  disambiguated and titles sanitised and bounded by cell width. #485 #486
- **Native `sc -w` works outside a source checkout** — the native launcher
  routes `worktree` through `openWorktree()` like the shell launcher, accepts
  the bare `worktree` subcommand, documents it in `--help`, and rejects
  task-only options before dispatch. #483 #487
- **Large sessions resume** — persisted transcripts hydrate from the session
  file plus a bounded `get_entries(since)` delta instead of one oversized RPC
  frame that terminated the host. #493
- **Dependency audit gate** — the post-publication `smol-toml` advisory that
  broke the CI gate for every branch is remediated by a narrow dev-graph
  override, recorded with its reachability evidence. #489
- **Native release gate** — the native executable contract asserted the
  pre-provenance visible-child command, so the macOS release build failed
  before packaging; the assertion now pins both the parent-selected
  `PI_BIN` and the native binary. #509

### Documentation
- Salvaged the Pi RPC audit documents (upstream protocol inventory,
  implementation audit, visual map) from the superseded audit branch. #482

## [0.5.0] — 2026-09-09

### Added
- **Native `sc` shortcut** — the installer now exposes both `sumocode` and `sc` as the same compiled executable.
- **Manual releases** — dispatch a tagged native release from GitHub Actions, with native contract tests, SHA-256 checksums, changelog notes, and generated contributor notes.
- **Retained subagent work and result disposition** — added fenced recovery for supported Node-source subagents, advisory budgets/stall visibility, and explicit confirmation for applying or pruning worktree results. Native subagents remain disposable. #473 #478
- **Visible subagent steering and close** — delivered steering through task
  control files, added `subagent_close` for graceful shutdown, and re-armed
  the idle exit window after each turn. #381
- **Multi-account Claude OAuth modal preview** — OAuth login modals now show
  an identifiable two-row preview of the authorization URL (with ellipsis
  truncation) instead of hiding the destination behind a generic
  "open authentication page" label. The complete URL stays the OSC-8
  hyperlink target, and Ctrl+Y copies the full URL.
- **`/accounts` command** — manage multiple Claude subscription accounts
  registered through `pi-multi-pass`. Lists the base `anthropic` provider plus
  `anthropic-2`… extras with signed-in status, adds and labels extra accounts
  in `~/.pi/agent/multi-pass.json` (preserving pools/chains/presets and
  non-Claude entries), offers in-UI `pi-multi-pass` installation behind an
  explicit confirmation, requests a reload after adding, switches the active
  provider while preserving the current model ID where possible, renames
  extras, and hands sign-in to the SumoCode RPC `/login` flow with the exact
  provider id. Requires the SumoCode RPC runtime; warns elsewhere.
- **Herdr Terminal theme** (`herdr`) — fourth first-party theme, matching the
  approved Herdr/Ghostty operator setup: green-black `#040704` chassis,
  electric-green `#39FF14` phosphor focus/body, amber `#FFB000` execution, red
  `#FF706D` approval, sharp ASCII chrome (`┌ ┐ └ ┘`, `> # @ $ %` sigils), and
  an eight-frame ASCII packet working indicator. Registered fourth after
  Obsidian; Cathedral remains the default.
- **Ultraviolet Core theme** (`ultraviolet-core`) — fifth first-party theme:
  violet-black `#06050B` chassis, violet `#B974FF` focus/cursor, pale lavender
  `#DCC7FF` body/idle, ice `#75E8FF` syntax/learning, amber `#FFC857` tool
  execution, and pink `#FF668F` approval/failure. Registered fifth after Herdr;
  Cathedral remains the default.
- **Theme application roles** — optional complete `ThemeApplicationRoles` for
  tool ledgers and code blocks. Existing themes resolve through
  legacy-compatible fallbacks, while Ultraviolet supplies amber-tinted tool
  bodies and violet/ice/amber code syntax without renderer theme-name branches.
- **Herdr visual evidence** — deterministic Bible target
  (`theme-herdr-active.html` via `scripts/gen-bible-theme-herdr.mjs`), design
  contract (`docs/ui/stitch/herdr-terminal/DESIGN.md`), and an isolated
  `herdr-theme-active-runtime` review scenario driven by the committed
  `test/fixtures/pi-agent-herdr` fixture (never the developer's live Pi
  config). Review notes in `docs/visual/parity/HERDR_THEME_REVIEW.md`; no
  runtime goldens promoted.
- **Ultraviolet visual evidence** — deterministic Bible targets for active,
  tool-ledger, code-block, and RunCat-active states via
  `scripts/gen-bible-theme-ultraviolet-core.mjs`, design contract under
  `docs/ui/stitch/ultraviolet-core/DESIGN.md`, themed fixture scenarios, and
  isolated `ultraviolet-core-active-runtime` / `ultraviolet-core-runcat-active-runtime`
  review scenarios driven by committed fixtures. No runtime goldens promoted.
- **Ultraviolet RunCat indicator** — optional Fredy Sandoval 0BSD RunCat glyphs
  for `U+E900–U+E904`, gated by `SUMOCODE_RUNCAT_FONT=1`, with the safe
  orbital fallback as default, `/sumo:spinner` inspection, vendored font
  provenance, and `pnpm runcat:install` / `pnpm runcat:check` setup helpers.

### Changed
- **Node requirement** — source development now requires Node 23.11.0 or newer; native installs do not require Node.
- **Large-session responsiveness** — bounded terminal reconciliation and retained transcript/Activity work for long-running sessions. #447 #472
- **Pi 0.85.1 support** — upgraded for GPT-6 Astra, `cacheTTL`, and
  selector fixes; removed the obsolete `pi-server` packaging workaround.
- **Pi 0.85 / Fable 5.1 support** — updated the supported Pi runtime to
  0.85.0, including root-import packaging and overlay compatibility. #455
- **Herdr-only terminal hosting** — removed the legacy alternate-host adapter,
  split helpers, environment probes, diagnostics, compatibility copy, and
  obsolete research artifacts. Visible panes, worktrees, notifications, and
  host detection now use Herdr exclusively.
- **Terminal API v2 migration** — callable background terminals are now
  `terminal_start/check/wait/stop/list`, with durable passive-by-default
  completion and hardened process-tree ownership. Private `sumocode-config`
  prompts, skills, settings, or scripts that still mention `bg_start`,
  `bg_status`, `bg_kill`, `bg_list`, or `/bg` must be migrated separately;
  this public release intentionally does not edit the private config repo.
- **Theme-aware terminal background/cursor** — the host terminal's OSC 11
  background and OSC 12 cursor accent now follow the active theme at startup,
  on live theme switches, and across suspend/resume, instead of being
  hardcoded to Cathedral. Explicit `/sumo:cursor reset` remains respected
  across theme changes, and exit still restores terminal defaults.
- `/sumo:cursor accent` is theme-neutral: it applies the ACTIVE theme's accent
  (copy now says "theme accent"); the legacy `orange` / `cathedral` aliases
  are deprecated but still resolve the current theme accent.

### Fixed
- **Coalesced terminal input** — routed multiple key events independently and bounded malformed/incomplete paste recovery without retaining overflow text. #479
- **Native Pi 0.85.1 startup** — preserved sandbox environment setup and OAuth registration while updating diagnostic hooks and Bedrock-free child compilation.
- **Process and artifact safety** — tightened child identity, credential redaction, protocol bounds, lifecycle cleanup, and executable provenance across terminal and subagent paths.
- **Claude account reliability** — preserved private multi-account state
  during migration, clarified when no Claude account is active, redacted
  login failure diagnostics, and preserved account routing in subagents.
  #413 #420

## [0.5.1] — 2026-09-09

### Fixed
- **Herdr agent-tab detection for wrapper launches** — the Pi RPC child now
  sets `HERDR_AGENT=pi` inside Herdr panes so Herdr applies the Pi manifest
  to the `sumocode` / `sumocode-pi` wrapper chain; native sessions appear in
  the agent tab with working/idle/blocked state and the `sumocode` display
  name. #480

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
- **Fan-out decision docs** — synthesis-vs-production boundary and legacy pane integration
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
the chat, and `/reload` makes hot iteration safe. Daily-driven for the
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
- **`/reload`** (#239) — hard-reload the SumoCode shell via launcher loop
  and exit code 100. Strips `--resume`/`-r` on relaunch and replaces with
  `--continue`. Preserves terminal context.
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
  dispatch, retained lifecycle across session switches, and `/reload`.

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
