# Pi RPC child boot cost: extension-package loading

**Status:** investigation complete; upstream issue text is a draft only  
**Measured:** 2026-08-10  
**Checkout:** `fe2afd8cf20f058a3bcc4e289f740c520a27a870`  
**Pi:** `@earendil-works/pi-coding-agent` `0.83.0`  
**Machine:** Apple Silicon `arm64`, macOS `26.5.1`, Node `v25.6.1`

## 1. Summary

The RPC child boot cost is dominated by Pi eagerly loading configured extension entry points through jiti, not by Pi core initialization. In the current 18-package configuration, the three-sample readiness median was **2,205.236 ms**; `--no-extensions` was **456.740 ms**. A scratch configuration containing only SumoCode had a **1,361.444 ms** median versus **413.555 ms** with no packages, making SumoCode's measured marginal contribution **947.889 ms**. The CPU profile sampled **2,571.416 ms** during a **2,595.750 ms** readiness run: `node:fs` accounted for **713.574 ms**, jiti for **596.507 ms**, and `node:internal` for **591.843 ms**. jiti plus `node:fs` was **1,310.081 ms / 50.95%** of sampled CPU time. Pi's extension loader iterates extension paths sequentially, so this is consistent with a CPU-serial resolution/transpile path rather than parallel extension loading.

This reproduces the structure of the 2026-08-10 advisor audit: extension-enabled boot is much slower than `--no-extensions`, and the installed SumoCode package is the largest single contributor in the isolated-package test. Absolute values are lower than the audit's 21-package measurements because the operator's configuration now has 18 packages.

## 2. Method

### Probe and safety

The probe was written to `/tmp/plan063-probe.mjs`. Each successful run:

1. Spawned the Pi binary (or, for the profile, `node --cpu-prof ... dist/cli.js`) with cwd `/tmp`.
2. Passed `--mode rpc --offline --no-session` on every Pi run.
3. Wrote `{"type":"get_state","id":"probe-1"}\n` to stdin and measured spawn-to-stdout response time.
4. Used a 30,000 ms timeout; on completion or failure sent `SIGTERM`, then `SIGKILL` after 250 ms if necessary.

The probe outputs recorded `ok: true` for every matrix and profile run. No real user configuration files were edited. Scratch configurations were created under `/tmp/plan063-run-20260810-131122/`; each used symlinks for `npm/`, `git/`, `extensions/`, `themes/`, `prompts/`, and `skills/`, with a synthesized copy of `settings.json`:

- `default`: copied current settings, 18 packages.
- `empty`: copied settings with `packages: []`.
- `sumocode`: copied settings with `packages: ["git:github.com/dhruvkelawala/sumocode"]`.

The current settings package count and package list were read from `~/.pi/agent/settings.json`; the real file was not changed. The drift check `git diff --stat e45351e..HEAD -- package.json docs/research/` produced no output, and the Pi pin remained `0.83.0`.

### Installed-copy / plan 083 check

The installed SumoCode package is a symlink to `/Volumes/SumoDeus NVMe/code/sumocode`. The check reported:

```json
{"piExtensions":["src/extension.ts"],"bundlePresent":false}
```

Therefore the additional Step-1 configuration for the plan-083 bundled entry was skipped: plan 083 had not landed in the installed copy at measurement time.

## 3. Boot matrix

### 2026-08-10 audit evidence

The following ranges are explicitly **2026-08-10 audit, advisor-measured** values, not measurements from this run. They used Pi `0.83.0`, warm caches, and the then-current 21-package configuration:

| Configuration | Audit readiness time |
|---|---:|
| Default flags, full package set | ~2,800–3,500 ms |
| `--no-extensions` | ~430–840 ms |
| Scratch config, `packages: []` | ~380–760 ms |
| Scratch config, SumoCode only | ~1,350–1,515 ms |
| Full set minus SumoCode | ~2,500–2,690 ms |

The audit also reported the following isolated marginal costs, all explicitly advisor-measured on 2026-08-10: `pi-cursor-sdk` ~+0.6 s, `pi-subagents` ~+0.4 s, `@plannotator/pi-extension` ~+0.45 s, and approximately +0–0.15 s each for `mitsupi`, `stitch-kit`, `pi-figma`, `pi-goal`, and the OAuth adapter. Those three largest packages were subsequently removed from the operator configuration.

### Current reproduction

Raw samples came from `/tmp/plan063-boot-matrix.jsonl`. The default and `--no-extensions` rows used the current full configuration; the two scratch rows used the isolated settings copies described above.

| Configuration | Samples (ms) | Median (ms) |
|---|---:|---:|
| Default, current 18 packages | 2,975.536; 2,205.236; 1,787.974 | **2,205.236** |
| Default config + `--no-extensions` | 453.277; 456.740; 457.487 | **456.740** |
| Scratch `packages: []` | 454.843; 410.288; 413.555 | **413.555** |
| Scratch, SumoCode only | 1,418.963; 1,361.444; 1,220.103 | **1,361.444** |
| Scratch, SumoCode bundled entry | — | **Skipped**: plan 083 was not present in the installed copy |

The structure reproduces: the default median is **4.828×** the `--no-extensions` median, and SumoCode alone adds **947.889 ms** over the empty scratch configuration. The SumoCode-isolated result is the largest single contributor tested in this current matrix.

As a supplemental host-side check, the probe was run three times with a fresh `NODE_COMPILE_CACHE` directory under `/tmp`. Samples were **2,385.776; 1,822.374; 1,954.342 ms**, median **1,954.342 ms**. Node created 1,762 cache files. This was not a paired controlled benchmark and does not remove the jiti/filesystem resolution work; it is a possible modest host-side bytecode mitigation, not an existing Pi extension-package bundle.

## 4. Attribution

### Current CPU profile

The profile command was:

```text
node --cpu-prof --cpu-prof-dir=/tmp/plan063-cpu-prof-131410 \
  <worktree>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --mode rpc --offline --no-session
```

The probe reported **2,595.750 ms** and produced one `.cpuprofile`. `/tmp/aggregate-cpu-prof.mjs` summed each `timeDeltas` entry by `callFrame.url` bucket. The profile had 427 samples and **2,571.416 ms** of sampled time:

| Bucket | Sampled CPU (ms) |
|---|---:|
| `node:fs` | 713.574 |
| `jiti` | 596.507 |
| `node:internal` | 591.843 |
| `(unknown)` | 453.946 |
| `@earendil-works/pi-coding-agent` | 33.583 |
| `file:other` | 30.558 |
| `typebox` | 22.015 |
| `node:path` | 19.145 |
| `yaml` | 19.057 |
| `highlight.js` | 16.447 |
| `zod` | 15.925 |
| `@earendil-works/pi-tui` | 15.380 |
| `minimatch` | 10.411 |
| `recheck` | 8.825 |
| `@earendil-works/pi-ai` | 8.406 |

The jiti and `node:fs` buckets together were **1,310.081 ms**, or **50.95%** of sampled CPU time. Pi coding-agent code was **33.583 ms**, or about **1.31%**. The largest individual jiti URLs were `jiti.cjs` at **571.022 ms** and `babel.cjs` at **25.485 ms**. SumoCode source URLs also appeared in the profile, including `src/background-tasks/task-store.ts` at **13.085 ms**, `src/activity/manager-bridge.ts` at **9.003 ms**, and `src/activity/persistence.ts` at **8.470 ms**.

### Comparison with the prior audit

The prior **2026-08-10 audit, advisor-measured** CPU profile sampled approximately **3,459 ms** and attributed **1,181 ms** to jiti, **1,138 ms** to `node:fs` (including **588 ms** in `statSync` and **325 ms** in `readFileSync`), **591 ms** to `node:internal`, and approximately **43 ms** to `@earendil-works/pi-coding-agent` itself. It also observed module URLs from `@plannotator/pi-extension` and `pi-claude-oauth-adapter`.

The current profile confirms the same attribution shape after the package trim: jiti, filesystem work, and Node internals dominate; Pi core remains small. The current profile's lower absolute package-related totals are expected from the current 18-package configuration and do not invalidate the finding.

## 5. What Pi has today

Pi `0.83.0` was inspected read-only in `node_modules/.pnpm/.../@earendil-works/pi-coding-agent/`, including the complete `docs/packages.md` and `docs/environment-variables.md` documents.

### Loader behavior

- `dist/core/extensions/loader.js:2,14` identifies jiti as the TypeScript extension loader and imports `createJiti` from `jiti/static`.
- `dist/core/extensions/loader.js:318–337` creates a jiti instance for each extension load. Pi sets `moduleCache: false`; in Node mode it supplies aliases, but it does not pass an `fsCache` path or a precompiled/bundled entry option. The per-process `extensionCache` at `loader.js:104–124,313–337` caches factory functions only within a process/cwd/generation; it cannot remove work from a newly spawned RPC child.
- `dist/core/extensions/loader.js:396–423` loads extension paths in a plain `for (const extPath of paths)` loop. `loadExtensionsCached` is an in-process reload cache, not a cross-process artifact cache. There is no lazy/on-demand extension hook in this path.
- `dist/core/resource-loader.js:315–318,401–418,423–456` resolves the enabled extension set and loads it during runtime creation. `--no-extensions` removes configured package extensions but retains explicit CLI extension paths.
- `dist/core/package-manager.js:694–733,977–1030` resolves package sources and collects their resource paths before extension loading. Package-source resolution itself is also a sequential `for` loop. `runWithConcurrency` and its `Promise.all` calls at `package-manager.js:1340–1358` are for update/check tasks, not extension module evaluation.

### Caches and alternatives

- jiti `2.7.0` documents `fsCache` in its README `### fsCache` section (lines 119–137): it is enabled by default and uses `node_modules/.cache/jiti` when present or `{TMP_DIR}/jiti` otherwise. Pi does not disable it, but the cache stores transpiled source; it does not pre-resolve or bundle the package module graph. The jiti `moduleCache` option is documented in lines 139–149, and Pi explicitly disables that runtime cache for extension loads.
- The Pi package documentation's **Install and Manage** (§, `docs/packages.md:18–50`) describes install/update operations; **Creating a Pi Package** (`:116–154`) and **Dependencies** (`:167–188`) describe package manifests and bundled dependencies. They do not provide an extension-entry precompile cache, lazy extension lifecycle, or parallel extension loader. `docs/packages.md:107–114` documents local paths, but local paths still resolve to extension files.
- `docs/environment-variables.md:70–85` lists Pi process configuration, including `PI_CODING_AGENT_DIR`, `PI_PACKAGE_DIR`, and `PI_OFFLINE`; it exposes no Pi extension compile-cache or lazy-load setting. A search of Pi's `dist/` for `NODE_COMPILE_CACHE`, `enableCompileCache`, and `compile cache` returned no matches.
- The supplemental `NODE_COMPILE_CACHE` probe above demonstrates that a Node host can create bytecode cache files, but it was not configured by Pi and did not change the requested loader design. The upstream ask therefore does **not** request jiti's existing fs cache, Node bytecode caching, an already-existing lazy hook, or parallel update checks.

## 6. SumoCode-side mitigations

- A pre-bundled extension entry is a proposed SumoCode-side fix for the installed SumoCode package: ship a committed ESM extension bundle so Pi loads one SumoCode entry instead of its source module graph. No Plan 083 document is present in this checkout, and the bundle was not present in the installed copy during this investigation, so its improvement was not measured here.
- [Plan 062: pre-bundled RPC host entry](../../plans/062-prebundled-rpc-host-entry.md) addresses SumoCode's own RPC-host startup path, keeping jiti as a source fallback. It does not change Pi's generic global package loader.

After those plans, SumoCode's own package and host costs should be reduced, but Pi will still eagerly resolve and jiti-load other configured package extensions in every child. The remaining resolution/stat/read work belongs to Pi's loader design and is the subject of the draft below.

## 7. Upstream issue DRAFT — DO NOT FILE

### Title

`perf: avoid eagerly resolving and transpiling every extension package on RPC boot`

### Body

> **DRAFT — DO NOT FILE.** Filing is the maintainer's decision.

Every `pi --mode rpc` child pays the cost of loading all configured package extension entry points before it can answer a basic RPC request. On an Apple Silicon Mac with Pi `0.83.0`, warm caches, and the current 18-package configuration, a readiness probe measured:

| Configuration | Three samples (ms) | Median (ms) |
|---|---:|---:|
| Default, 18 packages | 2,975.536; 2,205.236; 1,787.974 | 2,205.236 |
| `--no-extensions` | 453.277; 456.740; 457.487 | 456.740 |
| Scratch `packages: []` | 454.843; 410.288; 413.555 | 413.555 |
| Scratch, only `git:github.com/dhruvkelawala/sumocode` | 1,418.963; 1,361.444; 1,220.103 | 1,361.444 |

The isolated SumoCode package therefore added **947.889 ms** over the empty package configuration. A CPU profile of the default configuration sampled **2,571.416 ms**: `node:fs` **713.574 ms**, jiti **596.507 ms**, `node:internal` **591.843 ms**, and Pi coding-agent code **33.583 ms**. The jiti plus filesystem buckets were **50.95%** of sampled CPU time.

Reproduction:

```bash
# Run outside any checkout; the actual probe used cwd=/tmp.
node /tmp/plan063-probe.mjs \
  <pi-binary> --mode rpc --offline --no-session

# For isolation, set PI_CODING_AGENT_DIR to a scratch directory whose
# settings.json contains packages: [] or the single SumoCode package.
# The probe writes get_state/probe-1 to stdin and waits for that response.
```

Pi's current loader explains the result. `dist/core/extensions/loader.js:318–337` creates jiti with `moduleCache: false` and aliases; `loader.js:396–423` evaluates extension paths sequentially. The existing jiti fs cache is a warm transpiled-source cache, not a package-graph bundle. Pi's in-process extension cache cannot survive a new RPC child. Pi's package and environment-variable docs contain install/update and resource-filtering controls, but no precompiled extension artifact, lazy per-command load hook, or parallel extension evaluator.

**Requested direction:** add a package-install/update-time artifact—precompiled or bundled extension entry points, with an invalidation/version strategy—or provide a lazy extension-loading contract that defers package code until a command, tool, provider, or event actually needs it. The goal is for interactive/RPC boot to load approximately O(packages) artifacts rather than O(modules) source resolutions. Preserve explicit `-e` development behavior and package filtering. This request is intentionally not for jiti's existing fs cache, Node's optional bytecode cache, or Pi's update-check concurrency; those do not remove the per-child extension module resolution graph.

## 8. Non-goals honored

The only repository file created by this investigation is this document. Before committing it, `git status --short` showed:

```text
?? docs/research/pi-extension-load-cost.md
```

No files under `src/`, `scripts/`, `bin/`, `node_modules/`, or `~/.pi/agent/` were edited. Scratch scripts, settings copies, profiles, and cache outputs were under `/tmp` only. No GitHub issue was created; the upstream text above remains explicitly marked **DRAFT — DO NOT FILE**.
