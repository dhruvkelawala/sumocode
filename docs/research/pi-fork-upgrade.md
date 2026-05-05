# Pi fork upgrade procedure

> Active strategy: [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](../SUMO_TUI_PI_PATCH_STRATEGY.md). This file is the step-by-step upgrade runbook.

SumoCode currently pins Pi `0.73.0` plus Dhruv's tiny constructor patch. The patch is carried as a pnpm patch against the published `@mariozechner/pi-coding-agent` package because pnpm's GitHub subdirectory installs pack `packages/coding-agent` without untracked `dist/` output.

## Current activation model

- Runtime flag: `SUMO_TUI=1`
- Optional module override: `SUMO_TUI_MODULE=file:///.../sumo-interactive-mode.js`
- SumoCode wrapper: `bin/sumocode.sh`
- Local package patch: `patches/@mariozechner__pi-coding-agent@0.73.0.patch`
- Patched constructor site: `@mariozechner/pi-coding-agent@0.73.0/dist/main.js` around the interactive-mode construction block

## Upgrade checklist for future Pi bumps

1. Create a scratch copy of the target published package:

   ```bash
   rm -rf /tmp/pi-npm-target
   mkdir /tmp/pi-npm-target
   cd /tmp/pi-npm-target
   npm pack @mariozechner/pi-coding-agent@<version> --silent
   tar -xzf mariozechner-pi-coding-agent-<version>.tgz
   ```

2. Re-apply the minimal constructor patch in `package/dist/main.js`:

   - Find the interactive constructor site near `new InteractiveMode(runtime, ...)`.
   - Replace it with `interactiveOptions`, `useSumoTui`, and `loadSumoInteractiveMode(...)`.
   - Add the `loadSumoInteractiveMode` helper at the end of the file.
   - Keep the default path non-breaking when `SUMO_TUI` is unset.

3. Regenerate SumoCode's pnpm patch:

   ```bash
   cd /tmp/pi-npm-target
   git diff --no-index --no-prefix \
     package/dist/main.js.orig \
     package/dist/main.js \
     > /tmp/pi-main-dist.patch || true
   ```

   Convert the patch headers to `a/dist/main.js` and `b/dist/main.js`, then save as:

   ```text
   patches/@mariozechner__pi-coding-agent@<version>.patch
   ```

4. Update SumoCode `package.json`:

   - `peerDependencies.@mariozechner/pi-coding-agent` -> `~<minor>.0`
   - `peerDependencies.@mariozechner/pi-tui` -> `~<minor>.0`
   - `devDependencies.@mariozechner/pi-coding-agent` -> `<version>`
   - `devDependencies.@mariozechner/pi-ai` -> matching Pi version
   - `devDependencies.@mariozechner/pi-tui` -> matching Pi version
   - `pnpm.patchedDependencies` key/path -> new patch file

5. Install and verify the patch is present:

   ```bash
   pnpm install
   rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@mariozechner/pi-coding-agent/dist/main.js
   ```

6. Run SumoCode verification:

   ```bash
   pnpm test
   pnpm test:integration
   pnpm exec tsc --noEmit && pnpm build
   pnpm visual:ci
   ./scripts/smoke-pi-versions.sh <version>
   ```

7. Manual smoke:

   ```bash
   ./bin/sumocode.sh doctor
   ./bin/sumocode.sh --offline --no-extensions --no-session
   SUMO_TUI=0 ./bin/sumocode.sh --offline --no-extensions --no-session
   ```

   Check splash centering, footer pinning, clean Ctrl+C, scroll, PgUp/PgDn, Ctrl+P, and streaming sticky-bottom.

## Rebase notes

- Never push to `badlogic/pi-mono`.
- Do not open upstream PRs for this fork unless Dhruv explicitly asks.
- If upstream moves the constructor site, update `docs/research/interactive-mode-map.md` with new line citations before patching.
- If Pi adds a public renderer injection API, stop and evaluate ADR Q4:C before carrying the patch forward.
