# Pi fork upgrade procedure

Phase 4b pins SumoCode to Pi `0.70.2` plus Dhruv's tiny fork patch on `dhruvkelawala/pi-mono` branch `sumocode/0.70.2-fork`.

The fork patch lives in upstream Pi source at `packages/coding-agent/src/main.ts` and is mirrored into SumoCode's pnpm patch file because pnpm's GitHub subdirectory install packs `packages/coding-agent` without `dist/`.

## Current activation model

- Runtime flag: `SUMO_TUI=1`
- Optional module override: `SUMO_TUI_MODULE=file:///.../sumo-interactive-mode.js`
- SumoCode wrapper: `bin/sumocode.sh`
- Pi fork branch: `https://github.com/dhruvkelawala/pi-mono/tree/sumocode/0.70.2-fork`
- Fork commit for Phase 4b: `13568394`
- Local package patch: `patches/@mariozechner__pi-coding-agent@0.70.2.patch`

## Upgrade checklist for Pi 0.71+

1. Create a new fork branch from the upstream release tag:

   ```bash
   cd /tmp/pi-mono-fork
   git fetch upstream --tags
   git checkout v0.71.0
   git checkout -b sumocode/0.71.0-fork
   ```

2. Re-apply the minimal constructor patch in `packages/coding-agent/src/main.ts`:

   - Find the interactive constructor site near `new InteractiveMode(runtime, ...)`.
   - Replace it with `interactiveOptions`, `useSumoTui`, and `loadSumoInteractiveMode(...)`.
   - Keep the diff under 30 changed lines.
   - Keep the default path non-breaking when `SUMO_TUI` is unset.

3. Build and check the fork:

   ```bash
   npm install
   npm run build
   npm run check
   cd packages/coding-agent && npm run build
   ```

4. Run upstream tests and compare with a clean upstream tag run:

   ```bash
   ./test.sh
   ```

   If upstream release tests already fail before the patch, document the exact failures in the PR body and ensure the fork does not add new failures.

5. Commit and push the fork branch:

   ```bash
   git add packages/coding-agent/src/main.ts
   git commit -m "feat(coding-agent): load SumoInteractiveMode on demand"
   git push -u origin sumocode/0.71.0-fork
   git log --oneline -1
   ```

6. Regenerate SumoCode's pnpm patch from the published package for the new Pi version:

   ```bash
   rm -rf /tmp/pi-npm-orig
   mkdir /tmp/pi-npm-orig
   cd /tmp/pi-npm-orig
   npm pack @mariozechner/pi-coding-agent@0.71.0 --silent
   tar -xzf mariozechner-pi-coding-agent-0.71.0.tgz
   git diff --no-index --no-prefix \
     package/dist/main.js \
     /tmp/pi-mono-fork/packages/coding-agent/dist/main.js \
     > /tmp/pi-main-dist.patch || true
   ```

   Convert the patch headers to `a/dist/main.js` and `b/dist/main.js`, then save as:

   ```text
   patches/@mariozechner__pi-coding-agent@0.71.0.patch
   ```

7. Update SumoCode `package.json`:

   - `devDependencies.@mariozechner/pi-coding-agent` -> `0.71.0`
   - `devDependencies.@mariozechner/pi-ai` -> matching Pi version
   - `devDependencies.@mariozechner/pi-tui` -> matching Pi version
   - `pnpm.patchedDependencies` key/path -> new patch file

8. Install and verify the patch is present:

   ```bash
   pnpm install
   rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@mariozechner/pi-coding-agent/dist/main.js
   ```

9. Run SumoCode verification:

   ```bash
   pnpm test
   pnpm test:integration
   pnpm exec tsc --noEmit
   ./scripts/smoke-pi-versions.sh 0.71.0
   ```

10. Visual smoke:

    ```bash
    vhs docs/visual/sumo-tui-flex-splash.tape
    ./bin/sumocode.sh
    ```

    Check splash centering, footer pinning, clean Ctrl+C, scroll, PgUp/PgDn, Ctrl+P, and streaming sticky-bottom.

## Rebase notes

- Never push to `badlogic/pi-mono`.
- Do not open upstream PRs for this fork.
- Keep the fork branch on Dhruv's account.
- If upstream moves the constructor site, update `docs/research/interactive-mode-map.md` with new line citations before patching.
- If Pi adds a public renderer injection API, stop and evaluate ADR Q4:C before carrying the fork forward.
