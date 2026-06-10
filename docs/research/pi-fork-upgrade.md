# Pi fork upgrade procedure

> Active strategy: [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](../SUMO_TUI_PI_PATCH_STRATEGY.md). This file is the step-by-step upgrade runbook.

SumoCode currently pins Pi `0.79.1` plus Dhruv's tiny constructor patch. Pi `0.79.x` requires Node `>=22.19.0`, so SumoCode's `engines.node` tracks that floor. The patch is carried as a pnpm patch against the published `@earendil-works/pi-coding-agent` package because pnpm's GitHub subdirectory installs pack `packages/coding-agent` without untracked `dist/` output.

## Current activation model

- Runtime flag: `SUMO_TUI=1`
- Optional module override: `SUMO_TUI_MODULE=file:///.../sumo-interactive-mode.js`
- SumoCode wrapper: `bin/sumocode.sh`
- Local package patch: `patches/@earendil-works__pi-coding-agent@0.79.1.patch`
- Patched constructor site: `@earendil-works/pi-coding-agent@0.79.1/dist/main.js` around the interactive-mode construction block

## Upgrade checklist for future Pi bumps

1. Create a scratch copy of the target published package:

   ```bash
   rm -rf /tmp/pi-npm-target
   mkdir /tmp/pi-npm-target
   cd /tmp/pi-npm-target
   npm pack @earendil-works/pi-coding-agent@<version> --silent
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
   patches/@earendil-works__pi-coding-agent@<version>.patch
   ```

4. Update SumoCode `package.json`:

   - `peerDependencies.@earendil-works/pi-ai` -> `~<minor>.0`
   - `peerDependencies.@earendil-works/pi-coding-agent` -> `~<minor>.0`
   - `peerDependencies.@earendil-works/pi-tui` -> `~<minor>.0`
   - `devDependencies.@earendil-works/pi-coding-agent` -> `<version>`
   - `devDependencies.@earendil-works/pi-ai` -> matching Pi version
   - `devDependencies.@earendil-works/pi-tui` -> matching Pi version
   - `engines.node` -> Pi's published Node floor when it changes
   - `pnpm.patchedDependencies` key/path -> new patch file

5. Install and verify the patch is present:

   ```bash
   pnpm install
   rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@earendil-works/pi-coding-agent/dist/main.js
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
- If upstream moves the constructor site, update the patch hunks at `patches/@earendil-works__pi-coding-agent@<version>.patch` to match the new line offsets, and re-run the smoke matrix in `scripts/smoke-pi-versions.sh`.
- If Pi adds a public renderer injection API, stop and evaluate ADR Q4:C before carrying the patch forward.
