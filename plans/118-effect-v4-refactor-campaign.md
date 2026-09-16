# Plan 118: Effect v4 adoption campaign (post-perf follow-up)

> **Executor instructions**: This is the umbrella plan for a multi-wave campaign. Do not implement it as
> one branch. Each slice below becomes its own executor-grade plan (`plans/118-<wave>-<slice>.md`) when
> scheduled, with the drift check, working-tree preflight, and dependency check in the `plans/EXECUTION.md`
> contract. Every slice ships behind an unchanged public interface with the existing test file as the
> parity oracle, passes the per-slice gates in §7, and never removes a test. A slice that cannot meet its
> gate is reverted, not weakened.
>
> **Baseline**: `docs/research/effect-v4-feasibility.md` and the four track reports under
> `docs/research/effect-v4/` are the evidence. Effect API facts come from the installed
> `node_modules/effect/{AGENTS.md,ai-docs/,src/}` at the pinned version, never from Effect 3 memory.
> **Original research baseline**: PR-stack tip `99b8cc4d` (PR #457), 2026-09-05,
> `effect@4.0.0-rc.112`. Those API and performance findings are historical evidence, not a current pin.
> **Refreshed against**: `201d8fde` (SumoCode 0.7.1, Pi 0.85.1), 2026-09-16.
> No Effect package is currently declared or installed. Implementation must review an exact compatible
> v4 version before adoption; this refresh neither installs a dependency nor claims a new benchmark.

## Status

- **Priority**: P2 (follow-up to the shipped performance/lifecycle work)
- **Effort**: XL. The original inventory had 44 slice rows, not ~30; retired and completed rows below
  are reconciliation records, not new tickets. Schedule a bounded release tranche, not the whole inventory.
- **Risk**: HIGH on the host track, MED on lifecycle; decoder risk depends on actual import reachability
- **Depends on**: Plan 102 / [#396](https://github.com/dhruvkelawala/sumocode/issues/396) remains
  consumer-upstream-blocked. Keep the inherited production-adoption gate until it is satisfied or
  Dhruv explicitly revises it; read-only planning and plain-TS guard/measurement work can proceed.
  Plans 104, 106, 108, 109 and 111–114 are recorded as delivered; do not recreate their seams.
- **Relationship to Plan 110**: this is the separate production-adoption proposal, not a retroactive
  GO verdict for the deferred pilot. Preserve available pilot evidence as supplemental context; current
  production tests are the oracle. Startup isolation and the unstable-module restriction remain rules.
- **Category**: direction
- **Milestone**: M7 — Effect adoption (historical campaign label); approved first tranche for GitHub
  `v0.8.0`, published as [#588–#592](118-ticket-draft.md) with native blocking links and `ready-for-agent`.
  Later waves are not implicitly release blockers and have no newly assigned milestone.
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/459 (umbrella, unchanged by this refresh).
  #460, #461 and #470 are closed; their safety/observability/visible-spawn behavior remains the oracle.

### Refresh findings

The durable registry, worktree disposition, advisory budgets, conversational children (`subagent_reply`),
visible idle-turn delivery, and plain-TS host lifecycle are already production behavior. Effect ports
must preserve those contracts, not replace them with the older Plan 110 prototype's smaller contract.
Retained children are not automatically killed when a session scope closes: verified retention/hand-off
policy still decides ownership, and process/pane identity is checked at effect time.

The Effect skills are already vendored and the Effect lint plugin exists but is not enabled. TypeScript
incremental mode, a recorded compiler baseline and the CI full-pass instantiation-budget checker already
exist (`scripts/check-tsc-budget.mjs`, `docs/perf/typecheck.json`); do not recreate them. The CI check
intentionally disables incremental mode for comparable counters, so a new cache is not a prerequisite.
A draft overlay exists at `docs/research/effect-v4/agents-md-overlay.md`; reconcile it rather than invent
another or copy old runtime/pin assumptions. Remaining foundations are overlay/import enforcement and
build/startup guards. Native comparison exists but compares native with Node arms, not two native revisions.

`native-task-params` and its worker-pool caller were retired with the old `task` tool (PR #523, issue #513). Do not
recreate them as a Schema demonstration. Memory still exists at this baseline but is scheduled for
removal in [#574](https://github.com/dhruvkelawala/sumocode/issues/574); exclude it from adoption.
Config, roles and RPC response modules are eagerly reachable today: "cold data" does not imply a cold
import. Defer those ports unless their import graph and readiness measurements satisfy the gates.

## 1. Decision

Adopt Effect v4 in production for SumoCode's in-memory lifecycle and supervision code, for typed
errors at trust boundaries, and for deterministic time in tests. Keep the render pipeline, durable
stores, process-identity primitives, byte-level protocol framing, launcher, and pre-spawn/signal
handoff in plain TypeScript. Effect is a guest in the process, never its owner.

The maintainer's stated goal is correctness and fewer bugs, with "maybe some perf". The evidence
supports the first two for specific bug classes and contradicts the third: expect a startup tax of
+8–19 ms in the shipped binary and no runtime gain. The campaign therefore carries a hard startup gate
that can stop the on-path slices.

## 2. Why this matters

The subagent, background-task, activity, and RPC-host domains hand-roll structured concurrency:
promise-tail mutexes, six parallel id sets for one settlement, `Promise.race` timeouts that leak the
loser, three cancellation channels, eleven hand-`unref`'d timers, two duplicated backoff machines,
three request/response correlation maps, four signal owners, and a `generation` counter that is
`Fiber.interrupt` written by hand. Git history proves these leak: 16+ lifecycle fix commits in six
weeks in `src/subagents` and `src/background-tasks`; 206 commits on `src/sumo-tui/rpc/**`; 57 on
`bin/sumocode.sh`; and a production env knob (`SUMOCODE_TEST_POST_ADOPTION_DELAY_MS`) that exists
solely to make one race window observable. These counts describe the original research baseline;
the shipped terminal supervisor and host lifecycle seam have since removed some of that machinery.
Do not use historical counts as a mandate to migrate a now-simple synchronous module.

The original boundary audit found divergent predicates, silent parse failures, unreported protocol
errors and unbounded streamed content indexes. The last two are fixed: the host now wires protocol
diagnostics and the transcript bounds `contentIndex` with `MAX_CONTENT_INDEX`. Preserve those tests;
Schema adoption is not a prerequisite for their correctness. Reproduce any remaining failure claim
against the current code before giving a migration ticket a bug-fix acceptance criterion.

## 3. Non-negotiables for the campaign

1. **No Effect on the first-frame path until Wave 3, and never in the launcher.** `src/native/main.ts`
   argv classification, `src/sumo-tui/rpc/spawn-child.mjs`, `sumo-rpc-host.js`, and the pre-spawn +
   signal-ownership handoff stay plain. A build assertion enforces this from Wave 0. Distinguish the
   eager/pre-adoption import closure from the full native metafile, which includes the lazy host.
   Source-level dynamic import is insufficient: prove evaluation timing in the native host and both
   classic/RPC extension bundles inside the Pi child, and measure command-ready as well as
   first-frame/editor-ready. The extension bare-import guard does not detect inlined Effect.
2. **Deep subpath imports only.** `import * as Effect from "effect/Effect"`, never `from "effect"`;
   never a `@effect/platform-*` barrel. Lint-enforced.
3. **Exact pins.** Review a compatible v4 `effect` / `@effect/vitest` release pair against its package
   source and peer requirements, then pin exact versions (`effect` in `dependencies`, tests in
   `devDependencies`). Align release versions where the package release train supports it. rc.112 is
   the research baseline, not an instruction to install a stale version. Upgrades are reviewed,
   never automated; a future final release is a checkpoint, not a date-dependent v0.8 release gate.
4. **No `effect/unstable/*` in production code** unless a slice plan justifies it and wraps it behind
   one project-owned interface. Child processes stay on `node:child_process`; fs stays on `node:fs`.
5. **No Effect type crosses a Pi boundary.** Tool `execute` callbacks, `pi.on(...)` handlers, pi-tui
   components, and `TerminalHost` keep their Promise/plain signatures; `ManagedRuntime.runPromise`
   and the `*Unsafe` bridges live at the edge.
6. **The existing test file is the oracle.** No slice weakens or deletes an assertion. Integration
   lane, zero-survivor audit, and visual CI run on every slice that touches supervision or the host.
7. **Two runtimes coexist during the campaign.** Each migrated fire-and-forget becomes owned work
   whose failure routes to the existing diagnostic seam, never only to Effect's default logger.
   Introduce a runtime/service/error with its first real consumer, not an unused foundation hierarchy.
   Scope disposal must honor retained-child hand-off, durable fences, advisory-only budgets and
   per-turn delivery; it is not permission to kill every child or erase durable authority.

## 4. Target footprint

LOC figures below are historical sizing only; the decisions reflect the refreshed scope.

| Zone | Historical LOC (non-test) | Decision |
|---|---:|---|
| `src/subagents`, `src/background-tasks/task-manager.ts`, `src/activity/{manager-bridge,store,feed-publisher}.ts`, `src/terminal-host` | ~8,000 | **Effect** lifecycle core behind existing interfaces |
| `src/sumo-tui/rpc/{client,host,host-actions,prompt-scheduler,runtime,controls,session-reader,chrome-cache-worker-client}.ts`, `src/sumo-tui/runtime` | ~8,000 | **Effect** host core, gated by startup budget |
| Boundary candidates: `src/config`, `mcp-config-reader`, `subagents/roles`, `rpc/response`, `rpc/lovely-web-config`, `config/enabled-models` | ~1,500 | **Schema only if import-eligible**; pure decoding still loads modules |
| Hot boundary: `rpc/client.ts` event funnel and its four consumers | ~1,000 | **Schema** for one event union, gated by import budget |
| `src/sumo-tui/{render,transcript,widgets,layout,input,cathedral}`, `src/cathedral`, `src/themes`, `footer`, `top-chrome`, `sidebar` | ~14,800 | **Plain TS**; no class/equality migration by default |
| `background-tasks/task-store.ts`, `activity/persistence.ts` I/O layer, `process-tree.ts` identity primitives, `child-protocol.ts` framing, `pi-compat/tree-navigation-command.ts` | ~3,000 | **Plain TS forever** (synchronous by design, security-hardened) |
| `src/native/main.ts`, `spawn-child.mjs`, `sumo-rpc-host.js`, `bin/`, `scripts/` | ~2,500 | **Plain forever** (launcher, pre-spawn, signal handoff, build) |

The table is the historical sizing estimate, not a current LOC inventory or migration quota. The
current target is the remaining complexity behind those interfaces. No Effect runtime enters rendering,
locks, process-identity checks, byte framing or launcher execution. Plain reason codes at those seams
may be translated into typed Effect failures by a later adopter; do not import Schema there merely
for an error class. Memory and the retired `task` tool are excluded.

## 5. Waves and slices

Every slice: one branch, one plan file, one owner, `pnpm exec tsc --noEmit && pnpm build && pnpm lint
&& pnpm test` green, plus the wave-specific gates in §7. Effort S ≈ 1 day, M ≈ 2–4 days, L ≈ 1–2 weeks
of agent-driven work with human review.

### Wave 0 — Foundations (no behaviour change, no Effect runtime in production yet)

| # | Slice | Files | Effort |
|---|---|---|---|
| 0.1 | With the first production consumer, review/exact-pin the compatible v4 package pair; run native/host/extension builds and their guards. No dependency-only or unused-runtime ticket | `package.json`, `pnpm-lock.yaml` | folded into first adopter |
| 0.2 | Skills and draft overlay already present. Reconcile only the repo overlay and pinned-source reading rule: no launcher `Config` rewrite, no durable-store `Cache`, no default `Schema.Class`, boundary-only validation, deep imports; do not claim Effect is installed before the first adopter or copy rc.112 API names as timeless truth | `AGENTS.md`; existing overlay/skills reused | S |
| 0.3 | Lint: enable `tools/oxlint/anti-slop/effect` plugin (`no-service-constructor-imports`, zero violations today); add rules banning `from "effect"` root barrel, `@effect/platform-*` barrels, `effect/testing/FastCheck` and `effect/unstable/encoding` barrels outside tests | `oxlint.config.ts`, `tools/oxlint/anti-slop/effect/rules/*` | M |
| 0.4 | Assert no Effect in the launcher eager/pre-adoption closure; distinguish legal lazy host edges from the complete native graph. Reject `fast-check`/`msgpackr` in native, host and extension production artifacts; positive and negative fixtures prove the guards | existing build scripts and guard tests | M |
| 0.5 | Extend existing tooling to compare identified native revisions (editor-ready ≤ +1 baseline MAD, command-ready no rise, gap no widen; 15 samples per arm). Record source host-import plus classic/RPC extension size/evaluation baselines and reviewed budgets; measure native-distributed extension evaluation in the Pi child, not just host imports | existing perf tools and evidence | M |
| 0.6 | DELIVERED: incremental mode, recorded diagnostics baseline and CI full-pass budget checker (fails above 2x baseline). Reuse them; no redundant compiler/cache ticket. Any baseline refresh requires explicit evidence/review, not automatic acceptance of Effect cost | `scripts/check-tsc-budget.mjs`, `docs/perf/typecheck.json`, CI | none |
| 0.7 | Add the selected v4 TestClock vocabulary to the wait-classification gate with the first timing migration, not after it | existing wait-classification tests | folded into first adopter |
| 0.8 | No empty shared runtime/error/service scaffold. Introduce the smallest lazy owned runtime, typed failures and teardown at the first consumer; expand only when a subsequent consumer needs it | owning lifecycle seam | folded into first adopter |

### Wave 1 — Boundary candidates (import-gated, each independently revertable)

Pure decoding still loads Effect modules. These candidates are not proven cold: inspect every caller
and the compiled graph first. Keep startup-reachable decoders plain until a separately approved measured
import seam exists. Keep public TypeBox tool declarations; do not duplicate them with a second validator
without a real untrusted boundary. Use plain record schemas, not class/equality churn or new schema
versions unless an actual format migration requires one.

| # | Slice | Bug fixed | Effort |
|---|---|---|---|
| 1.1 | RETIRED: `native-task-params.ts` no longer exists. Do not resurrect the removed `task` tool for a toolchain proof | not applicable | none |
| 1.2 | Independently migrate config tiers, MCP config, then roles only after import eligibility; preserve unknown round-tripped keys, precedence, custom-role warnings and fallback policy through existing interfaces | reproduce remaining failure cases first | separate S/M tickets |
| 1.3 | Memory migration REMOVED due to #574. Worktree typed failures belong with their first Effect consumer; synchronous Git/disposition stays plain | preserve current worktree errors and confirmations | folded into consumer |
| 1.4 | Classify store failures at a proven eligible decode/consumer seam only; preserve fail-closed locks, owner parsing, errno distinctions, partial-generation freshness and synchronous I/O. No Schema dependency in the security primitives | current regression oracle, not historical bug claims | M |
| 1.5 | Headless child supervision may translate plain termination outcomes into internal typed failures. Native unadopted-child termination stays entirely plain and retains its existing honest cleanup contract | cancellation must not claim success over live/unverified descendants | folded into 2.5 |
| 1.6 | Validate RPC responses and eligible config/session reads in separate bounded batches through existing plain interfaces; statically host-reachable code waits for the import/perf gate | preserve response diagnostics and filtering semantics | separate M tickets |
| 1.7 | Executable provenance remains plain TS on launcher/pre-adoption paths. Any new validation needs its own reproduced defect and must not import Effect | Plan 108 already delivered | no adoption ticket |

### Wave 2 — Lifecycle track (Track A), requiring proven off-startup seams

| # | Slice | Effect primitives | Oracle | Effort |
|---|---|---|---|---|
| 2.1 | No standalone `Clock`/`Git`/`ProcessTree` service ticket. Use the built-in clock inside migrated subjects; retain existing injectable plain-TS OS/test seams. Add a service only when its consumer needs one | pinned-version APIs | current public-interface tests | folded into consumer |
| 2.2 | A5 visible-backend steering acknowledgements: lazy owned waiter scope, consumption-versus-settlement races, timeout, authority loss and shutdown; preserve no-model-acceptance promise. The sibling durable supervisor request/ack channel stays plain and regression-covered, not migrated here | `Deferred`, scoped polling, timeout | current `backend-pane` race suite plus retained-control and non-TTY exit | M incl. first adopter |
| 2.3 | RETIRED: old native-task worker pool no longer exists | none | no replacement tool | none |
| 2.4 | A2 terminal index retry and Activity takeover retry as separate slices; preserve existing cadence, cap, resets, diagnostic dedupe and freshness semantics. Do not introduce jitter as an incidental refactor | `Schedule` where it simplifies ownership | current manager/bridge retry suites | M each |
| 2.5 | A6 headless child resource/cancellation supervision behind current interface; preserve retained launch gates, identity verification, drain and escalation truth. Visible pane acquisition/release is a separate later slice preserving #470 and effect-time pane/process checks | scoped Node process adapters; not platform spawners | backend/process-tree and integration zero-survivor suites | M each |
| 2.6a | A1 bounded manifest/settlement slice: interrupt losing Git work at deadline/disposal, settle once, preserve unknown evidence and durable fencing. Wrapping an uncancellable Promise is insufficient | owned timeout/settlement | current manager/manifest suites, real subprocess cleanup | M |
| 2.6b | A1 admission: current visible placement and worktree-creation serialization, bounded queue, capacity and re-entrant dequeue semantics; no registry rewrite | semaphore/queue only where needed | current manager, placement and worktree suites | M |
| 2.6c | A1 snapshots and owned child work: preserve conversational idle turns, replies, per-turn delivery, advisory budgets and synchronous observations | owned fibers/ref only behind existing API | current manager, budgets, reply and recovery suites | M |
| 2.6d | A1 disposal: interrupt ephemeral owned work but hand off verified retained children; keep fencing against late non-cancellable completions. Remove generation guards only when their actual safety role is superseded | explicit scoped teardown and hand-off | dispose/rebind/recovery/retention contracts | M |
| 2.7 | A8 delivery: current outbox is already a small synchronous FIFO. Defer a Queue rewrite unless a demonstrated ownership problem justifies it; preserve the no-await interval between durable admission and the synchronous Pi send, at-least-once retry on ambiguous failure, observation suppression and per-turn receipts | decide at scheduling, not by primitive checklist | delivery/index/current retained receipt tests | conditional |
| 2.8 | A3 split Activity polling and bridge polling into independent owned-lifecycle slices. The terminal manager already has one supervisor timer; preserve idle retry wakes, active-only cost and retention behavior, rather than recreating a timer forest | owned repeat/poll fibers as needed | current store/bridge/supervisor and non-TTY exit tests | M each |
| 2.9 | A4 batching only if the current projection protocol benefits: preserve one final snapshot, no re-entrant rescan and no newer-then-stale notification. Gate on measured perf, not completion of every unrelated lifecycle slice | refs/pubsub only if justified | current refresh/terminal delivery contract tests | conditional |

### Wave 3 — Host track (Track B), on the startup path, stop-ruled

| # | Slice | Effect primitives | Startup | Effort |
|---|---|---|---|---|
| 3.0 | **DONE: Plan 111 / #405**. Reuse `RpcHostLifecycle` and its characterization suite (exit, signals, adoption/rejection, reload, runtime failure, cache timeout); do not file a duplicate extraction | plain TS | unchanged | none |
| 3.1 | B3 `InitialHydrationActionGate` → `Latch.whenOpen` + keyed `FiberMap`. **Purpose: measure the Effect module-evaluation floor on the native path.** | `Latch` | on, ~0 work | S |
| 3.2 | B4 prompt scheduler cancellation/queue through its existing interface; preserve rebind and stale-outcome semantics | pinned-version owned fibers | currently host-import reachable; not automatically off | M |
| 3.3 | Chrome-cache drain and session-read worker pool as separate consumer-owned slices, preserving timeouts and bounded concurrency | services only if needed | currently host-import reachable; prove any lazy cut | M each |
| 3.4 | B5 hydration retry ownership and diagnostics behind current policy; preserve current cadence/cancellation, and reproduce any silent failure before treating it as a bug. No incidental exponential-backoff behavior change | reviewed schedule/clock APIs | on (command-ready) | M |
| 3.5 | B1 child adoption and request correlation behind the existing RPC client contract; characterize actual current correlation owners before any consolidation, preserve bounded exit/close/drain semantics, and retain plain pre-spawn/identity ownership | scoped adoption, deferred responses, timeouts | on (editor-ready) | separate bounded tickets |
| 3.6 | B2 terminal modes + teardown as `Scope` finalizers replacing plan 111's implementation; `Ref<"restore" | "hand-off">` models `preserveTerminal` | `Scope`, `Layer.effect` | on | M |
| 3.7 | B6 `runRpcHost` prologue → `Layer` composition; delete `createLazyChatSink`; `runRpcHost(): Promise<number>` unchanged; signals stay on `process.on` calling `runtime.runFork` | `Layer.mergeAll`, `ManagedRuntime` | on, entirely | L |

**Not in scope**: B7 event dispatch to `PubSub`, deep Schema traversal of every `message_update`
payload, `effect/unstable/rpc` as transport, or the native reload respawn loop. Wave 4 may validate a
shallow event envelope and required scalar bounds once; it must not add a second deep streaming decode.
The 3.1 stop rule also prevents 3.2/3.3 from importing Effect eagerly as a back door: those slices may
continue only behind a separately proven off-startup seam and passing budgets.

### Wave 4 — The event union (Track C slice 7)

| # | Slice | Effort |
|---|---|---|
| 4.1 | Reuse Pi's `AgentSessionEvent` vocabulary and the existing compile-exhaustive `AGENT_EVENT_DISPOSITIONS` matrix; characterize actual runtime validity disagreements, not a second disposition/type inventory. This work need not wait for unrelated lifecycle migrations | M |
| 4.2 | Decode an eligible event envelope once behind the import/perf gate, aligned with `AgentSessionEvent` while preserving forward-tolerant unknown events, unknown fields and existing scalar bounds. #460 content-index limits and #461 protocol diagnostics are already delivered; retain their oracle. Do not recursively validate every streamed payload or delete guards still serving an untrusted boundary | M per bounded consumer batch if needed |
| 4.3 | DEFERRED: no automatic `Data.Class` or render-cache rewrite. Equality changes require measured benefit and their own interface/visual contract; rendering remains plain TS | no default ticket |

### Wave 5 — Tests and lint end-state

| # | Slice | Effort |
|---|---|---|
| 5.1 | Timing tests migrate with each Effect-backed subject, using its pinned test APIs and deterministic synchronization; no `vi.waitFor` mixed with TestClock. Keep plain-TS fake timers and live OS tests where those remain the correct clock/oracle. The historical 26-file count is not a quota | included per adopter |
| 5.2 | Relevant malformed-input/property tests ship with each adopted decoder, not in a later correctness wave; test-only arbitrary imports stay out of production artifacts | included per decoder |
| 5.3 | Tighten boundary lint only in fully converted scopes. Plain launcher/security/render code still needs justified guards; no global option deletion while those sanctioned boundaries remain | local cleanup |

### Wave 6 — Consolidation

| # | Slice | Effort |
|---|---|---|
| 6.1 | Reviewed version checkpoint against the chosen pin; move to final only when available and verified, not as a date-dependent release requirement | M |
| 6.2 | Remove residual transitional paths when the final caller has migrated; use existing `dead-code:strict` rather than add another dead-code command. Prefer local cleanup in each adopter | remaining cleanup only |
| 6.3 | Reconcile architecture/dev docs and annotate historical feasibility evidence with actual adopted/deferred scopes and new measurements; do not rewrite historical measurements as current results | S/M |

## 6. Sequencing relative to existing plans

- **Plan 110** remains a historically deferred pilot with no recorded GO/NO-GO verdict. Plan 118 is
  the separate adoption proposal; do not relabel the pilot as completed or discard its preserved evidence.
- **Plan 111 / #405** is delivered as `RpcHostLifecycle`. Its characterization suite is a prerequisite
  already satisfied, not a new extraction ticket. Any eventual replacement must preserve its order.
- **Plans 112–114** are delivered. Preserve the durable registry's fencing, receipts, recovery capability
  limits, worktree disposition, and advisory-only budgets through the existing manager interface. They
  are now migration constraints rather than dependents waiting for Wave 2.
- **Plan 102 / #396** stays open for the consumer-runtime criterion. Its local remediation is not proof
  of consumer remediation; do not copy private security evidence into campaign tickets. Resolve or
  explicitly revise this inherited policy gate before the first production Effect dependency lands.
- **Approved v0.8.0 tranche**: #588/#589 provide plain-TS guards/measurements; #590 adds bounded
  off-startup steering acknowledgements after both and #396; #591/#592 independently follow #590 for
  manifest cancellation and headless supervision. [Published ticket contracts](118-ticket-draft.md).
  Later boundary/manager/host work stays in this roadmap until separately scheduled; #574 is not a
  blocker because Memory migration has been removed from scope. Tests and relevant lint tightening
  ship with each migrated subject, not as deferred correctness work in Wave 5.

## 7. Gates

Per slice, in addition to `tsc`, `build`, `lint`, `test`:

| Gate | Applies to | Pass condition |
|---|---|---|
| Startup-path assertion (0.4) | every slice | no Effect in eager launcher/pre-adoption execution; source and compiled evaluation agree with declared lazy seams |
| Metafile assertion (0.4) | every slice | `fast-check`, `msgpackr` absent |
| Native-vs-native perf (0.5) | every production Effect adopter | `editor_ready` ≤ baseline + 1 baseline MAD; `command_ready` ≤ baseline; `editorToCommandGapMs` ≤ baseline; 15 samples per identified native arm |
| Source-arm perf (0.5) | every production Effect adopter | startup comparison verdict ≠ `REGRESSED`; `host-import` within the explicitly reviewed baseline budget |
| Integration lane + zero-survivor audit | every runtime/SumoTUI adopter, including 2.2 | green, no owned survivors; includes non-TTY `--print` exit and explicit verified-retention/hand-off cases |
| Visual CI | any runtime/SumoTUI slice, including the first lifecycle adopters | green; no golden promotion |
| Extension bundle bare-import guard | every slice | only allowed Pi/typebox/Node externals; necessary but insufficient because Effect may be inlined |
| Extension size/evaluation (0.5) | every production Effect adopter | classic/RPC bundles, including native distribution, stay within reviewed size/evaluation budgets; no unapproved eager Effect evaluation in the Pi child |
| Wait-classification gate (0.7) | every timing-test migration | green with selected v4 TestClock vocabulary |
| Existing tsc budget (0.6) | every slice | existing full-pass checker passes (`instantiations` ≤ 2x recorded baseline); no silent baseline reset |

**Stop rule (Wave 3):** if slice 3.1 alone moves native `editor_ready` by more than 1 MAD, stop slices
3.4–3.7. The campaign then keeps Waves 1, 2, 4 (if `host-import` budget allows), 5, and the plain-TS
seam from 3.0. This is a valid outcome, not a failure.

## 8. Where the maintainer may be over-expecting

These cautions and numeric measurements come from the **2026-09-05 rc.112 research**, not a new
measurement of the refreshed checkout. Re-measure at the selected pin; do not turn historical counts
into mandatory migrations:

1. **Perf.** Effect does not make SumoCode faster. Shipped-binary startup +8 ms (core) to +19 ms
   (core + Schema + Stream); dev-mode startup +86–91 ms unless every import is a deep subpath; RSS
   +4.7 MB (Bun) / +13 MB (Node). The only perf-positive number is in-fiber steady-state work on Node
   (62 vs 76 ns/op), which is irrelevant at TUI event rates. Plan 117 just bought 367 ms of editor-ready;
   Wave 3 can give back 4–11% of it, which is why the stop rule exists.
2. **"As much as possible."** About 25k of 58k LOC must stay plain for correctness or security reasons,
   not taste. The honest footprint is the lifecycle core, the host core, and ~15 boundaries.
3. **Fewer bugs.** True for in-memory races, cancellation-path leaks, orphaned listeners, and
   unvalidated boundary data. False for the hardest recent bugs: ABA file leases, cross-restart process
   identity, incomplete-generation freshness (9 of 16 lifecycle fixes), Pi protocol ambiguities, and
   bash 3.2 `wait`. A new bug class arrives: agent-written v3-shaped Effect code and hand-written
   `*Unsafe` bridges between the two worlds, which the existing tests do not cover.
4. **RC stability.** One prerelease every ~2.25 days; interface breaks in patch bumps; a `Deferred`
   waiter hang fixed in rc.111. Exact pins and a reviewed upgrade ritual are mandatory, and a 4.0.0
   final checkpoint should be planned.
5. **Effect covers child processes and fs.** In rc.112 it does not, for SumoCode's needs: no adoption
   constructor, no verified process-group kill, no `O_NOFOLLOW`/`fchmod`/inode-compare. Those stay on
   Node APIs behind services; the value is the service seam and typed errors, not the platform layer.
6. **Test cost.** The research counted 26 test files and 198 `advanceTimers*` sites; two files toggled
   fake/real timers 17–24 times. Migrate only tests for adopted subjects, alongside the implementation.
   Preserve plain-TS clocks and live OS tests rather than mechanically converting that old inventory.
7. **Coexistence.** For most of Waves 2 and 3 a bug can live in either world. Budget review time for
   the `runPromise`/`runFork` seams specifically.

## 9. STOP conditions (campaign level)

- Slice 3.1 fails the native editor-ready gate: stop the specified on-startup host expansion, not every
  independently gated off-startup slice (see §7).
- An rc upgrade changes a primitive the campaign depends on (`Deferred`, `Scope`, `Latch`, `Queue`,
  `Schedule`) in a way the contract suites detect; pin stays, campaign pauses for reconciliation.
- A slice needs `effect/unstable/*` or `@effect/platform-*` in production without a wrapped interface.
- Any Effect type appears in a Pi tool, `pi.on` handler, pi-tui component, or `TerminalHost` signature.
- The extension bundle bare-import guard or the launcher-path assertion fails.
- Integration zero-survivor audit reports a leaked fiber-owned poller keeping a non-TTY process alive.

## 10. Done criteria

Release completion is the **approved ticket tranche (#588–#592)**, not every row of this roadmap.
The five-ticket v0.8.0 scope and blocking edges are approved and published. For each adopted slice:

- [ ] The named behavior and existing oracle pass behind unchanged public interfaces; current durable,
      conversational, visibility and advisory-budget contracts remain intact. Historical pilot evidence
      supplements, never replaces, the current tests.
- [ ] Import/build, native/source readiness and compiler gates pass; supervised integration leaves no
      survivors and non-TTY runs exit; relevant visual evidence passes without golden promotion.
- [ ] Tests, failure diagnostics, typed boundary handling and local dead-path cleanup ship together;
      plain-TS clocks, guards, durable stores and security primitives are not migrated by quota.
- [ ] Adopted, stopped, retired and deferred rows are recorded honestly, with the host stop decision and
      event-import decision backed by measurements before their expansion is authorized.
- [ ] Version and measurement evidence is recorded for the tested head; the plan index tracks the
      approved tickets without rewriting Plan 110's deferred history or duplicating completed Plan 111.
