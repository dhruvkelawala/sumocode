# SumoCode — Plan

> Living document. Records decisions made during grilling sessions, the
> architectural rationale, and open questions. Superseded by `docs/prd.md`
> for the formal product spec — this stays as the "why we built it this
> way" trail.

---

## Vision

SumoCode is a Pi extension that makes the terminal AI coding experience feel
personal. It layers OpenCode-style visual design (split-pane, streaming
markdown, status footer) onto Pi's engine, and adds what OpenCode doesn't:
**persistent memory across sessions** + **preattentive status signals**
+ **a consistent identity** (persona layer). The goal is that using
SumoCode feels meaningfully different from using stock Pi — it feels like
it knows me.

Non-goals (v1): voice, proactive hooks, multi-user support, themes
configurability. See scope below.

---

## Architecture

### Agent topology (how SumoCode fits in my wider setup)

```
        ┌──────────────────────────┐
        │ Dhruv (me)               │
        └──────────────────────────┘
              ▲              ▲
   telegram   │              │ terminal
              ▼              ▼
   ┌──────────────────┐  ┌──────────────────┐
   │ OpenClaw         │  │ SumoCode (Pi)    │
   │ secretary / VP   │  │ CTO / senior eng │
   │ qmd memory       │  │ Remnic memory    │
   └──────────────────┘  └──────────────────┘
              │              ▲
              │   acpx pi    │
              └──────────────┘
              delegate coding work
```

Two agents, two roles, independent memory:

- **OpenClaw** is the secretary / VP. Lives on telegram. Handles dispatch,
  comms, life admin. Has its own memory (qmd backend, HIPPOCAMPUS, etc.).
- **SumoCode** is the CTO / senior engineer. Lives in the terminal via Pi.
  Does the actual coding work. Has its own memory (Remnic, coding-focused).
- Communication is via **acpx pi** — structured ACP message passing, not
  shared state. OpenClaw delegates work with full context; SumoCode
  reports back results. Same as a real CEO → CTO relationship.

### SumoCode internals

```
Pi (mariozechner/pi-mono)            SumoCode (this repo)
├─ LLM abstraction                   ├─ Persona layer (Zeus, via APPEND_SYSTEM.md)
├─ Agent loop + tools                ├─ Product voice layer (voice.ts)
├─ Sessions, compaction, MCP    ◄──► ├─ Custom footer
├─ Skills, extensions                ├─ Right sidebar overlay (memory + status)
└─ Extension API (ctx.ui.*)          ├─ Remnic client (queries local daemon)
                                     ├─ 5 preattentive status color signals
                                     └─ Slash commands (/sumo:memory, etc.)
                ▲
                │ config + memory sync (private repo)
                ▼
          sumocode-config
          ├─ pi-agent/
          │  ├─ APPEND_SYSTEM.md  (Zeus persona)
          │  ├─ settings.json, mcp.json, extensions/, themes/, prompts/
          └─ memory/
             ├─ identity.md      (cross-project preferences)
             ├─ entities/        (projects, people, tools — Remnic-managed)
             ├─ episodes/        (auto-extracted per-session notes)
             └─ .remnic.json
```

- SumoCode runs **in-process** with Pi via the extension API (`ctx.ui.*`).
- No subprocess, no RPC, no new binary. The `pi` command stays `pi`.
- Config + memory sync via `sumocode-config` (private GH repo) using
  symlinks — single source of truth, identical state on all machines.
- Remnic runs as a **local HTTP daemon** (launchd-managed) pointing at
  the synced `memory/` directory. SumoCode extension talks to it as a
  client.

---

## Scope — v1.c ("Personal")

### In scope

| # | Feature | Surface |
|---|---------|---------|
| 1 | Persona | `APPEND_SYSTEM.md` (Zeus, synced via sumocode-config) |
| 2 | Product voice layer | Neutral, minimal microcopy in extension code (see Voice below) |
| 3 | Custom footer | `ctx.ui.setFooter()` — model · cost · branch · memory-count · status dot |
| 4 | Right sidebar overlay | `ctx.ui.custom({ overlay: true, anchor: "right-center" })`, auto-hides < 120 cols |
| 5 | Memory widget (Remnic-backed) | Sidebar renders top-N facts from local Remnic daemon; synced via `sumocode-config/memory/` |
| 6 | Theme system + 3 themes | **cathedral** (default), **amber-crt**, **obsidian-temple**. Each carries its own 5-state palette, decoration glyphs, and effects. Switchable via `/sumo:theme`. Active choice persists in `sumocode-config/sumocode.json` (synced). |
| 7 | Custom working indicator | `ctx.ui.setWorkingIndicator()` — branded frames, theme-aware |
| 8 | Slash commands | `/sumo:memory [show\|add\|forget\|status]`, `/sumo:theme [name\|list\|picker]`, `/sumo:persona`, `/sumo:sync` |

### Explicitly out of scope (v2 or later)

- ❌ Voice input/output
- ❌ Proactive behaviors (auto-summarize on git-pull, etc.)
- ❌ Custom command palette (tomsej/leader-key covers this today)
- ❌ Time-of-day auto-theme-switching
- ❌ Per-project theme overrides
- ❌ User-defined custom themes (only the 3 hardcoded themes ship in v1)
- ❌ Session tree / timeline view
- ❌ Settings UI — everything hardcoded in `src/`, edited as code

---

## Decisions Log

| # | Question | Choice | Rationale |
|---|----------|--------|-----------|
| Q1 | What artifact is SumoCode? | Pi extension | Inherit Pi's full ecosystem (LLMs, tools, skills, extensions, MCP). Own the UX layer only. |
| Q2 | Who is it for? | Me first, public anyway | Matt Pocock pattern — zero maintainer burden, shareable if someone stumbles on it. |
| Q3 | v1 scope? | V1.c "Personal" | Smallest bundle that actually feels like SumoCode vs "prettier Pi." Memory is the "personal" part. |
| Q4 | Config sync? | GitHub private repo + slash command | Git history, rollback, diffable. Works from anywhere. Handles conflicts sanely. |
| Q5 | Extra packages + MCP? | tomsej/pi-ext (leader-key + tool-pills) + jayshah5696 (todos) + context7 MCP | Fills the 3 real gaps: command palette, todo panel, live library docs. |
| Q6 | MacBook → mini migration? | Bootstrap `sumocode-config` and use it as the channel | Tests the sync architecture with a real payload on day one. |
| Q7 | Scaffold order? | Minimal scaffold now, spec drives code after | 20 min to build the dev loop + avoid later friction when moving from spec to code. |
| Q8 | Persona / voice? | C — two voices separated by domain | Zeus stays for agent output (working well). SumoCode owns a neutral, minimal **product voice** for UI microcopy (notifications, widget labels, status text). Mirrors Siri/Settings pattern. |
| Q9 | Memory backend? | B — [Remnic](https://github.com/joshuaswarren/remnic) standalone from day one | Auto-extracts facts via LLM, lifecycle management (active/validated/stale/archived), hybrid search via qmd (already installed), plain markdown, git-syncable. Independent of OpenClaw's qmd memory — different agents, different stores. |
| Q10 | Preattentive palette + theme system? | 3 themes (cathedral default + first, amber-crt, obsidian-temple) | Started as one-direction palette grilling; expanded after exploring all 3 directions visually via Stitch. Layout/components are theme-agnostic, only ~12 token swaps per theme. Cathedral (warm walnut + burnt orange + IBM Plex Mono) is default — a 19th-century scriptorium. Amber CRT (warm dark brown + amber phosphor) aligns with Mission Control v3 family. Obsidian Temple (deep obsidian + bronze + gold/cyan/magenta neon) is the theatrical sacred-tech mode. Cathedral is first because that's the one that feels like SumoCode's primary identity — the others are mood variants. |
| Q11 | Memory sync conflict strategy? | C — append-only design + sync wrapper | Conflicts designed away: episodes are timestamped immutable files, entity files use append-only dated sections (git's 3-way merge is trivial). Only `identity.md` can genuinely conflict and changes infrequently. `/sumo:sync push` always pulls-then-pushes to minimize conflict windows. The one path with manual intervention (identity.md) is intentional — you should be conscious about identity edits anyway. |
| Q12 | Release cadence? | C — vertical slice per release | Each release is a usable end-to-end SumoCode with growing breadth. v0.2 = minimum useful (cathedral + footer + sidebar + memory + slash commands). v0.3 = theme system + amber-crt. v0.4 = obsidian-temple + glow effects + VT323/Cinzel. v1.0 = polish + dogfooding. ~16 days dev / 6 weeks evenings / 3 weeks focused. Tag only when sure; bias to rc tags for uncertain releases. |
| Q13 | ACPX integration behavior? | A — punt to v2+ | Pi's existing TTY detection makes UI features naturally invisible in non-TTY (`acpx pi`, `pi --print`, `--mode rpc`). No SumoCode-specific code needed. Persona stays Zeus regardless of caller. Memory works in both contexts. v0.2–v1.0 must defensively guard `ctx.ui.*` calls behind `ctx.ui.isTTY` checks. After v1.0, dogfood ACPX flow for 2 weeks, then revisit if real frustrations surface. |
| Q14 | Theme picker UX | D + C + C + bindings | (a) Visual: cycle preview — entire UI is the preview, Tab/→ cycles, Enter confirms, Esc reverts. (b) First-launch: no picker; cathedral default; discovery via README + leader-key. (c) Slash command: both `/sumo:theme` (picker) and `/sumo:theme <name>` (direct). (d) Keybindings: `Ctrl+Shift+T` primary, `Alt+T` fallback — instant-cycle forward, persist immediately, toast "theme: <name>" for 1.5s. ~30 LOC for keybindings. |

### Q8 downstream — voice rules

Product voice (UI microcopy, not LLM output):

- **One word when possible.** `Remembered.` not `Got it, I've saved that!`
- **Confident, never apologetic.** `Can't write there.` not `Sorry, I wasn't able to…`
- **Ambient, stays out of the way.** `thinking` not `Zeus is thinking deeply…`
- **No exclamation marks.**
- **Present tense preferred.**
- **No emoji in copy.** Emoji / dots are preattentive signals (Q10), not text decoration.
- **Lowercase for mode/status, Capitalized for nouns.** `thinking · claude-opus-4-7`

All UI copy lives in `src/voice.ts` — single source of style, enforced by types.

Intentional crossover with Zeus: `Zeus says: that tool needs approval.` The
`Zeus says:` prefix marks intentional voice-switching.

### Q9 downstream — memory architecture

| Decision | Choice |
|----------|--------|
| Memory file location | `sumocode-config/memory/` (synced via git), symlinked to `~/.sumocode/memory/` |
| Daemon management | `@remnic/server` via launchd plist, auto-start on login, local HTTP `127.0.0.1:7749` |
| Extraction model | `anthropic/claude-haiku-4-5` (cheap, same fallback already used by `answer.ts`) |
| Extraction cadence | `session_end` (Remnic default). Manual override: `/sumo:memory extract now` |
| LLM exposure | No memory tool in v1.c. Memory is ambient context via sidebar. Adding a `memory_search` tool is a v0.3 concern. |
| SumoCode extension surface | Sidebar widget (top 5 relevant facts) + `/sumo:memory [show\|add\|forget\|status]` slash commands |

---

## Open Questions — ALL RESOLVED ✅

Grill complete. All 14 questions resolved across 3 grilling sessions on 2026-04-24/25.
No open questions block PRD generation or v0.2 implementation.

### Future grills (post-v1.0, only if real frustrations surface)

- ACPX-aware persona variants (revisit Q13 after dogfooding ACPX flow)
- Time-of-day auto-theme-switching (post-v1)
- Per-project theme overrides (post-v1)
- User-defined custom themes (post-v1)

### Theme System Architecture (locked via Q10)

All 3 themes share the same token shape, only values differ. Layout, components, content, slash commands are 100% theme-agnostic.

```typescript
interface Theme {
  id: "cathedral" | "amber-crt" | "obsidian-temple";
  name: string;
  description: string;
  tokens: {
    background: string;       // base canvas
    surface: string;          // panels
    panel: string;            // sidebar bg
    foreground: string;       // primary text
    foregroundDim: string;    // secondary
    foregroundMuted: string;  // disabled
    accent: string;           // hero color
    accentSecondary: string;  // emphasis
    border: string;           // dividers
  };
  states: {
    idle:     { hex: string; glyph: string; glow: boolean };
    thinking: { hex: string; glyph: string; glow: boolean };
    tool:     { hex: string; glyph: string; glow: boolean };
    approval: { hex: string; glyph: string; glow: boolean };
    learning: { hex: string; glyph: string; glow: boolean };
  };
  decoration: {
    memoryPrefix: string;     // ❫ for cathedral, • for amber, 𓏛 for obsidian
    sectionBorder: string;    // ═ for all
    activeTabFrame: string;   // ║ cartouche
  };
  effects: {
    scanlines: boolean;
    radialGradient: string | false;
    glowOnFocal: boolean;
    chromaticAberration: boolean;
  };
}
```

The 3 theme bundles live at `src/themes/cathedral.ts`, `src/themes/amber-crt.ts`, `src/themes/obsidian-temple.ts`. Default is **cathedral**. First-launch shows a 5-second picker with all 3; Enter accepts default. Active choice persists in `sumocode-config/sumocode.json`.

---

## Next Actions

### Done
- [x] Resolve Q1–Q7 via grilling session 1 (2026-04-24)
- [x] Scaffold `sumocode` repo at `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode`
- [x] Write v0.1.0 hello-world extension
- [x] Publish to `github.com/dhruvkelawala/sumocode` (public)
- [x] Tag v0.1.0
- [x] Wire into `sumocode-config/pi-agent/settings.json` as git source
- [x] Write SETUP.md (new-machine bootstrap) and DEV_LOOP.md (edit/test/release)
- [x] Q8 resolved — voice separation (Zeus = agent, SumoCode = product)
- [x] Q9 resolved — Remnic memory backend
- [x] Q10 resolved — 3 themes (cathedral default + first, amber-crt, obsidian-temple)
- [x] Stitch generated initial mockups for all 3 themes
- [x] DESIGN.md created (canonical 9-section format, ready to upload to Claude Design)
- [x] CLAUDE_DESIGN_PROMPT.md updated with explicit Design System upload steps
- [x] Q11 resolved — append-only memory design + sync wrapper
- [x] Q12 resolved — vertical-slice release cadence (v0.2 → v0.3 → v0.4 → v1.0)
- [x] Q13 resolved — punt ACPX integration to v2+ (defensive TTY guards in v0.2)
- [x] Q14 resolved — cycle preview picker + Ctrl+Shift+T keybinding
- [x] **GRILL COMPLETE** — all 14 questions resolved

### Next
- [x] Stitch generated all 3 themes (cathedral idle, amber-crt idle, obsidian-temple idle)
- [x] Q10 resolved — ship with 3 themes (cathedral default + first)
- [ ] Run `/skill:to-prd` to produce `docs/prd.md`
- [ ] Run `/skill:to-issues` to file v0.2+ issues on this repo
- [ ] v0.2.x implementation:
  - [ ] Install Remnic on mini + MacBook (update `bootstrap.sh`)
  - [ ] Initialize `sumocode-config/memory/` with Remnic config
  - [ ] Add launchd plist for `@remnic/server` daemon
  - [ ] `src/voice.ts` — the copy style module
  - [ ] `src/memory.ts` — Remnic HTTP client
  - [ ] `src/theme.ts` — theme registry + active theme state + persistence
  - [ ] `src/themes/cathedral.ts`, `amber-crt.ts`, `obsidian-temple.ts`
  - [ ] Custom footer + working indicator (theme-aware)
  - [ ] Right sidebar overlay with memory widget (theme-aware)
  - [ ] Slash commands incl. `/sumo:theme [name|list|picker]`
  - [ ] First-launch theme picker (5-second timeout, default cathedral)
- [ ] Dogfood v0.2 for a week, capture frustrations in `.local/frustrations.md`
- [ ] Iterate

---

## Conventions

- **Never** put user-specific state in this repo. That belongs in `sumocode-config`.
- **Always** quote paths with spaces: `/Volumes/SumoDeus NVMe/...` — shell scripts must handle this cleanly.
- **Semver:** major for breaking extension API usage, minor for new features, patch for fixes.
- **Commit messages:** first line is imperative ("add memory widget"), rest explains why.
- **No build step in v0.x:** Pi uses jiti to execute TypeScript directly from `src/`. Keep it that way as long as possible.

---

*Last updated: 2026-04-25 · v0.1.0 scaffold · Q1–Q14 ALL RESOLVED · grill complete · ready for PRD generation*
