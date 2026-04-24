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

```
Pi (mariozechner/pi-mono)            SumoCode (this repo)
├─ LLM abstraction                   ├─ Persona layer
├─ Agent loop + tools                ├─ Custom footer
├─ Sessions, compaction, MCP    ◄──► ├─ Right sidebar overlay
├─ Skills, extensions                ├─ Memory widget
└─ Extension API (ctx.ui.*)          ├─ 5 status color signals
                                     └─ Working indicator
                ▲
                │ config sync (private repo)
                ▼
          sumocode-config
          ├─ persona.md
          ├─ memory.json
          ├─ settings.json
          ├─ mcp.json
          └─ extensions/
```

- SumoCode runs **in-process** with Pi via the extension API (`ctx.ui.*`).
- No subprocess, no RPC, no new binary. The `pi` command stays `pi`.
- Config/memory/preferences sync via `sumocode-config` (private GH repo)
  using symlinks — single source of truth, identical state on all
  machines.

---

## Scope — v1.c ("Personal")

### In scope

| # | Feature | Surface |
|---|---------|---------|
| 1 | Persona | `APPEND_SYSTEM.md` (synced via sumocode-config) |
| 2 | Custom footer | `ctx.ui.setFooter()` — model · cost · branch · memory-count · status dot |
| 3 | Right sidebar overlay | `ctx.ui.custom({ overlay: true, anchor: "right-center" })`, auto-hides < 120 cols |
| 4 | Memory widget | JSON at `~/.sumocode/memory.json`, injected into system prompt, editable via `/sumo:memory` |
| 5 | 5 named preattentive color signals | Defined meanings: idle / thinking / tool-running / needs-approval / learning-write |
| 6 | Custom working indicator | `ctx.ui.setWorkingIndicator()` — branded Zeus/SumoCode frames |
| 7 | Slash commands | `/sumo:memory`, `/sumo:persona`, `/sumo:sync` |

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
| Q5 | Extra packages + MCP? | tomsej/pi-ext (leader-key + tool-pills) + jayshah5696 (todos) + context7 MCP | Fills the 3 real gaps: command palette, todo panel, live library docs. Everything else was duplicated or low-value. |
| Q6 | MacBook → mini migration? | Bootstrap `sumocode-config` and use it as the channel | Tests the sync architecture with a real payload on day one. |
| Q7 | Scaffold order? | Minimal scaffold now, spec drives code after | 20 min to build the dev loop + avoid later friction when moving from spec to code. |

---

## Open Questions (next grilling)

- **Q8 — Persona:** Does SumoCode have its own voice/tone, or does it inherit the existing Zeus-as-senior-dev persona from `APPEND_SYSTEM.md`?
- **Q9 — Memory:** Format of `memory.json`. Injection cadence (every turn, every N turns, or event-triggered). Editing UX.
- **Q10 — Preattentive palette:** The 5 status colors — terminal hex values, named theme tokens, interaction with theme switching.
- **Q11 — Sync edge cases:** What happens if two machines both edit memory.json offline and push simultaneously? Merge strategy for JSON state files.
- **Q12 — Release cadence:** When does v0.2.0 cut? After one feature, one weekend, or one "feels right" threshold?

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

### Next
- [ ] Run `/skill:grill-me` to resolve Q8 (persona)
- [ ] Run `/skill:grill-me` to resolve Q9 (memory format)
- [ ] Run `/skill:grill-me` to resolve Q10 (palette)
- [ ] Run `/skill:to-prd` to produce `docs/prd.md`
- [ ] Use stitch-kit to generate 3 design directions for the sidebar layout
- [ ] Run `/skill:to-issues` to file v0.2+ issues on this repo
- [ ] Implement v0.2.x (persona + footer + working indicator)
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

*Last updated: 2026-04-24 · v0.1.0 scaffold*
