# SumoCode — Setup

Two audiences: **me (the author)** setting up a new machine, and **anyone else** who wants to try this. Read the section that matches you.

---

## 🧢 If you're me (new machine setup)

The "full SumoCode experience" needs both repos: this one (the extension) **plus** the private `sumocode-config` repo (my persona, memory, synced settings/mcp/extensions). Bootstrap the config repo and everything else installs itself.

### Prerequisites

```bash
# install Pi
npm install -g @mariozechner/pi-coding-agent

# system tools
brew install chafa gh tailscale jq
brew install --cask ghostty

# verify
pi --version && gh auth status
```

### One-shot bootstrap

```bash
# Clone the private config repo (GH SSH auth required)
git clone git@github.com:dhruvkelawala/sumocode-config.git ~/sumocode-config
cd ~/sumocode-config

# This symlinks ~/.pi/agent/{settings,mcp,extensions,...} into the repo
# and runs `pi install` for every package in synced settings.json —
# which includes THIS repo (git:github.com/dhruvkelawala/sumocode).
./bootstrap.sh
```

Bootstrap will print a list of env vars you still need to add to `~/.zshrc`. At minimum:

```bash
export STITCH_API_KEY="..."          # stitch MCP — get from stitch.withgoogle.com/settings
export GITHUB_TOKEN="..."            # github MCP — gh auth token works
# Optional (only if you plan to use these providers with API keys instead of OAuth):
export ZAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export GEMINI_API_KEY="..."
```

OAuth providers (`anthropic`, `openai-codex`, `google`, `github-copilot`, etc.) use `pi`'s `/login` flow — no env vars needed.

### Verify

```bash
pi
```

You should see:
1. Zeus splash art for ~3 seconds
2. Working indicator swaps to Zeus-style messages
3. Notification: `SumoCode loaded · v0.1.0`
4. In `/skill` list: 40+ skills including `grill-me`, `to-prd`, `stitch-ideate`
5. Footer: model + cost + branch

### Development clone (only on machines where I want to author changes)

The dev repo lives at `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode` on my Mac mini. If I want to author changes from another machine, clone it there too:

```bash
mkdir -p ~/code && cd ~/code
git clone git@github.com:dhruvkelawala/sumocode.git
# Now edit at ~/code/sumocode — use DEV_LOOP.md for the workflow
```

See [DEV_LOOP.md](./DEV_LOOP.md) for the edit/test/release cycle.

---

## 🤷 If you're anyone else

SumoCode is a personal project — installing it without the private config repo gets you the scaffold (a notification on session start) and not much more. Real features land in v0.2+, driven by my specific taste and memory. You're welcome to fork and personalize.

### Minimum viable install

```bash
npm install -g @mariozechner/pi-coding-agent
pi install git:github.com/dhruvkelawala/sumocode
pi
```

You should see `SumoCode loaded · v0.1.0`. That's all v0.1.0 does. If you want the full experience:

- Read [PLAN.md](./PLAN.md) to understand the scope
- Fork the repo
- Replace `dhruvkelawala/sumocode-config` references with your own private config repo
- Build your own persona, memory, and signals

See [README.md](./README.md) for architecture and roadmap.

---

## Troubleshooting

**"SumoCode loaded" notification never appears**
→ Check `pi list | grep sumocode`. If missing, run `pi install git:github.com/dhruvkelawala/sumocode`. Restart Pi.

**Zeus splash shows placeholder text instead of ASCII art**
→ `brew install chafa`. The splash extension regenerates pixel art from the source image via chafa at install time.

**Bootstrap.sh complains about missing env vars**
→ Add them to `~/.zshrc` and open a new terminal, or `source ~/.zshrc` in the current one. `ZAI_API_KEY` is required if you want to use Zai's GLM models; other keys are optional if you use OAuth providers.

**`pi install` fails with auth errors on a git: source**
→ `gh auth login` (for HTTPS clone) or add your SSH key to GitHub (for SSH clone). Pi follows your system git config.

**Stitch MCP returns auth errors when invoked**
→ `echo $STITCH_API_KEY` in the terminal where you're running Pi. If empty, your `~/.zshrc` isn't being sourced by whatever launches Pi. Open a new terminal and retry.

**MacBook and mini are out of sync**
→ From either machine: `cd ~/sumocode-config && git pull && ./bootstrap.sh`. The bootstrap is idempotent and only touches files that differ.

---

## What lives where

| File | Managed by | Location |
|------|-----------|----------|
| Extension code | this repo | `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode/` (dev) + `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` (installed) |
| Synced config (settings, mcp, extensions, persona) | sumocode-config repo | `~/sumocode-config/`, symlinked to `~/.pi/agent/` |
| Local secrets (auth.json, API keys) | local only, never synced | `~/.pi/agent/auth.json`, `~/.zshrc` |
| Skills (mattpocock, stitch-kit, etc.) | auto-cloned by `pi install` | `~/.pi/agent/git/github.com/…` |
| Sessions | local only | `~/.pi/agent/sessions/` |
| Pre-bootstrap backups | local only | `~/.pi/agent/pre-sumocode-backup/<timestamp>/` |

---

*Last updated: 2026-04-24 · tested on macOS 26, Node 25, Pi 0.73.0*
