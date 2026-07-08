# Plan 062: Pre-bundle the RPC host entry with esbuild (jiti stays as the dev fallback)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0dc25c7..HEAD -- sumo-rpc-host.js package.json scripts/ knip.json .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. NOTE: plan 061 intentionally
> changes `sumo-rpc-host.js` (pre-spawn) — that change is EXPECTED drift;
> read 061's final version of the file and preserve its behavior.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/061-early-first-frame-and-parallel-hydration.md (both rewrite `sumo-rpc-host.js`; 061 lands first)
- **Category**: perf
- **Planned at**: commit `0dc25c7`, 2026-07-08

## Why this matters

Importing the RPC host through jiti costs ~900–1350ms per launch even with
every cache warm. CPU-profiled at `0dc25c7`: ~241ms in jiti's `tryStatSync`,
~360ms in jiti resolver internals, plus ESM/URL machinery — roughly
650–900ms of pure loader overhead for a 94-file graph whose transpile results
are all fsCache hits (~0.1ms each). `tryNative: true` measured no better.
Bundling the host's own TS into a single ESM file (all `node_modules` kept
external and loaded natively) removes per-file resolution entirely; expected
host-import: ~200–400ms. Combined with plan 061 (splash paints right after
host import), this puts first paint under ~0.5s. jiti remains as an
automatic fallback whenever the bundle is missing or stale, so the dev loop
("edit TS, relaunch") keeps working with zero manual steps.

## Current state

- `sumo-rpc-host.js` (repo root) — after plan 061 it pre-spawns the Pi child
  and then jiti-imports `./src/sumo-tui/rpc/host.ts`, calling
  `main({ preSpawnedChild })`. At `0dc25c7` (pre-061) it is:

  ```js
  import { createJiti } from "jiti";
  const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
  const mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
  await mod.main();
  ```

- `package.json`: `"type": "module"`, engines node >=22.19.0, **no esbuild
  anywhere** (verified: `require('esbuild')` does not resolve). Scripts
  include `"build": "tsc --noEmit"` (a typecheck, not an emit — the repo has
  deliberately had no emit step; this plan adds an *optional* one that never
  gates the dev loop).
- `dist/` exists at the repo root but contains only `bible-site/` (generated
  docs). Check `.gitignore` for whether `dist/` is ignored before assuming.
- Module-graph facts that constrain the bundle (verified at `0dc25c7`):
  - `src/splash.ts:82–83` resolves a runtime asset relative to the module:

    ```ts
    const ASSET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "assets");
    const FACE_PATH = resolve(ASSET_DIR, "sumo-face.ans");
    ```

    and `src/sumo-tui/cathedral/splash-tree.ts:10` imports from
    `../../splash.js`, so this file IS in the host bundle graph. A bundled
    host at `dist/host/sumo-rpc-host.bundle.mjs` will resolve
    `ASSET_DIR = dist/host/assets` — the build must copy
    `src/assets/sumo-face.ans` there.
  - `src/sumo-tui/layout/yoga.ts:87` and `src/sumo-tui/rpc/runtime.ts:116`
    use `createRequire(import.meta.url)` to resolve packages
    (`yoga-wasm-web`, a pi-tui native module). From `dist/host/` these still
    resolve the same `node_modules` (same package root) — no action needed,
    but the smoke test must prove yoga loads.
  - `src/sumo-tui/rpc/host-actions.ts:748` reads `CHANGELOG.md` via an
    injected `changelogRoot` (env-derived, not module-relative) — unaffected.
  - Plan 061's `src/sumo-tui/rpc/spawn-child.mjs` is plain JS imported
    natively by the entry — it must stay OUTSIDE the bundle graph decision
    (esbuild will just include it if `host.ts` imports it; that's fine).
- `knip.json` exists; the ledger (plans/README.md, plan 034 notes) records
  known knip entrypoint gaps — new scripts may need an entry added.
- Source imports use ESM `.js` specifiers for `.ts` files (jiti convention),
  which esbuild resolves natively with `--resolve-extensions` defaults — no
  config needed beyond `bundle`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (after adding esbuild) | `pnpm install` | exit 0 |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit tests | `pnpm test` | exit 0 |
| Integration | `pnpm test:integration` | pass |
| Build the bundle | `pnpm build:host` (added by this plan) | exit 0, bundle file exists |
| Perf evidence | `pnpm perf:startup` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `package.json` (esbuild devDependency, `build:host` script)
- `pnpm-lock.yaml` (via `pnpm install` only)
- `scripts/build-host.mjs` (create)
- `sumo-rpc-host.js` (loader selection + freshness check)
- `.gitignore` (ignore `dist/host/` if `dist/` is not already ignored)
- `knip.json` (only if knip flags the new script)
- `test/integration/` (one new/extended PTY test)
- `docs/perf/startup.json`, `docs/perf/startup.md` (regenerated evidence)

**Out of scope** (do NOT touch):
- Everything under `src/` — the bundle must work against the source AS IS.
  If bundling seems to require a source change, that's a STOP condition.
- `bin/sumocode.sh` — it already runs `node sumo-rpc-host.js`; loader
  selection is the entry file's job.
- `dist/bible-site/` — unrelated generated docs.
- CI config — the bundle is launch-time optional; do not add build gates.

## Git workflow

- Branch: `advisor/062-prebundled-rpc-host-entry`
- Conventional commits, e.g. `perf(host): bundle the RPC host entry with esbuild`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add esbuild and the build script

- `pnpm add -D esbuild` (accept the current latest; pin whatever version the
  lockfile records).
- Create `scripts/build-host.mjs` using esbuild's JS API:
  - entry: `src/sumo-tui/rpc/host.ts`
  - out: `dist/host/sumo-rpc-host.bundle.mjs`
  - `bundle: true`, `format: "esm"`, `platform: "node"`, `target: "node22"`,
    `packages: "external"` (ALL node_modules stay external — this is
    load-bearing: yoga wasm, pi packages, and native modules must load
    natively), `sourcemap: true`.
  - After the build, copy `src/assets/sumo-face.ans` →
    `dist/host/assets/sumo-face.ans` (see the `splash.ts` constraint in
    "Current state").
  - Print the output size and a one-line success message.
- Add `"build:host": "node scripts/build-host.mjs"` to package.json scripts.

**Verify**: `pnpm build:host` → exit 0;
`test -f dist/host/sumo-rpc-host.bundle.mjs && test -f dist/host/assets/sumo-face.ans && echo ok` → `ok`;
`node --input-type=module -e "await import(process.cwd() + '/dist/host/sumo-rpc-host.bundle.mjs')"` → exit 0
(imports cleanly; `main()` is not called at import time).

### Step 2: Loader selection with freshness check in `sumo-rpc-host.js`

Rewrite the entry to choose the loader, **preserving plan 061's pre-spawn
before either import path**:

1. Compute `bundlePath = <root>/dist/host/sumo-rpc-host.bundle.mjs`.
2. Freshness: bundle is usable when it exists AND its mtime is >= the newest
   mtime of every `*.ts`/`*.mjs` file under `src/` (recursive readdir with
   `withFileTypes`, skip `*.test.ts`; ~200 stats, a few ms — cheap relative
   to the ~700ms it saves) AND `SUMOCODE_HOST_BUNDLE !== "0"`.
   `SUMOCODE_HOST_BUNDLE=1` skips the freshness walk and forces the bundle.
3. Fresh → `await import(pathToFileURL(bundlePath))`. Stale/missing → jiti
   path exactly as today, plus a single stderr hint (only when the bundle
   exists but is stale): `[sumocode] host bundle stale — using source; run
   pnpm build:host`.
4. Either way, call `mod.main({ preSpawnedChild })` (061's contract).
5. Any error importing the bundle (not just staleness) → fall back to jiti;
   never let the bundle path be the reason sumocode fails to boot.

**Verify**: `node --check sumo-rpc-host.js` → exit 0. Manual matrix (each via
a real terminal or `pnpm test:integration` after Step 3):
fresh bundle → boots; `touch src/sumo-tui/rpc/host.ts` → stderr hint + boots
via jiti; `SUMOCODE_HOST_BUNDLE=0` → boots via jiti; bundle deleted → boots
via jiti with no hint.

### Step 3: Integration test + smoke the risky resolutions

Extend `test/integration/` (follow the existing node-pty harness pattern)
with a bundle-path boot test:

- Run `pnpm build:host` in the test setup (or `execFileSync` node
  `scripts/build-host.mjs`).
- Boot `bin/sumocode.sh --offline --no-session` under node-pty with
  `SUMOCODE_HOST_BUNDLE=1`, assert the altscreen frame appears (this
  transitively proves yoga wasm loaded — the shell cannot render without it —
  and the splash face asset resolved), then exit cleanly.
- Second case: `SUMOCODE_HOST_BUNDLE=0` boots identically (jiti fallback
  regression guard).

**Verify**: `pnpm test:integration` → pass, including the two new cases.

### Step 4: Housekeeping + evidence

- `.gitignore`: ensure `dist/host/` is ignored (check whether `dist/` already
  is; if `dist/bible-site` is committed, ignore only `dist/host/`).
- `pnpm dead-code` → if `scripts/build-host.mjs` is flagged, add it to
  `knip.json` entries.
- Re-run `pnpm perf:startup` **with a fresh bundle present** and commit the
  regenerated `docs/perf/` files. The `host-import` row (plan 060) measures
  the jiti path by design — additionally record the bundle-path number in
  your summary by timing
  `node --input-type=module -e "const t=performance.now(); await import(process.env.B); console.log(Math.round(performance.now()-t))"`
  with `B=<abs bundlePath>` (3 runs).

**Verify**: `pnpm exec tsc --noEmit && pnpm build && pnpm test` → all exit 0;
`git status --short` clean apart from in-scope files.

## Test plan

- Integration (Step 3): bundle boot, jiti-fallback boot — model after the
  existing PTY boot tests in `test/integration/`.
- No unit tests for `scripts/build-host.mjs` (build tooling; the integration
  boot is its test). The freshness logic in `sumo-rpc-host.js` is plain JS in
  an entry file — if you find it growing beyond ~40 lines, extract it to
  `scripts/lib/` and unit-test it; otherwise the integration matrix in Step 2
  covers it.
- Verification: `pnpm test` exit 0, `pnpm test:integration` pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm build:host` exits 0 and produces `dist/host/sumo-rpc-host.bundle.mjs` + `dist/host/assets/sumo-face.ans`
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `pnpm test` exits 0; `pnpm test:integration` passes including both new boot cases
- [ ] Bundle import timing (3-run avg, method in Step 4) is at least 40% below the `host-import` (jiti) row in `docs/perf/startup.md`
- [ ] Stale-bundle launch prints the hint once and still boots (integration or manual evidence)
- [ ] `git status --short` shows only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Bundling appears to require modifying anything under `src/` (e.g. an
  `import.meta.url` usage this plan didn't enumerate breaks) — report the
  file and usage instead of patching it.
- The bundled host renders a different splash than the jiti host (compare
  via `pnpm visual:ci` if in doubt) — asset or resolution divergence.
- `packages: "external"` still inlines something from `node_modules`
  (check the bundle for `node_modules` content) — esbuild config issue,
  report rather than switching to a hand-listed externals array without review.
- Plan 061 has not landed (this plan's `sumo-rpc-host.js` steps assume the
  pre-spawn contract exists).
- esbuild's install adds platform binaries that fail on this machine.

## Maintenance notes

- The bundle is **optional at runtime by contract** — any future change may
  assume jiti fallback exists. Never make `bin/sumocode.sh` or CI require
  `dist/host/` to be present.
- If the package is ever published/installed as a pi-package, wire
  `build:host` into `prepack` so installs get the fast path; deliberately
  deferred here because the publish pipeline wasn't in evidence at planning
  time.
- Reviewers should scrutinize: the freshness walk cost (should be single-digit
  ms), the fallback-on-any-error guarantee, and that the pre-spawn (061)
  still precedes the module import on both loader paths.
- Future `src/` additions that read files relative to `import.meta.url` will
  silently break the bundle path only — the stale-check won't catch it. The
  integration bundle-boot test is the guard; keep it meaningful.
