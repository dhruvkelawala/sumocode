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
| 6 | 5 named preattentive color signals | Defined meanings: idle / thinking / tool-running / needs-approval / learning-write |
| 7 | Custom working indicator | `ctx.ui.setWorkingIndicator()` — branded frames |
| 8 | Slash commands | `/sumo:memory [show\|add\|forget\|status]`, `/sumo:persona`, `/sumo:sync` |

### Explicitly out of scope (v2 or later)

- ❌ Voice input/output
- ❌ Proactive behaviors (auto-summarize on git-pull, etc.)
- ❌ Custom command palette (tomsej/leader-key covers this today)
- ❌ Multi-theme configurability (one theme, my taste)
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

## Open Questions (next grilling)

- **Q10 — Preattentive palette:** The 5 status colors — terminal hex values, named theme tokens, interaction with theme switching.
- **Q11 — Sync edge cases:** Conflict strategy when both machines extract memory offline and push simultaneously. Probably negligible for a one-user tool but worth thinking through.
- **Q12 — Release cadence:** When does v0.2.0 cut? After one feature, one weekend, or one "feels right" threshold?
- **Q13 — ACPX integration:** What does the OpenClaw → SumoCode handoff look like in practice? Does SumoCode need any ACP-specific behavior (e.g., different default persona when invoked via ACPX vs. direct)? Separate grilling after v0.2+.

---

## Next Actions

### Done
- [x] Resolve Q1–Q7 via grilling session
- [x] Scaffold `sumocode` repo at `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode`
- [x] Write v0.1.0 hello-world extension
- [x] Publish to `github.com/dhruvkelawala/sumocode` (public)
- [x] Tag v0.1.0
- [x] Wire into `sumocode-config/pi-agent/settings.json` as git source
- [x] Write SETUP.md (new-machine bootstrap) and DEV_LOOP.md (edit/test/release)
- [x] Q8 resolved — voice separation (Zeus = agent, SumoCode = product)
- [x] Q9 resolved — Remnic memory backend

### Next
- [ ] Resolve Q10 (palette) via grilling
- [ ] Run `/skill:to-prd` to produce `docs/prd.md`
- [ ] Use stitch-kit to generate 3 design directions for the sidebar layout
- [ ] Run `/skill:to-issues` to file v0.2+ issues on this repo
- [ ] v0.2.x implementation:
  - [ ] Install Remnic on mini + MacBook (update `bootstrap.sh`)
  - [ ] Initialize `sumocode-config/memory/` with Remnic config
  - [ ] Add launchd plist for `@remnic/server` daemon
  - [ ] `src/voice.ts` — the copy style module
  - [ ] `src/memory.ts` — Remnic HTTP client
  - [ ] Custom footer + working indicator
  - [ ] Right sidebar overlay with memory widget
  - [ ] Slash commands
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

*Last updated: 2026-04-24 · v0.1.0 scaffold · Q8+Q9 resolved*
