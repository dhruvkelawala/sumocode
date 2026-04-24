<div align="center">

# SumoCode

**A Pi extension that makes your terminal AI coding experience feel personal.**

OpenCode visual language · persistent memory across sessions · preattentive status signals · built on [@mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

</div>

---

> **Status:** v0.1.0 — scaffold. Hello-world extension only. Real features land as we resolve the decision tree in [PLAN.md](./PLAN.md).

## What it is

SumoCode is a personal fork of the "OpenCode terminal UI" idea, as a Pi extension — not a separate binary. Pi handles agents, tools, LLMs, sessions, skills, MCP. SumoCode owns the **experience layer**: sidebar, footer, memory widget, status colors, persona.

Paired with a private `sumocode-config` repo that syncs settings/extensions/memory across my machines. Both repos together = my terminal AI stays the same whether I'm on the Mac mini or the MacBook.

## Architecture

```
┌──────────────────────────────────────────────┐
│ Pi (the engine)                              │
│  - LLM abstraction (pi-ai)                   │
│  - Agent loop + tools (pi-agent-core)        │
│  - Sessions, compaction, auth, MCP           │
│  - Extension API (ctx.ui.*)                  │
└──────────────────────────────────────────────┘
                    ▲
                    │ extension API
                    ▼
┌──────────────────────────────────────────────┐
│ SumoCode (this repo)                         │
│  - Persona layer                             │
│  - Custom footer (model/cost/branch/memory)  │
│  - Right sidebar overlay                     │
│  - Memory widget (cross-session facts)       │
│  - 5 preattentive status color signals       │
│  - Custom working indicator frames           │
└──────────────────────────────────────────────┘

 Private, synced:
   github.com/dhruvkelawala/sumocode-config
     ↳ persona.md, memory.json, settings, mcp, extensions
```

## Install

```bash
pi install git:github.com/dhruvkelawala/sumocode
```

Then reload Pi. You should see the notification: `SumoCode loaded · v0.1.0`.

## Roadmap

See **[PLAN.md](./PLAN.md)** for decision log, v1.c scope, and open questions.

High level:
- **v0.1.0** (today): scaffold + notification
- **v0.2.x**: persona + custom footer + working indicator
- **v0.3.x**: right sidebar overlay + memory widget
- **v0.4.x**: 5 named preattentive color signals locked in
- **v1.0.0**: all of V1.c "Personal" shipped, used daily, dogfooded

## Development

```bash
cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode"
pi -e .          # ephemeral install — doesn't touch settings.json
# edit src/extension.ts
# reload pi to see changes
```

When ready to release:

```bash
# bump version in package.json
git commit -am "v0.x.y: <what changed>"
git tag v0.x.y
git push && git push --tags

# both machines pick it up:
pi update git:github.com/dhruvkelawala/sumocode
```

## License

MIT — see [LICENSE](./LICENSE). Personal project; take whatever's useful.
