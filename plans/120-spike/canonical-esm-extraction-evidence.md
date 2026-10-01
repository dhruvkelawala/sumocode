# D93 readable cleanup

**STATIC CHECKS PASS; no behavioral/runtime certification.** This section supersedes
D91's padding retention, byte-equality requirement and two static failure statuses;
the historical D91 record below is unchanged.

- Starting clean HEAD: `562f472c00510115eba0cdc9b0f273f894b6c8be`.
- D93 source cleanup: `146e3bd043e6429234f346a2502e30fb1adcc5e3`.
- D93 evidence: sole report-only child of that source commit; exact SHA is recorded
  after commit in `.local/canonical-esm-revision/d93-final-manifest.json` (no self-hash loop).
- Only the two MJS sources changed: erasure padding/trailing whitespace removed;
  original comments and tokens retained. One justified block disable covers the
  audit-record predicate's five `anti-slop/no-runtime-typeof` guards, following
  preflight precedent. No lint configuration or other suppression changed.

Equivalence proof: **exit 0, both committed files byte-identical after esbuild
transform** with `{ loader: "js", format: "esm", minifyWhitespace: true,
legalComments: "none" }`; no syntax/identifier minification. Expected inputs are
Node24 `stripTypeScriptTypes` of pristine `03e456ac` TS plus only the three allowed
supervisor edits. Tradeoff: formatting and lint comments may differ, but normalized
emitted code must match; this is static preservation, not runtime validation.
Proof script/output: `.local/canonical-esm-revision/proof-d93.mjs` and
`d93-proof.{stdout,stderr,exit}`; Node's experimental warning is retained.

Checks ran once each (cached Node24/pnpm10.29.2, requested environment unset):
- Targeted oxlint on both MJS: **0**.
- `git diff --check 03e456ac..HEAD -- test/integration tsconfig.integration-facades.json`: **0**, at source HEAD.
- `pnpm exec tsc -p tsconfig.integration-facades.json --noEmit`: **0**.
- `node --check` core: **0**; admission: **0**.
- `pnpm exec tsc --noEmit`: **0**; conditional `pnpm build`: **0**.

Receipts: `.local/canonical-esm-revision/d93-*.{command,stdout,stderr,exit}`.
No tests, workload imports/evaluation, app/harness spawns, or publication occurred.

# D91 S1 — corrected declaration input, exact pristine ESM extraction

**INCOMPLETE / STATIC SOURCE ONLY / NOT REVIEW-READY.** The bounded extraction is preserved in one source/config commit, but targeted lint failed with five diagnostics and Git's whitespace check failed with 64 diagnostics. No repair, suppression, normalization, lint retry, workload import, behavioral test, runtime adoption or publication followed. Narrow corrected-input typing, successful declaration generation, facade typing, MJS syntax, exact byte correspondence, protected-source checks, root typecheck and build passed. Those passes do not waive either failure or certify runtime behavior.

## D91 current manifest and authority

```text
branch: sumo/v08-canonical-esm-baseline-revision
BASE: 03e456acc09830b27355ea72b5d8b6332534af4b
tree: b07ac29df5d57bb2b7abb363bb3807ff387d3ffb
D91 source/config HEAD: 64d509f3ec512494770e5db3a17c60d6a1e6f8e3
tree: 73a950655c112d41920a6549d7dc0e51782ba86b
D91 evidence: sole report-only child of that source HEAD; resolve exact hash/tree
              from .local/canonical-esm-revision/final-manifest.json after commit
preserved66 branch: sumo/v08-canonical-esm-extraction
HEAD: 03e456acc09830b27355ea72b5d8b6332534af4b
tree: b07ac29df5d57bb2b7abb363bb3807ff387d3ffb
partial SOURCE ancestor: 0019a7483a69b486578e7534baee6073b0b3c0c9
tree: 8d0d27b5e7e520b1921bf4e46559b3851246ca7f
accepted C1/C2 evidence ancestor: 3642b683e889727e2ac8fcdb4b918095a2af5b40
tree: 69b7085f45a95d5b34851ef433edb72affca55a3
accepted C1/C2 SOURCE ancestor: 88c38b535c75e43f771af508d600248f80556436
tree: 6930b3d74d856a2c97d52fe28afbb73f7dfaafe9
```

Read the full authoritative absolute dirty-parent read-only grant `/Users/sumodeus/code/sumocode/plans/120-spike/canonical-esm-baseline-revision-contract.md`: **13,152 bytes**, SHA256 **c8242010c6e877bc6e0eb7fe4b0c1285902877b82fd416726f8d7a220e255b62**. No optional parent checkpoint, other dirty-parent file, private historical session, or old tool script was read/replayed. Full local AGENTS.md/DEV_LOOP.md and review-ready/quality/ponytail/commit/TDD/tests/mocking guidance were read. D91 controls over generic behavioral-TDD/full-verification/publication guidance. Spec67/Standards68 approval is the granted provenance of partial0019's three auxiliary declarations, not a new exact-head review or completed S1. Earlier62–63 accepted C1/C2 source88/evidence364; a5/869 remain rejected preserved history.

Before any source changes, exact branch/base/tree and empty tracked/untracked status were verified. `initial-manifest.json` and pristine snapshots are newly owned under `.local/canonical-esm-revision/`; the old66 worktree/report/logs were not written. `preserved-original-head` reverified its public Git branch identity without entering that worktree. No fetch, pick, merge, rebase, reset, stash, amend, history rewrite, cleanup, parent apply, push, PR, adoption, or delegated reviewer occurred.

Exactly these seven source/config paths changed in the source commit:

```text
test/integration/harness-admission.ts
test/integration/harness-supervisor.ts
test/integration/harness-admission.mjs
test/integration/harness-admission.d.mts
test/integration/harness-supervisor-core.mjs
test/integration/harness-supervisor-core.d.mts
tsconfig.integration-facades.json
```

The separate evidence commit changes only this existing report. The report below preserves the original D88 text and its failures/NOT RUN history, except one P3 factual typo correction: **“accepted source188” → “accepted source88”**. This was coordinator66 prompt attribution, not worker disobedience or an alternate base. Original03 report: **21,654 bytes**, SHA256 **87de005545ea1a782bf4fcb91b6f0b3f514ecaad92104041dbb2a840017e19a2**; also available as `pristine/evidence.md` and public Git blob at03. P3-only corrected historical text: **21,653 bytes**, SHA256 **e8c703498eea9e9d11d28a8c65433beb04a171ddb0aa54584660b35605cb1e7e**. The complete new report's after hash/size, evidence HEAD/tree and clean status are post-commit entries in `final-manifest.json`; an evidence commit/report cannot contain its own content-addressed hash. No amend/self-hash loop.

## D91 actual RED → corrected-input GREEN

This is **static type-input evidence, not behavioral TDD**. The first and only pristine no-emit check was `pnpm exec tsc --noEmit --project .local/canonical-esm-revision/narrow-original-node.json --pretty false`, label `pristine-red`, exit **2**. It reproduced exactly four diagnostics: TS2551 at463,13 and552,13; TS7053 at464,9 and553,9. Exact new stdout contains the same env-delete messages printed in the historical blocker below; stderr is empty. `capture-inputs` verifies those exact codes/locations and absence of extra diagnostics. No replay of the earlier62/8/tool.py checks, no pristine-green claim, and no error-emitted declaration baseline.

The fresh owned config extends the unchanged root config, sets only `types: ["node"]` and `incremental: false`, uses exactly the two original TS files and `include: []`. Only two identical local env lines, in `spawnSupervisedProcess` and `spawnSupervisedPty`, were temporarily changed from:

```ts
const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
```

to:

```ts
const env: NodeJS.ProcessEnv = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
```

The corrected copies and exact unified input diffs remain owned artifacts. No parameter, exported type/signature, statement order, literal/key/deletion, spawn flag, auth/readiness/cleanup behavior or inferred public returned-env shape was changed. The normal-process return is explicitly `SupervisedProcess`; PTY returns its explicitly typed IPty plus the existing `Pick<SupervisedProcess, ...>` supervision, not the local env. The env remains local and is not an inferred public export. Admission was unchanged. No cast/any/ignore/fake field/constant widening or additional repair.

```text
pristine admission: 1664 bytes
61a45cd0fde8748325c5d2fa678df380b086becc36300bd04839dc50de9180c0
corrected admission: same bytes/hash
pristine supervisor: 24157 bytes
9f369d15f5f73b25bb8f8a9857d73b0fd1a3bab77ce0eb0b61e8ebf729142a9a
corrected supervisor: 24195 bytes
9b80270522da377d9cfcb8fe5982c66f0e85af893dbc70c9721035ed9b35b091
```

The one subsequent `corrected-green` no-emit check, same Node-aware config, exited **0**, empty stdout/stderr. `declarations-corrected` then exited **0**, empty stdout/stderr, using `declarations-corrected-node.json`: inherited strict original two-file config, `noEmit: false`, `declaration: true`, `emitDeclarationOnly: true`, **`noEmitOnError: true`**, owned `outDir: ./declarations`, original integration `rootDir`. Both configs and all raw results are retained verbatim. This is a **CORRECTED TYPE-INPUT baseline**, not pristine generation. The two temporary annotated inputs were replaced by the final TS facades only after successful generation.

Complete public outputs (read fully and retained exactly):

```text
declarations/harness-admission.d.ts: 285 bytes
c582de3f9412bcd0313eca394d8b07de8ea9ec508ffe383c8db58ee4f6021892
declarations/harness-supervisor.d.ts: 3594 bytes
01135ec9c0906fb0177e3a11fedcd37da71ac1abc4a641317732719601acb647
```

Admission.d.mts is byte-identical to the successful generated admission declaration. Core.d.mts is the successful generated supervisor declaration plus exactly `export function finalizeFocusedNamespace(): Promise<void>;` and its newline. **Necessary declaration specifier adaptations: none**; all emitted Node/node-pty/constants specifiers already remain valid at the adjacent path. No generic/framework/fake/missing old export was substituted. The accepted six preflight exports remain frozen. Compiler inputs are tied to pristine/corrected hashes, exact configs, root/package/lock hashes, tool-source manifest and full local dependency source/declaration/JSON inventory; that inventory is a superset of compiler resolution, not a claim every inventoried module was loaded.

## D91 pristine runtime erasure and static caller trace

`strip-pristine` invoked **only** cached Node24's actual `node:module.stripTypeScriptTypes(source, { mode: "strip" })` on the two **pristine** snapshots. It exited **0**; the actual ExperimentalWarning is retained in stderr without normalization. No repository workload/native PTY module was imported by that owned conversion script. There was no standalone API probe, Node26 fallback, alternate transpiler, formatter, whitespace collapse, trim, newline or AST normalization. Annotated TS was never a runtime conversion input.

```text
admission erased == expected == committed admission.mjs:
1664 bytes; 192d4281cb7301342aca0614b9234d9301aedba2b73866d803cd6b64c007370b
supervisor pristine erased:
24157 bytes; cdc74369cf29548388d50ef8261dddb30c0855c277817befe307604345adaab0
supervisor expected == committed core.mjs:
24149 bytes; e0bc898e99e43b03c2599b2a029067b4885b8a524f0b026c5bd2a28c7dd15d9c
final erased callback BODY == exported finalizer BODY:
1271 bytes; baf42afe2212ee107c55403670e222cd30cad856f605c124de619dab6b750abc
```

`strip-pristine.mjs` asserts unique exact literals before transforming. Supervisor deltas are exclusively: the quoted admission literal `.js` → `.mjs`; removal of the exact `import { afterAll } from "vitest";` declaration and its line break; final `afterAll(async () => { BODY });` wrapper becomes `export async function finalizeFocusedNamespace() { BODY }`, preserving the full erased BODY bytes and final newline. The runtime env literals remain the pristine, unannotated literals. Padding produced by Node strip is deliberately retained. `static-proof` compares bytes, not normalized strings or formatter equivalence, and verifies exact requested facade text and narrow config.

1. **Caller → facade:** 17 direct caller files retain their original `.js` import specifiers and complete base identities; owned `caller-inventory.json` records import/call/type-use sites. Read full representative PTY adapter and both original modules; other caller sites were inventoried statically, not claimed to have been exercised or all read end-to-end. Tests do not import the new core.
2. **Facade → core:** admission facade only reexports its adjacent MJS. Supervisor facade imports Vitest afterAll, imports the real finalizer, reexports core, then registers `afterAll(finalizeFocusedNamespace)` at the same importing TS seam. Core has no Vitest import or afterAll call, still eagerly imports node-pty, and is **not safe to import under this grant**. Finalizer is a real facade lifecycle API, not a test-only export.
3. **Single owner:** core alone owns fallback root/token/run-id/key, child sequence and focused registration map. Allocation remains lazy inside `harnessRoot`/`harnessAuth`, not facade/module import-time allocation. PTY adapter still resolves auth before evidence/spawn; core signs registration before admission release. Finalizer uses that same map/cache, with the unchanged original cleanup/audit body. This is static preservation, not an exercised lifecycle guarantee.
4. **Admission/termination:** admission retains the literal adjacent `new URL("./fixtures/harness-admission.cjs", import.meta.url)` and unchanged bootstrap. Full original preflight/auth/constants were read as source only. Auth, owner-birth, signing, per-signal reaper, retention and TERM/KILL graces are byte-protected; no future authority is inferred from the unchanged trampoline.

`static-proof` exited **0**, verified base/accepted ancestor trees and **1,166 protected tracked paths** (all inherited tracked paths except the two replaced TS modules), exact seven-path change closure, no test core imports, declarations/config/facades/body/fixture URL/expected-runtime equality. The three frozen auxiliary hashes remain:

```text
scripts/preflight-integration.d.mts
494f7b4221dfd9c423e2ec6241743118c4527d5bf9aad4eb90fb927712556fad
scripts/lib/integration-harness-auth.d.mts
f84742bb495d648aca1b34f35192b3c515850aa103a9f965d4760890975d3c88
scripts/lib/integration-harness-constants.d.mts
dc1cecfbf0df701a66f67bb361a6d8f1210dd566b47500984de833425f2ac18d
preflight reaper window: offset21987 / 10106 bytes
cf3f2ddebeec024201a8a4d4a4dc0237a558d93e6ddeb0e8804ca568df8e5c86
```

All inherited runtime MJS/CJS/runner/bootstrap/helpers, tests, selector, root config, package/lock pins and DEV_LOOP bytes are unchanged; their exact base hashes remain in `protected-base.json` and the historical protected section below. C1/C2's two full A/B census, readable-identity manual exclusions, unknown/valid tuple handling, fresh verified reaper body, any-file-change non-Green behavior and signed admission remain untouched. This is mechanical preservation, not C3 completion or new admission authority.

## D91 tooling, actual checks and failure receipts

Before cached tool processes, metadata and SHA256 matched the grant:

```text
Node24.15.0: /Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin/node
119944608 bytes; 3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32
pnpm10.29.2: /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs
1102 bytes; b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9
TypeScript6.0.3 lib/_tsc.js:
6239091 bytes; 1c59e77a54b186ec43fa7f3e0d3c4bb15ca5eb5ba43e96b1d3a267139eddd3e3
```

`node-version`/`pnpm-version` exited **0**, respectively `v24.15.0`/`10.29.2`. Initially this worktree had no node_modules. Exactly one authorized `install` ran offline/frozen/ignore-scripts/ignore-pnpmfile with the granted `/Users/sumodeus/Library/pnpm/store`: exit **0**, **337 reused, 0 downloaded**. No age bypass, package-manager switching, hooks, native build, download hunt or application execution. Store-server metadata search found no server.json; no daemon query or workload was requested. Package/lock bytes stayed unchanged.

Owned agent/state/config/diag/tmp/cache/bin/hooks directories and empty npm user/global configs were staged before tools. `run.py` scrubs environment **names**, not credential values: PI/SUMO/HERDR/NODE/NPM/PNPM/XDG/Bun/Vitest/Vite/ts-node/provider prefixes, credential-name patterns, PATH/shell/injection/temp/SSH variables; then assigns owned paths/caches, empty configs, ignored scripts/pnpmfile, disabled manager switching, `SHELL=/bin/sh`, **LEFTHOOK=0**. Every `env -u` precedes every assignment. HOME/Git/GIT_CONFIG_COUNT remain unchanged and their values were not logged. Removed names and exact assignments/argv/cwd are retained per command. After bounded lint-source inspection the wrapper additionally scrubs NAPI/VP/OXLINT/DEBUG/TSC/VSCODE names; the preceding wrapper is retained as `run-before-lint.py`, and the extra sensitive ambient names were absent (`additional-tool-env-names.json`). This does **not** claim a full/uniform scrub or OS sandbox: initial Bash/read/static setup operations used the harness environment; source acquisition/preliminary composite-command observations remain in the tool transcript rather than separately captured per-subcommand exit receipts. The early absent `.local`/node_modules inspections emitted missing-path messages; these were inventory observations, not verification retries. No private session was opened to reconstruct them.

Bounded pnpm inspection covered bin→bundled dist, built-in/project/user/global config loading, owned config/data dirs, hook/config-dependency branches, store connection and manager-selection conditions. No local/workspace npmrc/pnpmfile/workspace config was present. Compiler bin→shim→_tsc uses builtins and owned compile cache; no watch/profile/plugin mode was selected. PNPM-generated local bin shims may synthesize a **worktree-local NODE_PATH** for tools; this is not inherited application NODE_PATH and no shim points at installed private applications. TypeScript resolves source/declarations without evaluating imported repository workloads.

Before targeted lint, inspected oxlint bin/CLI/bindings/config/plugin loaders, root config, plugin import/effectful-operation closure and @oxlint/plugins implementation. `tool-source-trace` exited **0** and retains source excerpts/digests in `tool-source-boundaries.raw.log`/`tool-source-manifest.json`. Config imports only oxlint's identity defineConfig; plugins import local rules/helpers and @oxlint/plugins. Their sole filesystem operation is noRestrictedImports' nearest-root `existsSync(oxlint.config.ts)`, bounded by this root for the selected files. Tool CLI loads its cached Darwin-arm64 **lint binding**, not native node-pty/application SDK; NAPI/VP override names are scrubbed, Linux ldd branch is not the Darwin path, no LSP/fix/type-aware mode was requested. Plugin code parses source ASTs and does not import the target modules. This is a bounded **tool-source/import/env/FS trace**, not dynamic native-tool/syscall/private-FS containment certification.

Actual verification (each label has unique `.command.json`, `.stdout.raw.log`, `.stderr.raw.log`, `.exit`; no overwritten failures or hidden retries):

```text
pristine-red            exit2  exactly4 expected TS2551/TS7053 errors
corrected-green         exit0  no diagnostics
declarations-corrected  exit0  no diagnostics; successful noEmitOnError output
capture-inputs          exit0  exact input diff, protected/dependency snapshots
strip-pristine          exit0  actual Node strip; warning retained
facade-green            exit0  narrow two-facade closure only
admission-syntax        exit0  node --check without module import
core-syntax             exit0  node --check without module import
tool-source-trace       exit0  bounded source/plugin/tool trace
targeted-lint           exit1  5 no-runtime-typeof errors, unrepaired
root-typecheck          exit0  pnpm exec tsc --noEmit
build                   exit0  pnpm build = tsc --noEmit
static-proof            exit0  exact bytes/declarations/hooks/protected/callers
source-diff-check       exit2  64 trailing-whitespace errors, unrepaired
```

The final explicitly authorized root typecheck/build were run once after the lint failure only to retain their independent static results, not to repair/retry lint or assert full PASS. All checks since that failure are bounded preservation/reporting checks, not another implementation slice.

Exact new lint failure:

```text
test/integration/harness-supervisor-core.mjs:220:24: error anti-slop(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.
test/integration/harness-supervisor-core.mjs:223:9: error anti-slop(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.
test/integration/harness-supervisor-core.mjs:224:6: error anti-slop(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.
test/integration/harness-supervisor-core.mjs:225:6: error anti-slop(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.
test/integration/harness-supervisor-core.mjs:226:6: error anti-slop(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.
```

Static explanation: Node strip erased `value is HarnessAuditFailure`; the existing `allowInTypeGuards` rule checks a TypeScript predicate return annotation, so the unchanged JavaScript runtime guards no longer qualify. No lint-config reset, new suppression or runtime/type-padding alteration is allowed by D91. `source-diff-check` reports the 64 space-filled erased-type lines in core. They are actual trailing-whitespace diagnostics, not normalized away or converted into a passing check. Exact strip bytes outrank cosmetic cleanup under this grant. Both failures remain blockers for any review-ready/complete-source claim.

Other owned Git command logs cover status, full original-TS diff, exact staged paths/stat, source commit/head/clean state and preserved66 branch. Source commit used owned empty hooksPath, LEFTHOOK=0 and `--no-gpg-sign`; no private hook/reviewer ran. Report checks/commit/final heads/clean receipts and comprehensive command/artifact manifest are finalized after this report. Only ignored new owned proof scripts were used; none became a committed comparator/runner/framework.

## D91 review-ready gate and tradeoffs

Contract: authoritative D91 above plus bundled `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (no repo override found at documented candidate paths). Changed seam: existing TS supervisor/admission imports → adjacent canonical ESM owners; narrative entry point stays the supervisor TS facade/PTY adapter. Owner: one core owns the same supervision state and actual finalizer; admission owns its adjacent bootstrap seam. Test surface: unchanged caller-facing TS API; D91 grants source/byte/type evidence only.

1. **Caller-knowledge:** callers keep the same imports/types and need no core knowledge, new setup, registry or lifecycle call. Finalizer is wired by the TS facade, not delegated to tests.
2. **Deletion:** removing core would spread the existing supervision code back into the facade, not remove policy complexity. This is exact ownership extraction, not an invented abstraction or behavioral simplification.
3. **Ownership:** one core map/cache/state, one admission module, one actual finalizer hook site. Auxiliary declarations remain beside their unchanged owners. No duplicate supervisor, callback framework, worker/driver, parser/ledger or new process/filesystem owner.
4. **Test-surface:** strict compiler/byte/source/syntax checks only; no direct-core test seam or behavioral mock. Narrow facade GREEN does not certify full integration APIs or JavaScript body typing. Existing tests remain unchanged and unrun.
5. **Comment/simplification/verification pass:** reread all seven changed source/config files completely after checks, then this report. Retained original timing/security/resource comments and every emitted space; even the original hook-registration comment remains mechanically preserved in core although registration now lives in facade. No cleanup/refactoring/comment repair can supersede exact three-delta equality. Explicit Node types/local incremental setting replace the old nested-config ambiguity without root strictness changes. **Gate NOT READY**: lint and whitespace failures, plus initial per-subcommand receipt limitation above, are documented rather than waived. Behavioral verification is an explicit D91 exception, not falsely supplied by static RED/GREEN.

Tradeoffs: preserve exact source/runtime bytes and failure evidence rather than add a fourth runtime delta, change lint policy, normalize Node padding or silently retry. Retain the seven-path extraction in one explicitly incomplete mechanical source commit and the report in its sole report-only child; do not discard failures or modify old66. No more source repair under this grant. Successful declarations are visibly from corrected inputs, while runtime is visibly from pristine inputs. Runtime safety and whole-lane certification are deliberately not inferred from static correspondence.

## D91 reserved gates / STOP

**NOT RUN:** every Vitest test, including old104/focused positives/admission.test/canonical census; whole integration-API typing; native PTY/SDK/core/admission import smoke; sockets/bootstrap/key PID grants; harness spawn/PS/kill0/signals/preflight CLI; real admission/default wait/cleanup/finalization/quiescence/zero-survivor audit; full/native/integration/visual/perf/currentaudit/provider/MCP/Herdr/browser/app workloads. Root TypeScript checks read declarations, not SDK/private startup execution. Old104 is historical and was not rerun. No paid provider fixture/private auth/state/user layout was accessed. Bounded tool tracing is not actual startup/private-FS/syscall containment.

No C3 feature: no controlplane/signmain/env-marker admission/key-stripping change/shared sweep/owner transfer/rawsignal/record-only interrupt downgrade/exitCode-zombie-libuv-SIGINT shortcut/termination memo/finalization/quiescence rewrite/lazy PTY/spawnOwnedWorker. Future whole build/helper and worker-owned app-group coverage, complete pre-release births, actual final-env/startup private-I/O containment before app, signed PID-bound preexec admission, fresh owner/birth/ancestry/self-group/auth before TERM/KILL, truthful forced history and whole-group zero audit remain required, not excluded because unobserved. No third A/B census/retry/ledger or new runtime authority.

Consumer#396 whole Pi+Sumo artifact correspondence/jiti-both outputs+map/currentaudit/source-selector same-host promotion, production Effect#590 and browser54 public process-bound API/FD-helper parity, jiti-browser LOCAL NOT SENT, OAuth/private-destructive/golden/adoption/merge/tag/release remain separately blocked. Lease31 remains released/testedHead null with no successor/full-heavy grant. Isolated partial0019 inheritance is D91-only; no parent application, production import, whole-lane composition or reviewer reuse.

**Overall INCOMPLETE. Next: coordinator fresh independent exact-head Spec/Standards review and decision on retained static failures; no worker repair, runtime launch, adoption, publication or cleanup.**

---

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

C1/C2 accepted source88 controls remain unchanged; original a5/869 and previous rejected worktree logs remain preserved historical, not authority. C3 builds/helpers, worker-owned detached groups, complete pre-release births, control plane, fresh per-signal authentication, forced history, phase/repeated signals, finalization and after-B closure all remain **STOP / NOT RUN**. No signing-main/env-marker workaround, spawnOwnedWorker, key-stripping change, shared sweep, trampoline change, raw signal/owner-transfer/finalization rewrite or lazy PTY import. Removing build keys would not excuse unaudited helpers; unchanged trampoline is only an S1 preservation fact, not future runtime permission. Advisor65's disclosed forbidden Node-e builtin probe on Node26 supplies neither authorized proof nor Node24 support.

Consumer whole-artifact/jiti/currentaudit/source-selector promotion/#396/#590, browser54 API gap, LOCAL jiti-browser NOT SENT, privacy/OS sandbox, golden/adoption/merge/release remain separate blocked decisions. Lease31 remains **released / testedHead null**; no runtime successor or application lease. Coordinator only writes plans. No independent review was reused, applied, or spawned here.

**Next: coordinator fresh independent two-axis review of the exact partial source/evidence heads and declaration blocker. STOP; no continuation, runtime successor, cleanup, publication or adoption.**
