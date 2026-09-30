# v0.8 READY node: reliability

Status: candidate implemented; owner adoption pending. Heavy verification and independent review await coordinator scheduling. No DAG successors executed, publication, parent edits, UX redesign, Effect dependency, or native retention support added.

## Identity and scope

- Isolated worktree: `sumocode.sumo-worktrees/sumo__v08-reliability`; branch: `sumo/v08-reliability`.
- Immutable base, verified before editing: `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39` (0.7.5 / Pi 0.99.1).
- #595 original candidate: PR #596, `origin/fix/595-scope-subagent-recovery`, `aef952a20e5a84579151549f626ca753bae9d9e2`; original base `e533876233927cb6edbe0aca83e5342753a671a7`.
- #595 applied head: `f8997af2abed17589cc1ea69e72a76744e6472a5`. All 16 candidate commits cherry-picked; all 13 candidate paths compare byte-identical to #596. Original branch/ref preserved.
- #578 implementation head: `f5c3e1bfe8453bdaad5d6037044a6f5668a33ec5`; core report commit `e35de8e043c6efc2c7e936bb5b1145907a51882f`, final-drain commit `f5c3e1bf`.

#595 paths: `src/subagents/{index.ts,index.test.ts,manager.ts,manager-adoption.test.ts,retained-adoption.ts,retained-adoption-race.test.ts,retained-reconstruction.test.ts,retained-runtime.test.ts}` and `test/integration/{fixtures/plan112-local-faults.ts,fixtures/plan112-source-controller.ts,plan112-controller-executor.test.ts,subagent-production-retention.test.ts,subagent-recovery.test.ts}`. Additional original paths are fixture updates needed to model explicit handoff versus same-session disk recovery, not new features.

#578 paths: `src/sumo-tui/rpc/{host.ts,host.test.ts,host-lifecycle.ts,host-lifecycle.test.ts,client.ts,client.test.ts}`. Native entry, source wrapper, and terminal renderer remain unchanged.

Original → applied #595 commits, oldest first:

```text
c0a5bdd0 → 1207af99   scope retained recovery to its session
ae0c7f1b → d1f412e9   bind replacement adoption to Pi target
2e965187 → 48fe2dde   retry recovery after lease expiry
b81f405d → 84f30a55   model targeted production handoff
b1ea04e3 → f2344736   encode replacement destination
d12954f2 → 2826ab7d   fence superseded recovery retries
2fb3f90c → 4dbd9639   cover targetless reload delivery
3706eff5 → c194747a   assert pre-handoff delivery ownership
b3029c83 → 2d1a9328   harden retained takeover retries
8a076911 → dac281ec   clarify takeover lease timing
92fe793d → 30a80359   fence admission retries on evidence
18bbee45 → 205e04c9   preserve reserved writer renewals
c1562098 → 7430a0a7   clarify replacement lifecycle guards
e187e409 → a318e9df   bind reload source from shutdown context
13b4b470 → d530526f   keep lifecycle context current
aef952a2 → f8997af2   release legacy replacement state
```

## Reproduction and evidence

Use repository-pinned pnpm 10.29.2 (`npx --yes pnpm@10.29.2 <arguments>` if the system pnpm differs). Frozen installation succeeded in this worktree without lockfile changes. System pnpm 12.6.0 initially refused the pinned Pi packages under its minimum-release-age default; repository-pinned pnpm was used rather than editing policy or dependencies.

#595: reused #596's cross-session regression oracle after reading its old foreign-adoption assertion; ran it against pinned production source before applying candidate commits. Restored the temporary test edit before cherry-picking; no candidate assertions rewritten.

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts -t "leaves another session's retained record untouched"
```

Exact red excerpt:

```text
AssertionError: expected [ { entry: { …(4) }, …(2) } ] to deeply equal []
Test Files  1 failed (1)
Tests  1 failed | 21 skipped (22)
```

Green recovery command and excerpt:

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts src/subagents/retained-adoption-race.test.ts src/subagents/manager.test.ts src/subagents/index.test.ts src/subagents/manager-adoption.test.ts src/subagents/retained-runtime.test.ts
```

```text
Test Files  6 passed (6)
Tests  256 passed (256)
```

#578 core report: new lifecycle acceptance test drove the real exit-handler factory through lifecycle stop, terminal restoration, stderr, and exit; ran before implementation.

```bash
pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts -t 'prints the child crash'
```

```text
red: AssertionError: expected [] to deeply equal [ { terminalRestored: true, …(1) } ]
red: Tests  2 failed | 36 skipped (38)
green: Test Files  1 passed (1)
green: Tests  2 passed | 36 skipped (38)
```

#578 drain: new client regression exercised real transport error → reap → final stderr → stdio close; ran before retaining the stderr listener through reap.

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts -t 'retains final stderr while reaping'
```

```text
red: AssertionError: expected 'before failure\n' to be 'before failure\nfinal diagnostic\n' // Object.is equality
red: Tests  1 failed | 57 skipped (58)
```

Green expanded RPC command:

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts
```

```text
Test Files  3 passed (3)
Tests  233 passed (233)
```

Final required focused command (PASS):

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts src/subagents/retained-adoption-race.test.ts src/subagents/manager.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/client.test.ts
```

```text
Test Files  6 passed (6)
Tests  380 passed (380)
```

Adjacent production-host contracts (PASS): `pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts src/sumo-tui/rpc/host-protocol-errors.test.ts src/sumo-tui/rpc/host-entry.test.ts` → `Test Files  3 passed (3)` / `Tests  25 passed (25)`.

`pnpm exec tsc --noEmit && pnpm build`: PASS. `pnpm lint`: PASS, four existing unused-variable warnings in unchanged `scratch/tui-audit/proto/gen.mjs`; no new warning. `git diff --check`: PASS.

Exact runner logs retained locally as `/tmp/sumo-reliability-{595-red,595-green,578-red,578-green,578-drain-red,578-drain-green,final-focused,final-build,final-lint,host-adjacent}.log`. All fixtures are synthetic; no paid provider or private session used. Global Git hook fallback created untracked `.build/` and attempted the incompatible system pnpm; evidence is preserved, not committed. Subsequent authored commits used `LEFTHOOK=0` with explicit checks above, without changing global hook configuration.

## Feasibility and tradeoffs

Recovery stays in the existing manager/registry seam. Disk reconstruction filters `controllerSessionId ?? ownerSessionId` before mutation/delivery; replacement routing matches Pi's shutdown target file, with source-session fallback only for targetless reload. Dead-but-unexpired ownership defers until every blocking dead-owner lease expires; the one-shot retry is lifecycle-fenced. Registry CAS, authority, ambiguous identity and PID-reuse refusals remain unchanged. Targeted pending handoffs remain parked until their target starts or process exit, preserving the reviewed candidate's tradeoff.

Crash flow: client bounded stderr capture → `createRpcExitHandler` records the first crash before UI work/delay → any `RpcHostLifecycle.stop` path restores terminal and reaps child → one stderr report before resolving exit. The report includes child code/signal, bounded reason, and newest 20 sanitized stderr lines, without requiring `-d`. The first observed crash survives urgent SIGINT/SIGTERM/quit/reload/runtime-exit and duplicate events. Normal quit/reload remains quiet. Pre-adoption failure during retained reload restores the inherited terminal at the existing lifecycle seam; no entry/wrapper expansion required. Transport/protocol failures keep stderr draining through reap while stopping protocol delivery immediately.

Tradeoffs: preserve the existing 750ms toast; reuse the 64 KiB client tail, 500-byte reason cap, and existing redaction/output-tail helpers rather than new buffers or logging infrastructure. Reports are diagnostic evidence, not durable result delivery. No Effect claim is made about disk/lease/OS identity. Native/Bun retention remains unsupported/disposable.

## Security findings

Foreign-session reconstruction must leave records and recovery evidence untouched; focused regressions cover this and the authority/identity race fences. No built-in tool registration, approval gate, role permissions, or MCP grant changes.

Crash output reuses terminal-control stripping and known-credential redaction, performed before display limits. Embedded stderr is removed from the reason so old rows cannot bypass the 20-line limit. A byte-truncated leading row is conservatively dropped because its credential label may be missing. Arbitrary opaque secrets cannot be proven absent by heuristic redaction; stderr remains local user-visible diagnostic data and should be inspected before sharing. No new diagnostic file, environment dump, or telemetry is written. Unavailable exit identity is reported as unknown for transport/spawn failures. Child reap failure and terminal I/O limitations remain explicit existing failure boundaries.

## Performance findings and remaining gates

Performance benchmark: not applicable to this bounded reliability node. New report formatting runs once at shutdown over an existing bounded tail; normal rendering/request hot paths are unchanged. Recovery adds an unref'd one-shot timer at legal lease expiry, not continuous polling. No throughput/performance improvement is claimed.

NOT RUN, coordinator lease required: `pnpm test`, `pnpm test:integration` (including zero-survivor audit and production retention), `pnpm test:native`, `pnpm visual:ci`; any real PTY crash capture/native/compatibility/bundle verification must also be sequentially scheduled. No visual goldens promoted. The unit terminal-restore ordering oracle is not live PTY/native evidence.

Review-ready design check used `~/.pi/agent/skills/review-ready/contract.md`: caller-knowledge—host records crash intent, lifecycle owns reporting; deletion—removing lifecycle would spread teardown/reporting across callers; ownership—client owns bounded capture/reap, host owns exit classification, lifecycle owns post-restore publication; test-surface—public reconstruction, exit-handler, lifecycle and client interfaces with synthetic process/time/terminal boundaries. Simplification: reused reviewed recovery and shared redactors; no new framework, module, runtime selection, or configurable subsystem. Full review-ready gate remains pending independent review and coordinator heavy gates; no review loop was run here.

Next action for the original candidate: coordinator grants the sequential heavy-verification lease, then independent review and owner adoption. The isolated revision below supersedes this candidate for the next independent review.

## Bounded follow-up revision1of2

Status: COMPLETE for the authorized bounded implementation and focused checks only. Candidate independent re-review is next; owner adoption remains pending. This is not independent approval, a heavy-gate result, or a release decision.

Identity:

- Own path: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-reliability-revision-1`; branch: `sumo/v08-reliability-revision-1`.
- Fresh preserved immutable base: `15ab38b036bfdf9e5e453d660f355f9103cc0f47`; approved runtime ancestor remains `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39`, Pi 0.99.1.
- Revised source/test head: `734a0fcd89503cec595471d1d1e881b1b23b90d0` (`fix(reliability): secure startup reports and detach legacy views`). The subsequent evidence-only commit has this source head as its parent.
- Source/test changes only: `src/sumo-tui/rpc/host-lifecycle.ts`, its colocated test, `src/subagents/index.ts`, its colocated test. Evidence changes only in this document. Original 16 #595 commits and their assertions remain in ancestry, with no original assertion removed or weakened.
- Parent/old candidate/remote branch untouched. No manager, recovery authority, schema, Effect, MCP, dependency pin, launcher, native entry, DAG, README, or golden changes.

### Finding 1 — REJECTED: suppressing the reload cleanup acknowledgment

The suggested `restoreTerminal(false)` would confuse terminal responsibility with UI startup success. `bin/sumocode.sh:1276-1293` restores original termios but skips terminal mode fallback when the marker is `ready`; `:1333-1335` explicitly defines the marker as the terminal owner's responsibility acknowledgment. `:1393-1396` invokes that fallback after any non-100 host exit, including failure. `src/native/main.ts:693-708` likewise reads `ready` to skip fallback. `sumo-rpc-host.js:152-160` intentionally writes `ready` after failed-reload terminal cleanup; its failure callers are `:267-276` and `:307-321`. All marker consumers and their surrounding control flow were read; there is no contradictory startup-success contract.

No production marker change. Public lifecycle test `host-lifecycle.test.ts:267` observes an empty marker at the terminal restore boundary, then `ready` before child reap, exit side-channel `1`, phase `stopped`, one post-restore report, and no runtime/input/editor/command-ready operations. It passed before any marker edit (none was made). The rejecting entry still owns generic pre-adoption setup failures, as the original assertion requires. Omitting the acknowledgment could trigger a second outer cleanup after the persistent diagnostic is printed; the bounded test is an ordering oracle, not live PTY proof.

### Finding 2 — REJECTED: speculative pathname canonicalization

Pi 0.99.1 public shutdown types only promise a destination pathname (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:603-609`). Its implementation provides the stronger relevant property: `agent-session-runtime.js:128-145` opens one successor `SessionManager`, emits that manager's `getSessionFile()` via `teardownCurrent`, and passes the **same manager** to runtime creation. `/new`, persisted `/fork`, and import do the same at `:147-172`, `:206-230`, and `:278-290`; reload is targetless (`agent-session.js:2870`).

This is identical-string routing, **not a realpath guarantee**. `session-manager.js:665-666,782-784` stores `resolvePath(sessionFile)` and returns it unchanged; `utils/paths.js:82-86` resolves relative inputs without following symlinks. Aliases are not converted between shutdown and startup by this flow, so there is no evidence-based legitimate alias miss to fix. Guessing nonexistent future paths, using the predecessor cwd for a successor path, or widening target identity to guessed filesystem aliases is unnecessary.

Public contract tests `index.test.ts:731` invoke the installed Pi's actual `AgentSessionRuntime.switchSession` and actual `SessionManager` with relative and directory-symlink inputs, across cwd changes, routing their events through `installSubagents`. Both passed with the original exact comparator: the symlink spelling deliberately differs from `realpathSync(file)`, yet the shutdown and successor strings match and retained control adopts exactly once, without signalling or interruption. The test runtime-creation boundary is synthetic; no provider is contacted.

Added opt-in `subagent_replacement_parked` diagnostic in `index.ts:360-364`: only the enum `target=session-file|session-id`, never session contents, credentials, IDs, or paths. `index.test.ts:780` first failed because this diagnostic did not exist, then passed: a different target leaves the full registry record unchanged, does not detach the origin or offer it to the foreign manager, and later adopts once at the exact not-yet-created destination. Unmatched replacements remain parked until their destination starts or process exit, an explicitly accepted tradeoff. No expiry, foreign detach, or abandoned-target auto-recovery claim.

### Finding 3 — FIXED: raw, pre-cleanup owned startup reporting

Root cause: `RpcHostLifecycle.run` wrote the thrown message and raw client stderr before its `finally` stop. The reachable `childOwned && code === undefined` path now records the failure through `recordChildCrash` and leaves output to the existing post-finalization report (`host-lifecycle.ts:115-125,237-252,304-328`). A plain setup failure is labelled `RPC host startup failed`, with code/signal `unknown`; only `RpcChildExitError` supplies a process identity. No invented exit code or unsupported child-blame claim.

Public `lifecycle.start` regression at `host-lifecycle.test.ts:169`, with and without a runtime, throws a real `Error` while the client/child are owned. Its real bounded UTF-8 tail includes a byte-truncated credential first row, more than 20 lines, an authorization credential, OSC clipboard data and CSI styling. The child stop boundary is held pending: terminal restore has occurred but output must remain empty until reap completes and contributes its final stderr row. Red: **2 failed / 46 skipped (48)**, raw writes were already present. Green after the fix: **48 passed**, including the two startup cases. Final expected report has exactly the newest 20 sanitized rows, no synthetic credential/control payload or duplicate, and exit 1.

Additional public guard tests `:203` and `:216` preserve deliberate exit 0/100 silence and the exit handler's first crash during startup rejection. Original urgent-signal/quit/reload/runtime-exit, duplicate-event, unknown-identity, pre-adoption-root-intent and seven reap-failure cases remain unchanged and green. The initialization/reap-failure case confirms a throwing child stop does not wedge cleanup, cache disposal, listener removal, or exactly-once exit.

### Finding 4 — FIXED: plain-error embedded stderr bypass

`SumoRpcClient.start` can throw a plain `Error('RPC child exited during startup. stderr=...')` (`client.ts:322`), not only `RpcChildExitError`. Shared formatting now splits `. stderr=` unconditionally at `host-lifecycle.ts:314`, before the separate reason redaction/500-byte bound. All existing tail redaction, byte bound, conservative truncated-row handling and last-20-line limits remain shared; no new buffer/logger.

Public exit-handler/lifecycle regression `host-lifecycle.test.ts:232` supplies that exact plain-error shape with an embedded old payload and a truncated credential tail. Red: **1 failed / 45 skipped (46)**; older rows and embedded payload bypassed the independent tail limit through the reason. Green: **1 passed / 45 skipped (46)**. The expected report contains only the plain reason and newest 20 tail rows, with unavailable identity honestly `unknown`.

### Finding 5 — FIXED: detach safe v1 manager views before dropping state

Validated the earlier v1 manager's public API directly with `git show 8ac67f6c:src/subagents/manager.ts`: `detachForReplacement` at `:305-321` has the same retained-view semantics as current `manager.ts:306-322`. It unsubscribes retained observers and removes retained children from the disposable child map **before** `disposeAll`; retained persistence owners, leases and process trees are not terminated or newly claimed. Disposable/non-retained work remains unsupported, as before.

`index.ts:36-44` now calls that public API best-effort for each legacy entry before clear/delete. A malformed entry or throwing detach is contained per entry and optionally diagnosed with `scope=legacy-detach`; no reflection, unchecked optional-method cast, migration or adoption was introduced. A legacy shape lacking the API is dropped after its call fails; this does not signal an unknown process.

Public installer regression `index.test.ts:306` places a real manager with a real retained registry/control grant and supervisor boundary in the v1 set, alongside `{}`, `null` and a throwing entry. Its detach spy calls the real API. Red after correcting the test-owned record to satisfy the unchanged schema: **1 failed / 32 skipped (33)** because detach was never called. Green: **1 passed / 32 skipped (33)**. Startup continues; observers go from one to zero, old snapshots disappear and cannot deliver, the legacy set is cleared/deleted, and no adoption, interruption or tree signal occurs. The entire retained record is unchanged. No native/Bun retention support added.

### Revision verification and retained evidence

Fresh own-tree `pnpm 10.29.2 install --frozen-lockfile` passed with no lockfile/dependency edits. Initial source test/type/build/lint commands used this command-local prefix (flags before assignments); post-commit commands also set `LEFTHOOK=0` as explained below:

```bash
env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID LEFHOOK=0 npx --yes pnpm@10.29.2 <command>
```

Required focused suite (PASS, **6 files / 387 tests**, original 380 plus 7 new lifecycle cases):

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts src/subagents/retained-adoption-race.test.ts src/subagents/manager.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/client.test.ts
```

Recovery/installer and host-adjacent suite (PASS, **6 files / 138 tests**):

```bash
pnpm vitest run src/subagents/index.test.ts src/subagents/manager-adoption.test.ts src/subagents/retained-runtime.test.ts src/sumo-tui/rpc/host-cleanup.test.ts src/sumo-tui/rpc/host-protocol-errors.test.ts src/sumo-tui/rpc/host-entry.test.ts
```

Required adjacent host-only rerun (PASS, **3 files / 25 tests**, subset of the preceding 138, not extra unique tests):

```bash
pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts src/sumo-tui/rpc/host-protocol-errors.test.ts src/sumo-tui/rpc/host-entry.test.ts
```

Total: **525 unique tests in 12 files passed**. `pnpm exec tsc --noEmit && pnpm build && pnpm lint`: PASS; only the same four unused-variable warnings in unchanged `scratch/tui-audit/proto/gen.mjs`. `git diff --check`: PASS. No assertion/timeout weakening or lint/policy waiver. No paid provider/private session used.

Local runner logs are `/tmp/sumo-reliability-revision1-{reason-red,reason-green,startup-red,startup-green,marker-green,legacy-red,legacy-green,path-contract,installer-green,types,focused,adjacent,host-adjacent,build-lint}.log`. `path-contract` records the two passing Pi path probes and missing-diagnostic red; the complete installer-green log contains its subsequent green. Test payloads are synthetic; raw red-run fixtures/control bytes are not copied into this document. First legacy attempt failed on test fixture schema, then a real detach regression was obtained before changing source.

Hook caveat: the literal requested `LEFHOOK=0` did not suppress the installed global Lefthook shell hooks on the source commit; those hooks check `LEFTHOOK=0`. Their fallback printed missing-config/missing-executable messages, created an untracked `.build/` cache, and disrupted this own tree's dependency links. The cache is preserved, not cleaned or committed. Own-tree pinned frozen reinstall restored the links without lockfile changes; all 12 selected files were rerun together at source head `734a0fcd` (**525 passed**) and `tsc --noEmit && build && lint` reran successfully with the same four unchanged warnings. Additional logs: `/tmp/sumo-reliability-revision1-{reinstall,postcommit-focused,postcommit-build-lint}.log`. Subsequent commit uses both variables command-locally; no agent environment, global Git config, parent tree, or installed hook file was changed. Explicit pinned checks, not hook output, are the verification evidence.

NOT RUN in this revision by the authorized lease boundary: full `pnpm test`, `pnpm test:native`, `pnpm test:integration`/preflight/zero-survivor audit, `pnpm visual:ci`, `pnpm render:bible`/visual review/promotion, real PTY crash capture, native archive/bundle builds and provenance guards, supported Pi compatibility matrix, dependency audit/dead-code CI, and performance benchmarks. Verification17's separate heavy run is not evidence for this changed HEAD; the coordinator must schedule any required heavy re-verification. No cleanup/purge, publication, push, merge, tag or release performed.

### Review-ready gate (bounded source scope, not independent approval)

Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`. All changed source/test files were reread top-to-bottom after the final green runs; this evidence-only update was also reread before commit.

Changed seam: `RpcHostLifecycle.start/stop` reporting and `installSubagents` session shutdown/start replacement routing. Narrative entry points and owners remain the existing lifecycle and installer modules.

Trace: owned startup throw → capture failure only if no prior root intent → finally stop → terminal restore → child reap/final stderr drain → shared sanitized report once → stopped/exit 1. Pi relative/symlink resume → successor manager's exact pathname → shutdown pending handoff → matching installer startup → existing fenced adoption once. v1 set → best-effort public detach → drop unscoped state, never adopt.

#### Caller-knowledge

Existing host callers still record a child crash with one `Error`; the default kind and all output policy remain lifecycle-owned. Only its own startup catch chooses the honest startup label. Installer callers need no new setting or guessed path transform.

#### Deletion

Removing lifecycle reporting would spread privacy/order logic across startup and exit callers. The fix deletes the raw catch formatter and reuses its existing deep reporting/teardown seam. Removing the installer routing would spread destination/detach policy into managers; none was moved there.

#### Ownership

Client owns bounded capture/reap; lifecycle owns root-intent precedence, classification and post-cleanup publication; installer owns pending destination routing and safe legacy-state release; manager/registry retain unchanged authority, identity and CAS fences.

#### Test-surface

New checks enter through `lifecycle.start`, the public exit handler, public installer events, and installed Pi's public runtime/session manager. Registry is real; time, terminal, process/supervisor and runtime-creation boundaries are synthetic. No production helper is exported for tests, no private method is called, and no whole-module mock added.

Simplification pass: retain one report formatter/tail, add only a local failure-kind discriminator for truthful classification, reuse the existing public detach and opt-in diagnostic sink, keep exact routing after evidence disproved a legitimate alias miss. No new expiry/recovery subsystem, filesystem-normalization pass, logger, schema or authority API.

Verification: all authorized bounded checks above pass. Exceptions: none in the changed design scope; heavy/live/native/visual gates are explicitly deferred by coordinator ownership, not waived or claimed passed. Arbitrary opaque secrets remain outside heuristic redaction guarantees; unit ordering is not PTY/native proof; unmatched destinations remain parked; unknown legacy shapes receive no assumed authority.

Next action: independently re-review this revision candidate, then let the coordinator schedule required changed-HEAD heavy evidence and seek owner adoption.
