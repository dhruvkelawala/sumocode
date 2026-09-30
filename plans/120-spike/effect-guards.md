# #588 effect-guards — isolated candidate evidence

**Status: candidate-ready, not release-verified.** Heavy verification and independent review remain coordinator-owned. No Effect dependency or runtime was added; #589/#590 were not implemented.

## Identity and provenance

Approved base: `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39` (SumoCode 0.7.5 / Pi 0.99.1).
Tested implementation head: `0fe2ab4c84d92aaf290d695824223281e5833de0`.
Branch: `sumo/v08-effect-guards`.
Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-effect-guards`.
This evidence file is the only subsequent change.

Reused [PR #594](https://github.com/dhruvkelawala/sumocode/pull/594) from
`origin/chore/588-effect-boundaries`, exact head `533100c8497c1093368e25a8335386f6afea2edc`,
original base `e533876233927cb6edbe0aca83e5342753a671a7`.
Read #588, the public PR body, reviews and inline history, Plan 118/ticket contracts,
AGENTS/DEV_LOOP, the existing vendored Effect skills/plugin and held import overlay.
Prior PR verification on its older base is historical evidence, not a pass for this checkout.

All ten source commits were cherry-picked with `-x`; source → local mapping:

```text
2d715cc8 → 872f533b  source policy/guidance
3689a19e → 300b2f08  eager native closure
296d545a → 1a8ef9b4  production leakage
70220204 → d9dfe891  policy recipe hashing
e6201f9e → 817c3641  fresh clone/test support
2aabe787 → a315c816  review policy repair
eccad6cb → 55a9bd0c  source/package boundary repair
84b84eb9 → 62a7c7e5  shared inspection
f4bccf02 → a9bd0f2d  public review repairs/Bun CI contract
533100c8 → 0fe2ab4c  scoped test exemptions
```

## Scope and conflict decision

Changed paths are confined to:

- `AGENTS.md`, `oxlint.config.ts`, `tools/oxlint/anti-slop/effect/{index.ts,rules/no-restricted-imports.ts}`.
- `scripts/build-{native,host,extension}.mjs` and their three colocated `.test.mjs` files.
- `scripts/effect-import-policy.test.mjs`, `scripts/lib/production-boundaries.mjs` and its `.test.mjs`.
- `scripts/lib/{extension-bundle,host-bundle}.mjs`, `.github/workflows/ci.yml`.
- This bounded evidence file.

There was one actual cherry-pick conflict, in `scripts/build-native.mjs` at the
host metafile check. Kept the approved base's `resignAdHoc(sumocode)`, then parsed
once and ran containment plus the candidate boundary checks. The Pi 0.99.1 pin,
updated source/bundle startup-instrumentation fixtures, both executable signing
calls and absence of the retired Yoga sidecar were preserved. The test-file merge
was clean; no assertions were removed or weakened and no new behavior was invented.
`package.json`, `pnpm-lock.yaml`, `.bun-version`, `src/**`, `bin/**` and
`sumo-rpc-host.js` have no changes relative to the approved base.

## Verification actually run

Environment: macOS arm64, Node `26.10.0`, CI-selected pnpm `10.29.2`, pinned Bun
`1.4.0`, TypeScript `6.0.3`, Oxlint `1.80.0`, Vitest `4.1.11`. Commands below were
run with pnpm 10.29.2 on PATH; Bun tests used `BUN_BIN` pointing to the exact 1.4.0
binary obtained through npm tooling. No repository pins were changed.

- **PASS** — `pnpm install --frozen-lockfile`; only this worktree's dependencies.
  Package build-script warnings for esbuild/protobufjs/@google/genai were left
  intact, not broadly approved. System pnpm 12.6.0 initially blocked installation
  and attempted check commands on its minimum-release-age policy for Pi 0.99.1;
  those commands did not reach verification. Missing-bin follow-up attempts also
  did not run checks. Reinstalled frozen with the repository's CI pnpm version,
  then reran all listed gates successfully; no cleanup or lockfile regeneration.
- **PASS** — `pnpm exec tsc --noEmit && pnpm build`; `pnpm lint` exits 0 with four
  pre-existing unused-variable/parameter warnings in `scratch/tui-audit/proto/gen.mjs`.
  `node scripts/check-tsc-budget.mjs` passes: 1,536,374 instantiations, baseline
  1,353,836, limit 2,707,672 (1.13×). Baseline/cache policy unchanged.
- **PASS** — focused candidate suite, five files / 94 tests / no skips (including
  pinned Bun package resolution and the real `dynamic-import` metafile contract).
  `src/extension-entry-loader.test.ts` separately passes all six fallback tests.
- **PASS** — `pnpm build:bundles` runs host and classic extension builds; host
  output is 971,337 bytes, extension manifest has 153 inputs. Generated `dist/**`
  remains ignored and untracked. `git diff --check` and unchanged-pin/runtime
  source checks pass. Explicit manifest/filesystem checks confirm Effect is neither
  declared nor installed.
- **NOT RUN — lease required** — full `pnpm test`, `pnpm build:native` /
  `pnpm test:native`, supervised integration/zero-survivor audit, visual CI and
  startup/perf comparison. No heavy gate was started. Native/classic/RPC release
  artifacts on this new base are not claimed verified; this is the candidate
  handoff, not approval to release or adopt Effect. Unrelated dependency-audit,
  visual-recap-validator, compatibility and dead-code commands were not run here.

Focused reproduction (pnpm 10.29.2 and Bun 1.4.0):

```bash
pnpm vitest run scripts/effect-import-policy.test.mjs \
  scripts/lib/production-boundaries.test.mjs scripts/build-host.test.mjs \
  scripts/build-extension.test.mjs scripts/build-native.test.mjs --maxWorkers=1
pnpm vitest run src/extension-entry-loader.test.ts --maxWorkers=1
pnpm exec tsc --noEmit && pnpm build
pnpm lint
node scripts/check-tsc-budget.mjs
pnpm build:bundles
```

## Tradeoffs and retained assumptions

- Reused the reviewed source policy and positive/negative fixtures instead of
  adding another plugin, parser or test framework. Oxlint rejects root/platform
  barrels, unstable/test-only production imports and protected plain zones;
  CLI tests inject forbidden source while stable deep imports and actual tests pass.
- The graph guard follows eager edges, not every input in the native metafile.
  Its existing positive fixture includes Effect behind a local dynamic host edge;
  eager Effect/platform mutations reject with an import trace. Direct dynamic
  Effect-package imports from the eager closure also remain forbidden. This is
  an import-graph assertion, **not proof of runtime evaluation timing**.
- The shared leakage check rejects bundled inputs, external output imports and
  surviving emitted specifiers; source maps are excluded. It is wired into host,
  classic extension, native host/Pi child and both native extension builds.
  The existing native extension Pi/typebox/Node bare-import allowlist is intact.
  Emitted-text scanning remains conservatively over-approximate (comments/strings
  can false-positive); no speculative parser or diagnostic aggregation was added.
- Kept existing PR decisions: deep-import bans include type-only imports/tests;
  lint zones and eager graph checks enforce different policies, not duplicate
  allowlists; the post-launch chrome worker is not an eager launcher entry.
  The nearest-config path assumption remains (inventory: only root
  `oxlint.config.ts` exists). Nested config support, Windows fixture plumbing,
  path-resolution caching and workflow-wide action SHA pinning were not expanded.
- The first commit's existing global hook reported missing lefthook; untracked
  `.build/{CACHEDIR.TAG,.buildSystem_debug}` appeared during that cherry-pick. Retained those files,
  staged neither, and disabled hooks command-locally for subsequent cherry-picks
  and the evidence commit. No parent checkout, shared git configuration, branch,
  worktree, installed clone, private config or retained evidence was edited/removed.

## Review-ready gate (candidate scope)

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (no project override found).
Changed seam: source import and production build acceptance; no runtime interface changes.
Trace: build entry → in-memory bundle/metafile → shared boundary assertion → publication;
rejected builds do not publish a fresh manifest. Native checks retain containment/signing.

### caller-knowledge

Build callers supply their artifact/entry and graph; package detection, normalization
and trace/error construction remain inside `production-boundaries.mjs`.

### deletion

Removing the shared helper would duplicate leakage/specifier logic across three
builders. The helper remains a real reused build-policy owner, not a wrapper scaffold.

### ownership

Source syntax/zone policy belongs to the vendored Effect plugin; build reachability
and shipped-dependency policy belong to the existing build seam. Guidance is in AGENTS.

### test-surface

Tests exercise Oxlint CLI registration, public graph assertions, actual build
freshness/publication and Bun's emitted graph shape, not exported private lint helpers.

Simplification pass: retained candidate reuse and existing assertions; no new abstractions,
dependencies, runtime/service hierarchy, campaign scaffolding or compiler policy.
Verification exception: heavy gates are explicitly deferred under the coordinator lease;
independent review remains pending. This report is not an independent review verdict.

## #589 handoff

#589 may proceed independently and reuse these guard/import test commands and the
unchanged compiler-budget checker. It owns reproducible native/source readiness
and classic/RPC extension size/evaluation measurements, including Pi-child evaluation
of native-distributed bundles. Do not treat this graph policy or local bundle sizes
as its performance baseline/approval. Production adoption still requires accepted
#588/#589, #396 (or explicit owner revision) and prototype gates. Stop here at #588.
