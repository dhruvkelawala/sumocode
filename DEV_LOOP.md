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

### 2. Test with ephemeral install or SumoCode CLI

Classic extension-only smoke:

```bash
pi -e .
```

Retained SumoTUI smoke (preferred for daily-driver UI work):

```bash
./bin/sumocode.sh
./bin/sumocode.sh .
```

If the package is globally linked, use the `sumocode` bin directly:

```bash
sumocode
sumocode .
```

### Why `-e` is the dev-checkout entry point

`-e <path>` (alias `--extension`) tells Pi: *for this session only, load the extension at this path via jiti*. Both `pi -e .` and the `bin/sumocode.sh` launcher (which internally runs `pi -e ${ROOT_DIR}/src/extension.ts`) use it for the same reason: the dev checkout is not registered in `~/.pi/agent/settings.json`, so without `-e` Pi would start without SumoCode loaded.

Load path matrix:

| How I run it | Where SumoCode is loaded from | `-e` needed? |
|---|---|---|
| `./bin/sumocode.sh` from this checkout | `${ROOT_DIR}/src/extension.ts` | yes — checkout isn't in settings.json |
| `sumocode` linked from a `pi install` | `pi.extensions` field in installed `package.json` | no — Pi resolves via its own loader |
| plain `pi` | only globally-registered extensions | never loads SumoCode unless installed |

What `-e` does NOT do:

- Modify `~/.pi/agent/settings.json`
- Touch the published git-installed version at `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/`
- Need a commit or push

What `-e` DOES do:

- Spin up a temporary Pi with my local code
- Read `src/extension.ts` directly via jiti on each launch
- Let me iterate without polluting my real setup

When I exit Pi, the ephemeral install vanishes. My stable install continues running whatever version is published on GitHub.

### Hot reload: `/sumo:reload`

Pi's built-in `/reload` reloads keybindings, themes, prompts, skills, and extension metadata, but it does **not** re-import a `pi -e` extension's TypeScript graph (jiti caches the modules). To pick up source edits without a Ctrl+C + relaunch, use:

```txt
/sumo:reload
```

Mechanism: `bin/sumocode.sh` runs pi inside a `while :;` loop. The slash-command handler exits pi with code `100`; the loop catches that, re-launches pi with `--continue` appended (so the in-progress session resumes), and the next jiti import reads the fresh source. Any other exit code propagates normally.

This only works when launched through `bin/sumocode.sh` (which exports `SUMOCODE_LAUNCHER`). Run from plain `pi -e .` and `/sumo:reload` falls back to a warning notification — you have to quit + relaunch by hand.

Good mental model: `/sumo:reload` is the dev-loop fast path; restart by hand is the safe fallback when the loop isn't available.

### 3. Verify it works

Launch Pi with ephemeral install or retained SumoCode:

```bash
pi -e .
./bin/sumocode.sh
```

For manual runtime/debug sessions, use diagnostics mode:

```bash
./bin/sumocode.sh -d .
sumocode -d .                    # if globally linked
sumocode diag                    # summarizes /tmp/sumocode-manual.jsonl
sumocode doctor                  # checks Pi patch/module/diagnostics health
```

Expected signals on a healthy boot:
- Splash centered with version line `SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE`
- Sidebar paints in landscape (terminal width ≥ 120 cols)
- Footer dot reads `● READY` in the active theme's idle colour

For a feature change, verify the specific surface I just touched.

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
{ "version": "0.3.1" }
```

And update `SPLASH_VERSION_LINE` in `src/footer.ts` so the splash matches. The bible mockup version line in `scripts/gen-bible-element-3.mjs` mirrors it; bump that too if the doc is part of the release.

Semver convention for SumoCode:
- **MAJOR** — breaking extension API usage (something crashes if downgraded)
- **MINOR** — new feature lands (footer added, memory widget lands, etc.)
- **PATCH** — bug fix or small polish

### 2. Commit + tag

```bash
git commit -am "release: v0.3.1"
git tag v0.3.1
```

### 3. Push

```bash
git push && git push --tags
```

GitHub now shows the new release. Installed machines still on the previous tag until they `pi update`.

### 4. Pull on each machine

```bash
pi update git:github.com/dhruvkelawala/sumocode
```

This refreshes `~/.pi/agent/git/github.com/dhruvkelawala/sumocode/` from the new `main` tip. Restart Pi to load the new version.

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
- Missing peer dep → ensure `@earendil-works/pi-coding-agent` exports the types I'm using
- Import path typo

### The extension loads but my UI changes don't render

`ctx.ui.*` calls must happen inside an event handler (`session_start`, `message_start`, etc.). If I'm calling them at module top-level, they fire before Pi's TUI exists and get silently dropped.

### Ephemeral install cache is stuck on old code

jiti caches every module it transpiles, so source edits don't show up inside the running session. Two ways to refresh:

```txt
/sumo:reload
```

Fastest path — only works when launched via `bin/sumocode.sh` / `sumocode`. Re-execs pi inside the launcher loop and resumes the session. See "Hot reload: `/sumo:reload`" above.

```bash
# Ctrl+D or /exit to quit Pi
pi -e .
```

Fallback when running plain `pi -e .` or when the reload signal is unavailable. Loses session unless you pass `--continue`.

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

**Pi-bundled deps** (things Pi itself ships, like `@earendil-works/pi-tui`): go into `peerDependencies` with `"*"` as the version. Do NOT add them to `dependencies` — that creates duplicate module instances and breaks things.

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

## What's in the dev loop now

- **Tests.** 821 unit tests via vitest, 32 integration tests via node-pty. Run `pnpm test` and `pnpm test:integration`. Both gated on the same TypeScript graph that ships.
- **Visual harness.** `pnpm visual:ci` for the V2 parity contract; `pnpm render:bible` regenerates the mockup PNGs.
- **Perf snapshot.** `pnpm perf:startup` produces a markdown report under `docs/perf/`.
- **Scribe diff review.** `/sumo:review` runs an in-session reviewer (default `openai-codex/gpt-5.3-codex`) on the current branch diff. Repeat until GREEN before merging.
- **CHANGELOG.** Keep-a-Changelog format; one section per release, retroactively documented for v0.1.0 → v0.2.0 → v0.3.0.
- **Pi version smoke.** `scripts/smoke-pi-versions.sh` runs `pi --version` against the pinned + adjacent Pi versions to catch the seam patch breaking on a Pi bump before a real session does.

## What's NOT in the dev loop yet

- **Public PR CI.** A GitHub Actions workflow that runs `pnpm test + pnpm exec tsc --noEmit` on every PR. Stub workflows for visual + perf live under `.github/workflows/`; the typecheck/test gate is on the v0.3.x followup list.
- **Lint.** Project leans on `tsc` strict and the scribe rather than a separate linter. If/when biome gets adopted, point it at `src/`.

These are intentionally deferred. Add them when friction actually shows up.

---

*Last updated: 2026-05-08 · v0.3.0 · Pi 0.74.0 (`@earendil-works/pi-coding-agent`)*
