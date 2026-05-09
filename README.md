<div align="center">

# SumoCode

**a scriptorium for the terminal**

a Pi extension i built so my terminal AI feels personal across machines.

[![mit license](https://img.shields.io/badge/license-MIT-2D211A?style=flat-square)](./LICENSE)
[![version](https://img.shields.io/badge/v0.3.0-B85A22?style=flat-square)](./CHANGELOG.md)
[![pi 0.74](https://img.shields.io/badge/pi-0.74.0-4A6B3A?style=flat-square)](https://github.com/earendil-works/pi)
[![tests](https://img.shields.io/badge/tests-807%20passing-4A6B3A?style=flat-square)](./test)

<br>

<img src="./docs/marketing/02-cathedral-active.png" alt="SumoCode running in Cathedral theme — active scroll/scribe delegation with sidebar visible" width="900">

</div>

---

## what you're looking at

SumoCode is a Pi extension that ships its own terminal renderer. [Pi](https://github.com/earendil-works/pi) keeps the agent loop, the LLM, sessions, MCP, and skills. SumoCode owns every cell that paints — splash, top chrome, footer, sidebar, modals, themes, in-app scrollback, mouse routing. the renderer is called **SumoTUI** and lives in [`src/sumo-tui/`](./src/sumo-tui/); it's a node-native retained renderer with Yoga flex layout, a cell compositor, frame diff, modal layer, and a headless test backend.

three themes ship. cathedral by default. amber CRT when i miss DOS. obsidian temple at night. cycle with `Ctrl+Shift+T`. choice persists across machines.

it's been my daily-drive shell for the last two months.

## theme tour

<table>
<tr>
<td align="center" width="33%">
<img src="./docs/marketing/02-cathedral-active.png" alt="Cathedral theme">
<br><strong>cathedral</strong>
<br><sub>warm walnut chassis, burnt-orange accent, fleur-de-lis bullets, rounded chrome. default.</sub>
</td>
<td align="center" width="33%">
<img src="./docs/marketing/04-amber-crt.png" alt="Amber CRT theme">
<br><strong>amber CRT</strong>
<br><sub>warm dark brown chassis, P3 amber phosphor, double-line ASCII chrome, P1 green / cyan / red phosphor states.</sub>
</td>
<td align="center" width="33%">
<img src="./docs/marketing/05-obsidian-temple.png" alt="Obsidian Temple theme">
<br><strong>obsidian temple</strong>
<br><sub>deep obsidian background, electrum gold + neon cyan + magenta, Egyptian section glyphs.</sub>
</td>
</tr>
</table>

## what makes it personal

<table>
<tr>
<td width="50%" valign="top">

### ❈  memory scriptorium

facts the agent learned about you, organised like a manuscript. six panels (identity, preferences, workflow, projects, system, general). `d` to forget a line, `/` to search, `⎋` to retreat. inline revise is a planned addition; for now use `/sumo:memory forget <id>` + `/sumo:memory add <text>`. the agent reads from the manuscript on every new session.

<sub>open with `/sumo:memory`</sub>

</td>
<td width="50%" valign="top">

### ●  five preattentive states

idle / thinking / tool / approval / learning. each gets a distinct colour drawn from the active theme. you can read the state out of the corner of your eye while your hands are typing.

<sub>set in `src/themes/*.ts`, surfaced in the footer dot + working indicator</sub>

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ▣  owned-shell mode

every cell that paints is mine. retained renderer, in-app scroll, modal layer, mouse routing, OSC 52 selection. Pi is reduced to LLM/tools/sessions through clean adapters; the seam lives in one directory (`src/sumo-tui/pi-compat/`).

<sub>see [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](./docs/SUMO_TUI_PI_PATCH_STRATEGY.md)</sub>

</td>
<td width="50%" valign="top">

### ↻  /sumo:reload

hard-reload the shell while keeping your terminal context. exits with code 100, the launcher loop respawns with `--continue`. iterating on the renderer no longer means losing the session.

<sub>also strips `--resume` and replaces with `--continue`</sub>

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ✾  cathedral approval modal

cathedral-styled gate for dangerous bash commands. patterns are configurable per session — `rm -rf`, `sudo`, `git push --force`, mutating gh CLI calls, plus your own. long commands get capped at 12 visible rows so the modal never overflows the terminal.

<sub>configurable via `ApprovalGateConfig`</sub>

</td>
<td width="50%" valign="top">

### ▦  sidebar with intent

three sections: context (token meter, session cost), MCP (server roster and current state), memory (persisted bullets the agent keeps). 30 columns wide; appears at terminal width 120+. portrait policy hides it deliberately. live MCP health surfacing is on the roadmap once Pi exposes it; today the section reflects the configured server list.

<sub>appears automatically at 120+ columns</sub>

</td>
</tr>
</table>

## under the hood

### SumoTUI — the retained renderer

pi's built-in TUI is a vertical line-concatenation `Container`. no flex layout, no in-app scroll, no mouse routing, no modal layer. ten cathedral elements in, the workarounds — manual padding math for splash centering, footers floating wherever the linear renderer left them, mouse-wheel translating to arrow keys (so the user couldn't scroll chat), kitty keyboard escapes leaking into the shell on signal exit — had stopped scaling.

[**SumoTUI**](./src/sumo-tui/) is the answer. node-native retained renderer that takes over altscreen, owns mouse routing, runs a Yoga flex layout tree, composites cells through a frame-diff, and wraps Pi's own `CustomEditor` as a leaf so autocomplete / IME / kill-ring / undo-stack / history all keep working. it pays for itself in surfaces that pi-tui structurally cannot do: in-app scrollback with sticky-bottom, modal overlays, sidebar dock at width ≥ 120, splash centering that holds at any terminal height, signal-clean cleanup. the full reasoning is in [ADR 0001](./docs/adr/0001-sumo-tui-framework.md).

### the seam — 36 lines of patch

SumoTUI has to insert itself before Pi's `InteractiveMode` is constructed. Pi's public extension API can't reach that high; it composes on top of the existing TUI rather than replacing it. so SumoCode carries a tiny pnpm patch against `@earendil-works/pi-coding-agent`'s `dist/main.js` ([`patches/@earendil-works__pi-coding-agent@0.74.0.patch`](./patches/), 36 lines) that adds:

```js
const useSumoTui = isTruthyEnvFlag(process.env.SUMO_TUI) || parsed.unknownFlags.has("sumo-tui");
const interactiveMode = useSumoTui
  ? await loadSumoInteractiveMode(runtime, interactiveOptions)
  : new InteractiveMode(runtime, interactiveOptions);
```

`loadSumoInteractiveMode` dynamically imports `@dhruvkelawala/sumocode/sumo-interactive-mode` (or `$SUMO_TUI_MODULE` for dev). without `SUMO_TUI=1` set, the patch is a no-op and plain Pi loads. the maintenance contract is documented in [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](./docs/SUMO_TUI_PI_PATCH_STRATEGY.md). the policy: revisit removal when Pi exposes a public `interactiveMode` injection API.

### the kernel

the consolidation epic ground a year of seam-bug churn into six contracts. each is small, each is enforced by tests:

| Contract | What it owns | Code | Doc |
|---|---|---|---|
| **TerminalSessionOwner** | single owner of the altscreen lifecycle, mouse + cursor reporting, signal cleanup, and the stdin/raw-mode lifecycle. split across two files: terminal output ownership in `terminal-controller.ts`, stdin + raw-mode + signal handling in `lifecycle.ts` | [`src/sumo-tui/runtime/terminal-controller.ts`](./src/sumo-tui/runtime/terminal-controller.ts) + [`lifecycle.ts`](./src/sumo-tui/runtime/lifecycle.ts) | (in ADR + audit) |
| **InteractionRegistry** | one place to register keybindings, shortcuts, slash commands, with collision detection. paired with a focus-aware key router that dispatches events to the focused widget | [`src/interaction-registry.ts`](./src/interaction-registry.ts) + [`src/sumo-tui/input/key-router.ts`](./src/sumo-tui/input/key-router.ts) | (in ADR) |
| **Cancellable WorkerRuntime** | jobs that respect Ctrl+C and don't leak across session switches | [`src/sumo-tui/runtime/worker-runtime.ts`](./src/sumo-tui/runtime/worker-runtime.ts) | (in ADR) |
| **Typed render primitives** | `Style`, `Span`, `Line` instead of hand-rolled ANSI; prevents stale-style + cell-width bugs | [`src/sumo-tui/render/primitives.ts`](./src/sumo-tui/render/primitives.ts) | [`SUMO_TUI_RENDER_PRIMITIVES.md`](./docs/SUMO_TUI_RENDER_PRIMITIVES.md) |
| **Headless TestBackend** | retained-renderer logic tested without parsing real PTY bytes | [`src/sumo-tui/testing/test-backend.ts`](./src/sumo-tui/testing/test-backend.ts) | [`SUMO_TUI_TEST_BACKEND.md`](./docs/SUMO_TUI_TEST_BACKEND.md) |
| **Structured TranscriptViewModel** | typed `ChatBlock` (markdown / code / tool / skill / question / delegation) instead of flattened strings | [`src/sumo-tui/transcript/view-model.ts`](./src/sumo-tui/transcript/view-model.ts) | [`SUMO_TUI_TRANSCRIPT_MODEL.md`](./docs/SUMO_TUI_TRANSCRIPT_MODEL.md) |

additionally, the **scriptorium modal chrome** — the lifted-bg overlay shared by Divine Query, Approval, and Memory Scriptorium — is its own contract: [`docs/cathedral/SCRIPTORIUM_CHROME.md`](./docs/cathedral/SCRIPTORIUM_CHROME.md). the typed primitives + the chrome contract together are why the three modals look like the same thing.

### the visual parity contract

the themes feel coherent because three different rendering paths agree, cell for cell, with the same Bible mockups. [`docs/visual/parity/CONTRACT.md`](./docs/visual/parity/CONTRACT.md) defines three lanes:

- **component** — deterministic fixture → ANSI → cell snapshot
- **fixture** — a `TranscriptViewModel` fixture → full-scene ANSI → cell snapshot
- **runtime** — `bin/sumocode.sh` via node-pty → cell snapshot

all three converge through `@xterm/headless` into a per-cell `{ char, fg, bg, bold, dim }` grid. the verifier is **styled-cell diff** (text-level, deterministic) plus a **geometry audit** that classifies each row and bounds it against the spec. PNG diffs exist for human review packs but they aren't the gate.

```bash
pnpm visual:ci
cat docs/visual/out/parity/<scenario>/raw/styled-cell-diff.txt
```

### portrait + sidebar policy

at width ≥ 120 columns, the sidebar docks. below 120, it deliberately disappears and project / branch context moves into the hint row. portrait — the canonical 60 × 100 viewport on the mac mini in portrait orientation — has its own policy: no sidebar, ever, no matter the width. documented in [`docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md`](./docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md).

## reading the source

this is a personal Pi extension, not a clean drop-in. the patch is tiny and well-documented; the renderer is yours to read, fork, lift from. start with [`src/extension.ts`](./src/extension.ts) for the Pi-extension entry point and [`src/sumo-tui/`](./src/sumo-tui/) for the renderer.

if you want to actually run it, [`DEV_LOOP.md`](./DEV_LOOP.md) walks the dev loop and [`SETUP.md`](./SETUP.md) is what i run on a new machine. you'll also need a personal companion config: [`dhruvkelawala/sumocode-config`](https://github.com/dhruvkelawala/sumocode-config) is private, so you'd be writing your own.

## the bigger picture

```
┌──────────────────────────────────────────────────────────┐
│  Pi  ·  @earendil-works/pi-coding-agent@0.74.0           │
│   · LLM abstraction (pi-ai)                              │
│   · agent loop + tools (pi-agent-core)                   │
│   · sessions, compaction, auth, skills, MCP              │
│   · extension API (ctx.ui.*)                             │
└──────────────────────────────────────────────────────────┘
                          ▲
                          │ extension API + 36-line seam patch
                          ▼
┌──────────────────────────────────────────────────────────┐
│  SumoCode  ·  this repo                                  │
│   ┌─ src/sumo-tui/  retained renderer kernel ─────────┐  │
│   │  yoga flex layout · cell compositor · frame diff │  │
│   │  modal layer · mouse routing · OSC 52 selection   │  │
│   └─ headless TestBackend · typed render primitives ──┘  │
│   ┌─ src/themes/    cathedral / amber-CRT / obsidian ─┐  │
│   │  palette + chrome glyphs + working indicator      │  │
│   └─ Ctrl+Shift+T to cycle, persisted via Pi ─────────┘  │
│   ┌─ src/cathedral/, src/memory-editor.ts, etc. ──────┐  │
│   │  cathedral surfaces · memory scriptorium ·        │  │
│   └─ approval modal · divine query · skill pills ─────┘  │
└──────────────────────────────────────────────────────────┘
                          ▲
                          │ symlink into ~/.pi/agent/
                          ▼
┌──────────────────────────────────────────────────────────┐
│  sumocode-config  ·  private, synced across machines     │
│   · persona.md · memory · settings · MCP · extensions    │
└──────────────────────────────────────────────────────────┘
```

the full design trail: [PRD](./docs/prd.md) · [ADR 0001 — build SumoTUI as a retained renderer](./docs/adr/0001-sumo-tui-framework.md) · [Pi patch strategy](./docs/SUMO_TUI_PI_PATCH_STRATEGY.md) · [render primitives contract](./docs/SUMO_TUI_RENDER_PRIMITIVES.md) · [transcript view-model](./docs/SUMO_TUI_TRANSCRIPT_MODEL.md) · [test backend](./docs/SUMO_TUI_TEST_BACKEND.md) · [scriptorium chrome](./docs/cathedral/SCRIPTORIUM_CHROME.md) · [visual parity contract](./docs/visual/parity/CONTRACT.md) · [V2 UX spec](./docs/ui/CATHEDRAL_UX_SPEC_V2.md) · [Pi tool architecture](./docs/PI_TOOL_ARCHITECTURE.md) · [portrait sidebar policy](./docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md).

## credits

* [Mario Zechner](https://github.com/badlogicgames) and the [@earendil-works](https://github.com/earendil-works) team for [Pi](https://github.com/earendil-works/pi). every cell SumoCode paints sits on top of Pi's agent loop, model registry, and extension API. the patch is 36 lines because Pi was already designed to be extended.
* [OpenCode](https://opencode.ai/) for the visual language i love and openly mirror.
* the AI agents that helped me write this — anthropic claude opus, openai codex, deepseek v4, kimi. several thousand commits' worth of pair programming.
* built in london, on a mac mini in portrait orientation, in cmux.

## license

MIT — see [LICENSE](./LICENSE).

<br>

<div align="center">
<sub>made by <a href="https://github.com/dhruvkelawala">@dhruvkelawala</a> · personal project, take whatever's useful</sub>
</div>
