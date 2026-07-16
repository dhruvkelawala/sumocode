# Pi upgrade procedure

> Active strategy: SumoCode uses the RPC host for interactive runtime ownership. The old private Pi constructor patch is retired; see `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` for the historical note.

SumoCode currently pins Pi `0.79.1`. Pi `0.79.x` requires Node `>=22.19.0`, so SumoCode's `engines.node` tracks that floor.

## Current activation model

- Interactive foreground: `bin/sumocode.sh` -> `sumo-rpc-host.js` -> Pi `--mode rpc -e src/extension.ts`
- Direct Pi bypass: `--print`, `-p`, explicit `--mode`, `--mode=*`, non-TTY stdout, and diagnostic `--no-sumo-tui`
- Runtime env: the launcher sets `SUMO_RPC=1` only for the RPC host path and `SUMO_TUI=0` for both paths

## Upgrade Checklist For Future Pi Bumps

1. Inspect the candidate Pi package and RPC contract.

   ```bash
   npm pack @earendil-works/pi-coding-agent@<version> --silent
   diff -u <old-rpc-types.d.ts> <new-rpc-types.d.ts>
   ```

2. Update SumoCode `package.json`:

   - `peerDependencies.@earendil-works/pi-ai` -> `~<minor>.0`
   - `peerDependencies.@earendil-works/pi-coding-agent` -> `~<minor>.0`
   - `peerDependencies.@earendil-works/pi-tui` -> `~<minor>.0`
   - `devDependencies.@earendil-works/pi-coding-agent` -> `<version>`
   - `devDependencies.@earendil-works/pi-ai` -> matching Pi version
   - `devDependencies.@earendil-works/pi-tui` -> matching Pi version
   - `engines.node` -> Pi's published Node floor when it changes

3. Install and verify package resolution.

   ```bash
   pnpm install
   ./bin/sumocode.sh doctor
   ```

4. Re-check SumoCode's RPC assumptions:

   ```bash
   rg "BUILTIN|slash" src/sumo-tui/rpc src
   pnpm vitest run src/sumo-tui/rpc/runtime.test.ts test/integration/rpc-host-shell.test.ts
   ```

5. Run SumoCode verification:

   ```bash
   pnpm test
   pnpm test:integration
   pnpm exec tsc --noEmit && pnpm build
   pnpm visual:ci
   ./scripts/smoke-pi-versions.sh <version>
   ```

6. Manual smoke:

   ```bash
   ./bin/sumocode.sh --offline --no-extensions --no-session --approve
   ./bin/sumocode.sh --offline --no-extensions --no-session --print hello
   ./bin/sumocode.sh --mode rpc --offline --no-extensions --no-session
   ./bin/sumocode.sh --no-sumo-tui --offline --no-extensions --no-session --approve
   ```

   Check RPC boot, editor input, clean Ctrl+C, scroll, approval gating, slash controls, and direct-Pi bypass behavior.

## Rebase Notes

- Never push to `badlogic/pi-mono`.
- Do not open upstream PRs for this fork unless Dhruv explicitly asks.
- If Pi changes RPC message shape, update SumoCode's RPC client/state/transcript mapping and rerun the full gate.
- Do not reintroduce private constructor patches as a Pi bump shortcut.
