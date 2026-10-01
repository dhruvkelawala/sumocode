# D88 S1 — stopped at pristine declaration baseline

**INCOMPLETE / STOP. No ESM extraction was performed.** The permitted auxiliary declaration additions did not make the original supervisor typecheck. Declaration generation used `noEmitOnError: true`, failed, and emitted no declarations. Neither facade was replaced; no admission/core MJS, generated module declarations, or facade config was created. No runtime behavior changed, no workload was imported, and no reviewer was launched.

## Manifest and authority

```text
branch: sumo/v08-canonical-esm-extraction
BASE: 3642b683e889727e2ac8fcdb4b918095a2af5b40
tree: 69b7085f45a95d5b34851ef433edb72affca55a3
accepted SOURCE ancestor: 88c38b535c75e43f771af508d600248f80556436
tree: 6930b3d74d856a2c97d52fe28afbb73f7dfaafe9
partial source/config HEAD: 0019a7483a69b486578e7534baee6073b0b3c0c9
tree: 8d0d27b5e7e520b1921bf4e46559b3851246ca7f
source commit purpose: preserve the three permitted auxiliary declaration additions,
                     explicitly NOT a completed S1 conversion
report commit purpose: new evidence only, sole child of the partial source HEAD
```

The evidence commit cannot contain its own content-addressed hash. Its exact HEAD/tree and final clean status are recorded after commit in `.local/canonical-esm/evidence-tree.stdout.raw.log`, `.local/canonical-esm/final-status.stdout.raw.log`, and `.local/canonical-esm/final-manifest.json`. Resolve it independently as the sole report-only child of the source HEAD on the branch above. This report is not approval of that child or of the preliminary declarations.

Authoritative grant read completely at **`/Users/sumodeus/code/sumocode/plans/120-spike/canonical-esm-extraction-contract.md`**, 11,495 bytes, SHA256 `d87acf45365fc3d56c16bdaae4648d43cfc87ca74bdf4002a7f32f54ae54963b`. No other parent dirty plans or private historical sessions were read. The optional historic acceptance document was not needed/read. Initial Git checks returned the exact branch/base/tree above and an empty status; a later static check verified the accepted ancestor and tree. No fetch, pick, merge, rebase, reset, stash, amendment, history rewrite, cleanup, push, PR, parent apply, or external `109a769` adoption occurred.

The ten allowed source/config paths remain the contract's closed set:

```text
test/integration/harness-admission.ts
test/integration/harness-supervisor.ts
test/integration/harness-admission.mjs
test/integration/harness-admission.d.mts
test/integration/harness-supervisor-core.mjs
test/integration/harness-supervisor-core.d.mts
scripts/lib/integration-harness-constants.d.mts
scripts/lib/integration-harness-auth.d.mts
scripts/preflight-integration.d.mts
tsconfig.integration-facades.json
```

Only the three `scripts/` declaration paths changed. The separate report adds only this new evidence path. Owned ignored tooling artifacts remain under `.local/canonical-esm/`; they were not committed or removed. Existing tests are untouched.

## Actual static RED sequence and blocker

Commands were invoked through `.local/canonical-esm/tool.py`; each invocation preserves full ordered `env -u`/assignment/argv/cwd in `<label>.command.json`, exact stdout/stderr in `<label>.{stdout,stderr}.raw.log`, and exit code in `<label>.exit`. No failed command was overwritten or silently retried.

1. `narrow-red`: `pnpm exec tsc --noEmit --project .local/canonical-esm/narrow-original.json --pretty false`, exit **2**, **62 actual diagnostics** before auxiliary changes. This strict, two-file config inherited the root settings, with local incremental disabled and `include: []`. It did not load Node ambient types from the nested config location. Preserve this failure rather than substituting the later result.
2. `narrow-red-node`: same command with `narrow-original-node.json`, exit **2**, **8 actual diagnostics**. This separately retained config explicitly adds the installed `types: ["node"]`, without changing root bytes/strictness/allowJs/skipLibCheck. Four diagnostics identify the two absent constants and missing auth/preflight declarations; four TS7053 diagnostics concern indexing the inferred spawn env. All locations are in the original supervisor, not unrelated source.
3. Add only the two actual constants, declarations for both actual auth functions, and declarations for all six actual preflight exports. Original admission and supervisor TS remain byte-identical to BASE.
4. `declarations-baseline`: `pnpm exec tsc --project .local/canonical-esm/declarations-original-node.json --pretty false`, exit **1**, **4 diagnostics**, **no output declarations**. The owned config overrides `noEmit: false`, `incremental: false`, `declaration: true`, `emitDeclarationOnly: true`, `noEmitOnError: true`, and owned `outDir`/original integration `rootDir`; the same original two files and strict root options remain inputs. `narrow-original-green` (a command label, NOT a passing result) subsequently invokes the Node-aware no-emit config, exit **2**, the same **4 diagnostics**. That label was not renamed after failure.

The declaration/no-emit blocker is exactly:

```text
test/integration/harness-supervisor.ts(463,13): error TS2551: Property 'SUMOCODE_HARNESS_SIGNING_KEY' does not exist on type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'. Did you mean 'SUMOCODE_HARNESS_SIGNATURE'?
test/integration/harness-supervisor.ts(464,9): error TS7053: Element implicitly has an 'any' type because expression of type '"SUMOCODE_HARNESS_RUN_ID"' can't be used to index type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'.
  Property 'SUMOCODE_HARNESS_RUN_ID' does not exist on type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'.
test/integration/harness-supervisor.ts(552,13): error TS2551: Property 'SUMOCODE_HARNESS_SIGNING_KEY' does not exist on type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'. Did you mean 'SUMOCODE_HARNESS_SIGNATURE'?
test/integration/harness-supervisor.ts(553,9): error TS7053: Element implicitly has an 'any' type because expression of type '"SUMOCODE_HARNESS_RUN_ID"' can't be used to index type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'.
  Property 'SUMOCODE_HARNESS_RUN_ID' does not exist on type '{ SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2"; }'.
```

Both spawn functions infer `const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE }`. TypeScript reports the two following key deletions against the inferred object shape. Runtime deletion semantics were not changed. No cast, broad-any signature, original TS annotation, ambient fake module, strictness waiver, noCheck, or error-emitted declaration was used to evade this blocker. An exact generated-declaration equality proof is therefore unavailable. **RED→GREEN was not achieved.**

## Source trace and preliminary declaration contracts

Read both original TS modules completely, all of `scripts/preflight-integration.mjs`, auth/constants implementation and existing constants declaration, all 1,707 lines of the direct preflight/auth TS consumer `verification-harness.test.ts`, and the full PTY adapter/admission test/focused fixture/real-recovery fixture. Direct caller inventory and bounded import/call/type-use excerpts are retained in `caller-inventory.json` and `caller-contracts.raw.log`; other direct tests were traced at their public call sites, not claimed to have been read end-to-end. Read-only caller snapshots remain owned artifacts.

1. Existing callers retain literal `.js` imports resolving to the TS seams. RPC/extension/terminal tests use `spawnSupervisedProcess`/`SupervisedProcess`; PTY adapter, native test, reload test, and PTY tests use evidence/auth, `spawnSupervisedPty`, exit recording and readiness. Retention/recovery also use `supervisePtyProcess`. One test imports the supervisor only for its focused lifecycle hook. No caller imports a new core; no callers were edited.
2. Original supervisor eagerly imports `node-pty`, admission, constants, auth and preflight, plus Vitest `afterAll`. One module owns fallback root/token/run-id/signing-key, sequence and focused registration map. Allocation is lazy through `harnessRoot`/`harnessAuth`; auth and registration precede admission release. The original final `afterAll(async () => {...})` retains its complete body and registration site. These are source facts, not exercised lifecycle guarantees.
3. Admission imports only Node builtins; its literal `new URL("./fixtures/harness-admission.cjs", import.meta.url)` remains adjacent to the unchanged bootstrap. Its socket, keys, release/cancel closures and all pre-exec semantics were read but never invoked.
4. Preliminary auth declarations expose exactly `signSpawnRegistration` and `spawnRegistrationHmacIsValid`. Signing serializes pid/pgid/processStart/ownerPid/ownerProcessStart/runId and does not validate those tuple values. Local optional `unknown` fields model untrusted/incomplete tuples used by actual consumers; validation of run id/key/HMAC is not a tuple identity certificate. No runtime export/type mock was added.
5. Preliminary preflight declarations cover **all six exports**: `processRows`, `liveProcessStart`, `inspectIntegrationPreflight`, `reapHarnessProcessGroup`, `fixIntegrationPreflight`, `runIntegrationPreflight`. Inspection options include root/tempRoot, bare rows or table, env; reaping includes fresh table/current group/start/kill/wait options, validated untrusted identity inputs, and exited/reaped/survived/unverified returns; fix includes table/rows/readRows/current group/kill/wait/purge, refusal or undefined; CLI-facing function includes fix/purge booleans and boolean result. Process rows expose public scrubbed command, never the private raw-command symbol. These declarations are preliminary and unreviewed, not whole-integration API certification.

No new callbacks, registry, ledger, framework, generic parser, duplicate runner/supervisor/driver, or state owner was committed. There is **no converted core**, hence no actual facade→core singleton/hook timing proof to claim. The planned exact strip/specifier/hook transformation was not attempted after the declaration gate failed.

## Tool provenance, environment and import bounds

Cached authority metadata and digests passed before compiler/install invocation:

```text
Node /Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin/node
119944608 bytes; SHA256 3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32
node --version: v24.15.0, exit 0
pnpm /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs
1102 bytes; SHA256 b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9
pnpm --version: 10.29.2, exit 0
cached installed TypeScript: 6.0.3
lib/_tsc.js: 6239091 bytes; SHA256 1c59e77a54b186ec43fa7f3e0d3c4bb15ca5eb5ba43e96b1d3a267139eddd3e3
```

Initially no local node_modules existed. The **one** authorized install ran `pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /Users/sumodeus/Library/pnpm/store --reporter append-only`, exit **0**: resolved/reused **337**, downloaded **0**, scripts ignored. No downloads, engine/version fallback, age bypass, native build or package workload execution. Metadata/stat-only checks found no store server.json; no daemon was contacted. Lock/package bytes remain unchanged. Cache install packages were not subsequently imported as applications.

Before cached tools, created owned agent/state/config/diag/tmp/cache directories and empty npmrc, plus owned tool PATH links. `tool.py` constructs `env -u` before assignments, scrubs ambient PI/SUMO/HERDR/NODE/NPM/PNPM/XDG/Bun/Vitest/Vite/ts-node prefixes, PATH/shell injection/temp variables and credential-name patterns, then sets owned paths, empty user/global npm configs, owned compile/npm caches, `LEFTHOOK=0`, ignore-scripts and disables package-manager switching. It inspects variable **names**, not secret values. HOME/Git/GIT_CONFIG_COUNT are deliberately unchanged and their values are not logged. Exact removed names and assignments are preserved in command JSON, not summarized as an OS sandbox. The initial mkdir/Git metadata command used a narrower explicit `env -u` set; plain Bash/Python file inventories were not all passed through this wrapper. Thus this report does **not** claim uniform process-environment scrubbing of every harness file operation or reproduce prior61's environment receipt. No secret/private configuration/session content was intentionally read or logged.

Source tracing of pnpm covered bin→bundled dist, config loading/user/global npmrc, owned XDG/PNPM_HOME, hook loading and store connection branches. Empty config overrides, absence of local/workspace rc/hooks, `--ignore-pnpmfile` and absent store server bound the used install path. TypeScript bin→tsc shim→`_tsc.js` uses builtins and owned compile cache; compiler source trace is retained in `tsc-tool-trace.raw.log`. No watch/profile/plugin mode was requested; TS imports are resolved as source/declarations, not evaluated repository modules. This is a bounded source inspection, **not dynamic filesystem/syscall auditing**. Oxlint config was read, but lint tool/plugin import tracing was not completed and lint was not invoked after STOP. No unsupported Node API probe occurred; the strip API itself was never invoked.

## Protected-byte and artifact proofs

`static-proof-v2`, exit **0**, verifies pinned Git identities, ancestor, and that the sole tracked difference before staging is the constants declaration, with only the two permitted untracked declaration paths. All other tracked paths, including all tests, selectors/configs, runtime helpers, bootstraps, runner tests and pins, remain unchanged. `protected.json` retains original SHA256/byte lengths for every tracked MJS/CJS and explicitly protected root/TS inputs, tied to that Git diff proof.

```text
original admission TS: 1664 bytes
61a45cd0fde8748325c5d2fa678df380b086becc36300bd04839dc50de9180c0
original supervisor TS: 24157 bytes
9f369d15f5f73b25bb8f8a9857d73b0fd1a3bab77ce0eb0b61e8ebf729142a9a
preflight full MJS: 37967 bytes
562c25be28fb76675ad79b208fb3f3bf63f4c639d8ed34a871a0ba0ce753597d
protected reaper window: byte offset 21987, length 10106
cf3f2ddebeec024201a8a4d4a4dc0237a558d93e6ddeb0e8804ca568df8e5c86
auth MJS:
63027275d45036aef09800292f224f28cf73847d0a7eadfe21cf13e617b811ee
constants MJS:
5308d71fc2328b99dc7d83e9a428a919ad216a843a1637c4f5ed5a8400f01a85
runner MJS:
ff898139e49baa9d2042f1041bd3a774e87469634eea8270a6b7b97cf97c2727
runner test MJS:
1689392b7ec308a49ade6ebdcd5e02f8617d23e59b6f799ce97f5ab42f3164ac
admission CJS:
7dfaff29719877a71a43b16590e824096dcd4771b471307d5927b2a115878ad3
DEV_LOOP.md:
357ccb735b85d0970754bd5b31d25daa9e619b2b341759b07b9e2c80d9ed5441
package.json:
fd801f64662fda1405cde5516ba94bc43029886d49e6be58739eb783bb9200ca
pnpm-lock.yaml:
d26fa61985b54bb2be474463794ff5d4ded738fef7d6f8e6403a23d99696f048
tsconfig.json:
af9267bcfebdb33b7117b4b84aa5846a97a2055618ad075cc0464e97ad589f2f
partial constants declaration:
dc1cecfbf0df701a66f67bb361a6d8f1210dd566b47500984de833425f2ac18d
partial auth declaration:
f84742bb495d648aca1b34f35192b3c515850aa103a9f965d4760890975d3c88
partial preflight declaration:
494f7b4221dfd9c423e2ec6241743118c4527d5bf9aad4eb90fb927712556fad
```

The first owned `static-proof` script failed, exit **1**, on `Path.read_bytes()` of tracked directory symlink `.claude/skills/effect` (`IsADirectoryError`). Preserve the failed script and raw traceback; it produced no PASS manifest. The separately named v2 proof uses Git's tracked-diff comparison, avoids following symlink targets, and hashes selected pristine Git blobs instead of indiscriminately opening tracked paths. This proof-script correction changed no repository source. Exact reaper-window hash was located using raw 10,106-byte windows without trimming/normalization; `reaper-window-proof.json` records it.

Original TS snapshots, both initial and Node-aware temporary configs, declaration options, tool/import metadata, commands, all intermediate failures and raw logs remain in the owned directory. `artifact-hashes.json` indexes their lossless hashes. Erasure outputs, expected core/admission bytes, facade/declaration outputs and their hashes are **NOT PRODUCED**. No formatter, whitespace collapse, trim, newline/AST normalization or raw TS→MJS move was used. `diff-check` and `staged-check` exited **0**; final diff/status receipts are post-commit artifacts. Git commits used the scrubbed wrapper, `LEFTHOOK=0`, owned empty `core.hooksPath`, and `--no-gpg-sign`, so no app hook/reviewer was spawned.

## Review-ready gate and tradeoffs

Contract: D88 above governs; read full AGENTS.md and DEV_LOOP.md, review-ready skill and bundled `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`, full ponytail/commit/TDD skill plus tests/mocking guidance. D88 overrides behavioral TDD/full verification/publication. No other project code-quality file was found in the documented candidate paths.

1. **Caller-knowledge:** preliminary declarations describe existing owning module contracts; callers are not asked to switch imports, manage a new lifecycle or understand a new registry. Complete generated old supervisor signatures remain unproved because baseline generation failed.
2. **Deletion:** removing these auxiliary declarations would restore implicit-any/missing-export diagnostics, not remove runtime complexity. The task is mechanical typing, not behavioral simplification; no duplicate runtime implementation was introduced.
3. **Ownership:** constants types stay beside constants; tuple/auth types stay beside auth; inspection/reaping/fix options and returns stay beside preflight. Runtime state/authority remains exclusively in the original modules. No new exported type framework or any escape was introduced.
4. **Test-surface:** only static strict compiler and Git/byte/export/source checks were used. Existing tests/assertions remain unchanged. Behavioral tests are a deliberate D88 exception, not replaced by invented test counts or a runtime PASS.
5. **Simplification/verification:** reread all three changed declarations after the failed check. Kept only actual exports and small local owning contract types, not a configurable driver or wrapper layer. Preserve exact original bodies instead of repairing them or weakening the type gate. **Gate NOT READY:** no GREEN/declaration equality/conversion proof. The only follow-up activity after this blocker was preserving/proving/reporting the partial artifacts, not continuing implementation.

Tradeoffs are intentional: retained unreviewed auxiliary declarations in one explicitly partial source commit to keep the preserved branch clean and auditable, rather than discard failures or rewrite history. Used explicit installed Node ambient types only in separate owned temporary configs, not root changes. Retained optional untrusted tuple fields to avoid claiming HMAC serialization validates malicious fixtures. Did not broaden constants or annotate the original env to force a baseline success. A complete facade typing config and extraction must await a fresh coordinator decision/review, not be built atop an unproved baseline.

## Verification boundaries and reserved STOPs

Authorized static execution completed only as reported above. Root `pnpm exec tsc --noEmit && pnpm build`, targeted lint, MJS `node --check`, strip-byte equality, generated-declaration equality and narrow facade GREEN are **NOT RUN** after the declaration STOP. No positive claim covers those gates. The historical **104** tests were **not rerun**; no new behavioral count is asserted.

**NOT RUN / no permission:** whole integration-API typing (including verification-harness callers), SDK load/jiti/consumer whole-artifact proof, eager native PTY import, signed live admission, actual zero-survivor audit, actual app/main/default wait, all Vitest/full/integration/native/visual/performance/provider/MCP/Herdr/browser/preflight workloads. No socket/server/key/PID grant/spawn/ps/kill0/signal/readiness/retention/finalization was exercised. No live quiescence or whole-process coverage claim.

C1/C2 accepted source188 controls remain unchanged; original a5/869 and previous rejected worktree logs remain preserved historical, not authority. C3 builds/helpers, worker-owned detached groups, complete pre-release births, control plane, fresh per-signal authentication, forced history, phase/repeated signals, finalization and after-B closure all remain **STOP / NOT RUN**. No signing-main/env-marker workaround, spawnOwnedWorker, key-stripping change, shared sweep, trampoline change, raw signal/owner-transfer/finalization rewrite or lazy PTY import. Removing build keys would not excuse unaudited helpers; unchanged trampoline is only an S1 preservation fact, not future runtime permission. Advisor65's disclosed forbidden Node-e builtin probe on Node26 supplies neither authorized proof nor Node24 support.

Consumer whole-artifact/jiti/currentaudit/source-selector promotion/#396/#590, browser54 API gap, LOCAL jiti-browser NOT SENT, privacy/OS sandbox, golden/adoption/merge/release remain separate blocked decisions. Lease31 remains **released / testedHead null**; no runtime successor or application lease. Coordinator only writes plans. No independent review was reused, applied, or spawned here.

**Next: coordinator fresh independent two-axis review of the exact partial source/evidence heads and declaration blocker. STOP; no continuation, runtime successor, cleanup, publication or adoption.**
