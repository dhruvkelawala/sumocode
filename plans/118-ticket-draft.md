# Tickets: Effect adoption — first v0.8.0 tranche

**Approved and published as #588–#592.** Parent: [#459](https://github.com/dhruvkelawala/sumocode/issues/459), unchanged.
Refreshed campaign: [Plan 118](118-effect-v4-refactor-campaign.md), checked against `201d8fde`.
Tracker: GitHub; milestone: `v0.8.0`; triage label: `ready-for-agent` on all five issues.
Native blocking relationships, issue bodies, labels and milestone assignments were verified after publication.

The approved release scope is five independently verifiable tickets, not the entire Effect campaign.
Two establish measurable safety constraints without adding Effect. Three exercise real, off-startup
subagent behavior. The old Schema proof target no longer exists; eagerly imported configuration is
not a safe replacement merely because its data is cold.

Work the frontier: #588 and #589 can start independently; #590 requires both and the inherited #396
policy gate; #591 and #592 then depend on #590, not on each other. Shared-file coordination is not a
semantic dependency. T1–T5 remain proposal shorthand; each heading links its published issue.

## Shared acceptance contract

These requirements are included in each published issue, as applicable, so a fresh-context executor
does not need another ticket's implementation details:

- Preserve public Promise/plain-value APIs, tool schemas, durable formats, security checks, and every
  existing assertion. Keep Effect out of launcher/pre-adoption and render execution; no built-in tool
  override, platform process owner, or new transport. A migration does not promise a new product feature.
- Run typecheck, build, lint and the full unit suite. Build-affecting tickets also verify native/host/
  extension builds and their guards; supervision/runtime tickets run integration with zero-survivor
  audit and visual CI without golden promotion. Evidence must identify the tested head.
- Production Effect slices prove lazy loading in source, native host and both classic/RPC extension
  bundles loaded by the Pi child, with no Effect evaluation before the agreed readiness boundary. Apply
  native/source readiness and extension size/evaluation budgets even with a source dynamic import.
  Bare-import guards cannot detect inlined Effect; bundler syntax alone is not performance evidence.
- Effect-backed timing tests use the reviewed v4 test harness and deterministic clock, with cancellation,
  timeout, shutdown and diagnostic failure cases. Keep real-process tests for identity and signal truth;
  do not convert unrelated plain-TS timer tests or replace OS evidence with a simulated clock.
- Create services/errors/runtimes only for a consumer in this ticket, use reviewed exact package pins
  and deep imports, report supervised failures through existing diagnostics, and remove only the
  replaced implementation's redundant path. No speculative shared framework or deferred test wave.

## 1. T1 / [#588](https://github.com/dhruvkelawala/sumocode/issues/588) — Enforce Effect import and release-bundle boundaries

**Parent:** #459

**What to build:** A developer cannot accidentally put Effect into launcher/pre-adoption execution,
import a heavyweight barrel, or ship test/serialization dependencies in production artifacts. The
repository explains the allowed adoption boundary before the first package is added.

**Blocked by:** None — can start immediately. This ticket adds no Effect dependency or production runtime.

- [ ] Import policy rejects the root Effect barrel, platform barrels, unapproved unstable production
      modules, and test-only Effect imports from production. Reuse the vendored Effect lint plugin,
      installed skills and held repository-overlay draft, reconciling stale API/runtime assumptions.
      Guidance must not claim Effect is installed until the first adopter pins it.
- [ ] Build checks distinguish the launcher's eager/pre-adoption closure from the intentionally lazy
      host graph. Synthetic forbidden imports fail; a permitted lazy host edge does not falsely fail
      merely because its code appears in the complete native metafile.
- [ ] Native, host and extension production artifacts reject `fast-check`/`msgpackr` leakage; the existing
      extension bare-import guard still passes. Nothing changes signal ownership or direct-Pi bypasses.
- [ ] Positive and negative guard tests, relevant release builds and the shared verification contract
      pass, with generated bundles remaining uncommitted.

## 2. T2 / [#589](https://github.com/dhruvkelawala/sumocode/issues/589) — Measure adoption against a reproducible native startup baseline

**Parent:** #459

**What to build:** A maintainer can compare a proposed migration with a pinned baseline and receive
an actionable regression verdict before accepting it. Extend the existing measurement tools rather
than treating the old native-versus-Node improvement benchmark as a native regression gate.

**Blocked by:** None — can start immediately. This ticket adds no Effect dependency or production runtime.

- [ ] Compare two identified native artifacts under the same fixture/environment using 15 samples per
      arm. Record artifact/source identities and raw timing evidence; no comparison with an accidentally
      rebuilt baseline or with a different runtime arm can masquerade as native-vs-native.
- [ ] Reject editor-ready median above baseline plus one baseline MAD, any command-ready median increase,
      and any widening of the editor-to-command gap. Missing/incomplete samples fail visibly rather than
      becoming a pass; verdict calculation has deterministic tests.
- [ ] Record source host-import plus classic/RPC extension-bundle size and evaluation baselines, with
      explicit reviewed budgets before adoption. Measure extension evaluation inside the Pi child,
      including native-distributed bundles, rather than relying on the surviving-bare-import guard.
      Preserve the source startup non-regression gate; do not reuse historical rc.112 measurements.
- [ ] Reuse the already-shipped full-pass compiler-budget checker and recorded baseline alongside the
      new startup evidence. Do not recreate its CI wiring, add a redundant incremental cache, or reset
      the compiler baseline merely to accommodate the migration.
- [ ] The shared verification contract passes; baseline refresh remains an explicit review decision,
      not an automatic way to turn a regression green.

## 3. T3 / [#590](https://github.com/dhruvkelawala/sumocode/issues/590) — Scope visible-child steering acknowledgement waits

**Parent:** #459

**What to build:** Sending steering to a visible child still reports only control consumption and
synchronous submission, never model acceptance. Acknowledgement, child settlement, timeout, authority
loss and shutdown resolve or reject each migrated waiter once, without a surviving poller. Scope is the
visible backend's steering-consumption waiters; the separate durable supervisor request/ack channel
stays plain TypeScript and is regression-tested, not migrated in this ticket.

**Blocked by:** [#588](https://github.com/dhruvkelawala/sumocode/issues/588);
[#589](https://github.com/dhruvkelawala/sumocode/issues/589);
[#396](https://github.com/dhruvkelawala/sumocode/issues/396), the inherited
production-adoption policy gate. That last edge may change only with an explicit owner decision;
local dependency remediation does not clear it.

- [ ] Review and exact-pin a compatible Effect v4/test-package pair; read that version's own API guidance.
      Add the wait-classification vocabulary required by its deterministic clock in this same slice.
      No other production subsystem is migrated to justify the dependency.
- [ ] Load the Effect-backed acknowledgement implementation only when this asynchronous feature needs
      it. Introduce its owned runtime/scope and awaited teardown with the first consumer; startup graphs,
      native/source readiness and compiler budgets pass without changing the public child interface.
- [ ] Preserve acknowledgement precedence: a consumed control succeeds even if settlement wins the next
      poll race; an unconsumed control times out/rejects honestly and is not retried automatically because
      the child may still consume it. Ownership/fencing checks remain at publication and acknowledgement.
- [ ] Deterministic race and teardown tests preserve the existing oracle and cover failure diagnostics;
      no pending wait or fiber survives terminal settlement, authority loss, or owner shutdown. Do not
      release a live conversational pane on a mere idle turn or kill a retained child on session detach.
- [ ] Existing visible close-to-respawn and `pane_unavailable` regressions, supervised integration,
      zero-survivor audit, non-TTY exit checks, visual CI and the shared gates pass. Closed #470 is
      a regression constraint, not a new pane-placement redesign.

## 4. T4 / [#591](https://github.com/dhruvkelawala/sumocode/issues/591) — Cancel losing manifest work when a subagent settles

**Parent:** #459

**What to build:** A settled child's completion becomes available within the existing manifest deadline,
with honest partial evidence if collection cannot finish. Timed-out or disposed manifest collection
actually stops its Git subprocess work and cannot later publish a second or stale completion.

**Blocked by:** [#590](https://github.com/dhruvkelawala/sumocode/issues/590)
(reviewed package/runtime/test seam). This does not require migrating the whole child
supervisor, durable registry, spawn queue or snapshot store first.

- [ ] The public spawn/check/wait/completion flow settles once under completion, cancellation and manifest
      timeout races. Preserve existing completion IDs, durable fences/receipts and result shapes.
- [ ] Make the Git subprocess adapter signal- or process-handle-cancellable and propagate interruption
      into it; wrapping an uncancellable Promise alone does not satisfy this ticket. Prove losing work
      has ended and its late result cannot mutate the manager or consume a later generation's completion.
- [ ] Preserve evidence semantics: failed status reads remain unknown rather than clean, shared-checkout
      paths are not attributed to a child, and worktree inspection performs no apply/prune/delete operation.
- [ ] Current conversational-child/reply, visible idle-turn, retained recovery and worktree-disposition
      tests remain intact. Only the manifest/settlement slice changes; no generic Git or process service
      is introduced without an actual consumer requirement.
- [ ] Deterministic deadline tests plus supervised real-process interruption/zero-survivor evidence and
      all applicable shared gates pass. Unchanged manager state machinery is explicitly out of scope.

## 5. T5 / [#592](https://github.com/dhruvkelawala/sumocode/issues/592) — Scope headless-child cancellation and cleanup

**Parent:** #459

**What to build:** Cancelling an owned headless subagent stops its verified process tree, drains and
settles it once, and releases its listeners/timers. Cleanup failures remain visible instead of claiming
successful cancellation. A session detach still hands off an eligible retained child rather than killing it.

**Blocked by:** [#590](https://github.com/dhruvkelawala/sumocode/issues/590)
(reviewed package/runtime/test seam). Not blocked by #591: child-process supervision uses the current
settlement interface and does not require changing manifest collection first.

- [ ] Replace headless child abort/escalation/wait ownership with scoped work over existing Node process
      adapters, reusing the retained supervisor's existing termination authority rather than duplicating
      it. Preserve the synchronous child handle and plain public promises; do not migrate visible
      pane provisioning, terminal tools, the native launcher, or byte framing in this ticket.
- [ ] Preserve launch-gate/release ordering and revalidate owner fence and PID/process-group start identity
      at signal time. Reused, unknown or unverified identities are not signalled; success requires the
      existing whole-tree-empty evidence, not merely exit of the direct child.
- [ ] TERM-to-KILL escalation, failed signals, startup rejection, caller abort and natural exit converge
      on one truthful outcome with bounded drain/cleanup. Batch cancellation interrupts every target
      before awaiting any settlement. Internal typed errors translate back to the existing public
      result/diagnostic contract without silent catches.
- [ ] Scope disposal distinguishes owned ephemeral cleanup from verified retained hand-off; conversational
      idle is not process settlement. Preserve existing recovery capability limits and advisory-only
      budgets, with no automatic cancellation or registry-format change.
- [ ] Deterministic race tests and supervised real-process tests cover descendants, timeout, refusal and
      shutdown, with zero-survivor evidence for owned trees and explicit retention evidence for handed-off
      trees. Native/source readiness, non-TTY exit, visual CI and all shared gates pass.

## Deliberately not committed to v0.8.0 yet

These remain in the refreshed campaign, not discarded requirements or newly created issues:

- Configuration/RPC/store Schema ports, after import-path eligibility is proved; Memory and retired
  task parameter/worker-pool ports are removed rather than deferred.
- Visible process/pane supervision and the remaining manager admission, snapshot and disposal migrations,
  preserving durable retention and conversational semantics; terminal/Activity retry, polling and batching
  follow their own existing interfaces and measured need. The small synchronous delivery outbox stays
  as-is unless a demonstrated ownership problem warrants replacement; ambiguous send failure remains
  at-least-once, not a new exactly-once guarantee.
- Host gate measurement, then only the permitted host migrations; the existing plain-TS lifecycle seam
  is already delivered. Event decoding is separately import/performance-gated and never a second deep
  validation pass over every streaming delta.
- Cross-campaign cleanup, remaining lint tightening and a reviewed version checkpoint. Relevant tests,
  property checks and local cleanup are part of each adopted subject, not postponed to this phase.

## Approval record

Dhruv approved the five-ticket scope and blocking edges with “lgtm” before publication. The inherited
#396 production-adoption gate is retained; #588/#589 can proceed independently. No additional campaign
waves were assigned to v0.8.0, and the parent issue was neither edited nor closed.
