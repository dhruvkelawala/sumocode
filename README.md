<div align="center">

# SumoCode

**a scriptorium for the terminal**

a Pi extension i built so my terminal AI feels personal across machines.

[![mit license](https://img.shields.io/badge/license-MIT-2D211A?style=flat-square)](./LICENSE)
[![version](https://img.shields.io/badge/v0.3.0-B85A22?style=flat-square)](./CHANGELOG.md)
[![pi 0.74](https://img.shields.io/badge/pi-0.74.0-4A6B3A?style=flat-square)](https://github.com/earendil-works/pi)
[![tests](https://img.shields.io/badge/tests-821%20passing-4A6B3A?style=flat-square)](./test)

<br>

<img src="./docs/marketing/02-cathedral-active.png" alt="SumoCode running in Cathedral theme — active scroll/scribe delegation with sidebar visible" width="900">

</div>

---

## what you're looking at

SumoCode is a Pi extension. it owns the experience layer — splash, top chrome, footer, sidebar, modals, themes, persistent memory across sessions. [Pi](https://github.com/earendil-works/pi) keeps the agent loop, the LLM, sessions, MCP, skills.

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

facts the agent learned about you, edited like a manuscript. six panels (identity, preferences, workflow, projects, system, general). `e` to revise a line, `d` to forget. groups by topic, search inline. the agent reads from it on every new session.

<sub>open with `Ctrl+M` or `/sumo:memory`</sub>

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

three sections: context (token meter, session cost), MCP (live status dots per server), memory (persisted bullets the agent keeps). 30 columns wide; appears at terminal width 120+. portrait policy hides it deliberately.

<sub>position cycles with `Ctrl+Shift+S`</sub>

</td>
</tr>
</table>

## reading the source

this is a personal Pi extension. it runs in my fork of Pi with a small private patch (`patches/@earendil-works__pi-coding-agent@0.74.0.patch`, 36 lines) that lets SumoCode own the root TUI. the package isn't designed to drop into your machine clean — but the source is yours to read, fork, and lift from. the patch is small and well-documented.

if you want to actually run it, [`DEV_LOOP.md`](./DEV_LOOP.md) walks the dev loop and [`SETUP.md`](./SETUP.md) is what i run on a new machine. you'll need the public companion config too: [`dhruvkelawala/sumocode-config`](https://github.com/dhruvkelawala/sumocode-config) is private and personal, so you'd be writing your own.

## how it's built

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
│   · retained terminal renderer (yoga flex layout)        │
│   · cathedral / amber CRT / obsidian themes              │
│   · memory scriptorium                                   │
│   · approval modal · divine query · skill pills          │
│   · cell-precise selection + OSC 52 auto-copy            │
│   · 5 preattentive status states + working indicator     │
└──────────────────────────────────────────────────────────┘
                          ▲
                          │ symlink into ~/.pi/agent/
                          ▼
┌──────────────────────────────────────────────────────────┐
│  sumocode-config  ·  private, synced across machines     │
│   · persona.md · memory · settings · MCP · extensions    │
└──────────────────────────────────────────────────────────┘
```

the design history lives in [`docs/prd.md`](./docs/prd.md) (PRD), [`docs/adr/0001-sumo-tui-framework.md`](./docs/adr/0001-sumo-tui-framework.md) (the retained-renderer ADR), and [`docs/ui/CATHEDRAL_UX_SPEC_V2.md`](./docs/ui/CATHEDRAL_UX_SPEC_V2.md) (the visual canon).

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
