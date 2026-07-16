# SumoTUI Pi Patch Strategy

**Status:** retired on 2026-07-02 by Plan 014
**Parent:** #98 SumoTUI consolidation
**Related:** `docs/research/pi-rpc-migration.md`, `docs/research/pi-fork-upgrade.md`

## Decision

SumoCode no longer carries a private Pi constructor patch. Interactive TTY launches use the SumoCode RPC host (`sumo-rpc-host.js`), which starts Pi with `--mode rpc -e src/extension.ts` and renders the foreground UI in the host process.

The old retained fallback was removed with its loader, patch files, package export, and `pnpm.patchedDependencies` metadata. The retired markers were `SUMO_LEGACY`, `SUMO_TUI_MODULE`, `loadSumoInteractiveMode`, `sumo-interactive-mode.js`, and `patches/@earendil-works__pi-coding-agent@*.patch`.

## Current Launcher Contract

`bin/sumocode.sh` has two runtime paths:

- Interactive TTY launches with no explicit Pi non-interactive mode execute `node sumo-rpc-host.js` with `SUMO_RPC=1` and `SUMO_TUI=0`.
- Non-interactive Pi behavior still bypasses the foreground host for `--print`, `-p`, explicit `--mode`, `--mode=*`, non-TTY stdout, and the diagnostic `--no-sumo-tui` flag. Those launches execute Pi directly with `-e src/extension.ts` and `SUMO_TUI=0`.

## Pi Bump Checklist

For Pi version changes:

1. Re-verify the RPC contract (`rpc-types.d.ts`) against the pinned version.
2. Re-check the hardcoded builtin slash list used by the RPC editor.
3. Rerun the approval/security regression.
4. Confirm `--print`, explicit `--mode`, and non-TTY stdout still bypass the foreground RPC host.
5. Run the normal typecheck, test, integration, visual, and startup perf gates.

Do not regenerate private patches for Pi bumps. UI parity work now belongs in the RPC host and shared Cathedral renderers.
