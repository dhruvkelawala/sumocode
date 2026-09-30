# Owned native-test child isolation

**Owner approved the small test-helper isolation fix on 2026-09-30.**

Guard verifier 17 stopped before native execution at unchanged source candidate `3393198c5f97ae59ba6eed4a600d4377f30bb5ad`; evidence-only head `5a67dfee5e525a5baecb7803df8046b384b9a1c7`. Its Node 24 default unit run failed five untouched-file timeouts; whole files isolated passed and full serial passed 4,363 tests. Original/default failures are preserved. Native/integration/visual remain NOT RUN; read-only process zero matches is not a supervised native/integration verdict.

## Observed source risk, not an observed user-state write

`test/integration/native-contract.test.ts:86–102` builds native child environment through `buildSpawnEnv(process.env, { PI_BIN: "", ...options.env })`. Some fake-Pi post-adoption/test-gate cases omit `PI_CODING_AGENT_DIR`. The spawn helper allowlists HOME but drops ambient `PI_CODING_AGENT_DIR`/`SUMOCODE_STATE_DIR`; merely setting the outer process variable is insufficient.

`persistence.ts:187–190` defaults from `SUMOCODE_STATE_DIR` to `PI_CODING_AGENT_DIR/state`, then `homedir()/.pi/agent/state`. Chrome-cache path resolution creates a private directory and host hydration/shutdown can write state. No native execution or actual real-user write was observed in this stopped run.

## Approved minimal delta

1. Default affected native fixture children to a harness-owned private temporary agent directory, through the **actual final spawn environment**. Reuse existing owned-fixture/namespace helpers and preserve deliberate test-owned overrides. Audit all affected direct/native spawn paths for omission or unsafe inherited state overrides.
2. Keep HOME, user/global Git configuration, credential configuration, `GIT_CONFIG_COUNT`, production code, pins, installed releases and existing test assertions unchanged. No HOME/Git-config shim, copied credentials, private config edits, hidden preload, fake clearance or assertion weakening.
3. Add the smallest regression through the real public fixture/environment seam that fails on the missing default. Prove final child-state resolution is within the owned namespace before launching any native app; no initial red run against real state. No private-function export solely for tests or module mocking.
4. Scope is test-helper/setup code, its colocated regression where needed, and this evidence file. Stop/request scope if containment requires production changes or cannot be demonstrated. Existing fixture lifecycle may operate only on its owned resources; no manual cleanup or preflight fix/purge.
5. Candidate requires bounded independent review **before** native verification resumes. Source/API/native/visual execution remains coordinator-serialized. Future compiled native checks must select freshly built artifacts, preserve signing/containment/boundary ordering and produce their own supervised zero-survivor audit.

All production bytes must match the approved guard candidate; the test-only setup change receives its own exact commit/head and acceptance. Re-run relevant focused/static gates; do not describe a patched harness as the old unchanged tested tree. Record owned-root proof, actual spawn contexts, failures, skipped checks and private raw evidence. No merge, tag, release, golden promotion or upstream publication approval is granted.

## Implementation candidate — CANDIDATE-READY, independent review pending

Base: `5a67dfee5e525a5baecb7803df8046b384b9a1c7`.
Implementation and committed-check head: `bec2873f33323472f37feb8d16cd248f04dc684b`.
Implementation tree: `a07d6e99650d5ef30d02f82962f4a3dc095c93b1`.
Branch: `sumo/v08-native-fixture-isolation`.
Preserved worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-native-fixture-isolation`.
The subsequent evidence commit adds only this file; its exact head/tree are in the private evidence `final-identity.json`.

Read the parent contract at `/Users/sumodeus/code/sumocode/plans/120-spike/native-sandbox.md` in full, read-only; the approved contract above is retained here. Own AGENTS, DEV_LOOP, test-backend contract, Plan 116 harness documentation, revised effect-guards verification appendix and verifier 17's final identity were read. No parent checkout was written.

Changed paths: `test/integration/native-contract.test.ts` setup, `test/integration/spawn-pi-pty.ts` public environment boundary, its colocated test, and this evidence. Existing assertions and timeouts remain intact. No production, launcher, package, lint-policy, budget, golden, role or MCP changes.

### Actual environment flow and spawn inventory

`nativeSpawnEnv` allocates a private root using the existing native `tempRoot`/`tempRoots` lifecycle, then opts into `buildSpawnEnv`'s native-fixture policy. The final environment defaults `PI_CODING_AGENT_DIR` without inheriting the developer's agent/state paths. **It does not default `SUMOCODE_STATE_DIR`:** absent an explicit owned override, the unchanged application's `defaultActivityStateRoot` selects `<owned-agent>/state`; chrome selects `<owned-agent>/state/sumocode/chrome/v1/chrome-cache.json`. Thus the existing chrome-cache and terminal-store fixtures retain their deliberately supplied agent roots.

Direct calls also get owned diagnostic and temporary defaults. PTY evidence setup replaces diagnostics/TMPDIR with canonical harness-owned paths; the public regression executes that same evidence/auth setup without invoking any spawner. `spawnSupervisedPty` subsequently copies that env, stamps the signature and removes signing/run-ID keys; it does not alter PI/state/HOME. Fixture roots are created mode `0700` (existing tests may deliberately change their own modes); evidence metadata remains owner-only through the existing supervisor.

Inventory completed in the native contract:

1. `spawnNativePty` (including omitted-agent pre/post-adoption, pre-main, inert-hold, crashing-child and reload cases) and `runNative` now share the owned environment policy. Explicit chrome, terminal, dynamic-extension and helper-agent roots are preserved.
2. The standalone compiled Pi `--version` and fixture-installed `sumocode`/`sc` `--version` spawns use the same policy. No executable was run here.
3. The existing in-process compiled-extension provenance fixture already temporarily sets/restores its own agent/TMPDIR. Its setup now also bounds the higher-precedence state, account/config and diagnostics paths to its existing owned root, using its unchanged save/restore lifecycle. Its tool/command assertions are unchanged; this fixture was not executed here.
4. The two installer shell invocations are not app launches: both explicitly bind `SUMOCODE_INSTALL_PREFIX` to their own `tempRoot`. Read the full installer: it copies/links only beneath that prefix and does not execute the installed app. `codesign --verify --strict` is read-only. Neither installer nor codesign ran here.
5. Diagnostic CLI paths, prompt/task directories, provider logs, fake-Pi executables and reload files are already created from `tempRoot`; argv-based diagnostic precedence/unwritable-directory assertions were not changed. The env guard additionally covers all 17 inventoried write-path keys, including harness root/manifest, config, temp/cache, terminal-index gate, task response/exit/started/diag/control, exit-code, initial-prompt and reload-ready paths.

Unsafe explicit env paths throw before an app/spawn boundary. Validation follows the nearest existing ancestor's realpath, so an owned-looking symlink cannot escape; dangling symlinks fail closed. Raw `..` is rejected before normalization, which otherwise hides `owned/link/../outside`. Empty, whitespace-only, relative, NUL, sibling-prefix and outside-root paths are rejected. Known owned overrides remain unchanged; run-owned TMPDIR/cache pinning retains its existing precedence.

### Test-first and actual verification

Private evidence: `/tmp/sumocode-588-native-fixture-vKHXfkvB` (mode `0700`). Commands/exits/raw logs are retained separately; no values/credentials were dumped. Cached command-local Node **24.15.0**, pnpm **10.29.2**, TypeScript **6.0.3**, Vitest **4.1.11**, Oxlint **1.80.0**. Bun was not needed or invoked. Frozen install passed; the existing ignored build-script warnings were not broadly approved.

Every gate used:

```bash
env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID LEFTHOOK=0 CI=1 \
  PATH="/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin:/Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/.bin:$PATH" \
  <command>
```

Four deliberate RED Vitest commands, all env-only and before the corresponding repair:

- `01-red-default`: **1 failed / 73 filtered**; `expected undefined` for final `PI_CODING_AGENT_DIR`. `02-green-default`: **1 passed / 73 filtered**.
- `03-red-overrides`: **1 failed / 2 passed / 73 filtered**; `PI_CODING_AGENT_DIR: expected [Function] to throw an error`. `04-green-overrides`: **3 passed / 73 filtered**.
- `09-red-raw-traversal`: **1 failed / 4 passed / 73 filtered**; expected traversal rejection, no throw.
- `18-red-harness-paths`: **1 failed / 4 passed / 73 filtered**; `SUMOCODE_INTEGRATION_RUN_ROOT: expected [Function] to throw an error`.

Seven GREEN Vitest commands total (`02`, `04`, `05`, `11`, `15`, `19`, `23`); **11 Vitest commands total**, not eleven different suites. Each later green included the prior repairs. Final `23-committed-focused` at the implementation head: **20 passed / 58 intentionally filtered / 1 file**, including all five new env regressions, all six existing env tests, three fake-spawn lifecycle tests, two exit predicates and four headless screen-match tests. The negative matrix covers **17 keys × 9 unsafe values**, plus raw symlink traversal. No real PTY/app was spawned; the focused audit reports **0 survivors across 0 registered groups**, not native/integration acceptance.

Final reproduction:

```bash
pnpm vitest run test/integration/spawn-pi-pty.test.ts \
  -t '^(buildSpawnEnv|native fixture environment isolation|spawnPiPty agent state isolation|isUnexpectedPtyFailure|waitForScreenText)' --maxWorkers=1
pnpm exec tsc --noEmit && pnpm build
pnpm lint
```

**PASS** final required typecheck/build (`24-committed-types-build`), lint (`25-committed-lint`, four existing scratch unused warnings), and `git diff --check`.

**FAIL, demonstrated baseline limitation:** an additional strict static probe explicitly including these integration files reports **11 errors**. Repository tsconfig intentionally includes `src/**`, not integration tests. An immutable `git archive` of this exact base, using the same dependencies and temporary probe config, reports the identical 11 errors after path/line normalization: stale harness declarations/missing `.mjs` declarations and the native provenance fixture's existing `never[]` call typing. Logs `08`/`14`/`22` preserve current probes, `10` preserves base. No declarations, test typing, tsconfig, assertions or production code were changed to hide this. This supplementary probe is not claimed green.

### Preservation and tradeoffs

All **589** tracked files under `src/**`, `scripts/**`, `bin/**`, plus host launcher and package/lock/Bun pins hash-identically to source candidate `3393198c5f97ae59ba6eed4a600d4377f30bb5ad`. Aggregate SHA-256 over the sorted path/hash JSON is `106f176542576c6581ff7bb984d255951b52428ef222c169ba71d662fcc6eec8`. Per-file hashes and zero-mismatch results are retained in `before-audit.json` and `final-audit.json`. Repair source remains `4400fd949b38fb143fafe9e58d7937bc217f9b22`; approved runtime remains `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39`, Pi **0.99.1**.

The real-process env regression compares HOME and the entire parent environment using booleans only; synthetic Git-count keys additionally prove no parent mutation. The allowlist itself is unchanged: it already drops ambient Git env overrides, so this fix neither introduces a Git-config shim nor starts forwarding/copying credentials. Read-only metadata checks for shared local/default-global/XDG Git config are unchanged across final checks (inode/device/mode/size/mtime/ctime only; no contents or private paths recorded). Actual `GIT_CONFIG_COUNT` is unset and was never assigned. No `git config`, HOME override, global tool installation, installed-native execution/mutation or hidden preload was used. Local commits used command-local `LEFTHOOK=0`; no shared Git configuration changed.

Tradeoff: an opt-in option on the existing public env builder keeps every non-native caller's behavior unchanged and avoids a generic sandbox/backend or private test-only export. Roots come from the existing native fixture registry (and trusted outer harness run root), not copied user directories. This is bounded fixture env containment, **not an OS/filesystem sandbox**: it does not prove protection against an adversarial concurrent symlink swap, arbitrary future tool writes, or a newly added write-path override absent from the inventory. Current argv paths were source-audited, not runtime-tested; future write destinations must extend the fixture inventory. Raw `..` overrides are conservatively refused even when a particular normalized path would remain owned.

Only normal owned fixture lifecycle ran. No manual kill/cleanup, preflight fix/purge, old evidence deletion, worktree/branch removal, golden promotion or publication. Earlier old 35-failure/default five-timeout/serial-pass records remain unchanged in `effect-guards.md` and their original retained roots; this candidate does not turn any default full-suite red into green.

### Review-ready gate

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`; no project override exists. Changed seam: the public native-fixture child environment, with native helper lifecycle ownership. Trace: omitted agent override → `tempRoot` → opt-in final-env default/validation → owned evidence diagnostics/temp → unchanged supervised spawn env. Changed files were reread top-to-bottom after green checks.

#### caller-knowledge

Native setup supplies its existing owned-root registry; callers need not know application fallback or path canonicalization. Existing two-argument env users remain unchanged.

#### deletion

Deleting the bounded env policy would restore the missing-default bug or spread safety checks across PTY/direct/version spawns. No service/factory/sandbox module was added.

#### ownership

Native `tempRoots` owns lifetime and cleanup; the existing public env boundary owns defaults and validation; the supervisor still owns evidence, authentication and process registration.

#### test-surface

Tests exercise the public env/evidence/auth boundaries, not a private export or module mock. Red probes cannot reach an app; existing assertions and test gates remain untouched.

Simplification pass: reuse existing fixture lifecycle and stdlib paths/fs; remove a redundant computed fallback-path assertion; no dependencies, generic backend, process interceptor or production changes. Verification exceptions: supplementary baseline integration typing errors above and coordinator-prohibited heavy gates below. This is a completion gate, not an independent review verdict.

**NOT RUN:** `build:native`/`test:native`, native binaries/compiled extension execution, integration/preflight/real PTYs, source app/runtime launch, runtime visuals/visual CI/goldens, default/full/serial unit suites, bundles, compiler-budget/performance sampling or baseline changes. No heavy lease acquired. Native/integration supervised zero-survivor verdicts are not produced.

**Next action:** coordinator obtain independent review of the exact candidate head before authorizing a heavy lease or any native/app verification. Stop here; #589 remains blocked.
