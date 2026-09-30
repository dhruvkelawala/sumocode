# #588 effect-guards — isolated candidate evidence

**Status: revision1 candidate-ready, not release-verified.** The original candidate received REVISE and failed its default full suite. That prior-head failure is recorded separately below, not adjudicated as a revised-head verdict. Bounded repairs and permitted verification are recorded below; independent rereview and heavy gates remain coordinator-owned. No Effect dependency/runtime or #589/#590 implementation was added. This does not unlock #589.

## Original candidate evidence (historical)

The following records the original isolated worker, not verification of revision1.

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

## Original #589 handoff (historical)

#589 may proceed independently and reuse these guard/import test commands and the
unchanged compiler-budget checker. It owns reproducible native/source readiness
and classic/RPC extension size/evaluation measurements, including Pi-child evaluation
of native-distributed bundles. Do not treat this graph policy or local bundle sizes
as its performance baseline/approval. Production adoption still requires accepted
#588/#589, #396 (or explicit owner revision) and prototype gates. Stop here at #588.

## Revision1 — bounded review repairs

**COMPLETE — candidate-ready only; independent rereview pending (round 1 of 2).**
The verifier's old-candidate run belongs to its separate tree and is not claimed
as revision1 evidence. No parent/old tree or remote branch was edited.

### Identity and scope

Revision base: `26d635d6b89e8b93b51cfcb285fa5d32f9752897`.
Tested repair head: `4400fd949b38fb143fafe9e58d7937bc217f9b22`.
Approved runtime base remains `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39`, Pi `0.99.1`.
Branch: `sumo/v08-guards-revision-1`.
Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-guards-revision-1`.
The subsequent evidence commit changes only this file.

Repair scope is five files: `scripts/lib/production-boundaries.mjs` and its test,
`scripts/build-native.test.mjs`, `scripts/effect-import-policy.test.mjs`, and
`oxlint.config.ts`. All prior assertions remain; no vendored rule was deleted or
changed. `AGENTS.md`, package/lock/Bun pins, `src/**`, launcher files, signing,
compiler baseline and golden policy are unchanged from the revision base.

### Finding 1 — ACCEPTED / FIXED

Unresolved static non-external imports now throw with the artifact and full
entry-to-missed-edge trace instead of silently disappearing from traversal.
The new public-API tests use `nativeMetafile` and cover a missing input and a
relative edge that does not match the existing bridge input; that bridge imports
Effect. Both failed against the old implementation, then passed after the one
shared guard repair. No filesystem resolver or speculative path normalization
was introduced. All callers still use the same public assertion.

The existing real Bun fixture now includes a live static preflight import as
well as its dynamic host import. Bun `1.4.0` emits `preflight.ts` as both the
static edge path and an input key, with kind `import-statement`; the host keeps
kind `dynamic-import`. The public eager guard accepts that actual graph. This
is a graph contract, not runtime evaluation or full native compile evidence.

Sanitized red/green excerpts:

```text
RED: production-boundaries.test.mjs — 2 failed | 8 passed
fails closed ... src/native/missing.ts / ./bridge.ts
AssertionError: expected [Function] to throw an error
GREEN after guard repair: 10 passed
GREEN final guard suite: 13 passed
```

### Finding 4 — ACCEPTED / COVERED

Added explicit missing-entry-point failure and direct dynamic `effect/Effect`
and `@effect/platform-node/NodeRuntime` rejection tests through `nativeMetafile`
and the public guard. They were green on introduction: existing behavior already
checks packages before skipping dynamic/external edges. No redundant production
change was needed. The prior allowed local dynamic-host edge assertion remains.

### Finding 2 — ACCEPTED / FIXED

Removed only global `no-service-constructor-imports` activation. The Effect
plugin remains registered and `no-restricted-imports` stays globally active.
The config comment records that constructor enforcement must be enabled only
in real, reviewed Effect-adopting scopes at #590; no speculative overrides or
scoping API were added. The vendored rule remains intact.

Policy check: AGENTS and the published #588 contract specify Effect import and
adoption boundaries, not a global plain-TS factory naming ban. Plan 118 roadmap
row 0.3 names plugin/constructor enforcement but does not prescribe global scope;
its later lint tightening is local to converted scopes. No documented decided
global-scope requirement was found, so this repair applies the task's explicit
scope correction rather than changing the broader adoption policy.

```text
RED: plain TypeScript local make helper CLI regression — 1 failed
anti-slop-effect(no-service-constructor-imports):
Do not import Effect service constructor "makeLabel" into runtime code.
Expected exit 0; received 1.
GREEN: effect-import-policy.test.mjs — 12 passed
```

The same CLI suite continues to reject root/platform barrels, protected plain
zones, and production testing/unstable imports, while accepted deep/test imports
retain their prior oracle.

### Finding 3 (LOW) — BROAD MATCH REJECTED / LIMITATION RETAINED

The current manifest, frozen lockfile and installed-tree inventory contain no
`fast-check`/`msgpackr` package or package-alias/workspace grant of either. No
escape through such a package was demonstrated in the current supported graph.
Builders retain their canonical node_modules/bare-specifier checks and existing
Bun/pnpm resolution contracts. A basename/substring ban would falsely reject the
intentionally accepted project input `msgpackr/compat.ts`; that assertion is
unchanged and green.

Residual limitation: this in-memory guard recognizes package paths/specifiers,
not package.json identity. A future alias or workspace symlink whose bundled
realpath loses the canonical node_modules package name is not proven covered.
Address a reproduced supported-graph escape with identity-aware evidence rather
than guessed path matching. Bun compile's empty `outputs` remains an accepted
metafile property; no output-presence rule or full compile claim was added.

### Revision1 verification actually run

Environment: macOS arm64, Node `26.10.0` (not CI Node 24), pnpm `10.29.2`, Bun
`1.4.0`, TypeScript `6.0.3`, Oxlint `1.80.0`, Vitest `4.1.11`. pnpm was selected
on command-local PATH and `BUN_BIN` selected the exact cached 1.4.0 binary.

- **PASS** — `pnpm install --frozen-lockfile` in this worktree; no lock changes.
  Existing esbuild/protobufjs/@google/genai build-script warnings were not broadly
  approved. Effect is neither declared nor installed.
- **PASS** — five-file focused suite: **100 tests, no skips**; separately the six
  `src/extension-entry-loader.test.ts` tests. The earlier name-filtered real-Bun
  fixture run passed one test with 64 intentionally filtered tests; the final
  five-file run executed all 65 native-builder tests. Existing invalid-main
  fixtures emit Node DEP0128 warnings, without failures.
- **PASS** — `pnpm exec tsc --noEmit && pnpm build`; `pnpm lint` exits 0 with only
  the four existing `scratch/tui-audit/proto/gen.mjs` unused warnings.
  `node scripts/check-tsc-budget.mjs`: **1,536,374** instantiations versus baseline
  **1,353,836**, **1.13x**, limit **2,707,672**; no baseline reset.
- **PASS** — `pnpm build:bundles` (host + classic extension): host **971,337 bytes**,
  extension **153 inputs**. `git diff --check`, ignored/untracked `dist` checks,
  and unchanged package/pin/runtime-source checks pass.
- **NOT RUN — no heavy-check lease** — full unit suite, integration/zero-survivor,
  `build:native`/`test:native`, visual CI, and startup/perf comparison. CI Node 24,
  dependency audit, compatibility and unrelated report-only checks were not run.
  No current permitted gate failed after repairs; the red runs above are deliberate.

Reproduction uses the original five-file focused command above, followed by the
loader, typecheck/build, lint, compiler-budget and ordinary-bundle commands, with
pnpm 10.29.2 and `BUN_BIN` 1.4.0. No full native executable was built or executed.

### Prior-head full-suite failure — separate verification provenance

Read-only follow-up reviewed the old worktree's evidence continuation at
`/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-effect-guards/plans/120-spike/effect-guards.md`
and selected failure/summary excerpts in
`/tmp/sumocode-588-verification-vpuixOtp/05-full-default.log`.
Tested old source head: `26d635d6b89e8b93b51cfcb285fa5d32f9752897`.
Old branch's evidence-only head: `4f6c98bcc2b5a8f934568ecca169622e4161b352`.

**FAIL at that old source head:** default `pnpm test`, exit 1, **35 failed /
4,322 passed tests; 10 failed / 245 passed files**. A read-only path-limited Git
diff confirms all ten failed test files are untouched between approved base
`8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39` and the old source head.
That fact alone does not establish root cause or a baseline/revision regression.

The failures include non-timing assertions: global-hook `.build` fixture
contamination reported in the continuation, installed-native runner selection
instead of `bounded-terminal-runner.mjs`, Herdr executor call count 2 versus 1,
and chrome-worker missing-write/undefined-result/early-completion assertions.
They are **not load-only adjudicable**. Read-only triage worker 12 is investigating;
this revision makes no root-cause verdict, unrelated fix or oracle change.

This is a **prior-head failure**, not a full-suite pass/fail for revision1.
No failed file was rerun here, no serial full suite was attempted, and no heavy
lease was granted. The prior failure remains unresolved; revised-head full,
native, integration, visual and performance gates remain unrun.

### Follow-up actual Bun static-edge proof

At evidence-only head `62a2bdf774c44040ff07c52cca3ebde33811508c` (repair source
still `4400fd949b38fb143fafe9e58d7937bc217f9b22`), the permitted focused command
was rerun with `CI=1`, pnpm `10.29.2` and `BUN_BIN` selecting Bun `1.4.0`:

```bash
pnpm vitest run scripts/build-native.test.mjs -t 'Bun metafile contract' \
  --maxWorkers=1 --reporter=verbose
```

**PASS:** `resolves eager static edges and marks the lazy host edge as a dynamic
import`; one test passed, 64 deliberately name-filtered, exit 0. The test builds
an actual tiny Bun graph and asserts `main.ts` imports
`{ path: "preflight.ts", kind: "import-statement" }`, that the matching input key
exists, and `{ path: "host.ts", kind: "dynamic-import" }`; the public eager guard
accepts it. Existing successful-fixture teardown remains unchanged. This proves
the observed static/dynamic graph contract, not a retained full native metafile,
compiled artifact or evaluation timing. No source change or additional heavy
check was made for this evidence update; prior revision type/build/lint results
remain as recorded above.

### Revision1 review-ready gate

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`; no project
override found. Changed files were reread top-to-bottom after green checks.
Changed seam: build graph acceptance and repository lint acceptance.
Trace: native builder supplies entry/artifact/metafile → eager traversal resolves
main/preflight → a static graph miss throws with trace; the real Bun graph resolves
and passes. Separately Oxlint loads the registered plugin → import boundary stays
active → a plain local make import is accepted without imposing Layer semantics.

#### caller-knowledge

Callers still provide only the entry, artifact and graph. Resolution failure and
trace construction stay in the shared policy owner; no new caller normalization.

#### deletion

The existing guard is shared build policy. Removing it would scatter checks
across callers; the repair adds no module, wrapper or configurable layer.

#### ownership

Graph integrity belongs to `production-boundaries.mjs`; rule activation belongs
to `oxlint.config.ts`. Future Effect constructor scope belongs to its real adopter.

#### test-surface

Tests use the public guard, real pinned Bun metafile and actual Oxlint CLI, not
private exports or mocked internals. No existing test/assertion was weakened.

Simplification pass: one fail-closed branch, one removed global activation,
existing fixtures reused. No runtime/dependency/parser/platform abstraction.
Verification and intentional exceptions: permitted gates pass; heavy verification
and independent rereview remain coordinator-owned, with Node-version difference
and package-identity limitation explicitly recorded here. Hooks were disabled
command-locally for focused commits; no shared git configuration was changed.

**Next action:** independently rereview the exact revised publication head. Stop
at #588 candidate-ready; this evidence does not unlock #589 or approve adoption.
