# #591: cancel losing completion-manifest work

Base: `0bbfc2a9` (#590 integration HEAD). Branch: `sumo/v08-591-manifest-cancel`.
This is the manifest/settlement slice, not the #592 retained-child cancellation work.

## Review repair P1: completion deadline

The collector now reserves the last 500ms of its existing budget for termination
and drain (less when module loading leaves less budget). Abort is synchronous;
Git receipt joining is interruptible work, not an uninterruptible finalizer.
The absolute deadline can therefore publish `{ exit, durationMs, cleanup:
"unproven" }` if receipts are still outstanding. Bounded adapter cleanup continues
independently, with no manager/supervisor references or publication authority.
Late receipt/builder settlement cannot upgrade the published evidence, diagnose
a stale builder failure, notify listeners or consume another generation.
The optional cleanup marker survives validated retained reconstruction and appears
in completion text; legacy artifacts without it keep their original shape.

Tradeoff: evidence collection ends at 4.5s rather than spending all five seconds
collecting evidence and then extending completion availability with teardown.
A missing receipt is explicitly not proof of termination. No service, new
runtime owner, completion ID, durable fence or performance sample is introduced.
TestClock checks cover termination at 4.5s, proven drain at 4.75s, missing drain
at 5s, and late receipts across deadline/disposal/replacement generations.

## Review repair P2: owned Git groups

Manifest Git reads now use `spawn(..., { detached: true })`; Node `execFile`
does not forward `detached`. Each read owns the fresh PGID, stdout bound,
watchdog, cancellation listener and a maximum 500ms cleanup window. TERM and
KILL each get a 100ms empty-group wait. PATH-independent asynchronous `ps`
probes (75ms timeout) bracket signalling with live spawn-handle or previously
captured PID/birth anchors, reject the current group, and refuse an unknown or
foreign group. Existing `systemProcessTree` helpers perform fresh-group signals
and empty-group verification. There is no synchronous `ps` in the public
collector/finalizer, new process service or Effect process/identity owner.

A read receipt now separately reports whether both the group and pipes drained.
A bounded but unproven receipt produces partial evidence with the cleanup marker,
never complete-shaped or clean-checkout evidence. Cleanup has no completion
publication capability; its referenced, bounded timer prevents a disposing idle
Node owner from exiting between TERM and KILL. The receipt/adapter result is
immutable once selected, even if `close` arrives later.

Tradeoffs: POSIX ownership is the dedicated group, not a descendant that explicitly
escapes it with setsid/daemonization (the existing process-tree policy). Unavailable
or ambiguous identity probes fail closed and record unproven cleanup rather than
signalling by a bare PID/PGID. Windows has no POSIX group guarantee here: its
spawn handle is stopped, but group drain is reported unproven. No platform
process owner or permission/identity fallback was added. No perf samples were
collected; #589 acceptance remains separate.

The default-mode real-process fixture now starts three Git leaders, each with a
TERM-ignoring helper that does not inherit Git's pipes. Leaders exit on TERM;
Git close cannot prove helper exit. The fixture joins actual drain receipts,
checks all six PIDs absent and all three groups empty, freezes old completion,
and independently collects the next generation. Disposal may publish unproven
cleanup before drain; the fixture verifies the eventual proof without upgrading
that publication. Its failure cleanup uses only captured owned birth anchors.

### Repair verification and review-ready gate

Node 24.15.0, pnpm 10.29.2 via the prescribed CLI, pinned Bun 1.4.0 for build
guards; unit `TMPDIR=/private/tmp`, serial file execution on the shared Mac.
Final production code: 264 unit files, **4,502 passed, 2 skipped**; seven targeted
manifest/manager/adoption/supervisor/reconstruction/prompt files **290/290**;
seven bundle/lazy-load/build/policy/wait-classification files **195/195**.
Typecheck, build, host/extension builds and lint pass (only four existing scratch
warnings). Default selected-file integration **2/2**, harness seam checks
**187/187**, outer audit **zero survivors across six registered groups**. The
fixture additionally verifies its detached Git groups, including six PIDs per
case; the outer registered-only audit is not substituted for that check.

Logs: `/private/tmp/sumo-591-review-final-{unit,targeted,integration,lint}.log`
and `/private/tmp/sumo-591-review-guards.log`. No full integration/native/visual
lane, perf sample, golden promotion, PR, merge or tag was run locally. Remote
workflow identities and conclusions are reported with the pushed repair HEAD,
without reruns.

Review-ready gate:
- Contract: public `~/code/skills/skills/review-ready/contract.md`; no repository
  override found at its documented locations.
- Changed seam/trace: child outcome → lazy collector → evidence cutoff → owned
  Git group TERM/KILL/drain → deadline-bounded immutable evidence → unchanged
  manager/durable completion publication.
- **Caller-knowledge:** plain Promise/value interfaces remain; builder wrappers
  forward cancellation and proof receipts. **Deletion:** removal would spread
  cancellation/drain policy into both settlement callers. **Ownership:** the
  collector owns availability; the plain Git adapter owns transient process
  groups; existing manager/supervisor modules retain publication authority.
  **Test-surface:** TestClock drives the public collector and manager, retained
  reconstruction validates real private artifacts, and supervised real OS
  processes prove signals/group emptiness independently of simulated clocks.
- Simplification pass: reused existing fresh-group signalling/empty-group waits
  and trusted ps resolution, kept only a manifest-local bounded census, removed
  redundant iterable copying, and introduced no process service or dependency.
- Verification: results above. Exceptions/limits: fail-closed unknown identity,
  POSIX dedicated-group ownership and Windows unproven group cleanup as described
  above; #589 performance budgets remain pending separately. Heavy local lanes
  intentionally delegated by the user.

The original implementation/evidence record below describes the reviewed base;
its post-deadline drain and immediate-PID-only termination tradeoffs are
superseded by these repairs.

## Boundary and behavior

`collectCompletionManifest()` remains a plain Promise API. Both the disposable
manager and retained supervisor call it after their existing outcome handling.
The lazy `manifest-effect.ts` runner races evidence against the existing five-second
budget, reduced by elapsed module-loading time. Each collection owns its runtime,
AbortController and Git close receipts. The losing work's finalizer aborts Git,
joins those receipts, and runtime disposal completes before the public Promise
returns. An aborted owner is checked again after teardown, even if evidence won.

The Git adapter owns each `execFile` handle and uses `SIGKILL` on interruption and
the existing 4.5-second per-read watchdog. Its Promise resolves on `close`, not
on the abort event or exec callback. No generic Git/process service or Effect
filesystem/process owner was added. Builder wrappers must forward the supplied
options, including `signal` and `onGitRead`; the existing production fixture does.
An arbitrary builder Promise cannot hold the collection hostage after its owned
Git reads close, and its late resolution/rejection cannot replace the chosen result.

Timeout/disposal returns the existing honest `{ exit, durationMs }` partial shape.
Ordinary best-effort reads retain their existing shape: failed status is unknown,
not clean; shared-checkout changes are not attributed to the child; worktree
inspection only issues rev-parse/status/diff/rev-list. No apply, prune or removal
is performed. No tool/schema, completion ID, durable artifact/receipt, authority
fence, result format, spawn queue or snapshot-state protocol changed.

Manager disposal/replacement aborts only its active manifest collections.
Supervisor disposal aborts its manifest collection, and the existing settlement
path checks that signal before publishing durable manifest/completion pointers.
It does not interrupt a retained child, add a kill path, or change the ordinary
event observer. Session detach, replies, idle turns and retained recovery keep
their existing owners. Builder/load failures report through existing diagnostics;
a failing diagnostic observer cannot reopen or strand settlement. Late rejected
builders are not reported as new failures after teardown.

## Deliberate tradeoffs

- These are read-only Git children, so interruption uses immediate SIGKILL, not
  a grace period that could consume the evidence deadline. Termination is
  process-handle based; this is not a new general descendant-tree supervisor.
- The five-second deadline chooses partial evidence; actual `close` and runtime
  teardown are then joined. OS scheduling/pipe closure can add drain latency.
  Returning before close would give a misleading termination guarantee.
- JavaScript module evaluation cannot itself be interrupted. Loading consumes
  the budget, and an exhausted or aborted owner starts no builder. Event-loop
  stalls/load evaluation are not hard real-time deadline guarantees.
- Deadline fallback intentionally does not merge half-finished reads into a
  potentially misleading complete-shaped manifest. The existing unknown and
  shared-checkout attribution semantics remain in the builder.
- No dependencies, service catalog, durable-state Effect adoption, rendering
  changes, approval gate, golden promotion or launcher-selection changes.

## Lazy distribution

The existing narrow bundle plugin now recognizes a second reviewed dynamic edge:
`manifest.ts` → `manifest.effect.mjs`. Static and wrong-owner edges fail, rather
than adding an Effect external-import allowance. The lazy artifact inlines Effect
and retains only Node builtin imports. Extension output/input hashes include it;
native classic/RPC bundles distribute the shared sidecar and retain containment,
eager-closure, nonvirtual-external and production-leakage guards. Neither source
nor compiled host has a manifest consumer/sidecar.

Fresh-process positive and negative probes cover source/bundled host, classic
extension and RPC child extension, separately loading manifest and steering first.
They observe no Effect symbols before explicit adoption, and the correct module
load diagnostic afterwards. The native contract extends the existing compiled-Pi
`session_start` cold probe to both lazy artifacts in both extension profiles;
actual compiled loading is delegated to `native-test.yml`, not claimed from a
source import or esbuild graph alone.

## Local verification

Node 24.15.0, pnpm 10.29.2, temporary Bun 1.4.0; system `TMPDIR=/private/tmp`.
No full local integration, native or visual lane was run on the shared Mac.

- Typecheck/build, lint, host/extension builds and all bundle/build guards pass.
  Lint retains four pre-existing scratch-file warnings. Compiler budget:
  **1,543,847** instantiations vs **1,353,836** baseline (1.14x; unchanged
  **2,707,672** limit). No baseline refresh.
- Earlier full serial unit suite: **264 files, 4,494 passed, 2 skipped**. The
  final-code full run had **4,491 passed, 2 skipped, 4 timeouts** in unchanged
  worktree-disposition (two cherry-pick rollback cases), retained-reconstruction
  (journal cap), and terminal-task-manager (feed budget) tests. No limits or
  assertions were changed. All three files subsequently passed isolated:
  **142/142**. Targeted subagents: **33 files, 912 passed**; final-code seam/guard
  checks: **10 files, 361 passed**. TestClock cases
  exercise 4,999/5,000ms, completion,
  shutdown, diagnostic failure, pre-abort, late success/rejection and close-drain.
- Canonical selected-file/default-mode integration: manifest cancellation **2/2**,
  retained recovery **38/38**, production retention **2/2**. Every selection's
  **187** harness-seam checks passed. Outer audits: **zero survivors** across
  **6/4/8** registered groups respectively (registered scope, not a claim about
  unrelated processes). The slow fake Git children ignore TERM; the fixture
  proves all three real Git PIDs are gone before completion, no late artifact,
  unchanged old snapshot and independently collected next-generation evidence.
  Final-code canonical repeats were blocked at preflight by another worktree's
  live groups, which were not touched. Final-code focused supervision passed
  manifest **2/2**, recovery **38/38**, and settled production transfer; running
  production transfer failed (**41 passed, 1 failed** combined). Both focused
  audits reported zero survivors (four production and two manifest groups).
  The failed transfer's durable record remained `running`, with no outcome or
  manifest phase; its synthetic evidence is retained at
  `/private/tmp/production-retention-pQ17nW/`. This is not claimed as a passing
  retained-transfer gate or silently repaired outside the manifest slice.
- Existing conversational/reply, visible idle-turn, recovery and worktree tests
  remain intact. The heartbeat test retains every assertion, but its 20-second
  renewal delay now precedes `run-settled`: an unbounded manifest wait is no
  longer valid behavior. The new deadline/drain tests cover that boundary.
  A new NUL-cwd case exposed a lost synchronous-launch-error guard; restoring
  best-effort unknown evidence passed the original and additional assertions.
- Initial obstacles are not hidden: native guards first found system Bun 1.4.2;
  temporary 1.4.0 passed. Integration preflight initially found another worktree's
  owned processes; none were killed, and later canonical runs were clean. One
  initial focused process run exited without a status; later focused/canonical
  runs passed with zero-survivor audits. A direct pnpm-launched retention probe
  refused preload overrides; the canonical runner's sanitized environment passed.
  The compiler checker initially hit the system pnpm shim; its stray workspace
  YAML was removed, frozen dependencies restored, and a temporary shim routing
  exclusively to the specified Node/pnpm CLI passed the unchanged checker.

Local logs are `/private/tmp/sumo-591-{full-unit2,targeted,final-targeted,lint,tsc-budget2,manifest-integration2,recovery-integration,retention-integration}.log`.
Final-code logs use `/private/tmp/sumo-591-final-{unit,lint,tsc-budget,build-host,build-extension,targeted2,focused}.log`;
unchanged-test isolation is `/private/tmp/sumo-591-timeout-isolation.log`.
Emitted classic extension: **988,838 UTF-8 bytes**; lazy manifest: **105,732**;
lazy steering: **117,663**. These are attribution, not a reviewed size verdict.
Final-HEAD verification and remote workflow identities/results are reported with
the branch delivery; unsuccessful local collection is not counted as acceptance.

## #589: required remeasurement, not an implied performance pass

The literal `docs/perf/adoption-baseline.json` remains pending, with no reviewed
replacement observations/budgets. Follow `docs/perf/adoption-baseline.md` on a
quiet owned machine; do not reuse historical rc.112 or pre-memory-removal numbers.
Compare the final clean candidate with the identified clean native baseline
`98406d428ff562f4c57269dbc361e8f51d4a2cef`, 15 alternating samples per arm, under
one fixture/environment, retaining artifact/source identities and raw evidence.
Also compare source startup with pre-adoption `97897ae9`; `0bbfc2a9` is useful as
an additional #591-only attribution arm, not a replacement for the adoption base.

Remeasure editor/command readiness and their gap, source host import, classic/RPC
source/native bundle bytes, and actual bundle-body evaluation inside source and
compiled Pi. Apply the reviewed budgets only after explicit baseline review;
keep the existing compiler baseline. Include the new lazy manifest artifact's
bytes/load cost as attribution, not as eager extension evaluation. Git collection,
cancel/drain latency and per-collection RSS can be additional measurements, not a
substitute for the prescribed readiness/evaluation gate. The `perf.yml` resume
budget and cold-symbol probes do not certify these #589 startup budgets.

## Review-ready gate

Contract: public `~/code/skills/skills/review-ready/contract.md` (no project override).
Changed seam: outcome → bounded host evidence → existing single settlement.
Trace: owner supplies abort signal → plain facade loads lazy runner → race selects
evidence/partial → loser aborts and joins Git closes → runtime disposes → owner
fences publication using its unchanged completion/durable machinery.

- **Caller-knowledge:** callers still receive plain Promises/values; cancellation
  and Git-drain composition stay inside the collector. Only builder wrappers
  need to preserve its supplied cancellation/receipt options.
- **Deletion:** removing this module would spread deadline, loser cleanup and
  runtime ownership back into two settlement callers, not remove that complexity.
- **Ownership:** transient collection belongs to the lazy runner; Git handles
  belong to the manifest adapter; durable authority and process identity remain
  plain TypeScript in their existing modules.
- **Test-surface:** tests use the Promise runner, manager/supervisor interfaces,
  deterministic clock and supervised real OS children, not mocked signal truth.
- **Simplification/verification:** reused the #590 lazy artifact boundary,
  eliminated the old uncancellable manager race, removed an unnecessary outer
  Effect scope, and kept ordinary event observation unchanged. No speculative
  framework. Local results above; heavy lanes delegated by the user's instruction.

Exceptions: performance acceptance remains pending #589 measurement/review;
latest local full-suite timeouts and the focused running-transfer failure are
reported above, not represented as green gates. Remote failures, if any, are
reported without workflow reruns, baseline changes or unrelated fixes.
