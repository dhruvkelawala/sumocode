# Native fixture account-config default — CANDIDATE-READY

Test-only candidate; independent exact-head review and separately leased lane trace/runtime remain required. This is not app privacy clearance, an every-child guarantee, or an OS sandbox. Worker40's production memory policy remains separate and untouched.

## Identities and bounded delta

Base: `32828a2ed6519a95380ee43cb1be7ce86698da11`, tree `696d8c85eeccfc801cbd3557810d540cb43a2ef4`.
Approved source: `0fd30c9406d7a5031b593a740474486024554821`, tree `f4231f7276ba119ff2f9b58e83893c2d2c1aa292`.
Implementation: `afa5189e7f1e3985782d5d120ef96abe0ef72255`, tree `8a1515a17ede3a4554a670789caf999fc3588224`.
Branch: `sumo/v08-native-config-isolation`.
Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-native-config-isolation`.
The evidence-only successor adds this document; exact final head/tree and final check exits are retained in `final-identity.json` under the raw evidence root below.

Changed paths only:

- `test/integration/spawn-pi-pty.ts`: one default assignment plus its invariant comment, inside `buildSpawnEnv`'s existing optional native-fixture branch.
- `test/integration/spawn-pi-pty.test.ts`: eight new public-interface cases and one added config assertion in the existing real-parent evidence/auth test.
- `plans/120-spike/native-account-config-evidence.md`: this record.

Read own AGENTS/DEV_LOOP and the full parent contracts read-only at `/Users/sumodeus/code/sumocode/plans/120-spike/{native-config-isolation,native-sandbox-review,runtime-proof-prerequisites}.md`. No parent edits. Native-contract setup/assertions needed no changes.

## Public ownership proof and negative controls

Trace: allowlisted parent → explicit overrides → existing run-root temp/cache pins → selected agent fallback → omitted config becomes `<effective PI_CODING_AGENT_DIR>/config` → unchanged 17-key owned-path validation → public evidence construction → diagnostic/signature assignment → public harness auth. No spawner, fake spawner, native executable or app was invoked by the selected cases. Supervisor's later spawn-env copy only stamps/removes harness identity fields; it does not replace agent/config. That source trace was inspected, not executed.

- Absent/hostile ambient config defaults owned after real public evidence/auth construction. Hostile ambient config is still dropped by the existing allowlist. An explicit owned agent override, not the unused fixture fallback agent, controls the default. A deliberately separate owned config override is preserved. The existing `process.env` test additionally proves config survives evidence/auth setup while HOME and the parent remain unchanged (boolean comparisons avoid disclosing ambient values).
- Existing agent/state/diagnostic assertions and all cases are intact. State remains unset so production chrome/activity selects `<owned-agent>/state`. Existing run-root temp/cache pinning, diagnostic precedence, credential/debug scrubbing, HOME and Git env semantics remain unchanged. Synthetic GIT_CONFIG_COUNT/key/value remain scrubbed as before; their parent object is unchanged. Actual GIT_CONFIG_COUNT was unset and never assigned. No HOME override or Git-config shim was used.
- Existing negative matrix passes **17 keys × 9 values**: empty, whitespace, relative, NUL, outside root, sibling-prefix, normalized escape, ancestor symlink escape and dangling symlink. Existing raw diagnostic symlink/`..` rejection remains intact. New checks reject both escaping and dangling **default config subdirs**, plus raw config symlink/`..` traversal, before any spawn.
- The unchanged public accounts loader receives only synthetic env/deps/files. A pre-loader assertion fails closed if config is not the owned default. Missing config falls back to the selected owned agent's synthetic `claude-accounts.json`; adding the owned regular config source makes the loader create its managed link (and old-file backup) within that same agent. `readlink` and canonical realpath assertions prove the link points to `<selected-owned-agent>/config/claude-accounts.json`; the created config dir is mode 0700. No auth store, private HOME/config, credential, daemon, install or request was accessed.
- Ordinary two-argument/non-native calls still leave config/agent/state/diagnostics omitted, scrub ambient config, and preserve explicitly supplied empty, relative and outside config values without native validation. The separate existing allowlist/run-root interface control also passes.

Tradeoffs: reuse the existing env boundary, owned-root registry, stdlib path joining and validation; no new helper/backend/export/dependency. Do not eagerly create the default config subdir: missing owned descendants are already validated through their nearest existing ancestor, and consumers own file creation. Default config follows the selected agent; existing diagnostic/temp fallbacks deliberately still use the fixture fallback agent, and run-root pins still win. Explicit config need only be within a registered owned root, not necessarily inside the selected agent. TOCTOU and residual HOME-rooted features remain uncontained; this change does not fix lovely-web/tabs/persona or certify memory/runtime lanes.

## Red → green and verification

Raw evidence: `/tmp/sumocode-native-config-followup-CQyWHw` (mode 0700). Command, exit and raw log files are preserved, including failures. Every gate/commit used command-local real `LEFTHOOK=0`, `CI=1`, flags-first env normalization and cached Node **24.15.0** / pnpm **10.29.2**:

```bash
env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID LEFTHOOK=0 CI=1 \
  PATH="/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin:/Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/.bin:$PATH" \
  <command>
```

Own cached frozen **offline** install passed (`00-install`); no age bypass or blanket build-script approval. Existing ignored-build warnings were retained. TypeScript **6.0.3**, Vitest **4.1.11**, Oxlint **1.80.0**, Pi **0.99.1**; no Bun or compiled artifact was needed. Initial system Node26/pnpm12 probes ran no gates.

`01-red-config`, before the helper edit: **6 failed / 2 passed / 78 filtered**. Failures were missing defaults (three construction cases and the guarded loader case) and missing default-config symlink rejection (two cases). The deliberate owned override and non-native control already passed. The loader never ran on this red path because its owned-config assertion stopped first. `02-green-config`: **8 passed / 78 filtered** after the two-line helper delta.

Final bounded reproduction (also repeated on the evidence successor; see final identity logs):

```bash
pnpm vitest run --maxWorkers=1 \
  -t '^(buildSpawnEnv|native fixture account-config isolation|native fixture environment isolation|isUnexpectedPtyFailure|waitForScreenText)' \
  test/integration/spawn-pi-pty.test.ts
pnpm vitest run --maxWorkers=1 \
  -t '^verification harness v2 seam constructs child env from an allowlist and pins run-scoped state$' \
  test/integration/verification-harness.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm lint
git diff --check
```

**PASS:** focused regression **25 passed / 61 intentionally filtered / 1 file**, plus run-root control **1 passed / 82 filtered / 1 file**; required typecheck/build; final lint; diff check. All spawner cases, including fake-spawner lifecycle cases, were filtered. The first lint attempt (`05-lint`) failed on two new conditional empty-object spreads; these were replaced with explicit property assignments. Final lint (`10-lint-final`) passes with four existing unused warnings in `scratch/tui-audit/proto/gen.mjs`. No lint rule/config change.

**FAIL, baseline limitation unchanged:** normal `tsconfig.json` includes `src/**` and excludes integration files; ordinary typecheck/build does not type these changed tests. Supplementary strict configs explicitly include helper/test/native-contract. Current `07-current-fixture-types` and an immutable archive of this exact base `08-base-fixture-types` each produce **11 identical errors**, exit 2. Path-normalized logs are byte-identical (`fixture-types-comparison.json`): stale harness constant declarations, absent `.mjs` declarations, dependent env indexing and native provenance `never[]` typing. No new error, declaration patch, assertion weakening or tsconfig workaround was introduced. This probe is not green.

## Preservation and settlement

`production-pin-equality.json` records **593 protected tracked paths**, including every `src/**`, `scripts/**`, `bin/**` file, host launcher, package/lock/Bun pin, native-contract test and verification configs. Each hashes identically to both base and approved source: **zero mismatches**. Native-contract state/chrome/diagnostic assertions and timeouts are byte-identical. Removing only the added describe/config assertion/import augmentation restores the exact base helper-test text (`existing-cases-preserved.txt`); no old case, assertion or timeout was rewritten. All tracked differences are confined to the three paths above; no production accounts/memory/host/native/launcher/guard/pin change. Parent, installed releases, `.build`, history, prior evidence, worktrees and branches were preserved; only ordinary existing test-owned teardown ran. The old 35-failure/default five-timeout/serial 4,363 evidence retains its own historical status; no current full-suite green is claimed.

All commands settled; no background job or heavy lease was acquired. **0 app launches, 0 real PTYs, 0 fake-spawner calls, 0 app process groups/registrations.** The selected public evidence/auth cases mint focused harness namespaces; existing automatic teardown reports **0 survivors across 0 registered groups**. That empty focused result is not a native/integration audit or runtime success verdict. No manual cleanup, preflight fix/purge, process scan, push/merge/tag/release or golden promotion occurred.

**NOT RUN:** full/default/serial unit suites; source app/print turn; PTY/spawner/launcher runtime; integration preflight success lane or full integration; native build/contracts/binaries/compiled extension; bundles/compatibility matrix; visual drivers/review/CI/goldens/Bible rendering; performance/compiler budgets; dependency/dead-code/security/runtime audits; private auth/config/daemon checks. Runtime supervised zero-survivor and actual lane privacy proofs remain absent.

## Review-ready gate

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (no project override).
Changed seam: public optional native-fixture env construction.
Trace: explicit selected owned agent → config default/override → existing path validation → public evidence/auth → unchanged accounts loader fallback/link.
Both changed code files were reread top-to-bottom after green checks.

### caller-knowledge

Native callers still supply only owned agent/roots; config fallback policy belongs to the existing builder, not every caller. Non-native interface and behavior are unchanged.

### deletion

Removing the assignment restores the HOME account-config fallback; duplicating it across native PTY/direct/version callers is unnecessary. No abstraction or speculative surface was added.

### ownership

Existing native fixture roots own lifetime; builder owns default/validation; supervisor owns auth/evidence; accounts owns fallback/link behavior. No production ownership moved.

### test-surface

Tests exercise public env/evidence/auth and accounts interfaces, with owned synthetic files and no mock/private export/spawner. Old assertions and timeout values are preserved.

Simplification pass: keep one assignment and one hidden-side-effect comment; reuse old matrix and existing lifecycle; replace rejected conditional spreads; do not rewrite setup or production code. Verification and exceptions: bounded allowed gates passed; unchanged supplemental typing failure and all prohibited runtime gates explicitly recorded above. No unresolved changed-scope design violation. This report is not independent review approval.

**Next action:** independent review of the exact final helper/evidence head; only then compose accepted prerequisites and renew lane-specific final-env/startup privacy traces before a separately authorized runtime lease. Stop CANDIDATE-READY; app continuation remains BLOCKED.
