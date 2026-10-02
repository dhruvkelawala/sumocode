# #592 — scoped headless-child cancellation

Base: `0bbfc2a9` (#590). Branch: `sumo/v08-592-headless-cancel`.
Exact package pins remain Effect / @effect/vitest `4.0.0-rc.112`.

## Ownership and public contract

`backend-pi.ts` retains the synchronous child handle, launch fences, prompt
release, parser and result ownership. Its first termination lazily imports
`headless-cleanup-effect.ts`; repeated aborts, errors and exit callbacks share
one public `Promise<void>`. No Effect type crosses a tool, event or TUI boundary.

The cleanup module owns a per-consumer ManagedRuntime, scoped release finalizer,
monotonic scheduled empty-tree observations, and a bounded close subscription.
It calls the existing `terminateProcessTree` authority through plain Node
adapters, not a new process/platform owner. TERM retains its five-second grace;
KILL retains one second. A stalled signal adapter fails after seven seconds;
pipe drainage gets one further second. Disposal is awaited before the public
cleanup promise settles. The extracted #590 clock uses cancellable, unref'd
sleeps; it never changes the global clock or owns Node's lifetime.

Owner/generation/head and process identity checks stay in the existing retained
launch gate and process-tree adapters. The final retained POSIX operation is one
signal, after those checks. No reused or unverified identity gets a direct-PID
fallback. A successful signal or a "gone" result is not success without an
independent whole-tree-empty observation. Ephemeral cancellation captures
later-born descendants while the original leader still verifies, then retains
those anchors for escalation after the leader exits.

Internal tagged errors are ordinary Error subclasses, translated to plain
public errors. Diagnostics use `headless_cleanup_effect_loaded` and
`headless_cleanup_failed` with fixed phase fields, never task content. Diagnostic
write failure cannot hide cleanup refusal. Error guards needed by a still-live
ChildProcess remain until close; scoped abort/close subscriptions and all scoped
sleeps are released even when cleanup fails.

Retained hand-off is not scope interruption: detach preserves the existing
supervisor, child identity, durable evidence and controller transfer. Neither
conversational idle nor an advisory budget starts cleanup. Registry formats,
receipts, tools and byte framing are unchanged. The manager changes only batch
cancel admission: all targets are interrupted before awaiting any settlement,
including when one target throws synchronously; refused cleanup cannot return a
successful cancellation. Existing retained synchronous refusal remains a public
rejection after sibling admissions have been handled.

## #591 coordination

Manifest collection, Git subprocess cancellation, completion deadlines, durable
publication and manager state machinery remain with #591. This slice consumes
the existing settlement interface. It does not change `manifest.ts`,
`retained-supervisor.ts`, registry code or manifest/result formats.

## Evidence and reproduction

Local verification used Node 24, pnpm 10.29.2 and Bun 1.4.0, with launcher/Herdr
and Vitest-worker overrides removed and the system temporary directory retained.

- Full unit discovery: **263 files; 4,506 passed, 2 existing skips**. Serial file
  execution avoids this host's filesystem-heavy concurrency timeouts; no test
  timeout or assertion was relaxed. The initial unrestricted run had seven
  timeout failures. An intermediate serial invocation also exposed the ambient
  Bun 1.4.2; the final run explicitly selected pinned Bun 1.4.0.
- `pnpm lint`, `pnpm exec tsc --noEmit && pnpm build`, host and extension builds
  pass. Lint retains four pre-existing scratch-file warnings. Full unit discovery
  includes native/host/extension build guards and wait-classification checks.
- Selected default-mode recovery, unchanged production-retention and new
  headless-cleanup suites pass **46 tests**, with zero survivors across four
  production-retention and six cleanup/source-readiness process groups. Both running and settled
  production hand-offs preserve child identity and deliver once. This observation
  does **not** fix or suppress the previously reported intermittent settled-child
  production-retention failure.
- TestClock races cover TERM/KILL deadlines, descendants after direct close,
  disappearance, owner/identity loss between signals, thrown/failed/stalled
  signals, misleading "gone" results, drain timeout and synchronous subscription
  notification. They assert release once, no sleeping fibers and no close
  subscriptions. Fresh Node subprocesses prove non-TTY idle exit and diagnostic
  failure behavior.
- Source/bundle probes cover host, classic extension and RPC extension, with an
  independent fresh-process positive control for **each** Effect consumer. Both
  `effect/` and `~effect/` globals must stay absent before that import. Reviewed
  dynamic edges remain owner-specific; static/unreviewed edges are rejected.
  Real source Pi classic/RPC session-start probes also pass with each consumer
  independently loaded after readiness. Compiled classic/RPC probes independently
  cover both sidecars in native CI.

Run the unit lane with `BUN_BIN` pointing to Bun 1.4.0:

```sh
pnpm test --fileParallelism=false
```

For selected integration, invoke Vitest's real entry rather than pnpm's Vitest
shim, which injects NODE_PATH and is correctly rejected by retention preflight:

```sh
pnpm exec node node_modules/vitest/vitest.mjs run \
  test/integration/subagent-recovery.test.ts \
  test/integration/subagent-production-retention.test.ts \
  test/integration/subagent-headless-cleanup.test.ts --fileParallelism=false
```

The IPC fixture uses a harness-owned synchronous registration before the trusted
anchor's release. Execve admission cannot preserve Node IPC. Failure captures
and cleanup traces use the existing harness evidence seam; no survivor audit or
production-retention assertion is waived.

Full native, full integration and visual lanes are intentionally CI-only for
this worktree. Dispatch `ci.yml`, `native-test.yml`, `visual-v2.yml`, `perf.yml`
on the final published head; final run URLs/results belong in the hand-off.
No PR, merge, tag or golden promotion is part of this ticket.

## Costs, limitations and #589 remeasurement

Final local build sizes: eager host **957,388 B**, eager extension **989,856 B**,
steering sidecar **117,701 B**, new headless sidecar **121,049 B**. These are raw
output sizes, not startup/evaluation measurements. Both lazy artifacts remain
self-contained; loading both incurs their separate bundled library footprints.

Fail-closed identity ambiguity can leave an unverified tree alive and returns a
visible failure, not cancellation. Existing physical-source/native retention and
POSIX-only retained signal capability limits are not broadened. A bounded
failure does not prove that an uninterruptible external signal adapter stopped;
it does prevent that adapter from granting successful cleanup or initiating an
unverified later escalation.

#589 must remeasure the pinned baseline against the final candidate with its
owned fixture/environment and immutable identified native artifacts: source host
import, source and compiled Pi classic/RPC extension evaluation, editor/command
readiness gaps, native/archive size and first-consumer evaluation. Include both
new sidecar loading and the cold path; apply the reviewed budgets and sample
policy without resetting the baseline or recycling historical rc.112 numbers.

Review contract: `/review-ready` bundled contract. The changed entry point reads
as capture authority → terminate verified tree → prove empty → drain → release.
Its adapter seam is replaced by deterministic clocks and real OS evidence, not
module mocks. Clock extraction and scoped subscriptions remove duplicated
ownership; no general lifecycle framework or schema layer was added.
