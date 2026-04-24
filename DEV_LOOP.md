# SumoCode — Dev Loop

How I edit, test, and release SumoCode. This is the workflow I actually use, not generic advice.

---

## Where the repo lives

**Dev repo (authoring):** `/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode/`

**Installed version (consumed by Pi):** `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` (clone managed by `pi install`)

These are two different directories on purpose:

- The **dev repo** on the NVMe is where I make changes — fast local filesystem, owned by me, unaffected by `pi update`.
- The **installed clone** is what Pi actually loads. It's kept in sync with the published `main` branch on GitHub via `pi install` / `pi update`. I never edit this directory directly.

---

## The inner loop (edit → test → commit)

### 1. Edit at the dev repo

```bash
cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode"
# open src/extension.ts or wherever the change lives
```

### 2. Test with ephemeral install

```bash
pi -e .
```

`-e` (or `--extension`) installs the extension **for this Pi session only**. It does NOT:

- Modify `~/.pi/agent/settings.json`
- Touch the published git-installed version at `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/`
- Need a commit or push

It DOES:

- Spin up a temporary Pi with my local code
- Hot-reload changes when I restart Pi (the next `pi -e .` picks up edits)
- Let me iterate without polluting my real setup

When I exit Pi, the ephemeral install vanishes. My stable install continues running whatever version is published on GitHub.

### 3. Verify it works

Launch Pi with ephemeral install:

```bash
pi -e .
```

Expected signals for v0.1.0:
- Notification: `SumoCode loaded · v0.1.0`
- No errors in the footer or on startup

For v0.2+ features, verify the specific things I just changed.

### 4. Commit to the dev repo

```bash
cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode"
git add -A
git commit -m "feat: add custom footer with memory-count indicator"
```

Commit messages use conventional-ish prefixes (`feat:`, `fix:`, `refactor:`, `chore:`) — first line imperative, rest explains why. See `.github/commit-style.md` (not yet written; see Q12 in PLAN.md).

### 5. Push to main (ongoing dev, not released)

```bash
git push
```

Pushing to `main` does NOT update installed machines. Pi machines pull from tagged releases via `pi update`, not raw `main`. So I can have work-in-progress commits on `main` without breaking my mini or MacBook.

---

## The outer loop (release → propagate)

When a set of commits is ready to go live on all machines:

### 1. Bump version

Edit `package.json`:

```json
{ "version": "0.2.0" }
```

And update `VERSION` const in `src/extension.ts` if the notification needs to reflect it.

Semver convention for SumoCode:
- **MAJOR** — breaking extension API usage (something crashes if downgraded)
- **MINOR** — new feature lands (footer added, memory widget lands, etc.)
- **PATCH** — bug fix or small polish

### 2. Commit + tag

```bash
git commit -am "release: v0.2.0"
git tag v0.2.0
```

### 3. Push

```bash
git push && git push --tags
```

GitHub now shows the v0.2.0 release. Installed machines still on v0.1.0.

### 4. Pull on each machine

```bash
pi update git:github.com/dhruvkelawala/sumocode
```

This refreshes `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` from the new `main` tip (which is now at v0.2.0). Restart Pi to load the new version.

Do this on both mini and MacBook. Since `sumocode` is in `sumocode-config`'s synced `settings.json`, no config changes are needed — it's just a package update.

---

## Debugging

### Pi loads my extension but nothing happens

Check the extension registered:

```bash
pi -p --no-tools "List all loaded extensions. Print one per line, name only."
```

If `sumocode` isn't listed: something errored during load. Run:

```bash
PI_LOG_LEVEL=debug pi 2>&1 | grep -i "sumocode\|extension.*load"
```

Common failures:
- Syntax error in `src/extension.ts` → check TS errors with `pnpm tsc --noEmit` or equivalent
- Missing peer dep → ensure `@mariozechner/pi-coding-agent` exports the types I'm using
- Import path typo

### The extension loads but my UI changes don't render

`ctx.ui.*` calls must happen inside an event handler (`session_start`, `message_start`, etc.). If I'm calling them at module top-level, they fire before Pi's TUI exists and get silently dropped.

### Ephemeral install cache is stuck on old code

Pi caches module resolution. Kill the ephemeral Pi and relaunch:

```bash
# Ctrl+D or /exit to quit Pi
pi -e .
```

### Need to see what Pi actually has for the extension

```bash
ls -la "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode/src/"
# Then compare to:
ls -la ~/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/
```

If the installed version is stale, `pi update git:github.com/dhruvkelawala/sumocode`.

---

## Common tasks

### Add a new extension file

1. Create `src/my-feature.ts`
2. Add it to `package.json` under `"pi": { "extensions": [...] }`:
   ```json
   "pi": {
     "extensions": ["src/extension.ts", "src/my-feature.ts"]
   }
   ```
3. Test with `pi -e .`

### Add a dependency

**Runtime deps** (things SumoCode uses at runtime, like a date library): go into `dependencies` in `package.json`.

**Pi-bundled deps** (things Pi itself ships, like `@mariozechner/pi-tui`): go into `peerDependencies` with `"*"` as the version. Do NOT add them to `dependencies` — that creates duplicate module instances and breaks things.

### Test on MacBook before releasing

Don't. That's what tagged releases are for. Keep the mini as the dev machine, MacBook as a consumer. If something's broken on MacBook but not mini, it's likely an environment diff worth investigating, not a dev/test issue.

### Emergency rollback

On any machine:

```bash
pi update git:github.com/dhruvkelawala/sumocode@v0.1.0
```

That pins to the exact tag. Restart Pi. To go back to latest: `pi update git:github.com/dhruvkelawala/sumocode` (no ref).

---

## Integration with sumocode-config

Changes to the `sumocode` extension (this repo) are released via git tags.

Changes to **personal config** (persona, memory, settings tweaks, new MCP servers, new packages) land in `sumocode-config` and sync via `git push` / `git pull` — no version tagging needed, no `pi install` needed, just `bootstrap.sh` if symlinks need refreshing.

Rule of thumb:
- Editing `.ts` files in this repo → tag and release
- Editing `settings.json` / `mcp.json` / `persona.md` in sumocode-config → just commit and push

---

## What's NOT in the dev loop yet

- Tests. No test harness exists yet. If/when extensions grow complex enough to warrant testing, add `vitest` and point it at Pi's `VirtualTerminal` for TUI tests. Not worth it at v0.1–v0.3.
- CI. No GitHub Actions yet. Might add a lint + typecheck workflow at v0.3+.
- Changelog file. Commit messages + GitHub Releases are enough at this scale.
- Lint. `oxlint` or `biome` would be nice eventually. Not worth setup time at v0.1.

These are intentionally deferred. Add them when friction actually shows up, not before.

---

*Last updated: 2026-04-24 · v0.1.0*
