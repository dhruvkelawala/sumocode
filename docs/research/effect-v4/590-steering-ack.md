# #590: visible steering consumption waits

Base: `97897ae9`. Code/test head: `47968042` on `sumo/v08-590-effect-steering`.
This note is not a release approval or a replacement for #589's measurements.

## Boundary and outcome

`backend-pane.ts` publishes the same private control files and owns all authority,
per-send fences, response/exit inspection, and terminal verdicts. Only `send()`
dynamically imports `steering-ack-effect.ts`. That module owns one cancellable
wait, runtime and scope per send, and awaits `ManagedRuntime.dispose()` before
its existing `Promise<void>` settles. No Effect value crosses the child, tool,
event, or TerminalHost interface.

Consumption means the child's watcher removed the control and synchronously
submitted it to Pi. It does **not** mean model acceptance. Settlement snapshots
consumption before a lazy import can resume; later removal cannot rewrite an
unconfirmed settlement. Authority and the caller's `beforeEffect` still fence
publication and acknowledgement. Timeout retains the file and never retries.
A monotonic clock bounds waiting even when exit-marker inspection encounters the
producer's truncate-before-write window. The original 250ms first-poll/cadence
and 30s wait budget are retained; the wait clock starts when the lazy runtime
starts, not during module loading.

A retained supervisor's steering AbortController stops only its waits, honoring
already consumed controls before rejecting those still on disk. Disposal
continues to be synchronous at the existing public boundary; each send Promise
awaits its own teardown. Idle turns and session detach do not close or signal a
retained child. The ordinary response watcher is intentionally unchanged.
`retained-control.ts` and its durable request/ack formats, admission and uncertain
outcomes are unchanged and covered by the existing suite.

Inspection exceptions and defects use `visible_steering_wait_failed` in the
existing opt-in diagnostic seam; import failures report phase `load`. A broken
diagnostic sink cannot strand the waiter. The lazy module's evaluation records
`visible_steering_effect_loaded` only when diagnostics are enabled.

## Reviewed dependency and implementation choices

Exact pins: `effect` and `@effect/vitest` **4.0.0-rc.112**. The latter permits the
repository's Vitest 4.1.11 (`>=4.1.0 <5.0.0`); subsequent surveyed candidates
require Vitest 5. No unrelated harness upgrade or platform package was added.
The installed package's AGENTS, managed-runtime, schedule and testing guidance,
and relevant Clock/Effect/ManagedRuntime/Scope/Schedule/TestClock implementations
were reviewed rather than treating the vendored skill examples as API authority.
In this pin, `tapDefect` supervises defects and callback-returned cleanup handles
interruption, not normal completion: the signal handler explicitly unsubscribes
before resuming normally. `raceFirst` interrupts and awaits the losing branch.

Production uses stable deep imports only. No shared runtime, service catalog,
Schema class, platform process owner, new transport, rendering adoption, or
production testing-module import was introduced. Existing fake-timer backend and
recovery fixtures inject the real Promise runner to avoid first-import latency;
new clock tests use the pinned `@effect/vitest` harness and TestClock. The wait
classifier recognizes `TestClock.adjust`/`setTime` (including element access).

Esbuild single-file bundles can eagerly hoist external package imports even
behind a source dynamic import. The narrow build plugin externalizes only the
backend's reviewed dynamic edge to `steering-ack.effect.mjs`, which includes
Effect and retains only Node builtin imports. Static or wrong-owner edges are
rejected. Extension manifests bind the lazy source/recipe and output bytes.
Native classic/RPC extensions share this sidecar. The host has no steering
consumer, so it gets no sidecar; its build now explicitly checks the eager
closure. Production-leakage, plain-path lint and native bare-import guards were
not relaxed. Generated artifacts remain ignored.

## Local evidence

Checks used Node 24, pnpm 10.29.2 and pinned Bun 1.4.0. The final production
change at `47968042` adds the consumed-before-owner-shutdown regression/fix;
all local checks below were repeated against that code head.

- Frozen install, typecheck, build, lint, dependency-audit policy and
  host/extension/native builds passed. Lint retains four existing scratch-file
  warnings. Full-pass compiler budget: 1,539,266 instantiations versus 1,353,836
  baseline (1.14x, below the unchanged 2,707,672 limit).
- Full unit suite: **257 files, 4,398 passed, 2 skipped**, using
  `pnpm test --fileParallelism=false`. Unbounded concurrency timed out five
  existing expensive tests; four workers left one timeout. The unchanged
  JSON-escaped-result test passed alone in 13.37s; serial execution passed all
  tests without increasing any timeout or changing an assertion.
- Nine deterministic wait checks prove consumption/settlement precedence,
  consumption at timeout, ordinary timeout/no retry, authority loss, shutdown,
  concurrent ownership, diagnostic failure and zero active sleeps after each
  public Promise completes. Existing empty/truncated exit-marker, publication
  fencing, private-artifact, close/respawn and `pane_unavailable` assertions stay
  intact. Existing real-process identity/signal tests were not replaced.
- Selected supervised integration files, each in default and srt mode:
  `plan112-visible-admission.test.ts` **9/9**, `subagent-recovery.test.ts`
  **38/38**. `rpc-subagent-status-strip.test.ts` passed **1/1** in default;
  srt failed **0/1** before app launch with `listen EINVAL` on the worktree's
  overlong `srt-mux-…sock` path. All six outer audits reported **zero survivors**
  (4/4/5 registered groups per mode); each selection's 187 harness-seam checks
  also passed. Admission/recovery fixtures do not establish real sandboxed app
  startup; the failed strip run is reported, not counted as a sandbox pass.

The srt failure's evidence is retained under
`.srt-spike/tmp/sumocode-harness-v2-run-fs5erw/` (initial reproduction: `rkXPJn`).
An earlier recovery fixture
first-import timeout also retained evidence under
`/private/tmp/sumocode-harness-v2-run-vWgAX5`; injecting the real runner fixed its
fake-clock setup without changing the production edge or recovery assertions.
No sandbox grant or process-identity rule was weakened and no evidence purged.

Fresh-process probes cover source and bundled host, classic extension and RPC
child extension evaluation: zero Effect symbols before explicit lazy loading,
and a positive observation afterwards. Two narrow native checks load the actual
inlined classic/RPC bundles inside the **compiled Pi** child, observe zero Effect
symbols through `session_start`, then successfully load the actual lazy sidecar.
Both passed with a focused zero-survivor audit over two registered groups:

```sh
SUMOCODE_NATIVE_CONTRACT=1 pnpm vitest run test/integration/native-contract.test.ts \
  -t 'keeps Effect cold through' --fileParallelism=false
```

This is cold-evaluation/loader evidence, not a full native or readiness-latency
certification. Full integration, native, visual and perf lanes are dispatched to
GitHub Actions, not run locally. No golden promotion, PR, merge or tag is part of
this branch's delivery.

## Review repair: non-owning poll timers

The default rc.112 Clock sleep uses a referenced `setTimeout`; unlike the
replaced backend interval's `unref()`, it held an otherwise idle Node process
open until the acknowledgement budget expired. The waiter now supplies a local
Clock layer whose sleep unreferences its timer and clears it on interruption.
All six time readers delegate to Effect's live clock, including its monotonic
clock. Explicit delegation preserves the live Clock's prototype methods.
Injected clocks still bypass this layer, so the nine TestClock cases are unchanged.

Tradeoff: this is a sleep adapter for this consumer's bounded polling cadence,
not a general-purpose clock or scheduler. No global timer patch, new public
option, shared runtime, or durable transport change is introduced. Natural exit
may leave the wait unresolved, just as the original unreferenced interval did;
it is not acknowledgement, and the published control remains available.

Two real Node child probes cover the initial delay and the next scheduled sleep.
The latter holds a referenced keeper only until the first inspection. Both assert
an unsettled wait with its terminal listener still installed at natural exit;
neither aborts nor calls `process.exit`. Both failed against the reviewed HEAD
with the parent's five-second timeout, then passed with the local Clock layer.

Local checks used Node 24.15.0, pnpm 10.29.2 and isolated system-temp fixtures:
**201/201** targeted waiter/backend/supervisor and bundle/build guard tests;
**4,400 passed, 2 skipped** across 257 full unit files; typecheck, build and lint
passed (four existing scratch warnings). The first guard run's only failure was
system Bun 1.4.2 versus pinned 1.4.0; a temporary pinned binary passed all guards.
The final targeted run also checks the strengthened active-listener assertion.
Full integration/native/visual lanes were not run on the shared Mac.

Review-ready gate (bundled `review-ready/contract.md`, read from the public skills
source at `~/code/skills/skills/review-ready/`):
- Changed seam/trace: plain wait Promise → per-wait Clock layer → unreferenced
  cancellable sleep → existing race/drain → awaited runtime disposal.
- **Caller-knowledge:** no new caller contract. **Deletion:** timer ownership
  stays hidden behind the runner. **Ownership:** only the lazy waiter owns the
  adapter. **Test-surface:** real processes and TestClock use the public runner.
- Simplification pass: kept the existing clock injection and deep imports;
  introduced no scheduler, service catalog, or separate test framework.
- Verification: results above; remote workflow results are reported separately.
  Exceptions: no design exception; heavy local lanes intentionally delegated.

## #589 remeasurement and next seams

Current native extension bytes (UTF-8, not JavaScript string lengths): classic
987,045; RPC 866,242; shared lazy artifact 116,213. These are identified candidate
sizes, **not** a budget verdict. Cold-symbol probes and eager-closure guards do
not substitute for evaluation timing or readiness samples.

When #589 lands, remeasure `97897ae9` versus this branch's final SHA with its same
owned fixture/environment, source host import, both extension evaluations inside
source/compiled Pi, and two immutable identified native artifacts (15 samples
per arm). Apply the reviewed editor/command/gap, size and evaluation budgets;
keep the existing compiler baseline. Do not recycle the historical rc.112
research numbers or reset a baseline to turn this candidate green. #396 remains
deferred and is not cleared by the clean dependency audit.

#591 terminal lifecycles can adopt behind their own plain Promise APIs without
reusing this waiter-specific runtime or moving durable stores/identity into
Effect. #592 RPC-host work must preserve launcher/readiness and render boundaries;
it must introduce its own first-consumer ownership, diagnostics and measurements.
Neither seam is implemented here.

## Review-ready gate

- Contract: the `review-ready` skill's bundled `contract.md` (no repository
  code-quality override).
- Changed seam: published visible control → consumed/unconfirmed Promise.
- Trace: `send` fences and renames → captures a terminal outcome → lazy runner
  races scoped polls with the terminal signal → losing branch drains → runtime
  disposal completes → backend map entry is removed → public Promise settles.
- Four tests: **caller-knowledge** stays plain callbacks/Promise;
  **deletion** would return wait lifecycle complexity to the backend;
  **ownership** leaves durable/authority truth with the backend and wait lifetime
  with the lazy module; **test-surface** exercises the public runner and child
  send interface, with actual compiled-loader cold probes.
- Simplification pass: removed the replaced interval path and the unnecessary
  host-side lazy artifact; kept only a waiter-specific module and one build edge.
- Verification: local results above; remote heavy results are reported separately
  against their exact workflow HEAD.
- Exceptions: no design-contract exception. Verification limitations are the srt
  bootstrap failure, pending #589 remeasurement, deferred #396, and heavy lanes
  delegated to CI; these are not represented as green acceptance evidence.
