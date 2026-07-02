# Plan 014: Remove the legacy Pi patch seam and make RPC the only interactive runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 96a2a0a..HEAD -- bin/sumocode.sh package.json sumo-interactive-mode.js patches src/sumo-tui/pi-compat/sumo-interactive-mode.ts AGENTS.md DEV_LOOP.md docs/SUMO_TUI_PI_PATCH_STRATEGY.md docs/research/pi-rpc-migration.md test/integration/rpc-host-shell.test.ts test/integration/spawn-pi-pty.test.ts test/integration/sumo-reload.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: 006 DONE
- **Category**: migration
- **Planned at**: commit `96a2a0a`, 2026-07-02

## Why this matters

The feature branch exists to finish the RPC migration, not carry a second
interactive runtime. Keeping `SUMO_LEGACY=1`, the Pi constructor patch, and the
`sumo-interactive-mode.js` loader leaves the fragile seam in the product and
keeps every Pi bump tied to private patch maintenance. Dhruv explicitly does
not want the fallback. After this plan, interactive TTY launches use the RPC
host, non-interactive Pi modes still bypass the foreground host, and there is no
patched retained rollback path in this branch.

## Current state

This branch is currently the accepted RPC cutover stack (`96a2a0a`) with a
one-release fallback still present.

`bin/sumocode.sh:17-19` still documents and defaults around the fallback:

```bash
# The patched retained path is still kept for one release as the explicit
# SUMO_LEGACY=1 rollback. Default launches go through the RPC host below.
export SUMO_TUI="${SUMO_TUI:-1}"
```

`bin/sumocode.sh:109-112` maps `--no-sumo-tui` to the legacy path:

```bash
  --no-sumo-tui
      Disable the SumoCode retained runtime for this launch. Equivalent to
      SUMO_LEGACY=1 SUMO_TUI=0 sumocode ... and useful for comparing against
      legacy Pi UI.
```

`bin/sumocode.sh:469-472` still inspects the patched Pi constructor:

```bash
pi_has_sumo_tui_patch() {
	local main_file
	main_file="$(pi_main_file "$1" 2>/dev/null || true)"
	[[ -n "${main_file}" ]] && grep -Fq "loadSumoInteractiveMode" "${main_file}"
}
```

`bin/sumocode.sh:578-619` still supports `SUMO_LEGACY=1`, checks
`loadSumoInteractiveMode`, exports `SUMO_TUI_MODULE`, and falls back to classic
Pi when the patch is missing. `bin/sumocode.sh:651-690` still runs a direct Pi
interactive loop for the non-RPC branch.

`package.json:19-21` exports the loader:

```json
"exports": {
  "./sumo-interactive-mode": "./sumo-interactive-mode.js"
}
```

`package.json:78-85` still applies the patch:

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "node-pty"
  ],
  "patchedDependencies": {
    "@earendil-works/pi-coding-agent@0.79.1": "patches/@earendil-works__pi-coding-agent@0.79.1.patch"
  }
}
```

Physical seam files still present:

- `sumo-interactive-mode.js`
- `patches/@earendil-works__pi-coding-agent@0.78.0.patch`
- `patches/@earendil-works__pi-coding-agent@0.79.1.patch`
- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts`
- `src/sumo-tui/pi-compat/sumo-interactive-mode.test.ts`

Docs still describe rollback:

- `AGENTS.md:95-110`
- `DEV_LOOP.md:111-112`, `DEV_LOOP.md:268-303`
- `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`
- `docs/research/pi-rpc-migration.md:3`, `docs/research/pi-rpc-migration.md:219-226`

Important convention: keep non-interactive Pi behavior. `bin/sumocode.sh` must
continue to bypass the foreground RPC host for `--print`, explicit `--mode`,
and non-TTY stdout; those are not the legacy interactive seam.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Focused launcher/RPC tests | `pnpm vitest run test/integration/rpc-host-shell.test.ts test/integration/spawn-pi-pty.test.ts test/integration/sumo-reload.test.ts src/sumo-tui/rpc/runtime.test.ts` | all pass |
| Integration | `pnpm test:integration` | all pass |
| Visual smoke | `pnpm visual:ci` | exit 0 |
| Startup perf | `pnpm perf:startup` | exit 0, no readiness timeout |
| Full unit caveat check | `pnpm test` | all tests pass; known background-task temp `output.log` ENOENT may still make the command exit 1 |

## Scope

**In scope:**

- `bin/sumocode.sh`
- `package.json`
- `pnpm-lock.yaml` only for the surgical removal of patch metadata
- `sumo-interactive-mode.js` (delete)
- `patches/@earendil-works__pi-coding-agent@*.patch` (delete)
- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` (delete only if no imports remain)
- `src/sumo-tui/pi-compat/sumo-interactive-mode.test.ts` (delete with the module)
- `src/sidebar.ts`, `src/top-chrome.ts`, `src/commands/worktree.ts`, and any other imports that only exist to call `getActiveSumoRuntime`
- `AGENTS.md`, `DEV_LOOP.md`, `docs/SUMO_TUI_PI_PATCH_STRATEGY.md`, `docs/research/pi-rpc-migration.md`, `docs/research/pi-fork-upgrade.md`
- `README.md`, `knip.json`, `scripts/smoke-pi-versions.sh`, and any docs found by
  `rg` that still give active operator instructions for the retired patch seam
- launcher/integration tests that currently assert `SUMO_LEGACY=1`

**Out of scope:**

- Changing visual layout or trying to restore 1:1 UI parity. That is Plan 016.
- Promoting visual goldens.
- Removing non-interactive direct-Pi bypass for `--print`, explicit `--mode`, or non-TTY stdout.
- Removing the RPC host or `sumo-rpc-host.js`.

## Git workflow

- Branch: `codex/rpc-migration-no-seam`
- Commit message example: `refactor: remove legacy sumotui patch fallback`
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Simplify launcher mode selection

In `bin/sumocode.sh`, remove `SUMO_LEGACY` as a supported input and delete the
patch/module checks. The launcher should have exactly two high-level execution
paths:

1. Interactive TTY plus no explicit Pi non-interactive mode: execute
   `node "${ROOT_DIR}/sumo-rpc-host.js" ...` with `SUMO_RPC=1`,
   `SUMO_TUI=0`, no `SUMO_TUI_MODULE`.
2. Non-interactive direct Pi: stdout is not a TTY, or argv requests `--print`,
   `-p`, `--mode`, or `--mode=*`; execute `"${PI_BIN}" -e
   "${ROOT_DIR}/src/extension.ts" ...` with `SUMO_TUI=0`, no
   `SUMO_TUI_MODULE`, and no patch checks.

Remove or redefine `--no-sumo-tui`. Recommended behavior: keep the flag as a
classic direct-Pi bypass for diagnostics, but it must not set `SUMO_LEGACY` or
attempt to load the patched retained path. Document it as "bypass the foreground
RPC host and execute Pi directly."

**Verify:**

```bash
./bin/sumocode.sh --dry-run --offline --no-extensions --no-session --approve
./bin/sumocode.sh --dry-run --offline --no-extensions --no-session --print hello
./bin/sumocode.sh --dry-run --mode rpc --offline --no-extensions --no-session
```

Expected:

- The default dry-run uses `sumo-rpc-host.js` only when stdout is a TTY. In a
  non-TTY shell dry-run it may show direct Pi; the PTY integration test below
  is the source of truth for interactive default.
- Print/mode dry-runs execute Pi directly.
- No output mentions `SUMO_LEGACY`, `loadSumoInteractiveMode`, or
  `SUMO_TUI_MODULE`.

### Step 2: Delete patch metadata and loader files

Remove `package.json#exports["./sumo-interactive-mode"]` and
`package.json#pnpm.patchedDependencies`. Delete `sumo-interactive-mode.js` and
all `patches/@earendil-works__pi-coding-agent@*.patch` files.

Do **not** run `pnpm install --lockfile-only` for this plan. On 2026-07-02 it
was observed to add unrelated `libc` metadata across many lockfile package
entries, which is outside scope. Instead, edit `pnpm-lock.yaml` surgically:

- remove the top-level `patchedDependencies:` block for
  `@earendil-works/pi-coding-agent@0.79.1`,
- change the importer version from
  `0.79.1(patch_hash=...)(ws@8.20.0)(zod@4.3.6)` to
  `0.79.1(ws@8.20.0)(zod@4.3.6)`,
- rename the matching snapshot key the same way.

If a future lockfile shape requires broader package metadata changes, STOP and
report instead of normalizing the lockfile.

**Verify:**

```bash
rg "patchedDependencies|sumo-interactive-mode|loadSumoInteractiveMode|SUMO_TUI_MODULE|SUMO_LEGACY" package.json pnpm-lock.yaml patches bin/sumocode.sh
git diff -- pnpm-lock.yaml
```

Expected: no matches for patch metadata, loader exports, `SUMO_LEGACY`, or
`SUMO_TUI_MODULE` in those files. The `patches` directory may be gone.
The lockfile diff contains only patch metadata removal and `patch_hash`
reference removal; it does not add `libc`, CPU/OS, integrity, version, or other
package metadata churn.

### Step 3: Remove in-process runtime imports or isolate still-needed code

Search for in-process runtime imports:

```bash
rg "getActiveSumoRuntime|sumo-interactive-mode" src
```

If callers only use `getActiveSumoRuntime` to notify or update the old patched
runtime, delete those calls or route them through an RPC-safe service that
already exists. Do not re-create a new hidden seam. If `owned-shell-renderer.ts`
or other `pi-compat` modules contain reusable render helpers, extract those
helpers into a non-legacy module before deleting `sumo-interactive-mode.ts`.

Delete `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` and its test only when
the search above has no production import left.

**Verify:**

```bash
rg "getActiveSumoRuntime|sumo-interactive-mode|SUMO_TUI_MODULE|SUMO_LEGACY|loadSumoInteractiveMode" src test
pnpm exec tsc --noEmit
```

Expected: no legacy seam matches in `src`/`test`; typecheck exits 0.

### Step 4: Update docs to one-runtime language

Update the docs and tooling notes listed in Scope so they say:

- SumoCode's interactive runtime is the RPC host.
- The old private Pi constructor patch is removed, not rollback-only.
- Pi bumps verify the RPC contract and builtin slash list; they do not
  regenerate private patches.
- `--print`, explicit `--mode`, and non-TTY stdout still bypass the foreground
  host for Pi non-interactive behavior.

Either delete `docs/SUMO_TUI_PI_PATCH_STRATEGY.md` and replace it with a short
historical note, or keep it as "retired strategy" with no active instructions.
Also update active tooling/config:

- `scripts/smoke-pi-versions.sh` must no longer synthesize
  `pnpm.patchedDependencies` or check `SUMO_TUI_MODULE` /
  `loadSumoInteractiveMode` markers.
- `knip.json` must not ignore deleted files.
- `README.md` must not describe the removed patch as the current activation
  path.

**Verify:**

```bash
rg "SUMO_LEGACY|rollback|loadSumoInteractiveMode|patched retained|patch regen|SUMO_TUI_MODULE" AGENTS.md DEV_LOOP.md docs/SUMO_TUI_PI_PATCH_STRATEGY.md docs/research/pi-rpc-migration.md docs/research/pi-fork-upgrade.md
rg "SUMO_LEGACY|SUMO_TUI_MODULE|loadSumoInteractiveMode|patchedDependencies|sumo-interactive-mode|getActiveSumoRuntime" --glob '!plans/**' .
```

Expected: only historical "removed/retired" mentions remain, not active
operator instructions. Active scripts/config such as `scripts/smoke-pi-versions.sh`,
`README.md`, and `knip.json` have no live patch-seam references.

### Step 5: Rewrite tests away from rollback

Remove the `SUMO_LEGACY=1` rollback assertion in
`test/integration/rpc-host-shell.test.ts`. Replace it with an assertion that an
interactive PTY defaults to the RPC host and that `--no-sumo-tui` or direct Pi
non-interactive mode does not try to load the patch.

Update `test/integration/spawn-pi-pty.test.ts` so environment scrubbing still
removes stale `SUMO_LEGACY` if a developer has it set locally, but the launcher
itself does not support it.

Update `test/integration/sumo-reload.test.ts` so reload tests use the direct-Pi
bypass intentionally, not `SUMO_LEGACY`.

**Verify:**

```bash
pnpm vitest run test/integration/rpc-host-shell.test.ts test/integration/spawn-pi-pty.test.ts test/integration/sumo-reload.test.ts src/sumo-tui/rpc/runtime.test.ts
```

Expected: all pass.

### Step 6: Run the gate and inspect source scope

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test:integration
pnpm visual:ci
pnpm perf:startup
pnpm test
git status --short
```

Expected:

- Typecheck/build pass.
- Integration passes.
- Visual CI exits 0.
- Startup perf exits 0 and readiness diagnostics do not time out.
- `pnpm test` either exits 0 or has only the already-known background-task
  temp `output.log` ENOENT issue after all assertions pass.
- Modified files are limited to the Scope list.

## Test plan

- Launcher dry-run tests for RPC default, print/mode direct Pi, and
  `--no-sumo-tui` direct Pi.
- PTY test proving an interactive `bin/sumocode.sh --offline --no-extensions
  --no-session --approve` boots the RPC host.
- Regression search proving no `SUMO_LEGACY`, `SUMO_TUI_MODULE`,
  `loadSumoInteractiveMode`, or `patchedDependencies` active seam remains.

## Done criteria

ALL must hold:

- [ ] No supported `SUMO_LEGACY` path remains.
- [ ] No `SUMO_TUI_MODULE` export path remains.
- [ ] `package.json` has no `patchedDependencies` and no
  `./sumo-interactive-mode` export.
- [ ] Patch files are deleted.
- [ ] `sumo-interactive-mode.js` is deleted.
- [ ] `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` is deleted or there is
  a documented STOP explaining the remaining dependency.
- [ ] Interactive PTY tests prove RPC host startup.
- [ ] `--print`, explicit `--mode`, and non-TTY stdout still bypass the
  foreground RPC host.
- [ ] Active docs/tooling no longer instruct maintainers to regenerate,
  install, smoke, ignore, or activate the retired Pi patch seam.
- [ ] Required verification commands from Step 6 were run and reported.

## STOP conditions

Stop and report if:

- Removing `sumo-interactive-mode.ts` reveals production behavior with no RPC
  equivalent.
- Non-interactive Pi modes break.
- `pnpm install --lockfile-only` creates broad dependency churn unrelated to
  patch metadata removal.
- `pnpm-lock.yaml` contains any metadata churn beyond patch metadata and
  `patch_hash` reference removal.
- Any visual harness failure is caused by the fallback removal itself; do not
  "fix" visual parity in this plan.

## Maintenance notes

After this plan lands, the feature branch has no runtime escape hatch back to
the old patched UI. That is intentional. UI parity must be achieved by making
the RPC runtime compose the existing Cathedral surfaces, not by resurrecting the
patch.
