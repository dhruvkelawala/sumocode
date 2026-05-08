# SumoCode v1.0 — PRD

> Generated 2026-04-25 from a 14-question grilling session.
> Decision rationale lives in [PLAN.md](../PLAN.md).
> Visual reference lives in [docs/ui/DESIGN.md](./ui/DESIGN.md), [docs/ui/claude-design/](./ui/claude-design/), [docs/ui/stitch/](./ui/stitch/).

---

## Problem Statement

I (Dhruv, senior engineer) work in the terminal all day. Pi (`@earendil-works/pi-coding-agent`) is the best terminal AI coding agent available, but its UX is generic — every Pi user gets the same default footer, no persistent memory across sessions, no visual identity. After three weeks of using stock Pi, my terminal still feels like "running someone else's tool" rather than "this is mine."

Three concrete symptoms:

1. **No persistent identity.** Each new Pi session starts from zero. The agent doesn't remember that I prefer TypeScript strict mode, that I use pnpm not npm, that I'm based in London, or that I work at Argent on argent-x. I re-explain these every time, or I edit `APPEND_SYSTEM.md` once and hope the LLM picks it up.

2. **No visible state.** I can't tell at a glance whether the agent is thinking, running a tool, or waiting for my approval. The default footer shows model + cost, which is useful, but lacks the preattentive state signals that production-grade agent UIs (Cursor's status bar, OpenCode's split-pane) use.

3. **No cross-machine continuity.** I work on a Mac mini and a MacBook. Setting up Pi identically across both is a manual nightmare — copy-paste extensions, re-auth providers, retype env vars, re-install packages. Memory and preferences live on whichever machine I'm currently on, not "with me."

I also want a clean separation: my **secretary** (OpenClaw on Telegram) dispatches work; my **CTO** (a custom coding agent) does the work. Pi is the engine for the CTO. SumoCode is the personality, memory, and visual identity that make the CTO feel like *my* CTO.

---

## Solution

**SumoCode is a Pi extension that wraps Pi in a persistent, personal, visually-distinct experience that syncs identically across all my machines.**

It does not replace Pi. It does not fork Pi. It loads as a regular Pi package and uses Pi's extension API (`ctx.ui.*`) to:

1. **Establish a consistent identity.** A persona layer (Zeus, in the Temple of SumoDeus) lives in `APPEND_SYSTEM.md` and is appended to every Pi session's system prompt. The agent introduces itself the same way, talks the same way, has the same memory of who I am — across every session, every day, every machine.

2. **Show what's happening.** A custom footer replaces Pi's default with a concise status line: `~/repo (main) · ↑12k ↓8k · $0.42 · 42%/200k · ● <state> · <model>`. The `●` dot uses one of five preattentive colors (idle / thinking / tool-running / needs-approval / learning-write) — the kind of color-coding a production observability tool uses, brought to a coding agent. A right-sidebar overlay (auto-hidden on narrow terminals, repositionable to bottom on portrait monitors) shows live context: project name, token usage, cost, MCP server health, and top relevant memory facts.

3. **Remember me across sessions.** A local Remnic daemon (built on QMD, which I already use for OpenClaw) auto-extracts durable facts from each session — preferences, project context, decisions made — and injects the relevant ones back into future sessions. Memory storage is plain markdown, git-syncable via the same private repo as my settings and extensions.

4. **Three themes for three moods.**
   - **Cathedral** (default) — a 19th-century scriptorium aesthetic. Warm walnut background, burnt-orange accents, IBM Plex Mono. The everyday driver.
   - **Amber CRT** — Apple II / IBM 5151 phosphor terminal. Aligns with my Mission Control v3 design language for cross-agent visual consistency.
   - **Obsidian Temple** — sacred-tech mode. Deep obsidian background, bronze body text, gold + cyan + magenta neon glows on focal elements. For deep-focus sessions where I want the agent to feel like a ceremonial space.

   Switch instantly via `Ctrl+Shift+T` (cycles forward) or thoughtfully via `/sumo:theme` (preview overlay). Choice persists in synced config and follows me to any machine.

5. **Sidebar adapts to my screen layout.** Right sidebar on landscape monitors. Bottom sidebar on portrait (my Mac mini is rotated 90°). Auto-detects on startup; user can override per-machine. Position preference is **machine-local** (not synced) because it's about physical screen orientation, not personal preference.

6. **Sync is one command.** Both machines share a private GitHub repo (`sumocode-config`) that holds my persona, memory, settings, MCP servers, and extension list. `/sumo:sync push` and `/sumo:sync pull` are slash commands. The memory storage is designed as **append-only files with timestamped sections**, so concurrent extraction on both machines never produces git conflicts in practice.

7. **It just works in non-interactive contexts.** When OpenClaw delegates a task via `acpx pi`, SumoCode's UI features silently disappear (no TTY = no footer / sidebar / splash). Persona and memory still apply. Pi's structured ACP output is unaffected.

The end state: I open a terminal on either machine, run `pi`, and SumoCode greets me with my identity, my memory, and the theme I last picked. Switching machines is a `git pull && bootstrap.sh` away from identical state.

---

## User Stories

### Daily use

1. As a developer, I want to launch SumoCode and see Zeus's persona active immediately, so that the agent's voice is consistent with how I trained it.

2. As a developer, I want to glance at the footer and know whether the agent is idle / thinking / running a tool / waiting for my approval / writing to memory, in under 250ms, so that I can keep working without breaking flow.

3. As a developer, I want the sidebar to show the current project, token usage, cost, connected MCP servers (with their health), and my top 5 most-relevant memory facts, so that I have permanent situational awareness without typing a query.

4. As a developer working at 80-character terminal width, I want the sidebar to auto-hide so it doesn't crowd my chat area, but I want it to come back as soon as I widen my window past 120 cols.

5. As a developer with a portrait monitor (Mac mini, 90° rotation), I want the sidebar to render at the bottom of the terminal as a horizontal band, so it doesn't squeeze my chat area into a single column.

6. As a developer working in a tmux split, I want SumoCode to detect my terminal's actual aspect ratio at startup and on resize, and pick the best sidebar position (right/bottom/top/hidden) automatically.

7. As a developer who runs SumoCode in many different terminal shapes during the day, I want a `/sumo:sidebar` slash command and a `Ctrl+Shift+S` keybinding that lets me cycle through `right → bottom → top → hidden → auto`, so I can override the auto-detection when I disagree with it.

8. As a developer, I want the sidebar position to persist per-machine (mini = bottom, MacBook = right) but not sync between machines, because it depends on physical screen orientation that's specific to each machine.

### Memory

9. As a developer, I want SumoCode to automatically extract durable facts from my sessions when each session ends, so I don't have to manually log preferences, decisions, or learnings.

10. As a developer, I want the memory extraction model to be cheap (Anthropic Claude Haiku 4.5, ~$0.0005 per session), so I never think about cost.

11. As a developer, I want to add a memory fact manually via `/sumo:memory add "I prefer Bun where possible"`, so I don't have to wait for auto-extraction when I want something remembered now.

12. As a developer, I want `/sumo:memory show` to render my full curated memory in an overlay where I can read, search, and edit it, so I can curate what the agent knows about me without leaving the terminal.

13. As a developer, I want `/sumo:memory forget <id>` to soft-archive a fact so it stops being injected, but stays in version-controlled history for audit, so I never lose a fact accidentally.

14. As a developer, I want memory facts to be timestamped and sourced (which session generated them), so I can trace why the agent thinks something about me.

15. As a developer, I want a `/sumo:memory status` command that tells me whether the Remnic daemon is running, how many facts are stored, last extraction time, and any errors, so I can diagnose memory issues fast.

16. As a developer, I want the memory directory to live in my synced config repo (`sumocode-config/memory/`) so the same facts surface on both my machines.

17. As a developer, I want memory writes from concurrent sessions on both machines to never produce git merge conflicts, because conflict resolution on memory.json files would be miserable.

### Themes

18. As a developer, I want the default theme to be Cathedral on first launch, so SumoCode has a strong identity without forcing me to choose at install time.

19. As a developer, I want `Ctrl+Shift+T` to instantly cycle to the next theme, so I can see all 3 in three keypresses without leaving my session.

20. As a developer, I want my chosen theme to persist across sessions and across machines (synced via `sumocode-config`), so I don't pick a theme every time I open the terminal.

21. As a developer, I want `/sumo:theme cathedral` to apply Cathedral immediately by name, without showing a picker, so I can quickly switch when I know what I want.

22. As a developer, I want `/sumo:theme` (no argument) to enter a preview cycle mode where Tab/Right cycles, Enter confirms, Esc reverts, so I can compare themes carefully when I'm choosing.

23. As a developer, I want `/sumo:theme list` to print the 3 themes with short descriptions so I'm reminded what they offer.

24. As a developer, when I switch themes, I want the entire UI (footer, sidebar, working indicator, splash, every state dot) to redraw with the new tokens — no restart required.

25. As a developer, I want each theme's preattentive state colors to be distinctly recognizable (greens differ from greens), so I can use them across themes without re-learning the meaning of each color.

### Voice and copy

26. As a developer, I want SumoCode's UI text (notifications, status labels, error messages) to follow a strict "product voice" — terse, confident, never apologetic, no exclamation marks — so the tool stays out of the way.

27. As a developer, I want the agent's actual responses (LLM output) to keep its existing Zeus persona — confident, structured, slightly didactic — separate from the product voice. The product voice and Zeus voice are clearly distinguished.

28. As a developer, I want the option to invoke Zeus explicitly in UI text via the `Zeus says: ...` prefix when I want the persona to break through (e.g., "Zeus says: tool needs approval"), so intentional crossover is marked.

### Persistence and sync

29. As a developer who works on both a Mac mini and a MacBook, I want both machines to load identical SumoCode state (persona, memory, theme, settings, MCP servers, packages) after a single command (`git pull && ./bootstrap.sh`), so switching machines is friction-free.

30. As a developer, I want `bootstrap.sh` to be idempotent — running it twice on the same machine should produce no errors and no surprises, so I can run it confidently after every `git pull`.

31. As a developer, I want secrets (API keys, OAuth tokens) to never sync — they live machine-local in `~/.zshrc` and `~/.pi/agent/auth.json` — so I can sync my setup publicly without leaking credentials.

32. As a developer, I want `/sumo:sync push` to gracefully handle the rare case where two machines have edited the same file (`identity.md`) — surface a clear error message and leave the repo in a state I can manually resolve, so I never silently lose a memory fact.

33. As a new-to-SumoCode developer (or me on a third machine), I want a single document — SETUP.md — that takes me from "fresh macOS" to "fully working SumoCode" in under 30 minutes.

### Extension points and ACPX

34. As an OpenClaw user dispatching coding tasks via Telegram, I want `acpx pi "fix the auth bug"` to invoke SumoCode in non-interactive mode where TUI features (footer, sidebar, splash) don't render but persona, memory, and tools all work normally.

35. As a developer, I want SumoCode to never crash when there's no TTY (`pi --print`, `pi --mode rpc`, ACPX delegation), because dispatched workflows must be reliable.

### Working indicator and splash

36. As a developer, I want SumoCode to replace Pi's default working indicator with theme-aware frames, so the "thinking" animation feels consistent with my chosen theme's aesthetic.

37. As a developer, I want a brief Zeus splash screen on session start (3 seconds, dismissible by typing) — the existing `zeus-splash.ts` extension already does this — so the start of every session has a small ceremonial moment.

### Slash commands

38. As a developer, I want all SumoCode slash commands to live under the `/sumo:` namespace (`/sumo:theme`, `/sumo:memory`, `/sumo:sync`, `/sumo:sidebar`, `/sumo:persona`), so I can discover them by typing `/sumo:` and seeing autocomplete.

39. As a developer who uses tomsej's leader-key extension (`Ctrl+X` palette), I want SumoCode's slash commands to auto-discover into that palette under appropriate categories, so I can also access them via the keyboard-driven palette.

---

## Implementation Decisions

### Architecture: 12 modules, sharply scoped

The extension is built from twelve modules. Five of them are "deep" — they encapsulate non-trivial logic and have clean tested interfaces. Seven are shallow (data, registration glue, or simple renderers).

**Deep modules (testable in isolation):**

1. **theme** — owns theme registry, active theme state, cycling, persistence to synced `sumocode-config/sumocode.json`. Subscribers re-render on theme change. Holds the typed `Theme` interface that all 3 theme bundles implement.
2. **layout** — owns sidebar position decision logic (auto vs override), terminal aspect-ratio detection on startup and resize, persistence of position override to **machine-local** `~/.sumocode/local-config.json`. NOT synced, because screen orientation is physical, not personal.
3. **memory** — HTTP client for the local Remnic daemon. Methods: `query(prompt, n)` returns top-N relevant facts; `status()` returns daemon health; `add(fact, category)` writes a manual fact; `forget(factId)` soft-archives. Encapsulates Remnic protocol, retries, and error handling.
4. **sync** — wraps git operations against `~/sumocode-config`. Methods: `push(message?)` does a pull-then-push to minimize conflict windows; `pull()` updates local state; `status()` returns structured info about pending changes, conflicts, and last sync time. Encapsulates `child_process` shell-out and git output parsing.
5. **footer** — pure formatting function from agent state to footer strings. Theme-aware (uses theme tokens for state-dot color and text colors). Defensively guarded with `ctx.ui.isTTY` check; no-op in non-TTY contexts.

**Shallow modules:**

6. **voice** — pure data: typed copy constants. Single source of truth for UI microcopy. Enforces voice rules (terse, no apologies, no exclamation marks) at the type level.
7. **sidebar** — custom overlay component. Pulls data from `memory`, `theme`, `layout`. Renders differently based on resolved sidebar position (right vs bottom vs top). TTY-guarded.
8. **working-indicator** — theme-aware frame array per theme. Simple data + registration via `ctx.ui.setWorkingIndicator`.
9. **commands/{theme,memory,sync,sidebar,persona}** — thin slash command handlers. Each delegates to the appropriate core module. Lives in `src/commands/<name>.ts`.
10. **keybindings** — registers `Ctrl+Shift+T` (theme cycle) and `Ctrl+Shift+S` (sidebar position cycle). Plus `Alt+T` and `Alt+S` as fallbacks for terminals that grab Ctrl+Shift.
11. **splash** — already exists in `sumocode-config/pi-agent/extensions/zeus-splash.ts`. Just needs a TTY guard added.
12. **extension** — entry point. Wires modules together, subscribes to Pi events (`session_start`, `tool_call`, etc.), registers commands and keybindings.

### Theme system

All three themes share an identical `Theme` interface shape. Only token values differ. The interface includes:

- Surface tokens (background, surface, panel, recess, lifted, divider)
- Text tokens (foreground, foregroundDim, foregroundMuted)
- Accent tokens (accent, accentSecondary, border)
- 5 preattentive state slots (idle, thinking, tool, approval, learning) each with hex + glyph + glow boolean
- Decoration tokens (memoryPrefix, sectionBorder, activeTabFrame)
- Effects flags (scanlines, radialGradient, glowOnFocal, chromaticAberration)

**Cathedral is default and first** in the registry order. Amber CRT is second. Obsidian Temple is third.

**First-launch behavior:** No theme picker. Cathedral is loaded immediately. Discovery happens via README, `/sumo:theme list`, or accidentally typing `/sumo:`.

**Persistence:** Active theme name stored in `sumocode-config/sumocode.json`. This file syncs across machines (theme preference IS personal).

### Memory system

**Backend:** Remnic standalone (`@remnic/cli` + `@remnic/server`), running as a launchd-managed local HTTP daemon at `127.0.0.1:7749`. Storage location: `sumocode-config/memory/`. Uses QMD (already installed for OpenClaw) as the search backend.

**Storage layout (append-only, designed for git):**
- `memory/identity.md` — manual writes only (rare). The cross-project preferences. Conflicts here ARE expected because identity changes are intentional; user resolves manually.
- `memory/entities/<entity>.md` — append-only. Each new finding gets a timestamped section appended. Concurrent appends from two machines merge trivially in git.
- `memory/episodes/<timestamp>-<topic>.md` — immutable. Each session's auto-extracted facts are written to a unique timestamped file. Files are never edited after write.

**Extraction:**
- Trigger: Pi `session_end` event.
- Model: `anthropic/claude-haiku-4-5` (cheap, sufficient quality).
- Cost: ~$0.0005 per session.
- LLM exposure: NO `memory_search` tool in v1. Memory is ambient context via the sidebar and the system-prompt-injected top-N facts. A tool is a v0.3+ consideration.

### Sync system

**Strategy:** Append-only files for memory. Manual merge for identity.md. `/sumo:sync push` always pulls-then-pushes to minimize conflict windows.

**What's synced (`sumocode-config` repo):**
- `pi-agent/APPEND_SYSTEM.md` — Zeus persona
- `pi-agent/settings.json` — packages list, model preferences
- `pi-agent/mcp.json` — MCP server configurations (with env-var-templated secrets)
- `pi-agent/extensions/` — custom extensions (think, exit-alias, zeus-splash, answer, zeus-working)
- `pi-agent/themes/` — theme files
- `pi-agent/prompts/` — prompt templates
- `memory/` — all memory files
- `sumocode.json` — active theme + version

**What's NOT synced (per-machine):**
- `~/.pi/agent/auth.json` — OAuth tokens, API keys
- `~/.pi/agent/sessions/` — local session SQLite stores
- `~/.pi/agent/git/` — cloned packages (regenerated by `pi install`)
- `~/.pi/agent/mcp-cache*.json` — runtime caches
- `~/.sumocode/local-config.json` — sidebar position override (NEW)

### Layout / sidebar positioning

**Auto-detection rule** (default):
- If `cols >= 120 && cols >= rows * 1.2` → `right`
- If `rows >= cols * 1.2` → `bottom`
- Otherwise → `hidden`

**Override:** `/sumo:sidebar [right|bottom|top|hidden|auto]` persists to `~/.sumocode/local-config.json`. `Ctrl+Shift+S` cycles forward through the 5 options.

**Sidebar content adjusts to position:** right sidebar shows 5-7 memory facts; bottom sidebar (12 rows tall) shows 3-4 memory facts and arranges Context/MCP/Memory in 3 horizontal columns instead of 3 vertical sections.

### Voice rules

UI microcopy follows strict rules enforced by the `voice` module's TypeScript types:

- One word when possible (`Remembered.` not `Got it!`)
- Confident, never apologetic (`Cannot write there.` not `Sorry, I can't…`)
- Ambient, stays out of the way (`thinking` not `Zeus is thinking…`)
- No exclamation marks
- Present tense preferred
- No emoji in copy (emoji is reserved for preattentive signals)
- Lowercase for state/mode, Capitalized for nouns

**Zeus crossover:** intentional voice-switching is marked with `Zeus says:` prefix, e.g., "Zeus says: that tool needs approval." This is the only path where the agent persona enters UI text.

### TTY-defensive coding

Every UI-emitting code path is guarded:

```typescript
if (!ctx.ui.isTTY) return;
```

before calling `ctx.ui.setFooter`, `ctx.ui.custom`, `ctx.ui.setWorkingIndicator`, etc. This makes SumoCode safe under `acpx pi`, `pi --print`, `pi --mode rpc`, and any CI scenario.

### Version staging

The 12 modules don't all ship at once. Vertical-slice releases:

- **v0.2 (Minimum Useful)** — voice, theme (cathedral only), footer, working-indicator, sidebar (right only — no layout module yet), memory, sync, splash. Slash commands: `/sumo:memory show|add|status`, `/sumo:sync push|pull|status`. Bootstrap.sh installs Remnic + drops launchd plist.
- **v0.3 (Theme System + Amber CRT)** — refactor cathedral hardcoding into theme registry, add amber-crt, add `/sumo:theme [name|list|picker]`, add `Ctrl+Shift+T` keybinding.
- **v0.4 (Obsidian Temple + Layout)** — add obsidian-temple, add layout module, add `/sumo:sidebar [position]`, add `Ctrl+Shift+S` keybinding, add support for bottom/top sidebar positions in the sidebar module, add VT323 + Cinzel font detection, add glow effects.
- **v1.0 (Polish)** — daily-use dogfooding for one week across both machines, fix all issues from `.local/frustrations.md`, finalize README, record VHS demos for each theme.

---

## Testing Decisions

### What makes a good test

- **Tests external behavior, not implementation.** Tests assert "given X input, observable output Y" — never "function called Z internal helpers."
- **Tests failure modes.** Daemon down, network errors, malformed responses, missing files. Real systems fail; tests must cover that.
- **Tests pure data round-trips.** Persistence: write → read should equal input. Theme switching: cycle 4 times → back to start. Memory query: ask for top 5 → get exactly 5 (or fewer with status).
- **Skips visual rendering.** TUI components are visually obvious when broken; integration tests via headless terminals are heavy and slow. Dogfooding catches visual issues much faster.

### Modules with tests in v0.2+

- **theme** — registry contents, cycling logic (forward and forward-from-end-wraps-to-start), persistence round-trip, fallback to default when persisted theme is unknown, subscriber notification on change.
- **layout** — auto-detection rule (test with terminal-size fixtures), override persistence to local-config.json, fallback when local-config doesn't exist, position-cycle keybinding logic.
- **memory** — query against fixture Remnic responses, status when daemon is down, malformed response handling, retry logic (if added), `add` and `forget` round-trips.
- **sync** — `push` happy path with mocked git output, `pull` happy path, conflict detection from git stderr patterns, status parsing for clean / dirty / ahead / behind / conflicted states.
- **footer** — render output for all 5 state values × at least one theme, format consistency, branch-detection edge case (detached HEAD).

### Modules without tests in v0.2

- **voice** — pure data; type-level enforcement is the test. Run vitest typecheck instead.
- **sidebar / splash / working-indicator** — TUI rendering. Visual issues found faster by dogfooding than by integration tests.
- **commands/** — thin wrappers over already-tested modules.
- **keybindings** — registration is trivial; broken bindings are immediately obvious in use.
- **extension** — orchestration glue. If broken, nothing works (smoke-tested by every Pi launch).

### Test framework

**Vitest.** Same framework Pi (the underlying system) uses. Zero-config, fast, no fixture boilerplate. Tests colocated `src/<module>.test.ts`.

```bash
pnpm add -D vitest @vitest/ui
pnpm vitest          # watch mode during dev
pnpm vitest run      # single CI-style pass
pnpm vitest run --coverage   # coverage report
```

`vitest.config.ts` at repo root with minimal config (defaults are fine).

### CI

No CI in v0.2 (manual local verification). GitHub Actions added in v0.3+ to run `vitest run` and `tsc --noEmit` on every push.

---

## Out of Scope

The following are explicitly NOT in v1. Each is a separate v2+ effort if and when actual frustration drives demand.

- **Voice input/output** — talking to SumoCode. Realtime API integration. Mic permissions per OS. Probably v2.
- **Proactive behaviors** — auto-summarize after `git pull`, auto-suggest fix after test failure, etc. Premature without dogfooding data on what proactive feels useful vs annoying.
- **Time-of-day auto-theme switching** — Cathedral by day, Obsidian by night. Conceptually nice; build only if I find myself manually switching at the same times every day.
- **Per-project theme overrides** — different repo, different theme. Wait until I want this for a real reason.
- **User-defined custom themes** — only the three hardcoded themes ship in v1. No theme schema documentation for external authoring. Add when someone (including future-me) actually asks.
- **ACPX-aware persona variants** — different default persona when invoked by OpenClaw vs directly. Pi's TTY detection covers the structural case; persona tuning only matters once I've used the ACPX flow enough to feel friction.
- **Session tree / timeline view** — already covered by Pi's existing branching/forking mechanisms.
- **Custom command palette** — `tomsej/pi-ext`'s `leader-key` (Ctrl+X) is excellent and auto-discovers slash commands. No reason to build a parallel palette.
- **Settings UI** — everything is hardcoded in TypeScript constants and edited as code. Settings UIs are an attractive nuisance for personal projects.
- **Multi-user / team support** — SumoCode is for me. Anyone forking it inherits a Matt-Pocock-style "this is my setup" project, not a configurable shared product.

---

## Further Notes

### Cross-agent visual consistency

SumoCode's Amber CRT theme deliberately mirrors Mission Control v3's existing palette (warm dark brown background, amber phosphor text, IBM Plex Mono + VT323 fonts, 0px border-radius globally). When I switch contexts between SumoCode and Mission Control, the visual language travels with me. The other two themes (Cathedral, Obsidian Temple) are SumoCode-specific identities for moods Mission Control doesn't have.

### Documentation surface

The repository carries five long-form docs that should not all need updating for every change:

- **PLAN.md** — decision log, never deleted, only appended. Source of truth for "why is it this way."
- **PRD.md** (this document) — product spec. Updated for major scope changes.
- **README.md** — short, install + roadmap pointer. Rarely updated.
- **SETUP.md** — new-machine bootstrap. Updated when bootstrap process changes.
- **DEV_LOOP.md** — edit/test/release cycle. Updated when dev process changes.
- **DESIGN.md** — visual design system. Updated when tokens change.

### Companion repos

- `dhruvkelawala/sumocode` (this repo) — public, MIT — the extension code.
- `dhruvkelawala/sumocode-config` (private) — personal config + memory + extensions.

The two repos are independent. Sumocode-config is bootstrapped first on a new machine; it pulls sumocode in via `pi install` automatically.

### Acknowledgments

- **Pi** by Mario Zechner (`@earendil-works/pi-coding-agent`) — the engine.
- **OpenClaw** — the secretary/dispatch layer SumoCode integrates with via ACPX.
- **Remnic** by Joshua Warren — the memory backend.
- **Mission Control v3** — the design language SumoCode inherits from for cross-agent consistency.
- **stitch-kit** by Gabi @ Booplex — Stitch MCP integration that produced our initial design exploration.
- **mattpocock/skills** — `grill-me`, `to-prd`, `to-issues`, `tdd` — the skill suite that drove this PRD's existence.

### Visual references

- `docs/ui/DESIGN.md` — canonical 9-section design system (Cathedral direction baseline).
- `docs/ui/CLAUDE_DESIGN_PROMPT.md` — paste-ready prompt for re-running Claude Design.
- `docs/ui/claude-design/` — current Claude Design HTML+CSS prototype (open `SumoCode Terminal.html`).
- `docs/ui/stitch/cathedral/` — Stitch-generated screens for Cathedral direction.
- `docs/ui/stitch/amber-crt/` — Stitch-generated idle for Amber CRT.
- `docs/ui/stitch/obsidian-temple/` — Stitch-generated idle for Obsidian Temple.

### Decision history

All 14 design decisions from the grilling sessions live in `PLAN.md` under "Decisions Log." That document is the canonical "why" trail; this PRD is the canonical "what."

---

*Generated 2026-04-25 from grilling sessions on 2026-04-24/25 by Zeus, in the Temple of SumoDeus.*
