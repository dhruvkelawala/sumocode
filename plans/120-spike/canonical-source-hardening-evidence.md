# D83 — source-only canonical corrections

**Corrections committed; overall verification INCOMPLETE.** Independent59 Spec / 60 Standards requested changes on the old source; D83 authorizes only the corrections below. No adoption, publication, independent review, runtime successor, parent application, or full verification occurred. Coordinator must independently re-review both axes before any reuse.

## Revision authority and exact manifest

Worktree `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-canonical-source-revision`, preserved new branch `sumo/v08-canonical-source-revision`. Initial branch/clean tracked state/HEAD/tree were verified exactly:

```text
base/evidence869 869c044c561a6cc272b12ca7ed7956e845ef46d6
base tree c8dd2cbc6fb62b88d49ea9c0468700d1cd57661b
ancestor source a5abe2cb131e7a94788bab4fb3c986e8bce35888
ancestor source tree 9a4db1780a22da41d76a67673d03254ff7938156
ancestor applied475 475560cf45becbafe81b41a718b4724c1cc871cb
ancestor applied475 tree 4ebf4544bc1bd1f020545a8785329426c9fce226
D83 source HEAD 88c38b535c75e43f771af508d600248f80556436
D83 source tree 6930b3d74d856a2c97d52fe28afbb73f7dfaafe9
```

One new bounded correction commit, followed by a separate report-only evidence commit. The latter's exact SHA/tree are recorded after committing in this worktree's `.local/canonical-source/logs/d83-evidence-head.log` and the handoff; a document cannot embed its own resulting commit/tree identity without changing it. No old commit was amended. Original58 worktree/branch/logs remain untouched.

Authorized full parent reads were the ABSOLUTE `/Users/sumodeus/code/sumocode/plans/120-spike/` files `canonical-source-revision-contract.md`, `canonical-c1-c2-source-contract.md`, `canonical-source-standards-review.md`, and `canonical-source-review-checkpoint.md`. D83 override: 9,231 bytes, SHA256 `7a045c3a2b001c21db19b27ef955152b4358a06a239e27e632359af6bdcd9281`. Immutable D80: 9,277 bytes, SHA256 `eb7d613030f245ab17f613d8c101799b37f9e5a0467b13f28d006c0c897cd9b6`. Full local AGENTS/DEV_LOOP/old report and build/tdd/commit/review-ready skills, tdd tests/mocking guidance, and the resolved quality contract were read.

Only allowed existing paths changed: source commit has `scripts/preflight-integration.mjs` (28 additions / 15 deletions), `scripts/run-integration-harness.mjs` (2 / 2), and `test/integration/verification-harness.test.ts` (91 / 0); evidence commit changes only this existing report. There is **zero old test-body churn versus869**, no new export/module/dependency/framework/ledger/registry/parser engine/supervisor/runner/test hook/module mock. New cases reside only in the two existing positive describes. The sole harmless old census caller is unchanged and selected for the final check.

Source blobs:

```text
scripts/preflight-integration.mjs cf42f31e208810ab22152def07d7d79e464d76ab
scripts/run-integration-harness.mjs 1eed779f8d7045f932540e53b9a4f0aff9bc9f76
test/integration/verification-harness.test.ts 989b08d066c899fa1a157935e8ffd33684752ac3
```

Whole preflight `function currentProcessGroupId`→`export async function fixIntegrationPreflight` is byte-identical to869: **10,106 bytes / SHA256 `cf3f2ddebeec024201a8a4d4a4dc0237a558d93e6ddeb0e8804ca568df8e5c86`**. Auth/constants/supervisor/admission/bootstrap/package/lock equal869 with the same blobs recorded in the historical manifest below. Accepted pick bytes remain: DEV_LOOP `55eef0ca75332aafcd5e0854bcad2653db22ea39` equals893; runner test ADD `905560a779ced169867f034efc80438d3fe62cf1` and Vitest config `16f227b777142924640050c793ba55689984a155` equal8d. Selector unchanged, 1,684 bytes / SHA256 `f30f54d0348dd3c14091b32ec12e8682347f966c7f7fa50514078e2fa8098ded`. Version0.7.5/Pi0.99.1 pins unchanged; source equality checks are retained in `d83-identities-before-commit.log`.

## Corrections and bounded tradeoffs

1. **P1 partial manual census:** the existing dead-census owner scans all available content, retains every independently schema-valid expected-run spawn tuple, coalesces only exact tuples, and preserves conflicting valid exclusions plus named uncertainty. Readable bytes are still parsed after later metadata loss/instability; unavailable bytes are not invented. Unknown classification now carries registrations through existing harnessState to public inspection. HMAC is FORMAT ONLY postmortem, never cryptographically verified or used as signal authority.
2. **P1 manual effect exclusion:** fix excludes known manual PIDs and their recorded/current groups from group TERM selection. A signature-bearing sibling can only use the existing individual-PID path, never group-signal the manual survivor. Escalation additionally excludes groups containing a known manual PID in the latest rows. Independent nonmanual groups remain eligible under existing checks; unknown namespaces remain preserved and returned as refused. Both fresh owner+census checks immediately before rm are untouched. This is observed known-metadata protection, not quiescence or a lifetime race proof.
3. **P2 torn whitespace:** any nonempty unterminated final fragment is named torn before whitespace skipping. No trim/newline/prefix forgiveness, extra read/retry, or raw parse excerpts. Signed candidates remain available even when a tail fails. Empty file and complete blank lines yield zero REGISTERED groups only. Full A/B, file-identity comparison, any-observed-change failure and per-group continuation are unchanged; after-B quiescence remains C3 STOP.
4. **Shared P2/Standards60 grace:** ONLY `const RUNNER_TERM_GRACE_MS = 1_000;` restored and compared byte-for-byte with applied475's declaration. Original58's750 was an actual unauthorized source change caused by the coordinator's incorrect scope premise, **not worker disobedience**. Browser750 is different and untouched; supervisor750/preflight300/other timers unchanged. Actual default waiting NOT RUN; no fake-clock equivalence or timeout-budget grant.

Tradeoffs: keep policies local to their existing owners, reuse the existing option bags and teardown, and add only local identity collections. The first named uncertainty is retained while all readable candidates are scanned; no unread-data coverage guarantee. No attempt to expand authority, repair C3, refactor shared parsing, or establish universal process/privacy/fidelity proof. Synthetic late-read instability is source-traced, not deterministically fault-injected: no hook/mock was introduced to claim that extra coverage.

## New execution containment and exact checks

Before any test import, re-traced the whole selected file and the actual import path: runner/preflight guards, bundle helpers/auth/constants, harness-supervisor/admission, spawn-pi-pty, terminal-controller/diagnostics/errors, Vitest config, installed node-pty entry/native-loader path, and lint config/plugin imports and repository-marker filesystem lookup. No selected body calls spawn/admission/Pi/PTY/ps; imported supervisor afterAll returns with fallbackRoot undefined. afterEach has no registered children and only removes owned synthetic roots. The existing package-local node-pty prebuilt library is loaded by the old import graph; no native build or native contract was run. This is a scoped static trace, not an encompassing SDK/app graph closure or OS sandbox certificate.

Owned agent/state/config/diag/tmp/cache and empty npm configuration were staged under this worktree's `.local/canonical-source/` before imports/checks. HOME/Git settings/config/GIT_CONFIG_COUNT were unchanged; no private agent auth/persona/accounts/Remnic/Herdr/MCP/server credentials were read. Credential names were scrubbed without reading/logging their values. All new fix calls inject **table + rows + readRows + currentPgid + kill + wait**; all new audit calls inject **readProcessTable + readProcessStart + currentPgid + kill + wait**. The only permitted real process operation in selected bodies is the existing metadata `kill(2147483647, 0)` probe, not a live-identity test. Synthetic callbacks record zero-attempt arrays rather than throwing into swallowed sendSignal errors.

Cached metadata, digests and version output still match Node24.15.0 and consumerpnpm10.29.2 at the exact historical tool paths/digests below. One offline frozen ignore-scripts installation: 337 reused, **0 downloaded**, no scripts. No download/version hunting/systempnpm12/Bun/age bypass. All new check commands used exactly the `scrub` / `safe` shell prefix printed in historical section4 below, from the **new revision worktree**; `env -u` flags precede assignments and `LEFTHOOK=0` is correctly spelled. No HOME or Git override was supplied.

Exact invocations and retained results:

```bash
# install.log / tool-version.log, exits0
"${safe[@]}" --version
"${safe[@]}" exec node --version
"${safe[@]}" install --offline --frozen-lockfile --ignore-scripts --store-dir /Users/sumodeus/Library/pnpm/store

# P1 red before source correction, d83-p1-red.log, exit1
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical preflight read loss'
# Tests 7 failed | 61 passed | 111 skipped (179)
# expected [] to deeply equal [60001,61001] (formatting retained raw)
# expected [[-60001,'SIGTERM'],[-60001,'SIGKILL']] to deeply equal []
# Extended same P1 red with wellformed sibling control before implementation:
# same command → d83-p1-group-red.log, exit1
# Tests 8 failed | 61 passed | 111 skipped (180)
# Includes wellformed AND unknown sibling-group failures, no hidden retry.
# P1 correction → same command → d83-p1-green.log, exit0
# Tests 69 passed | 111 skipped (180)

# P2 red after P1 green but before P2 source correction, exit1
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical census hardening'
# d83-p2-red.log: Tests 4 failed | 30 passed | 152 skipped (186)
# AssertionError: expected [] to deep equally contain StringContaining "manifest torn line"
# P2 correction + grace restore → same command → d83-p2-green.log, exit0
# Tests 34 passed | 152 skipped (186)

# Full permitted positive selection, d83-final-green.log, exit0
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical census hardening|canonical preflight read loss|harness manifest audit contract'
# Tests 104 passed | 82 skipped (186); 16 new cases, original88 are not new-head proof until this run.

# Each exit0; complete stdout/stderr in d83-tsc/build/lint/*-syntax/diff-check.log
"${safe[@]}" exec tsc --noEmit && "${safe[@]}" build
"${safe[@]}" exec oxlint scripts/run-integration-harness.mjs scripts/preflight-integration.mjs test/integration/verification-harness.test.ts
"${safe[@]}" exec node --check scripts/run-integration-harness.mjs
"${safe[@]}" exec node --check scripts/preflight-integration.mjs
LEFTHOOK=0 git diff --check

# Source commit, exit0; d83-source-commit.log and d83-source-head.log
LEFTHOOK=0 git add scripts/preflight-integration.mjs scripts/run-integration-harness.mjs test/integration/verification-harness.test.ts
LEFTHOOK=0 git commit -m "fix(integration): preserve manual exclusions and reject torn whitespace"
```

Public regressions include valid→null, null→valid, malformed/torn/foreign/conflicting input with independent later identities, exact duplicates/wellformed controls, manual signature PID + automatic-looking same-group sibling, and continued independent group TERM/KILL while unknown state is refused/preserved. P2 includes space/tab/newline-space/signed-record-plus-space under an empty injected table, preserved signed candidate, empty/complete-blank controls. No assertions/timeouts/tolerance weakened, no default/negative/mixed-file filter, no tests manufactured after their correction as red.

New lossless bounded stdout/stderr logs remain at `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-canonical-source-revision/.local/canonical-source/logs/` (largest test log6,450 bytes). No old log was copied, overwritten, normalized or relabeled:

```text
d83-p1-red.log 4420 0a60512bc16420e6f74fc6bb665ab442dd615a4507db33f481e122cb4f4ae794
d83-p1-group-red.log 4762 2a5ffa65966c63db666a6c0f942578c391b7627a7059cdbf65ff3b1c3a5b7bd6
d83-p1-green.log 280 c75e633d6db8612600cc88a5524f4aa0b4acb47872177dccaf15b043801ff3e8
d83-p2-red.log 6450 8e7dea622fe1c45953ab970b9b6e8afd5876044549abfb234957a08ee55263cb
d83-p2-green.log 5495 9d357644430b4f14ebd57501e41e13aa749a28941fc9a14aa864ce75c97b73e6
d83-final-green.log 5495 87241af8255149c81bf674e93392f2d8eaf923e67511b832e2ed23521fe33f35
d83-build.log 136 7c19b53c5290b2dc799afa8ba0f2d782147f6cc8696077b770de8cbe1cd974ef
install.log 855 a8b4e508a15ac1eca34ab8a76561915f19340118f20677b1936bed1b5451e552
tool-version.log 17 dac756eed06d6e3604959312cbdcb9e6860fd65ccdd5bb02f53e5ae557cccbfb
d83-tsc.log / d83-lint.log / d83-runner-syntax.log / d83-preflight-syntax.log / d83-diff-check.log:
  each0 bytes / e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Identity/protected/source/delta checks are retained in `d83-identities-before-commit.log`; source/evidence Git receipts and final log digests (`d83-final-receipt.log`) are separate from test output. Report-only settlement uses `LEFTHOOK=0 git diff --check`, `LEFTHOOK=0 git add plans/120-spike/canonical-source-hardening-evidence.md`, then `LEFTHOOK=0 git commit -m "docs(integration): record D83 revision evidence and rejected history"`, with full output retained in `d83-evidence-diff-check.log` and `d83-evidence-commit.log`. Empty logs indicate successful silent commands, not omitted output. One exploratory read of nonexistent `.oxlintrc.json` returned ENOENT; actual `oxlint.config.ts` and plugin filesystem owner were read before lint. No source/check failure was suppressed or retried as green.

## Review-ready gate and remaining STOPs

Contract `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (bundled default, no applicable repository override in the inventoried literal paths). Changed seam: public inspect→fix and manifestProcessGroups→auditAndReap. Trace: valid spawn + null → partial identity plus unknown → human registeredSurvivor → PID/group exclusion while independent group cleanup continues → unresolved namespace retained; signed spawn + unterminated whitespace → torn failure before skip → candidate retained through the unchanged finite audit.

### Caller-knowledge

Callers still use the existing public interfaces; partial-identity preservation and manual signal exclusion are internal to the owning preflight path, with no new caller policy/seam.

### Deletion

Removing the owning validation/selection would spread the same uncertainty and exclusion policy into inspection/fix callers. No wrapper/module/export/dependency was added.

### Ownership

Dead-census manual identity remains local to preflight; live signed census and grace remain runner-owned. Protected authenticated cleanup stays byte-identical; no authority port.

### Test-surface

Actual owned files through public inspect/fix/census/audit, existing signing helper and full process-I/O replacement. Zero-attempt arrays cover swallowed-signal hazards; positive controls and independent cleanup prevent a blanket-refuse-all shortcut. No internal parser test export or module mock.

Simplification pass: re-read all three changed source/test files top-to-bottom after both greens, traced the representative flows above, and kept only local sets/guards plus the two-line runner change. No refactor needed. Security comments explain available-byte retention and same-group exclusion. Source equality versus475 verifies only the grace declaration, not default-wallclock behavior.

Verification: all authorized scoped checks PASS; overall **INCOMPLETE**. Ordinary src tsconfig does not type integration APIs: **explicit integration API static typing NOT RUN**, no supplemental mixed-file typecheck/baseline repair/waiver. No independent reviewer/delegation launched. Exceptions: confirmed D83 scope overrides build's fetch/per-slice-commit/fullverify/publication flow and the generic completion contract's full runtime gates; one bounded source correction plus report-only commit, source checks only, no approval question.

NOT RUN / STOP unchanged: eager0600wx main/allocation/finalization; actual default wait; CLI or successful preflight; whole mixed file/full tests/integration/native/app/PTY/ps/actual signals/providers/MCP/Herdr/visual/perf/security/currentaudit; admitted signing-owner control plane/raw forwarding/hook-freeESM42/encompassing finalization/repeated signals/retention and after-B quiescence (C3). No live zero-survivor, universal/lifetime coverage, OS sandbox, source privacy, browser driver API/helper/fidelity, SDK/app graph closure or audit-license proof. Browser54 API gap, browser57 local draft/jiti55 held LOCAL NOT SENT, #396 correspondence/#590/currentaudit remain blocked. Lease31 remains released/testedHead null; no runtime successor.

**Next action:** coordinator obtains fresh independent Spec and Standards reviews of the exact D83 source/evidence identities before any reuse. Stop here; no parent apply, adoption or publication.

---

# Historical D80 — rejected old C1/C2 candidate and receipts

Everything below describes original58 at04be/a5/evidence869, **HISTORICAL / SOURCE REJECTED, not adoption or corrected-head proof**. All historical relative `.local/canonical-source/logs/` paths refer ONLY to `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-canonical-source-hardening/`, not this revision worktree. Original88 PASS hashes/amend history remain historical, unchanged. Original instructions'750-as-existing-default premise was wrong and is corrected above; source execution at750 was nevertheless real.

**Historical bounded source candidate committed; verification INCOMPLETE and source subsequently REJECTED.** Only the delegated C1/C2 source contract was implemented. Synthetic interface checks pass; eager main, C3, actual runtime, signed live admission, and complete process coverage remain NOT RUN / blocked. This is a coordinator handoff, not adoption, publication, release approval, or a source-privacy certificate.

## 1. Authority and composition manifest

Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-canonical-source-hardening`.
Branch: `sumo/v08-canonical-source-hardening`. Initial tracked worktree was clean; branch, HEAD, and tree exactly matched the grant. No fetch, merge, rebase, reset, stash, external-main adoption, push, PR, worktree removal, or parent edits occurred.

Full authorized parent reads, and no other parent dirty-plan reads:

```text
/Users/sumodeus/code/sumocode/plans/120-spike/canonical-c1-c2-source-contract.md
9277 bytes; SHA256 eb7d613030f245ab17f613d8c101799b37f9e5a0467b13f28d006c0c897cd9b6
/Users/sumodeus/code/sumocode/plans/120-spike/canonical-hardening-reassessment-receipt.md
8235 bytes; SHA256 262a3db7dd49cbe1497d96b8132b9d654d599e3fa89454c80bd95e251883bdf1
/Users/sumodeus/code/sumocode/plans/120-spike/canonical-hardening-contract-reassessment.md
8349 bytes; SHA256 932b39781279fda0e5ebce832ce889624ca312ea6464417081fb43e6d0f5b9c3
```

Exact authorized picks, in order, both conflict-free:

```bash
LEFTHOOK=0 git cherry-pick -x 893cd1e6dac62e80c845c5e8ca3b170179a3e3df
LEFTHOOK=0 git cherry-pick -x 8d909d1c7d8d0ea77f23334212abbb5cc4f48990
```

Observed heads and trees:

```text
base HEAD 32828a2ed6519a95380ee43cb1be7ce86698da11
base tree 696d8c85eeccfc801cbd3557810d540cb43a2ef4
original first pick 893cd1e6dac62e80c845c5e8ca3b170179a3e3df
original first tree 116e9a43d025d6b3341296c20f0a80284f68e1bc
applied first HEAD 3dc28de9b8071ff95b8e156748c13ea2820b3327
applied first tree c74e747f24a66606bc7ed4824bab3998fd99e5f6
original second pick 8d909d1c7d8d0ea77f23334212abbb5cc4f48990
original second tree 34e0c3dcfed6a7107117bda895d0acbcba8cc70d
applied second HEAD 475560cf45becbafe81b41a718b4724c1cc871cb
applied second tree 4ebf4544bc1bd1f020545a8785329426c9fce226
C1 HEAD 04be31469bd00c5db66646a76b6f827aac05ec07
C1 tree 9ab3b967dba3d4bf71ba675ac6d0d2f8efbe1245
C2 final source HEAD a5abe2cb131e7a94788bab4fb3c986e8bce35888
C2 final source tree 9a4db1780a22da41d76a67673d03254ff7938156
```

C2 initially recorded `0fc9b116f94fb18ff1e8ee862e45722e59359528`, tree `c60f42523315f539f11799bd1816025a94be4749`. The final completion-gate pass strengthened its new human-only test: use a signature-bearing synthetic row and record/assert zero signal attempts rather than throw from a callback that existing `sendSignal` could swallow. All bounded checks passed again; the owned latest C2 commit was amended to `2b216ab1611fdda8dbc77112da1c456df27da6f6`, tree `72077fe711360f5125921d4c2394c3d4e05d39a8`. A final schema trace then identified that a present foreign run ID on a lifecycle event must also remain unknown. One additional positive C2 test failed first; the local postmortem validator now rejects that present foreign field. All bounded checks passed again (88 selected tests), and the same owned latest C2 slice was amended into the final source HEAD above. Exactly two implementation commits remain after the two picks; this report is a separate evidence-only commit. No assertions were weakened.

Changed implementation paths after the picks are exactly `scripts/run-integration-harness.mjs`, `scripts/preflight-integration.mjs`, and `test/integration/verification-harness.test.ts`. Only one old test body changed: the sole external `manifestProcessGroups` caller now expects `{groups, failures}`. New TypeScript uses tabs.

## 2. Source identities and protected bytes

Final source blobs:

```text
scripts/run-integration-harness.mjs 3340e7d250169baa7cc0bcc4afbfcb050f423593
scripts/preflight-integration.mjs 5c6275b81a79fc3ca32826f440f8ae680b044baa
test/integration/verification-harness.test.ts 6222d6c8cea440ee6d6f017671687740f2e2baa8
```

Five protected blobs equal base and final source:

```text
scripts/lib/integration-harness-auth.mjs 6b90703df1ace92c986824162f2a59ad9b69b95c
scripts/lib/integration-harness-constants.mjs c0a69a7e334d62f971ce1b4bc80674fb0a2855ce
test/integration/harness-supervisor.ts 7fee104fd80fdd20c2cb6143dca098d7d2dd3331
test/integration/harness-admission.ts 9b0e35957cc86b1181f613d26f77f3e4437c922f
test/integration/fixtures/harness-admission.cjs 89ab895db61428d8e97598c7237104a468607e50
```

The entire preflight segment from `function currentProcessGroupId` up to (excluding) `export async function fixIntegrationPreflight` is byte-identical to base: 10,106 UTF-8 bytes, SHA256 `cf3f2ddebeec024201a8a4d4a4dc0237a558d93e6ddeb0e8804ca568df8e5c86`. This includes original group-inspection/authentication/identity checks and the original TERM→KILL reaper. No raw-kill fallback was added.

Accepted pick content is preserved byte-for-byte: `DEV_LOOP.md` equals 893 (`55eef0ca75332aafcd5e0854bcad2653db22ea39`); the runner test ADD equals 8d (`905560a779ced169867f034efc80438d3fe62cf1`); `vitest.config.ts` equals 8d (`16f227b777142924640050c793ba55689984a155`). The runner selector function equals 893: 1,684 bytes, SHA256 `f30f54d0348dd3c14091b32ec12e8682347f966c7f7fa50514078e2fa8098ded`.

Pins are unchanged from base, including version `0.7.5` and Pi `0.99.1`:

```text
package.json blob a361e6efa422c589a573917096934312aff21644
3341 bytes; SHA256 fd801f64662fda1405cde5516ba94bc43029886d49e6be58739eb783bb9200ca
pnpm-lock.yaml blob 2898eea06e4b846b40a9df5866495913a7c014f4
134468 bytes; SHA256 d26fa61985b54bb2be474463794ff5d4ded738fef7d6f8e6403a23d99696f048
```

## 3. Implemented criteria and tradeoffs

1. **Strict C1 census:** public `{groups, failures}` only; internal raw bytes/file identity stay private. Missing/read-lost/nonregular/symlink, malformed/nonobject/unknown/torn records produce named failures without parse excerpts. Spawn tuples require safe pid/pgid/owner, both nonempty births, expected run ID, and existing HMAC validation before cleanup eligibility. Mode is forced shared. Exact complete authority tuples coalesce; same-pgid conflicts preserve all valid candidates and fail, including across observations.
2. **Finite C1 cleanup:** full A → per-group guarded cleanup → full B → one pass over newly distinct valid B tuples. B is parsed completely despite torn A, append, replacement, truncation, or loss. Content or file-identity change is non-green, including identical-byte inode replacement. A results survive; outer `wait` exceptions do not skip later known groups. `readProcessTable` exceptions are correctly treated as the reaper's internal unverified result, not an outer throw. Reaped groups and audit records are non-green. Console prefixes remain, with explicit registered-only scope. Historical source used runner grace750 ms under the coordinator's incorrect request (NOT exercised with real I/O). Applied475's actual runner default was1,000 ms; this unauthorized change was rejected and restored only in D83. The wait implementation itself remained unchanged; browser750 is separate.
3. **Eager C1 coupling:** main creates empty `children.jsonl` with mode 0600 and `wx` immediately after writing owner.json. Missing census is fail-closed in the same C1 commit. That main path and allocation/write-failure finalization were NOT RUN and are not claimed fixed.
4. **Contextual C2 unknowns:** required-root readdir loss is mandatory and fix refuses it. Owner absence differs from invalid I/O/schema/present fields. Current shared `run-*` requires run ID/token, focused lazy absence requires its concrete focused prefix/mode/run/birth, and legacy PID/token/birth or ownerless fake-pi absence is supported only with genuinely absent census and no current shared claim. Present/unreadable legacy census without run authority is unknown. Dead-run schema checks do not verify HMACs without a key; valid postmortem identities remain human-only. Unknown takes precedence over stale and retained and is excluded from both deletion lists.
5. **Fresh C2 removal boundaries:** both ordinary fix and retained purge freshly classify owner plus census immediately before their existing rm sites. Inspect→mutate owner/census→fix or purge preserves new unknown state and returns unresolved issues. Seven mutations are covered on each boundary; purge permission and ordinary retained notice semantics were not expanded.

Tradeoffs: validations remain local to their two existing owners rather than introducing a shared parser/export/module or a new JSONL framework; the live authenticated census and unauthenticated postmortem census intentionally have different policies. Census tuples use simple local array comparisons, not a ledger/index or retention engine; large registration counts are not performance-qualified. Stat/content observations detect observed changes, not every possible transient mutation. Changes after B, or after a fresh classification before rm, require the separately blocked ownership/quiescence/finalization boundary; no atomic filesystem or complete runtime coverage claim is made. Invalid postmortem census is preserved for manual inspection rather than partially promoted into signal authority.

## 4. Containment and exact bounded verification

Read the full repo AGENTS/DEV_LOOP and build/tdd/commit/review-ready skills (including their applicable contracts). Before the first tests, traced the whole mixed test file, imports, supervisor hooks/writers, admission, spawn-pi-pty, terminal-controller/diagnostics/errors, preflight/runner import guards, bundle helpers, constants, auth, and every affected caller. New tests only use owned files and fully injected process I/O. Importing the supervisor registers an afterAll hook, but no selected test initializes its fallback root or spawns a child; its hook stays inert. Global afterEach has no registered children to terminate and removes only owned synthetic roots. The sole selected old census caller only signs/reads/writes owned files. No selected body enters Pi, admission, PTY, providers, MCP, Herdr, or private user configuration. Lint plugin import/I/O paths were traced; its filesystem lookup is the repository config marker, not private agent state.

Cached package metadata and executable output agree: Node `24.15.0`, consumer pnpm `10.29.2`; no system pnpm/Bun/version hunting. Exact cached tools:

```text
/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin/node
SHA256 3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32
/Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs
SHA256 b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9
```

No node_modules initially existed. One permitted install succeeded with `install --offline --frozen-lockfile --ignore-scripts --store-dir /Users/sumodeus/Library/pnpm/store`: 337 reused, 0 downloaded; no install/build scripts. Owned verification agent/state/config/diag/tmp/cache are under `.local/canonical-source/`. HOME, Git configuration files/settings, and GIT_CONFIG_COUNT were not changed. Git commands used `LEFTHOOK=0`; no hook cleanup was performed.

Exact shell prefix for all focused Vitest, tsc, build, lint, and final syntax invocations (run from the worktree):

```bash
scrub=()
for key in $(compgen -e); do
  case "$key" in
    HERDR_*|PI_*|SUMO_*|SUMOCODE_*|NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|PNPM_*|NPM_CONFIG_*|npm_config_*|AWS_*|AZURE_*|GOOGLE_*|GEMINI_*|OPENAI_*|ANTHROPIC_*|MISTRAL_*|GROQ_*|XAI_*|DEEPSEEK_*|OPENROUTER_*|TOGETHER_*|FIRECRAWL_*|TAVILY_*|BRAVE_*|*API_KEY|*API_TOKEN|*AUTH_TOKEN|*ACCESS_TOKEN|*CLIENT_SECRET|*PASSWORD|*_SECRET|*_TOKEN)
      scrub+=(-u "$key");;
  esac
done
safe=(env "${scrub[@]}" LEFTHOOK=0
  PATH="/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin:$PATH"
  NPM_CONFIG_USERCONFIG="$PWD/.local/canonical-source/empty.npmrc"
  NPM_CONFIG_GLOBALCONFIG="$PWD/.local/canonical-source/empty.npmrc"
  XDG_CONFIG_HOME="$PWD/.local/canonical-source/config"
  XDG_CACHE_HOME="$PWD/.local/canonical-source/cache"
  TMPDIR="$PWD/.local/canonical-source/tmp"
  NODE_COMPILE_CACHE="$PWD/.local/canonical-source/cache"
  PI_CODING_AGENT_DIR="$PWD/.local/canonical-source/agent"
  SUMOCODE_STATE_DIR="$PWD/.local/canonical-source/state"
  SUMOCODE_CONFIG_DIR="$PWD/.local/canonical-source/config"
  SUMO_TUI_DIAG_FILE="$PWD/.local/canonical-source/diag.jsonl"
  /Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin/node
  /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs)
```

The install prefix was the same scrub/tool/cache/config/tmp prefix before adding the agent/state/config/diag selectors (no tests/app imports during install). No replacement HOME or Git override was supplied. `env -u` entries precede assignments.

Exact focused command suffixes and retained red/green lines:

```bash
# C1 red; exit 1, intentional assertion failure
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical census hardening'
# AssertionError: expected [ { pid: 60001, pgid: 60001, …(8) } ] to deeply equal { groups: [], failures: [ …(1) ] }
# Tests  1 failed | 83 skipped (84)

# C1 green; exit 0 (also the only old caller selected)
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical census hardening|harness manifest audit contract'
# Tests  29 passed | 82 skipped (111)

# C2 root red then root green; exits 1 then 0
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical preflight read loss'
# red: AssertionError: expected [ { …(3) } ] to deep equally contain ObjectContaining{…}
# expected code "harness-root-unavailable"; received only "node-modules-missing"
# red: Tests  1 failed | 111 skipped (112)
# green: Tests  1 passed | 111 skipped (112)

# C2 contextual owner red; exit 1 before owner/census implementation
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical preflight read loss.*preserves unknown current shared owners'
# AssertionError: expected [] to deep equally contain ObjectContaining{…}
# expected code "harness-owner-unverified"; received []
# Tests  12 failed | 157 skipped (169)

# Additional C2 lifecycle red; exit 1 before the one-field validation correction
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical preflight read loss.*foreign exit'
# AssertionError: expected [ { …(3) }, { …(3) } ] to deep equally contain ObjectContaining{…}
# expected code "harness-census-unverified"; received only table/module issues
# Tests  1 failed | 169 skipped (170)

# Combined C2 and first completion-gate green; exit 0 each
"${safe[@]}" exec vitest run test/integration/verification-harness.test.ts --fileParallelism=false -t 'canonical census hardening|canonical preflight read loss|harness manifest audit contract'
# Test Files  1 passed (1)
# Tests  87 passed | 82 skipped (169)
# Same combined command after lifecycle correction: final-v2-green.log; exit 0
# Tests  88 passed | 82 skipped (170)
```

C1 and C2 also each passed ordinary `exec tsc --noEmit` followed by `build`. Final commands all returned 0:

```bash
"${safe[@]}" exec tsc --noEmit && "${safe[@]}" build
"${safe[@]}" exec oxlint scripts/run-integration-harness.mjs scripts/preflight-integration.mjs test/integration/verification-harness.test.ts
"${safe[@]}" exec node --check scripts/run-integration-harness.mjs
"${safe[@]}" exec node --check scripts/preflight-integration.mjs
LEFTHOOK=0 git diff --check 475560cf45becbafe81b41a718b4724c1cc871cb HEAD
```

Historical checks used no negatives/default test filters, retries, module mocks, new exports, fixture drivers, or baseline rewrites. The original report's no-timeout-change claim was incorrect: source runner grace changed1,000→750 under the coordinator's wrong premise; actual default wait was NOT RUN. D83 restores the declaration without claiming timing equivalence. Every new audit supplies readProcessTable/readProcessStart/currentPgid/kill/wait; every new fix supplies table/rows/readRows/currentPgid/kill/wait. The only real process probes in selected test bodies are the existing non-signaling `kill(pid, 0)` metadata probes on synthetic impossible-dead PID 2147483647; they are not live identity proof. Synthetic audit stdout saying zero registered survivors is not an actual runtime audit.

Full test/install stdout/stderr logs are retained losslessly under `.local/canonical-source/logs/`, each under 5 KB (no failure log overwritten). Key artifacts:

```text
c1-red.log 1801 bytes SHA256 112bf6698cc7f203c5a65f6a9f3c64e66c053099b8d0fc23d93634676d2adb21
c1-green-final.log 4274 bytes SHA256 8341c5eec88f6df64afaeec2f39dea0f4c66e954b7d36049dcf4ffc375e4bd36
c2-red.log 1521 bytes SHA256 f9a88d3a76f45e10023718224262d4c555191d0507f560ea0e32c697ac97a6ca
c2-root-green.log 281 bytes SHA256 33cecec6d94dcce6327b43b9b3d35d5aa63a48f4929fbacbfb02f48442b64400
c2-owner-red.log 4704 bytes SHA256 1a7db875aa5cef1606a44a5c3ba51daee4d08568644bf451100db0b642448a86
c2-green.log 4274 bytes SHA256 b94894dca55b43400c519d69123d04cdc8fb8bc2b726a3235f6148ae6138bc0d
final-green.log 4274 bytes SHA256 152f1f549ed1b2e48ada4e842900d43670d9ff1310c17be71455622a194cd9e7
c2-lifecycle-red.log 1710 bytes SHA256 b7b7c9b5fc81501ee5ae92123189bc958ba6be0206a51b3289580e34985d1a93
final-v2-green.log 4275 bytes SHA256 38c61d4f66b53bda619530f53007c423e444d7528f5f9c5508b052e3e0bfcace
install.log 855 bytes SHA256 31bb5d031d4747e0e72816d58a0d5b2a12165b6952224b6887bb5305915b95d1
```

`identities.log` retains pin/protected/tool/contract identities and preceding log hashes; `identities-final.log` rechecks protected/pin equality and records the final lifecycle-red and final-v2 verification log hashes. Empty final tsc/lint/syntax logs are successful silent commands, not omitted output; final build prints `> tsc --noEmit`. Earlier C1 green and per-slice verification logs remain beside the final logs.

Execution notes: one initial read used nonexistent `test/integration/harness-auth.mjs` and returned ENOENT; the actual `scripts/lib/integration-harness-auth.mjs` was then fully read before testing. An early standalone syntax-only `node --check scripts/run-integration-harness.mjs` did not use the uniform environment prefix; final syntax checks used the scrubbed prefix above. Ambient NODE_OPTIONS/NODE_PATH were absent when metadata-inventoried (values were not read). This is recorded rather than promoted into a privacy certificate. No code, fixture, app, or PS failure was retried or hidden.

## 5. Review-ready gate and remaining STOPs

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (bundled default; no applicable repo code-quality override found).
Changed seam: public census/audit and preflight inspect/fix interfaces.
Trace: signed tuple → schema/HMAC gate → full A cleanup → full B comparison/new candidates → registered-only result; dead shared owner → contextual census validation → unknown issue → fresh fix/purge classification → preserve and report unresolved.

### Caller-knowledge

Callers consume groups/failures rather than silent absence; audit owns finite observation/union/continuation and delegates live authority only to the unchanged reaper. Its extra public process-I/O bag reuses the reaper seam. Preflight callers do not need to distinguish malformed fields themselves; inspect/fix own that policy.

### Deletion

Removing these local owners would push manifest authentication/change detection or contextual deletion policy back into callers. No generic pass-through wrapper, new module, parser engine, supervisor, runtime, or dependency was introduced.

### Ownership

Authenticated census lifecycle stays in the runner; postmortem unknown classification and deletion refusal stay in preflight. Protected signal authority remains in the original inspection/reaper segment. Minimal file-identity checks remain local; no authority was ported.

### Test-surface

Tests use the actual public interfaces with real owned files, actual signing helper, and explicitly replaced process I/O. Inode replacement is a real owned-file rename, not a mock. Later-group cleanup uses real unchanged reaper logic with injected tables/wait/kill. Final human-only assertion records zero attempted signals even for a signature-bearing row. No test-only export or module mock was added.

Simplification pass: reread all changed files top-to-bottom after green, traced representative inputs, retained local validation despite intentional policy overlap, reused existing option bags/hooks/fixture-root teardown, and introduced no generalized framework. No additional production refactor was needed. New comments explain shared-mode forcing, finite observations, absent legacy authority, and fresh destructive boundaries.

Verification: bounded checks PASS; overall INCOMPLETE. Ordinary tsconfig includes only `src/**/*.ts`. **Static integration typing NOT RUN:** the `manifestProcessGroups` envelope and its old/new TypeScript consumers, `auditAndReap` fourth process-I/O parameter, and `fixIntegrationPreflight` unresolved-issues return are runtime-tested/transpiled but not checked by ordinary src tsc. No supplemental integration-typing waiver/check, mixed-file run, or historical baseline repair was performed.

Exceptions: delegated source-only verification restriction supersedes the skills' full-suite/publication workflow. Eager-main/C3 and actual runtime are explicitly unverified, not waived. Local live/postmortem validators deliberately remain separate because a shared export/module/parser and authority changes are outside the grant. The source candidate is ready for coordinator review within these boundaries, not for runtime reuse/adoption.

NOT RUN / blocked:

1. Eager main allocation/write/finalization, successful preflight CLI, full integration/mixed verification file, old real-spawn test, real ps/table scans, actual process signals, namespace startup/admission, and whole-process zero-survivor/quiescence proof.
2. C3 owner-control-plane signature, hook-free ESM/admission seam, interruption/repeated signals/group await/encompassing finalization and retention failures. Original runner forwarding/finalization remains untouched; no raw-signal waiver, exitCode proof, zombie/libuv argument, or SIGINT exemption.
3. Full pnpm test, native/app/PTY/MCP/provider/Herdr, visual/golden/performance/security/OS-sandbox gates, heavy lease, success-retention proof, and source-privacy certification.
4. Browser54 public URL/pipe API route remains STOP; browser57 local-doc review and jiti55 remain separate/local. No posting/download/repro/audit/source promotion. #396/#590, adoption, merge, publication, and release remain blocked.
5. Independent code/spec/standards review: not launched here. Coordinator must review this exact source HEAD and evidence before any apply or reuse. Parent dirty plans/.build, private user state, installed clone, worktree, and historical failures were not modified or cleaned up.

**Historical next action (superseded):** coordinator review of isolated `a5abe2cb131e7a94788bab4fb3c986e8bce35888` led to independent59/60 REQUEST CHANGES. Those old source/evidence identities are rejected, not reuse/adoption permission; current D83 next action is above.
