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
> **Planned at**: PR-stack tip `99b8cc4d` (PR #457), 2026-09-05, `effect@4.0.0-rc.112`.

## Status

- **Priority**: P2 (after the open perf stack #414–#457 merges)
- **Effort**: XL (campaign; ~30 slices, S–L each)
- **Risk**: HIGH on the host track, MED on lifecycle, LOW on cold boundaries
- **Depends on**: GitHub Stack #438 merged through PR #449 (Plan 117 native executable) at minimum;
  Plan 111 (plain-TS host lifecycle seam) before Wave 3; Plan 109 (`DONE` in PR #436)
- **Supersedes**: Plan 110 (contained spike). Its contract matrix survives as the Wave 2 oracle; its
  "no `effect/unstable/*`" constraint survives as a campaign rule; its STOP condition "Effect imports
  enter normal startup" becomes a permanent CI assertion in Wave 0.
- **Category**: direction
- **Milestone**: M7 — Effect adoption
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/459 (supersedes #404); live bugs filed as #460 and #461

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
solely to make one race window observable.

At the data boundary, eleven `isRecord`/`isString` families disagree (two are wrong), 32 of 35 caught
`JSON.parse` sites swallow to a default, `onProtocolError` is never wired in production, and a
producer-controlled `contentIndex` can force 50 M synchronous allocations from one frame.

## 3. Non-negotiables for the campaign

1. **No Effect on the first-frame path until Wave 3, and never in the launcher.** `src/native/main.ts`
   argv classification, `src/sumo-tui/rpc/spawn-child.mjs`, `sumo-rpc-host.js`, and the pre-spawn +
   signal-ownership handoff stay plain. A build assertion enforces this from Wave 0.
2. **Deep subpath imports only.** `import * as Effect from "effect/Effect"`, never `from "effect"`;
   never a `@effect/platform-*` barrel. Lint-enforced.
3. **Exact pins.** `effect` and every `@effect/*` pinned to the identical prerelease string, in
   `dependencies` for `effect` (it is inlined into the native binary and extension bundle). Upgrades are
   a reviewed ritual, never automated.
4. **No `effect/unstable/*` in production code** unless a slice plan justifies it and wraps it behind
   one project-owned interface. Child processes stay on `node:child_process`; fs stays on `node:fs`.
5. **No Effect type crosses a Pi boundary.** Tool `execute` callbacks, `pi.on(...)` handlers, pi-tui
   components, and `TerminalHost` keep their Promise/plain signatures; `ManagedRuntime.runPromise`
   and the `*Unsafe` bridges live at the edge.
6. **The existing test file is the oracle.** No slice weakens or deletes an assertion. Integration
   lane, zero-survivor audit, and visual CI run on every slice that touches supervision or the host.
7. **Two runtimes coexist during the campaign; each fire-and-forget becomes a supervised fork whose
   failure routes to the existing `onDiagnostic` seam**, never only to Effect's default logger.

## 4. Target footprint

| Zone | LOC (non-test) | Decision |
|---|---:|---|
| `src/subagents`, `src/background-tasks/task-manager.ts`, `src/activity/{manager-bridge,store,feed-publisher}.ts`, `src/terminal-host` | ~8,000 | **Effect** lifecycle core behind existing interfaces |
| `src/sumo-tui/rpc/{client,host,host-actions,prompt-scheduler,runtime,controls,session-reader,chrome-cache-worker-client}.ts`, `src/sumo-tui/runtime` | ~8,000 | **Effect** host core, gated by startup budget |
| Cold boundaries: `src/config`, `mcp-config-reader`, `subagents/roles`, `native-task-params`, `rpc/response`, `rpc/lovely-web-config`, `rpc/enabled-models`, `executable-provenance` | ~1,500 | **Schema** (pure, no runtime) |
| Hot boundary: `rpc/client.ts` event funnel and its four consumers | ~1,000 | **Schema** for one event union, gated by import budget |
| `src/sumo-tui/{render,transcript,widgets,layout,input,cathedral}`, `src/cathedral`, `src/themes`, `footer`, `top-chrome`, `sidebar` | ~14,800 | **Plain TS forever**; only `Data.Class` equality where decoded classes already exist |
| `background-tasks/task-store.ts`, `activity/persistence.ts` I/O layer, `process-tree.ts` identity primitives, `child-protocol.ts` framing, `pi-compat/tree-navigation-command.ts` | ~3,000 | **Plain TS forever** (synchronous by design, security-hardened) |
| `src/native/main.ts`, `spawn-child.mjs`, `sumo-rpc-host.js`, `bin/`, `scripts/` | ~2,500 | **Plain forever** (launcher, pre-spawn, signal handoff, build) |

Realistic Effect footprint: ~17k LOC of ~58k, plus ~15 boundary schemas.

## 5. Waves and slices

Every slice: one branch, one plan file, one owner, `pnpm exec tsc --noEmit && pnpm build && pnpm lint
&& pnpm test` green, plus the wave-specific gates in §7. Effort S ≈ 1 day, M ≈ 2–4 days, L ≈ 1–2 weeks
of agent-driven work with human review.

### Wave 0 — Foundations (no behaviour change, no Effect runtime in production yet)

| # | Slice | Files | Effort |
|---|---|---|---|
| 0.1 | Pin `effect@4.0.0-rc.112` exact in `dependencies`, `@effect/vitest@4.0.0-rc.112` exact in `devDependencies`; run `pnpm build:bundles`; confirm the extension bundle bare-import guard still passes | `package.json`, `pnpm-lock.yaml` | S |
| 0.2 | Vendor the v4 cheat sheet and Effect's agent directives into `AGENTS.md`; point agents at `node_modules/effect/ai-docs/src/**` as the canonical corpus; install the project skills `effect-ts` (Effect-TS/skills: read `node_modules/effect/AGENTS.md` first) and `effect` (kitlangton/skills: v4 production defaults with SCHEMA/SERVICES_LAYERS/SCHEDULING/STREAMS/TESTING references) via `npx skills add`, and add a SumoCode overlay note where they conflict with repo rules (no `Config`/`process.env` rewrite, no `Cache` for the existing stores, Schema at boundaries only, deep imports) | `AGENTS.md`, `.agents/skills/{effect-ts,effect}`, `skills-lock.json` | S |
| 0.3 | Lint: enable `tools/oxlint/anti-slop/effect` plugin (`no-service-constructor-imports`, zero violations today); add rules banning `from "effect"` root barrel, `@effect/platform-*` barrels, `effect/testing/FastCheck` and `effect/unstable/encoding` barrels outside tests | `oxlint.config.ts`, `tools/oxlint/anti-slop/effect/rules/*` | M |
| 0.4 | Build assertions: launcher entry graph contains no `effect` module; `fast-check` and `msgpackr` absent from native and host metafiles (mirror `bedrockInputs`) | `scripts/build-native.mjs`, `scripts/build-host.mjs`, `scripts/lib/host-bundle.mjs` | S |
| 0.5 | Perf gate: native-vs-native regression check in `scripts/perf-native-compare.mjs` (editor-ready ≤ +1 MAD, command-ready no rise, `editorToCommandGapMs` no widen); `host-import` budget in `scripts/perf-startup.mjs`; capture baselines on the campaign base commit | `scripts/perf-*.mjs`, `docs/perf/` | M |
| 0.6 | `tsconfig` `incremental: true` with cached `.tsbuildinfo` in CI; `tsc --extendedDiagnostics` baseline (`checkTime`, `instantiations`); CI budget on a >2x instantiation jump | `tsconfig.json`, `.github/workflows/ci.yml` | S |
| 0.7 | Teach `scripts/test-wait-classification.test.mjs` the `TestClock.adjust` vocabulary so timer migrations stay inside plan 103's gate | `scripts/test-wait-classification.test.mjs` | S |
| 0.8 | `src/effect/runtime.ts` (lazy `ManagedRuntime`, disposed on `session_shutdown` / host stop), `src/effect/errors/{store,rpc,process,config}.ts` (`Schema.TaggedError` with tagged `reason`), `src/effect/services/Clock.ts` note (built-in `Clock` reference); nothing imports these yet | new files | M |

### Wave 1 — Schema at cold boundaries (pure values, no fiber runtime, each independently revertable)

| # | Slice | Bug fixed | Effort |
|---|---|---|---|
| 1.1 | `native-task-params.ts` → `Schema` + `Result` (already `{ok,value}|{ok,error}` shaped; proves the toolchain) | none; toolchain proof | S |
| 1.2 | `config/sumocode-config.ts`, `mcp-config-reader.ts`, `subagents/roles.ts` → `Schema.Class` + `ConfigError`; add `schemaVersion`; `onExcessProperty: "preserve"` on round-tripped config | silent config-tier drops, spurious role warnings, corrupt settings read as "no packages" | M |
| 1.3 | `git/worktree.ts`, `memory.ts` → tagged reasons; `sidebar.ts:156` `catchReasons` names why memory is empty | `error.message.includes(...)` matching; memory-offline indistinguishable from empty | S |
| 1.4 | `StoreError` (`Transient|NotFound|Corrupt|Denied`) applied to lock-scan and owner-parse paths in `task-store.ts` and `activity/persistence.ts`; decoders only, I/O untouched; delete six errno re-implementations | fail-open lock scans that break mutual exclusion | M |
| 1.5 | `ProcessError` on `subagents/backend-pi.ts` `signalGroup` and `native/main.ts` unadopted-child termination; kills can fail and say so | "Cancelled" reported over live grandchildren; orphaned child holding the TTY | M |
| 1.6 | `rpc/response.ts` `expectRpcSuccess(schema)`; `controls.ts` call sites validated; `Schema.fromJsonString` replaces swallowing `JSON.parse` in `lovely-web-config`, `enabled-models`, `session-reader` | unvalidated `.data`, fail-open model filter | M |
| 1.7 | `executable-provenance.ts` validates `PI_BIN`/`SUMOCODE_LAUNCHER` at read time | typo surfaces as late `ENOENT` | S |

### Wave 2 — Lifecycle track (Track A), off the startup path

| # | Slice | Effect primitives | Oracle | Effort |
|---|---|---|---|---|
| 2.1 | `Clock`, `Git`, `ProcessTree` services; delete five injected `now` options | `Context.Service`, built-in `Clock` | `worktree.test.ts`, `process-tree.test.ts` | M |
| 2.2 | A5 `backend-pane` steering acks | `Deferred` + one scoped poll fiber + `Effect.timeout` | `backend-pane.test.ts` (4 race tests) | S |
| 2.3 | A7 `mapWithConcurrencyLimit` → `Effect.forEach({ concurrency })` | | `native-task-tool` suites | S |
| 2.4 | A2 both backoff machines → one `Schedule.min([exponential, spaced])`, `Schedule.jittered`, `Schedule.tap` for once-per-episode diagnostics | `Schedule`, `Effect.retry` | `task-manager.test.ts:926`, bridge backoff cases | M |
| 2.5 | A6 `ChildSupervisor` service over `node:child_process`; one `attachAbortSignal`; `waitForTreeEmpty` → `Effect.repeat` | `acquireRelease`, `Effect.timeout` | `backend-pi.test.ts`, `process-tree.test.ts`, integration zero-survivor audit | M |
| 2.6a | A1 `SubagentManager`: `Deferred` settlement + `Effect.timeout` manifest (interrupts the losing git fan-out) | | `manager.test.ts` + plan 110 contract matrix | L |
| 2.6b | A1: `Semaphore` visible-spawn + `Queue.bounded` dequeue | | same | M |
| 2.6c | A1: `SubscriptionRef` snapshots + `FiberMap` children | | same | M |
| 2.6d | A1: delete `lifecycleGeneration`; `disposeAll` = `Scope.close` | | same | M |
| 2.7 | A8 delivery outbox → `Queue` + typed send error; drop the `oxlint-disable` at `subagents/index.ts:222` | | `delivery.test.ts`, `index.test.ts` | S |
| 2.8 | A3 timer forest in `activity/store.ts`, `manager-bridge.ts` → scope-owned fibers; every poller interrupted at shutdown (no fiber-level `unref` exists) | `Effect.forkScoped`, `RcMap` for conditional polls | `store.test.ts`, `manager-bridge.test.ts:1841`, non-TTY `--print` integration case | M |
| 2.9 | A4 refresh batching → `SubscriptionRef`/`PubSub`; only if 2.1–2.8 are clean | | `task-manager.test.ts`, `terminal-tools.test.ts` | L |

### Wave 3 — Host track (Track B), on the startup path, stop-ruled

| # | Slice | Effect primitives | Startup | Effort |
|---|---|---|---|---|
| 3.0 | **Plan 111 in plain TypeScript, as written**: `RpcHostLifecycle` deep module + `characterizes lifecycle order:` suite (normal exit, `/quit`, SIGINT, SIGTERM, child exit, startup rejection before/after adoption, reload exit 100, runtime start failure, chrome-cache timeout) | none | none | L |
| 3.1 | B3 `InitialHydrationActionGate` → `Latch.whenOpen` + keyed `FiberMap`. **Purpose: measure the Effect module-evaluation floor on the native path.** | `Latch` | on, ~0 work | S |
| 3.2 | B4 prompt scheduler → `FiberHandle` + `Queue` + `Effect.onInterrupt` | | off | M |
| 3.3 | `ChromeCache` + `SessionReader` services (`Effect.timeout` for drain grace, `Effect.forEach({ concurrency: 8 })` for the session worker pool) | `Context.Service`, `Layer` | off | M |
| 3.4 | B5 hydration retry policy → `Effect.retry` + `Schedule.exponential` + `Clock`; loop shape unchanged; the empty `catch` at `host.ts:1387` becomes a diagnostic | | on (command-ready) | M |
| 3.5 | B1 `PiChild` service: adopts the pre-spawned child, `Deferred` correlation with `Effect.timeout`, folds the two sibling correlation maps, `Effect.race(exit, close, timeout)` | `acquireRelease`, `Deferred`, `Effect.race` | on (editor-ready) | L |
| 3.6 | B2 terminal modes + teardown as `Scope` finalizers replacing plan 111's implementation; `Ref<"restore" | "hand-off">` models `preserveTerminal` | `Scope`, `Layer.effect` | on | M |
| 3.7 | B6 `runRpcHost` prologue → `Layer` composition; delete `createLazyChatSink`; `runRpcHost(): Promise<number>` unchanged; signals stay on `process.on` calling `runtime.runFork` | `Layer.mergeAll`, `ManagedRuntime` | on, entirely | L |

**Not in scope, ever**: B7 event dispatch to `PubSub`; B8 Schema on `message_update`; `effect/unstable/rpc`
as transport (server-side only, wrong wire format); the reload respawn loop in `native/main.ts`.

### Wave 4 — The event union (Track C slice 7)

| # | Slice | Effort |
|---|---|---|
| 4.1 | Reconcile the four event consumers (`transcript/controller.ts`, `rpc/state.ts`, `rpc/prompt-scheduler.ts`, `pi-compat/chat-viewport-controller.ts`) on one definition of a valid event; every disagreement filed as a bug | M |
| 4.2 | `PiAgentEvent` `Schema.TaggedUnion` decoded once at `client.ts:379`; bound `contentIndex`; wire `onProtocolError` from `host.ts`; delete ~5 guard families and `SessionValue`; `onExcessProperty: "preserve"` | L |
| 4.3 | `Data.Class` equality where decoded classes now exist: `controller.ts:187` `messagesEqual`, `chat-message.ts:568` render-rows cache key | S |

### Wave 5 — Tests and lint end-state

| # | Slice | Effort |
|---|---|---|
| 5.1 | `@effect/vitest` `it.effect` where a subject is Effect-backed; `TestClock` replaces `vi.useFakeTimers` in the 26 timer files (five heavy ones last, individually; `vi.waitFor` removed from any file that uses `TestClock`) | L |
| 5.2 | `it.effect.prop` with Schema-derived arbitraries for every Wave 1/4 decoder | M |
| 5.3 | Flip `anti-slop/no-runtime-typeof` `allowInTypeGuards` to `false` per converted directory; delete the option when the last boundary lands | S per dir |

### Wave 6 — Consolidation

| # | Slice | Effort |
|---|---|---|
| 6.1 | Move to `effect@4.0.0` final (or the then-current rc) in one reviewed bump of all `@effect/*` | M |
| 6.2 | Remove transitional dual paths and adapters; `knip --strict` wired for the campaign window | M |
| 6.3 | Plan 115-style documentation reconciliation: `AGENTS.md` architecture section, `DEV_LOOP.md`, `docs/research/effect-v4-feasibility.md` status | M |

## 6. Sequencing relative to existing plans

- **Plan 110**: superseded; leave the file, mark the index row `SUPERSEDED by 118`.
- **Plan 111**: executed as slice 3.0, in plain TypeScript, before any host Effect slice. Its
  characterization suite is the contract Wave 3 must satisfy. Accept that its implementation is later
  replaced by 3.6/3.7.
- **Plans 112, 113, 114** (durable subagent registry and product features): the `SubagentRegistry`
  service in slice 2.6 is the natural home for 112's durable identity and exactly-once delivery.
  Recommendation: land Wave 2 through 2.6 before 112 so 112–114 are written natively against the
  Effect manager instead of being migrated twice. If product pressure requires 112 first, it must be
  built behind the same public `SubagentManager` interface so 2.6 can still replace the internals.
- **Issue #448** (pre-hydration key cycles) and Plan 108 provenance work are independent and may land
  in either order.

## 7. Gates

Per slice, in addition to `tsc`, `build`, `lint`, `test`:

| Gate | Applies to | Pass condition |
|---|---|---|
| Startup-path assertion (0.4) | every slice | launcher entry graph imports no `effect` module |
| Metafile assertion (0.4) | every slice | `fast-check`, `msgpackr` absent |
| Native-vs-native perf (0.5) | Waves 3, 4, and slices 2.2, 2.6, 2.9 | `editor_ready` ≤ baseline + 1 MAD; `command_ready` ≤ baseline; `editorToCommandGapMs` ≤ baseline; 15 samples |
| Source-arm perf (0.5) | Waves 3, 4 | `perf-startup-compare` verdict ≠ `REGRESSED`; `host-import` within budget |
| Integration lane + zero-survivor audit | slices 2.5, 2.6, 2.8, 2.9, all of Wave 3, 4.2 | green, no surviving processes; includes a non-TTY `--print` case for scope-owned pollers |
| Visual CI | Wave 4 and any slice touching `host.ts` | green; no golden promotion |
| Extension bundle bare-import guard | every slice | only `@earendil-works/*`, `typebox`, `node:*` |
| Wait-classification gate (0.7) | Wave 5 | green |
| tsc budget (0.6) | every slice | `instantiations` < 2x baseline |

**Stop rule (Wave 3):** if slice 3.1 alone moves native `editor_ready` by more than 1 MAD, stop slices
3.4–3.7. The campaign then keeps Waves 1, 2, 4 (if `host-import` budget allows), 5, and the plain-TS
seam from 3.0. This is a valid outcome, not a failure.

## 8. Where the maintainer may be over-expecting

Stated plainly so the campaign is judged against reality:

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
6. **Test cost.** 26 test files and 198 `advanceTimers*` sites move to `TestClock`; two files toggle
   fake/real timers 17–24 times and need redesign, not translation.
7. **Coexistence.** For most of Waves 2 and 3 a bug can live in either world. Budget review time for
   the `runPromise`/`runFork` seams specifically.

## 9. STOP conditions (campaign level)

- Slice 3.1 fails the native editor-ready gate (see §7 stop rule).
- An rc upgrade changes a primitive the campaign depends on (`Deferred`, `Scope`, `Latch`, `Queue`,
  `Schedule`) in a way the contract suites detect; pin stays, campaign pauses for reconciliation.
- A slice needs `effect/unstable/*` or `@effect/platform-*` in production without a wrapped interface.
- Any Effect type appears in a Pi tool, `pi.on` handler, pi-tui component, or `TerminalHost` signature.
- The extension bundle bare-import guard or the launcher-path assertion fails.
- Integration zero-survivor audit reports a leaked fiber-owned poller keeping a non-TTY process alive.

## 10. Done criteria

- [ ] Waves 0–2 landed; `SubagentManager`, `TerminalTaskManager` bridge, and steering-ack paths run on
      Effect behind unchanged public interfaces; plan 110's contract matrix passes against production.
- [ ] Wave 1 boundaries decode through Schema with named errors; fail-open lock scans and unfailable
      kills are gone; `onProtocolError` is wired.
- [ ] Wave 3 landed to the stop rule; native editor-ready and command-ready medians within gate.
- [ ] Wave 4 landed or explicitly deferred with the `host-import` measurement recorded.
- [ ] Wave 5: `TestClock` in every former fake-timer file; `allowInTypeGuards` deleted.
- [ ] `docs/research/effect-v4-feasibility.md` updated with post-campaign measurements and the
      final expectation table.
- [ ] `plans/README.md` rows: 110 `SUPERSEDED`, 111 `DONE`, 118 slices tracked.
