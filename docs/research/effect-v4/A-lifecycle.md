# Track A — Subagent / background-task lifecycle & terminal supervision

Effect v4 (`4.0.0-rc.112`) adoption analysis.

- Tree analysed: `/tmp/sumocode-stack-tip` (PR-stack tip, read-only). All `file:line` citations are against that tree.
- Effect API source of truth: `/tmp/effect-rc/package` (`src/*.ts`, `ai-docs/src/**`, `AGENTS.md`). Every API named below was grepped out of that package; unverifiable ones are called out explicitly.
- Repo constraints honoured: `AGENTS.md` (tabs, colocated tests, `src/spike/` is throwaway, Pi-bundled deps are peer-only, no emitted `dist`), `oxlint.config.ts` anti-slop rules.

**Headline.** This domain contains ~2,000 lines of hand-rolled structured concurrency that Effect's core primitives model directly, and it has a *documented* bug history proving those hand-rolls leak (16+ `fix(terminals|subagents|protocol)` commits between 2026-07-18 and 2026-09-01, most of them race/ordering repairs). But roughly half the domain — the durable terminal store, process-tree identity verification, the Pi tool/event boundary — is deliberately **synchronous** or **explicitly-killed**, where Effect adds ceremony without removing a bug class. The honest recommendation is a *narrow, deep* adoption: own the in-memory lifecycle graph in Effect, keep the durable/OS layer in plain TypeScript behind `Context.Service` seams.

---

## 1. Inventory: hand-rolled concurrency & lifecycle mechanisms

### 1.1 Promise tails / serialization

| Mechanism | Location | What it does |
|---|---|---|
| `visibleSpawnTail: Promise<void>` | `src/subagents/manager.ts:160`, allocator at `:651-657` | A one-permit mutex built from a chained promise: `reserveVisibleSpawn()` captures the previous tail, installs a new unresolved one, awaits the old. Released in a `finally` at `:388`. |
| `dequeueTail: Promise<void>` | `src/subagents/manager.ts:161`, `scheduleDequeue()` at `:604-608` | Serializes queue draining. `this.dequeueTail = next.catch(() => undefined)` — the failure branch is swallowed to keep the tail alive. Fired-and-forgotten from five sites (`:211`, `:492`, `:585`, `:835`, and indirectly `:597`). |
| `runtime.reconcilePromise` | `src/background-tasks/task-manager.ts:1483-1494` | Per-task single-flight guard: `if (runtime.reconcilePromise) return;` then `.catch(...).finally(() => { runtime.reconcilePromise = undefined })`. |
| `TerminalDeliveryCoordinator.flushQueued` / `flushing` | `src/background-tasks/terminal-tools.ts:171-172`, `:237-250`, `:252-255` | Two booleans implementing "coalesce to one queued microtask flush" plus "non-reentrant". |
| `takeoverRefreshInFlight` | `src/activity/manager-bridge.ts:187`, honoured at `:240-243` | Re-entrancy guard added by `b4227559` (2026-08-30) because the manager's own listener fan-out re-entered the bridge mid-refresh. |
| `indexInitInFlight` | `src/background-tasks/task-manager.ts:551` | "True while the lazy seeding scan runs, so a listener fanned out by it cannot re-enter." |

### 1.2 Settle de-duplication maps

- `src/subagents/manager.ts:162-164`: `settlingIds: Set`, `settlingPromises: Map<string, Promise<void>>`, `settlingOutcomes: Map<string, RunOutcome>`. `startSettle()` (`:780-792`) is the de-dup gate; `settle()` (`:794-837`) re-checks `settlingIds` *again* at `:796` and re-reads the snapshot at `:820-821` after the async manifest await.
- `src/subagents/manager.ts:165-167`: three more parallel id sets — `startedIds`, `cancelledSetupIds`, `workspacePlacedIds` — each with its own add/delete lifecycle scattered across `startTask`, `fold`, `settle`, and the `finally` at `:386-390`.
- `src/subagents/backend-pi.ts:619-624`: a local `settled` boolean + `settle()` closure, because `close` and `error` can both fire.
- `src/subagents/backend-pane.ts:214`, `:255-262`: same pattern again (`settled`, `interrupted`).
- `src/subagents/delivery.ts:31-32`: `pending: Map` + `consumed: Set` — an at-least-once outbox where `flush` deletes *after* `send` returns (`:47-52`).
- `src/subagents/index.ts:232-245`: `observedSettledIds` mirror set, pruned "in lockstep with the manager's MAX_TRACKED prune".

### 1.3 `Promise.race` timeouts & manual timers

- `src/subagents/manager.ts:839-861` — `collectManifest`: `Promise.race([build().catch(fallback), new Promise(r => timeout = setTimeout(() => r(fallback), 5000))])` with `clearTimeout` in `finally`. The losing manifest build is **not cancelled** — it keeps running and holding git subprocesses.
- `src/subagents/manager.ts:863-880` — `waitForSettle`: `new Promise` + `setTimeout` + a listener subscription, with manual `clearTimeout`/`unsubscribe` on both paths.
- `src/subagents/manager.ts:406-424` — `nextChange(signal)`: `new Promise` with a mutable `cleanup` variable reassigned after construction, an `abort` listener, and an unsubscribe. Classic lost-wakeup shape.
- `src/background-tasks/task-manager.ts:779-806` — `wait`: `new Promise` with `finished` flag, `timer`, `unsubscribe`, `onAbort`, **plus** an explicit re-check at `:797-800` ("Close the inspection/subscription lost-wakeup window"). Guarded by the test `closes the wait inspection/subscription lost-wakeup window` (`task-manager.test.ts:1856`).
- `src/subagents/backend-pi.ts:448-483` — `attachAbortSignal`: SIGTERM, then `setTimeout(SIGKILL, 5000).unref()`, plus `exited`/`aborted` flags, plus a `dispose()` that removes three listeners and clears the timer.
- `src/native-task-tool.ts:709-742` — a second, near-identical copy of `attachAbortSignal`.
- `src/background-tasks/process-tree.ts:355-376` — `waitForTreeEmpty`: a manual recursive `setTimeout(poll, 25)` deadline loop inside a `new Promise`.

### 1.4 `setInterval` polling

| Timer | Location | Cadence |
|---|---|---|
| terminal reconcile poll | `task-manager.ts:1473-1474` (`arm`), cleared `:1422`, `:2089` | `pollIntervalMs` per running task |
| lazy index-init retry | `task-manager.ts:1269-1274`, cleared `:1277-1281` | escalating backoff |
| pane exit-marker watcher | `backend-pane.ts:461-462`, cleared `:224-228` | `RESPONSE_POLL_INTERVAL_MS` |
| steering-ack watcher (one **per in-flight send**) | `backend-pane.ts:382-408`, cleared `:238` | `SEND_ACK_POLL_MS`, with hand-rolled `elapsed += ackPollMs` budget |
| terminal output poll | `manager-bridge.ts:627-628`, cleared `:622-624` | `terminalOutputPollMs`, armed/disarmed by `syncTerminalOutputPoll` |
| retention poll | `manager-bridge.ts:248-249` | `retentionPollMs` |
| takeover-refresh retry | `manager-bridge.ts:466-471` | escalating backoff |
| subagent publish debounce | `manager-bridge.ts:612-616` | `setTimeout`, single-shot coalesce |
| activity store fs poll + debounce | `activity/store.ts:338-343`, `:365-369` | `pollMs` / `debounceMs` |
| delivery lease retry | `terminal-tools.ts:318-325` | `getClaimRetryDelay() + 10` |
| herdr pane-list retry | `terminal-host/herdr.ts:126-132` | 4 attempts, `setTimeout(25)` |

Every one of these is `.unref?.()`'d by hand and cleared by hand in a `dispose`/`detach`/`clear*` method. There are **11 distinct timer fields** across four classes, each with its own teardown path.

### 1.5 Retry loops & backoff, duplicated

Two independent, near-identical escalating-backoff state machines:

- `task-manager.ts:552-562` (5 fields) + `:1153-1281` (~130 lines): `indexInitBackoffMs`, doubling, capped at `INDEX_INIT_RETRY_BACKOFF_MAX_MS`, `indexInitLastAttemptAt` throttle, `indexInitDiagnosedKind` once-per-episode dedupe, `indexInitRetryDueAt` idempotent rescheduling, `resetIndexInitEpisode()`.
- `manager-bridge.ts:33-38`, `:185-193`, `:360-485` (~130 lines): `takeoverRefreshBackoffMs`, doubling to a 60 s cap, `takeoverRefreshLastAttemptAt`, `takeoverRefreshFailureDiagnosed`, `takeoverRefreshRetryDueAt`. The comment at `:436` says explicitly it is "mirroring the manager's lazy init-retry schedule."

Plus two bounded retry loops:
- `task-manager.ts:1914-1947` — CAS retry against `StaleTerminalTaskRevisionError`, `MAX_TRANSITION_RETRIES = 16` (`:84`).
- `task-manager.ts:607-619` — 100-attempt id-allocation loop against `EEXIST`.
- `terminal-host/herdr.ts:126-133` — 4-attempt pane-list loop.

### 1.6 Listener sets & manual fan-out

- `manager.ts:150` `listeners: Set<Listener>`; `notify()` at `:882-895` wraps every call in try/catch and a *nested* try/catch for the diagnostic.
- `task-manager.ts:528-529` — **two** listener sets (per-task `listeners`, projection `snapshotListeners`), plus a batching layer: `refreshBatchDepth` (`:531`), `refreshBatchQueued: Map` (`:533`), `projectionPublishDeferred` (`:540`), drained by `drainRefreshBatch` (`:2043-2063`) and gated in `publishProjection` (`:2066-2083`).
- `activity/store.ts:168` + `apply()` at `:428-444`.
- `manager-bridge.ts:230-247` — two subscriptions with an in-flight re-entrancy bypass.

### 1.7 AbortControllers & cancellation

- `manager.ts:148` — `children: Map<id, { child, controller: AbortController }>`. The controller is created at `:360` and… never `.abort()`ed anywhere in `manager.ts`. Cancellation goes through `child.interrupt()` (`:480`, `:600`) instead. The `AbortSignal` exists only to be threaded into `backendFactory` (`:52`, `:364`) where `attachAbortSignal` consumes it. **Two parallel cancellation channels for the same operation.**
- `manager.ts:168`, `:594`, `:631-633` — `lifecycleGeneration` is a *third* cancellation channel: a monotonic token checked at five await-resume points in `startTask` (`:239`, `:301`, `:310`, `:339`, `:356`) because "In-flight setup cannot be synchronously interrupted".

### 1.8 Mutable capacity / queue state

`manager.ts:144-169` is 26 lines of mutable fields: `nextId`, `pendingSpawns`, `queuedTasks[]`, `snapshots`, `children`, `waitInterest` (a refcount map, incremented at `:429` and decremented in a `finally` at `:442-446`), plus the six id sets above. Capacity is computed by re-deriving `runningSummaries()` (`:215-225`) from two of those maps on every check.

### 1.9 Process spawn / kill sequences

- `backend-pi.ts:425-439` `signalGroup`: `process.kill(-pid, sig)` with a single-pid fallback; requires `detached: true` (`:598`).
- `process-tree.ts:273-297` `rawSystemSignal`: `-PGID` only; EPERM must **never** fall back to the positive leader pid.
- `process-tree.ts:299-377` `systemProcessTree`: `execFileSync("ps", ...)` identity capture, member anchors, ABA bracketing (`:325-328` — re-checks leader identity *after* the `ps`).
- `process-tree.ts:402-429` `terminateProcessTree` / `terminateFreshProcessTree`: TERM → `waitForTreeEmpty(termGrace)` → KILL → `waitForTreeEmpty(killGrace)`.
- `task-manager.ts:590-719` `start`: 130 lines with **five** distinct compensating-teardown paths (`:680`, `:697`, `:702`, `:711`) that each call `terminateFreshProcessTree` and throw if it cannot prove termination.
- `task-manager.ts:958-966` `stop`: fire all TERMs via `Promise.all`, *then* `Promise.all` the grace waits — deliberately not sequential.

### 1.10 fs persistence with partial-failure handling

- `activity/persistence.ts:440-483` `withPrivateFileLock`: a **fully synchronous** cross-process lease using `writePrivateJsonExclusive` + `sleepSync(pollMs)` in a deadline loop, with ABA repair (`releasePrivateFileLock` `:412-433` scans twice).
- `activity/persistence.ts:486-522` `atomicWritePrivateJson`: `O_EXCL|O_NOFOLLOW` temp → `fchmod` → `fsync` → `rename` → directory `fsync`, with an unlink-swallowing `finally`.
- `activity/feed-publisher.ts:200-256` — writer-lease takeover with rename-to-takeover, ABA detection (`:240-246`), and `restoreTakeoverLease`.
- `task-store.ts` — **entirely synchronous** (`transition` `:747-754`, `create` `:682-688`, `refreshIndex` `:521`, `getIndexed` `:708`, all wrapped in `withTaskLock` `:908`). No `async` method in the file.
- `task-manager.ts:1120-1140` — "incomplete generation" handling: a scan that succeeded but hit a transient per-record read still serves its index while keeping retries armed.

---

## 2. Ranked candidates

Ranking is by *bug classes removed per unit of risk*, not by LOC.

---

### A1 — `SubagentManager` settlement & cancellation core — **HIGHEST VALUE**

**What it is.** `manager.ts:143-906`. Specifically: `startSettle`/`settle` (`:780-837`), `collectManifest` (`:839-861`), `waitForSettle` (`:863-880`), `nextChange` (`:406-424`), `cancel`/`close` (`:451-587`), the six id sets (`:162-167`) and the `lifecycleGeneration` token (`:168`, `:594`, `:631-633`).

**Effect v4 replacement.**
- `Deferred<Exit<Settled>>` per subagent id replaces `settlingPromises` + `settlingOutcomes` + `settlingIds`. `Deferred.complete` is idempotent-by-construction (`Deferred.ts:260`); the `startSettle` de-dup gate (`:780-783`) and the second `settlingIds` check (`:796`) both disappear.
- `Effect.timeout` (`Effect.ts:8293`) replaces `Promise.race` in `collectManifest`. Critically, its documented semantics are *"If the timeout wins, the source effect is interrupted"* — the current code leaks the losing manifest build (which spawns four concurrent `git` processes, `manifest.ts:87`).
- `Fiber` + `Scope` replace `lifecycleGeneration`. `disposeAll()` (`:589-602`) becomes `Scope.close`; the five manual `setupInterrupted(id, generation)` re-checks at `:239/:301/:310/:339/:356` become ordinary interruption at each `yield*`.
- `Semaphore.make(1)` + `Semaphore.withPermit` (`Semaphore.ts:358`, `:516`) replaces `visibleSpawnTail` (`:651-657`).
- `Queue.bounded(SUBAGENT_MAX_QUEUED)` (`Queue.ts:500`) + one draining fiber replaces `queuedTasks[]` + `dequeueTail` + `scheduleDequeue` + `drainQueue` (`:604-629`) — and makes the `at_capacity` decision a queue property instead of a re-derived count.
- `SubscriptionRef<ReadonlyMap<id, Snapshot>>` (`SubscriptionRef.ts:111`, `changes` `:160`) replaces `snapshots` + `listeners` + `notify()` + `nextChange`. `waitFor` becomes `Stream.takeUntil` over `changes`.
- `FiberMap<id>` (`FiberMap.ts:162`) replaces `children` — `FiberMap.remove` interrupts and awaits, and the map is `Scope`-owned so a dropped entry cannot leak.
- `Effect.forEach(ids, …, { concurrency: "unbounded" })` (`Effect.ts:1088`) replaces `Promise.allSettled` at `:484` and `:572`.

**Bug class removed — evidence.**
1. `74cf3f66` (2026-07-18) *"fire all batch-cancel interrupts before awaiting settles"* — the fix is a comment at `manager.ts:452-455` explaining why the loop must be split into "signal all, then await all". Guarded by `manager.test.ts:1028` *"interrupts every batch-cancel target before awaiting any settle"*. In Effect this is not a fix, it is what `Effect.forEach(..., { concurrency })` does.
2. `manager.ts:747-751` + `manager.test.ts:982` *"keeps terminal state sticky when a late real settle arrives after cancel timeout"* — the sticky-terminal-state guard exists because the synthetic interrupted settle and the real `run-settled` race. A `Deferred` that is already completed silently ignores the second completion.
3. `manager.ts:380-384` — `startTask` must look up `settlingPromises.get(id)` and await it, because "a backend can settle synchronously". With a `Deferred` this is just `Deferred.await` with no special case.
4. `manager.ts:864` carries a `// SAFETY:` cast (`this.snapshots.get(id) as SubagentSnapshot`) precisely because the transient maps and the snapshot map can disagree. One `SynchronizedRef` state value removes the disagreement.
5. Unguarded path: `scheduleDequeue()` is invoked as `void this.scheduleDequeue()` from `:211`, `:492`, `:585`, `:835`. `dequeueTail` swallows failures at `:606`. A `drainQueue` throw is therefore invisible except through the inner try/catch at `:616` — and that catch only handles the case where the snapshot is still `queued` (`:618`). A throw *after* `startTask` mutated state loses the tail silently.

**LOC affected.** ~450 of 906 in `manager.ts`. **Effort: L. Risk: MED** — `manager.test.ts` (1,225 lines) is a strong parity oracle, and the public surface (`spawn`/`sendTo`/`waitFor`/`cancel`/`close`/`list`/`addChangeListener`/`disposeAll`) is small and already Promise-shaped.

---

### A2 — Escalating-backoff retry state machines (two copies) — **BEST VALUE/RISK RATIO**

**What it is.** `task-manager.ts:552-562` + `:1153-1281`, and `manager-bridge.ts:185-193` + `:360-485`. ~260 lines total implementing the same doubling-with-cap schedule twice, each with its own once-per-episode diagnostic dedupe and idempotent timer rescheduling.

**Effect v4 replacement.** Verbatim from `ai-docs/src/06_schedule/10_schedules.ts:85-89`:

```ts
Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("60 seconds")])
```

`Schedule.min` (`Schedule.ts:1023`) continues while any schedule continues and outputs the fastest delay — exactly "double until capped". Add `Schedule.jittered` (`:1441`) for free, `Schedule.tap` for the once-per-episode diagnostic, and drive it with `Effect.retry` (`Effect.ts:7192`) / `Effect.repeat` (`:14574`) on a scoped fiber. `indexInitRetryDueAt`'s idempotent-rescheduling logic (`:1266`) vanishes because there is one fiber, not a re-armed timer.

**Bug class removed — evidence.** Four commits on 2026-08-30 alone touch this machinery: `ed76b0e7` *"directory-assert transients and escalating init backoff"*, `f3293350` *"report and retry on incomplete index generations"*, `af1e6ebb` *"seed the index lazily after init-scan failure…"*, `35663c6c` *"escalate deferred takeover rescan backoff…"*. The test `re-arms the init retry timer when the last active task settles after stop with an incomplete index` (`task-manager.test.ts:926`) guards a specific arm/disarm interaction between `arm()` (`:1470`, `:1475`) and `clearPoll()` (`:2087`) — i.e. the retry timer's liveness is coupled to unrelated poll timers through three call sites.

**LOC affected.** ~260 → ~40. **Effort: M. Risk: LOW** — the state machine is internal, the entry points (`ensureIndexInitialized`, `syncOwnedSessions`) keep their signatures, and both have dedicated tests.

---

### A3 — Timer forest → `Scope`-owned fibers

**What it is.** The 11 timer fields in §1.4 and their four teardown methods: `task-manager.detach()` (`:1417-1427`), `manager-bridge.dispose()` (`:295-317`), `FileActivityStore.stopObservation()` (`:446-453`), `backend-pane.clearWatcher()`/`settle()` (`:224-262`).

**Effect v4 replacement.** `Effect.repeat(Schedule.spaced(interval))` forked into a `Scope` via `Effect.forkScoped` (`Effect.ts:17128`) or `Effect.forkIn` (`:17033`). Closing the scope interrupts every fiber; no `dispose()` needs to enumerate anything. `Effect.acquireRelease` (`:12928`) / `Effect.addFinalizer` (`:13112`) for the watcher and pane handles. For the *conditional* timers (`syncTerminalOutputPoll` at `manager-bridge.ts:619-629` arms/disarms based on whether any terminal is running), `RcMap` (`RcMap.ts:240`) or a `FiberHandle` gives ref-counted lifetime instead of a boolean + null check.

**Bug class removed — evidence.** `manager-bridge.test.ts:1841` — *"marks non-reattachable shutdown subagents lost and clears every timer"*. That a test must assert "clears every timer" is the tell: teardown correctness is currently a manual checklist across 6 fields in one method (`:302-308`). `activity/store.ts` additionally guards every timer callback with `if (this.disposed || generation !== this.generation) return` (`:339`, `:347`, `:363`, `:373`, `:381`) — five copies of a check that a scope makes structural.

**LOC affected.** ~200 across four files. **Effort: M. Risk: MED** — `unref()` semantics must be preserved (see §7).

---

### A4 — Terminal-task refresh notification batching

**What it is.** `task-manager.ts:530-540` (`refreshBatchDepth`, `refreshBatchQueued`, `projectionPublishDeferred`) + `runRefreshLoops` (`:1297-1359`) + `drainRefreshBatch` (`:2043-2063`) + `publishProjection` (`:2066-2083`) + `adoptLockedNoOpSnapshot` (`:1982-1993`). Roughly 180 lines whose entire job is "collapse N mutations into one fan-out, dedupe to the latest snapshot per id, and never emit newer-then-stale".

**Effect v4 replacement.** `SubscriptionRef` (`SubscriptionRef.ts:111`) makes "latest wins" the default: subscribers read `changes` (`:160`), a `Stream`, and the batching becomes `Stream.debounce`/`Stream.throttle` on the *consumer* side rather than manual depth-counting on the producer side. Per-task wakeups become a `PubSub` (`PubSub.ts:278`) with `PubSub.publishAll`. Observer isolation (the six `try { listener(...) } catch {}` blocks at `:2020-2024`, `:2077-2082`, `manager.ts:884-893`, `store.ts:438-443`) is inherent: a subscriber fiber failing cannot affect the publisher.

**Bug class removed — evidence.** `b4227559` (2026-08-30) *"coalesce refresh notifications and guard bridge takeover re-entrancy"*, `9f4cc595` (2026-08-30) *"drain refresh batch on throw and publish adoption-only rewrites"*, `34c6ad9a`, `290e250c` (*"wake delivery on same-revision delivery-field rewrites"*). Test `drains queued refresh notifications and wakes a parked waiter when the refresh loops throw` (`task-manager.test.ts:2067`). The comment block at `:2030-2042` is 13 lines of prose explaining an ordering invariant that `SubscriptionRef` provides by definition.

**LOC affected.** ~180. **Effort: L. Risk: MED-HIGH** — this batching is load-bearing for the `TerminalDeliveryCoordinator` and `ActivityManagerBridge`, and both have dense tests (`manager-bridge.test.ts` is 1,858 lines). Do this *after* A2/A3 have proven the Effect seam.

---

### A5 — `backend-pane` steering-ack watchers

**What it is.** `backend-pane.ts:210-222` (`pendingSteeringAcks: Map<path, { timer, resolve, reject }>`), `send()` (`:369-410`), `finishPendingSteeringAck` (`:234-241`), `settlePendingSteeringAcks` (`:249-253`). One `setInterval` **per concurrent send**, each carrying its own hand-summed `elapsed` budget (`:392`) with a five-line comment explaining why the budget must advance before any branch.

**Effect v4 replacement.** One `Deferred<void, SteeringError>` per send + a single scoped polling fiber (`Effect.repeat(Schedule.spaced(ackPollMs))`) + `Effect.timeout(ackTimeoutMs)` per waiter. `Deferred.complete` idempotence removes `finishPendingSteeringAck`'s "guard on map presence" (`:398-400`).

**Bug class removed — evidence.** Three commits in this exact area: `741d61e5` *"clarify and settle steering acknowledgements"*, `983bbb81` *"truthful steering ack cleanup and blank-send rejection"*, `d7bab039` (2026-08-29) *"resolve consumed steering acks at settlement and interrupt"*. Four tests guard it: `backend-pane.test.ts:612` *"rejects on consumption timeout, preserves the ambiguous file, and removes its timer once"*, `:671` *"rejects a pending send when spawn settlement wins the race"*, `:709` *"resolves a send whose control was consumed even when the response poll settles first"*, `:756` *"settles a pending send and clears timers after a graceful close exits"*. That is four distinct race repairs in one 40-line function.

**LOC affected.** ~90. **Effort: S. Risk: LOW** — well-fenced, heavily tested, and `SpawnedChild.send` already returns `Promise<void>`.

---

### A6 — Child-process TERM→KILL escalation (two copies)

**What it is.** `backend-pi.ts:425-483` (`signalGroup` + `attachAbortSignal`) and its near-duplicate `native-task-tool.ts:709-742`. Plus `process-tree.ts:355-376` (`waitForTreeEmpty` recursive-setTimeout poll) and `:402-429` (`terminateProcessTree`).

**Effect v4 replacement — partial, with a caveat.** `effect/unstable/process` genuinely covers the *shape*: `ChildProcess.make(cmd, args, { detached: true, env, extendEnv })` (`ChildProcess.ts:603`, `detached` at `:374+`), `ChildProcessSpawner.spawn` returning a scoped `ChildProcessHandle` (`ChildProcessSpawner.ts:79-196`) with `exitCode`, `isRunning`, `stdin` sink, `stdout`/`stderr`/`all` streams, `kill(options)`, and `unref`. `KillOptions` (`ChildProcess.ts:242-254`) has **exactly** `killSignal` + `forceKillAfter` — the SIGTERM-then-SIGKILL-after-5s escalation as a config field. `spawner.spawn` adds a `Scope.Scope` requirement, so an unclosed child is a type error rather than an orphan.

**But do not adopt it here.** Three blockers, all verifiable:
1. The Node implementation is **not in this package**. `ai-docs/src/60_child-process/10_working-with-child-processes.ts:104` provides it via `NodeServices.layer` from `@effect/platform-node`, which is absent from `/tmp/effect-rc`. Its `kill` semantics are therefore unverified — and SumoCode's entire correctness story depends on signalling the **process group** (`-pid`), never the leader pid (`backend-pi.ts:425-433`; `process-tree.ts:288-296` explicitly forbids the positive-pid fallback on EPERM because "doing so could leave descendants alive while claiming cancellation").
2. `ChildProcessHandle` exposes `pid` but no start-time/identity anchor. SumoCode's durable model requires PID + `ps lstart` + command fingerprint (`process-tree.ts:199-215`) and member anchors with ABA bracketing (`:318-329`) to survive process restarts. That is strictly outside what `ChildProcessSpawner` models.
3. Adding `@effect/platform-node` means a second package in a repo whose Pi-bundled deps are peer-only and whose extension bundle is `packages: "external"` (`scripts/build-extension.mjs:24`).

**Recommendation:** keep `node:child_process` and unify the *two duplicate copies* of `attachAbortSignal` behind a single `ChildSupervisor` `Context.Service` whose implementation is plain Node, using `Effect.acquireRelease` for the handle and `Effect.timeout` for the grace windows. That removes the duplication and the manual `dispose()` without importing an unverified spawner.

**Evidence.** `8be0e408` *"guarantee exit marker for visible children that die abnormally"*; `2bb0d469` (2026-09-01) *"settle child failures at close boundary"*; `backend-pi.test.ts:505` *"reports abort as interrupted"*, `:593` *"settles a no-child spawn error without waiting for close"*.

**LOC affected.** ~120 (dedupe) / ~300 (if `waitForTreeEmpty` also moves to `Effect.repeat`). **Effort: M. Risk: MED.**

---

### A7 — `mapWithConcurrencyLimit` → `Effect.forEach({ concurrency })`

**What it is.** `native-task-tool.ts:1068-1088`. A hand-rolled worker pool using **recursive `await runWorker()`** — one stack frame per item processed. `Promise.all(Array.from({ length: limit }, () => null).map(async () => runWorker()))`.

**Effect v4 replacement.** `Effect.forEach(items, fn, { concurrency: limit })` (`Effect.ts:1088`), one line. Documented short-circuit semantics; interruption propagates to in-flight workers, which the current version cannot do at all (a cancelled parent leaves `runWorker` recursions running to completion).

**LOC affected.** 21 → 1. **Effort: S. Risk: LOW.** Strictly a dependency of whichever slice migrates `native-task-tool`'s spawn path.

---

### A8 — `DeferredResultDelivery` outbox → `Queue` + typed errors

**What it is.** `subagents/delivery.ts:30-62` + its driver `subagents/index.ts:209-248`. An at-least-once outbox: `flush` deletes each entry only after `send` returns (`:47-52`), and `index.ts:209-228` retries **once** via `queueMicrotask(() => flush(false))`.

**Effect v4 replacement.** `Queue.unbounded` (`Queue.ts:611`) for the outbox; `Effect.retry(Schedule.recurs(1))` for the one-shot retry; `Schema.TaggedError` for the send failure so the `catch (error: unknown)` at `index.ts:223` — which currently needs an `oxlint-disable` for `anti-slop/no-unknown-parameters` (`:222`) — becomes a typed channel and the suppression disappears.

**Evidence.** `d169dbdd` (2026-07-19) *"survive session switches and dedupe sync-failure delivery"*; `c3c593a1` *"only consume manager-known ids on cancel"*. The `observedSettledIds`/`liveIds` prune dance at `index.ts:239-245` exists solely to bound a mirror set that a queue would not need.

**LOC affected.** ~110. **Effort: S. Risk: LOW-MED** — but note the ordering coupling to `manager.consumedIds` (`manager.ts:169`, read at `index.ts:234`), which is a public field.

---

## 3. What must stay plain TypeScript

1. **Pi tool `execute` callbacks and `pi.on(...)` handlers.** `subagents/tools.ts:151`, `:246`; `terminal-tools.ts:334+`; `manager-bridge.ts:650-657`; `background-task-tool.ts`. `AGENTS.md` is explicit that `ctx.ui.*` must be called inside an event handler, and Pi's `tool_call` gate at `manager-bridge.ts:651-656` returns `{ block, reason }` **synchronously**. Effect types must not cross this line (plan 110's contract, and repo convention). These stay `async (…) => { … await runtime.runPromise(…) }`.

2. **The whole of `task-store.ts` and `activity/persistence.ts`.** They are *deliberately synchronous* (`task-store.ts:747-754`, `:908`; `persistence.ts:440-483` uses `sleepSync`). The invariant "one authoritative decision per mutation, inside the lock" (`task-manager.ts:1892-1898`) is only sound because no continuation can interleave. Wrapping this in Effect either (a) forces `Effect.runSync`, which buys nothing and forbids any `Clock` use, or (b) introduces async suspension inside the lock, which is a *correctness regression*. Leave it; expose it as a `TaskStore` service whose methods return plain values.

3. **`process-tree.ts` identity primitives.** `captureProcessStartTime`, `positivePidStatus`, `posixGroupEmpty`, `listPosixGroupMembers` (`:71-215`) are `execFileSync`/`process.kill(pid, 0)` calls used as synchronous predicates inside decision sequences (`task-manager.ts:864`, `:889`, `:1817`). Effect adds nothing; the risk of accidentally introducing a suspension between "verify identity" and "signal" is real (`process-tree.ts:339-352` re-verifies immediately before the boundary *by design*).

4. **`git/worktree.ts` sync arm.** `gitSync`/`gitOkSync` (`:81-97`) exist because worktree creation is invoked from synchronous validation paths. The async arm (`git`/`gitOk`, `:63-79`) can become Effect; the sync arm cannot without changing callers.

5. **`executable-provenance.ts` (25 lines).** Pure, synchronous, `Object.freeze`d. No effects. Leave it.

6. **`backend-pi.ts` payload budget & event mapping.** `PiRunPayloadBudget` (`:270-365`) and `mapPiEvent` (`:367-415`) are pure byte-accounting on a per-line hot path (every stdout chunk of every child). Effect generators here are pure overhead. Keep them plain; call them from inside an Effect if the surrounding stream moves.

7. **`JsonLineDecoder` / `BoundedUtf8Tail` consumers** (`backend-pi.ts:648-664`). Node stream `data` listeners at ~kHz. Do not wrap per-chunk work in `Effect.sync`.

8. **`node-pty` and the integration harness.** `test/integration/harness-supervisor.ts` / `spawn-pi-pty.ts` (per `AGENTS.md`) own real PTY process groups and a zero-survivor audit. Effect interruption does not kill a PTY child; explicit signalling is required. Leave supervision explicit.

---

## 4. Boundary design

### 4.1 Runtime placement

**One `ManagedRuntime` per process, created lazily, owned by the extension install.**

```ts
// src/effect/runtime.ts  (new)
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined;
export const lifecycleRuntime = () => (runtime ??= ManagedRuntime.make(LifecycleLayer));
export const disposeLifecycleRuntime = () => { void runtime?.dispose(); runtime = undefined; };
```

`ManagedRuntime.make(layer)` is verified at `ManagedRuntime.ts:285`; the returned object exposes `runFork`, `runPromise`, `runSync`, `dispose`. It "owns the scope for resources acquired by the layer" (`:98-104`), so `disposeLifecycleRuntime()` in `session_shutdown` replaces `manager.disposeAll()` + `bridge.dispose()` + `store.dispose()` + `coordinator.dispose()`.

**Lazy is mandatory, not stylistic.** Plan 117 ships a native executable whose editor-ready is 182 ms and command-ready 1,008 ms. `dist/Effect.js` alone is 251 kB of ESM; a minimal lifecycle graph (Effect + Layer + Scope + Semaphore + Queue + Deferred + Ref + Schedule + Fiber + FiberMap + Context + Cause + Duration + ManagedRuntime + `internal/`) is ≈ 800 kB, and adding `Stream` + `PubSub` pushes it past 1 MB. Under `scripts/build-extension.mjs:24` (`packages: "external"`) **none of that is tree-shaken** — it is resolved and parsed at runtime. Gate every Effect import behind a dynamic `await import()` on the first subagent/terminal use, and add a startup-path assertion to CI.

### 4.2 Adapter shape — no Effect types in public interfaces

Keep the *exact* existing public surfaces. `SubagentManager` keeps `spawn(): Promise<SubagentSnapshot | AtCapacityDetails>`, `waitFor(ids, signal?): Promise<…>`, `cancel(ids): Promise<string[]>`, `addChangeListener(fn): () => void`, `disposeAll(): void`. Internally each becomes a thin `runPromise` shim:

```ts
public cancel(ids: readonly string[]): Promise<string[]> {
  return this.runtime.runPromise(Lifecycle.cancel(ids));
}
```

Three edge rules:
- **`AbortSignal` in → interruption.** `waitFor(ids, signal)` and `wait(ids, …, signal)` accept a caller `AbortSignal`. Bridge it once: `Effect.race(work, Effect.callback(cb => { signal.addEventListener("abort", …) }))`. `Effect.callback` is at `Effect.ts:1667`; `Effect.race` at `:8836`.
- **Synchronous returns stay synchronous.** `claimPending`, `acknowledge`, `getClaimRetryDelay`, `list`, `get`, `check`, `isIndexReady` must not become async — `terminal-tools.ts:252-306` calls them from a synchronous flush inside a Pi handler. Either leave them out of the Effect world or expose them via `runtime.runSync` over effects that provably never suspend.
- **Errors do not leak `Cause`.** Convert at the boundary: `Effect.catchTag` (`Effect.ts:4370`) → the existing `Error`/result-object shapes the tools already return (`tools.ts:162`, `:171`, `:222`).

### 4.3 `effect/unstable/process` verdict

**Do not adopt in this domain.** Reasons in §2/A6. Concretely: the Node implementation lives in `@effect/platform-node` (not in rc.112's tarball, so `kill` group semantics are unverifiable), and `ChildProcessHandle` has no process-identity/start-time anchor, which is the foundation of `process-tree.ts`. Keep `node:child_process` behind a `ChildSupervisor` service. Re-evaluate only if `@effect/platform-node` is verified to send `SIGTERM` to `-pid` for `detached` commands.

### 4.4 Anti-slop / lint

`tools/oxlint/anti-slop/effect/` already ships an Effect plugin (`no-service-constructor-imports`) that is **not enabled** in `oxlint.config.ts:23-41`. Enabling it is a prerequisite, not a follow-up. Separately, the comment at `oxlint.config.ts:32-34` ("Schema-free codebase: Pi/RPC payloads are decoded by hand-rolled boundary parsers") is what permits `allowInTypeGuards` on `no-runtime-typeof`; adopting `Schema` for the *internal* domain types would let that allowance narrow over time — but Pi boundary decoding must stay hand-rolled (`typebox` is the peer-dep contract with Pi's `registerTool`).

---

## 5. Service / Layer map

Naming follows the `ai-docs` convention (`"<package>/<dir>/<Service>"`, `AGENTS.md` §Context.Service).

| Service | Id | Interface (sketch) | Implementation module |
|---|---|---|---|
| `Git` | `sumocode/git/Git` | `read(cwd, args): Effect<string \| undefined>`; `revParse`, `status`, `diff` | `src/git/worktree.ts` async arm (`:63-79`) + `manager.ts:79-98` (`gitRead`, `captureGitContext`) |
| `WorktreeStore` | `sumocode/git/WorktreeStore` | `create(opts): Effect<CreateWorktreeResult, WorktreeError>`; `resolveBaseRef(path)` | `src/git/worktree.ts` (`createWorktree`, `resolveCreateOptions`) |
| `TerminalHost` | `sumocode/terminal-host/TerminalHost` | `startAgentPane`, `closePane`, `openExistingWorktreeWorkspace`, `kind` | `src/terminal-host/herdr.ts` — already an interface (`src/terminal-host/types.ts`), so this is a wrapper, not a rewrite |
| `ChildSupervisor` | `sumocode/subagents/ChildSupervisor` | `spawn(cmd, args, opts): Effect<Handle, SpawnError, Scope>`; `Handle.exit`, `Handle.interrupt` (group-signalling) | new; absorbs `backend-pi.ts:425-483` **and** `native-task-tool.ts:709-742` |
| `ProcessTree` | `sumocode/background-tasks/ProcessTree` | mirrors `ProcessTreeOperations` (`process-tree.ts:29-41`) — **already a dependency-injected interface** | `process-tree.ts:299` `systemProcessTree` |
| `TaskStore` | `sumocode/background-tasks/TaskStore` | synchronous methods returned as plain values; `Effect` only for `refreshIndex` | `src/background-tasks/task-store.ts` (unchanged) |
| `SubagentRegistry` | `sumocode/subagents/SubagentRegistry` | `SubscriptionRef<Map<id, Snapshot>>` + `Deferred` per settle + `Queue` for the pending queue | new; the state half of `manager.ts:143-169` |
| `SubagentBackend` | `sumocode/subagents/SubagentBackend` | `spawn(task): Effect<Stream<SubagentEvent>, …, Scope>` | `backend-pi.ts` / `backend-pane.ts` behind one tag (the `BackendFactory` seam at `manager.ts:52` already exists) |
| `ActivityPublisher` | `sumocode/activity/ActivityPublisher` | `publish(owner, snapshot): Effect<void, PublishError>` | `src/activity/feed-publisher.ts` |
| `Clock` | (built-in `effect` `Clock`) | `Clock.currentTimeMillis` (`Clock.ts:265`) | replaces the six injected `now: () => number` options (`task-manager.ts:568`, `manager-bridge.ts:203`, `store.ts:187`, `feed-publisher`, `persistence`) and unlocks `TestClock` (`src/testing/TestClock.ts:436`) |

**Layer composition.** `LifecycleLayer = SubagentRegistry.layer.pipe(Layer.provide(Layer.mergeAll(Git.layer, WorktreeStore.layer, TerminalHost.layer, ChildSupervisor.layer, SubagentBackend.layer)))`, with `TaskStore`/`ProcessTree`/`ActivityPublisher` merged in for the terminal half. Test layers substitute at the same tags, replacing today's ~10 optional constructor fields (`SubagentManagerDependencies` at `manager.ts:67-77`; `TerminalTaskManagerOptions` at `:507-523`).

**Note on `Clock`:** this is the single highest-leverage service. Five classes inject a `now` function purely for testability, and `manager-bridge.ts:192` carries an explicit warning that *"Date.now can move, so this is only a throttle, not a monotonic timer"*. Effect's `Clock` plus `TestClock.adjust` (`TestClock.ts:507`) makes every backoff/debounce/poll test deterministic without a fake-timer library.

---

## 6. Slice order

Each slice ships green behind the existing public interface, with the existing test file as the parity oracle. No slice removes a test.

| # | Slice | Files | Oracle | Depends on |
|---|---|---|---|---|
| **0** | Infrastructure: pin `effect@4.0.0-rc.112` exact (devDep first, promoted to `dependencies` at slice 2), enable `anti-slop/no-service-constructor-imports` in `oxlint.config.ts`, add `src/effect/runtime.ts` (lazy `ManagedRuntime`), add a CI assertion that the startup path imports no Effect module. | `package.json`, `oxlint.config.ts`, `src/effect/runtime.ts` | `pnpm exec tsc --noEmit && pnpm build && pnpm test`; plan-117 startup benchmark unchanged | — |
| **1** | `Clock` + `Git` + `ProcessTree` services. Pure extraction: no behaviour change, no Effect in any public signature. Delete the five injected `now` options in favour of `Clock`. | `src/git/worktree.ts`, `src/background-tasks/process-tree.ts`, new `src/effect/services/*` | existing `worktree.test.ts`, `process-tree.test.ts` | 0 |
| **2** | **A5** — `backend-pane` steering acks → `Deferred` + one scoped poll fiber. Smallest real slice; proves the `runPromise` edge and the `Scope` teardown story. | `src/subagents/backend-pane.ts` | `backend-pane.test.ts` (4 race tests at `:612`, `:671`, `:709`, `:756`) | 1 |
| **3** | **A7** — `mapWithConcurrencyLimit` → `Effect.forEach({ concurrency })`. One-line, proves interruption propagation into the task fan-out. | `src/native-task-tool.ts` | `native-task-tool` suites | 2 |
| **4** | **A2** — both backoff state machines → one `Schedule`. Two independent sub-slices (task-manager, then manager-bridge) so they can land separately. | `src/background-tasks/task-manager.ts`, `src/activity/manager-bridge.ts` | `task-manager.test.ts:926`, `manager-bridge.test.ts` backoff cases | 1 (needs `Clock`) |
| **5** | **A6** — unify the two `attachAbortSignal` copies behind `ChildSupervisor` (still `node:child_process`). Move `waitForTreeEmpty` to `Effect.repeat`. | `src/subagents/backend-pi.ts`, `src/native-task-tool.ts`, `src/background-tasks/process-tree.ts` | `backend-pi.test.ts`, `process-tree.test.ts`, **plus `pnpm test:integration` zero-survivor audit** | 1, 3 |
| **6** | **A1** — `SubagentManager` core. The big one. Sub-slice it: (6a) `Deferred` settlement + `Effect.timeout` manifest; (6b) `Semaphore` + `Queue` for visible-spawn/dequeue; (6c) `SubscriptionRef` + `FiberMap` for snapshots/children; (6d) delete `lifecycleGeneration` in favour of `Scope`. | `src/subagents/manager.ts` | `manager.test.ts` (1,225 lines) unchanged, plus `subagents/index.test.ts` | 2, 5 |
| **7** | **A8** — delivery outbox → `Queue` + `Schema.TaggedError`; drop the `oxlint-disable` at `index.ts:222`. | `src/subagents/delivery.ts`, `src/subagents/index.ts` | `delivery.test.ts`, `index.test.ts` | 6 |
| **8** | **A3** — remaining timer forest → `Scope`-owned fibers (`activity/store.ts`, `manager-bridge.ts` polls). | `src/activity/store.ts`, `src/activity/manager-bridge.ts` | `store.test.ts`, `manager-bridge.test.ts:1841` | 4 |
| **9** | **A4** — refresh batching → `SubscriptionRef`/`PubSub`. Highest risk; do last, only if 0–8 are clean. | `src/background-tasks/task-manager.ts`, consumers | `task-manager.test.ts` (3,293 lines), `terminal-tools.test.ts`, `manager-bridge.test.ts` | 4, 8 |

**Gate between every slice:** `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test`, plus `pnpm test:integration` for slices 5, 6, 9. Slice 0's startup benchmark must be re-run at slices 2, 6, and 9 — that is where the Effect graph actually widens.

**What changes vs plan 110.** Plan 110 assumed (a) a contained `src/spike/` prototype with *no production import*, (b) devDependency-only pinning, (c) "stable core only, no `effect/unstable/*`". (a) and (b) are superseded — this is production adoption, so `effect` moves to `dependencies` (it is **not** Pi-bundled, so `AGENTS.md`'s peer-only rule does not apply). (c) survives and should be kept: this analysis independently reaches the same conclusion for `effect/unstable/process` (§4.3). Plan 110's Step 2 contract matrix (capacity/queue FIFO, visible serialization, setup cancellation generation, settle de-dup, async event failure, manifest timeout, wait abort, batch cancel/close, listener ordering, pruning, finalization) remains the right acceptance oracle for slice 6 — but it should be run against `manager.test.ts` directly rather than a spike-local duplicate, since the campaign no longer maintains two implementations. Plan 110's STOP condition *"Effect imports enter normal startup despite no subagent use"* should be promoted to a permanent CI assertion (slice 0).

---

## 7. Where Effect will NOT help — or will hurt

**1. Double-runtime coexistence is the dominant cost, and it lasts nine slices.** During slices 2–9, `SubagentManager` and `TerminalTaskManager` will each be half Effect and half imperative, wired together by `runPromise` calls in both directions. `manager.ts:376` (`consumeEvents`) hands a backend's async iterator to a fire-and-forget `void consume().catch(...)`; `manager.ts:731` calls `void this.startSettle(...)` from a synchronous `fold`. Every one of those becomes a `runFork` whose failure lands in Effect's default logger rather than the existing `onDiagnostic` seam (`manager.ts:76`) — unless each is explicitly re-routed. Budget for that, and for the period where a bug can be in either world.

**2. `unref()` has no Effect equivalent, and this codebase depends on it.** Eleven timers call `.unref?.()` (`manager-bridge.ts:249`, `:471`, `:616`, `:628`; `task-manager.ts:802`, `:1274`, `:1474`; `store.ts:343`, `:369`; `terminal-tools.ts:324`; `backend-pane.ts:408`, `:462`; `process-tree.ts:372`; `backend-pi.ts:464`). An Effect fiber sleeping on `Schedule.spaced` holds the Node event loop open. `ChildProcessHandle.unref` exists (`ChildProcessSpawner.ts:196`) but there is no fiber-level unref. Consequence: any Effect-owned poller must be interrupted at `session_shutdown`, or `sumocode --print` / non-TTY Pi modes will hang. This is a *real regression risk* in a repo whose `AGENTS.md` demands TTY-defensiveness, and it is exactly what the `pnpm test:integration` zero-survivor audit will catch — late.

**3. Interruption is cooperative; child processes are not.** `Effect.timeout` interrupting a fiber does **not** kill a `pi` subprocess or a herdr pane. `manager.ts:524-525` documents that `close` timing out must *never* force-settle, because "the pane stays genuinely running". `process-tree.ts:283-286` records a deliberate scope boundary: a command that calls `setsid` has left the managed group and following it "would require a cgroup/native process supervisor outside this plan's dependency contract". Effect changes none of that. Every kill remains explicit; the win is only that the *bookkeeping around* the kill (grace windows, escalation, finalizers) becomes structural.

**4. Generator overhead on hot paths.** `processLine` (`backend-pi.ts:625-647`) runs per JSON line of every child's stdout; `PiRunPayloadBudget.appendLive` (`:280-296`) runs per text delta. `handlePollTick` (`task-manager.ts:1478`) runs per running task per poll interval. `Effect.gen` allocates a generator + fiber-step per `yield*`. Keep these plain (§3.6, §3.7) — and be suspicious of any slice that wraps a per-chunk callback.

**5. Startup and dependency weight, against a budget that was just fought for.** Plan 117 moved editor-ready from 549 → 182 ms and command-ready from 2,199 → 1,008 ms. `dist/Effect.js` is 251 kB; the realistic lifecycle graph is ≈ 800 kB–1 MB of externally-resolved ESM. `effect` also carries two runtime `dependencies` (`fast-check`, `msgpackr`) — verified not statically imported by `Schema`/`Effect` (`internal/schema/toArbitrary.ts:13` is `import type`), but they *are* installed for every consumer of a repo that is public MIT with a deliberately thin dependency list (currently three prod deps). Lazy-import discipline (§4.1) is the mitigation, but it is discipline, not a guarantee — one careless top-level `import { Effect } from "effect"` in `src/extension.ts`'s load order regresses the whole campaign silently.

**6. Debuggability trade is genuinely two-sided.** `Effect.fn("name")` gives named spans and better traces than today's anonymous `void promise.catch(...)`. But Effect's `Cause` output is dense, and the existing failure story is already *very* good: structured diagnostics with a typed `kind` (`manager.ts:62-65`, `task-manager.ts:2113-2115`), nested try/catch so diagnostics cannot re-enter a contained failure (`manager.ts:704-708`), and JSONL diagnostics summarised by `sumocode diag`. Effect's default logger must be wired to that same sink or the operator experience *regresses*.

**7. AI-agent authorship risk is the quiet one.** This repo is written largely by agents under a strict anti-slop lint. Effect v4 is release-candidate software with a *changed* API surface from Effect 3 (`Schedule.min` instead of `Schedule.either`, `Effect.catch` instead of `catchAll`, `Result` instead of `Either`, `effect/unstable/*` namespacing). Any agent writing this code from Effect-3 memory will produce plausible, non-compiling, or worse *subtly-different* code — `Schedule.union` vs `Schedule.min` have inverted continue-semantics. Mitigation: vendor `/tmp/effect-rc/package/AGENTS.md` + `ai-docs/` into the repo (or pin the exact version and require agents to grep it), and enable the Effect anti-slop rules at slice 0.

**8. Where Effect is simply not the answer.** The three hardest correctness problems in this domain — cross-process durable CAS with ABA-safe file leases (`persistence.ts:412-483`), process identity verification across restarts (`process-tree.ts:181-215`, `:318-329`), and the "incomplete generation" freshness model (`task-manager.ts:1120-1140`) — are *distributed-systems* problems, not concurrency-primitive problems. Nine of the sixteen historical fix commits in §2 are in that category (`742c0afb` stale-lock ABA, `91203944` duplicate indexed ids, `dba5096d` index-membership gating, `94c358e6` owner re-verification, `5298c9b0` identity reservations across quarantine…). Effect would not have prevented a single one. Any pitch for this refactor that claims otherwise is overclaiming; the honest claim is that Effect removes the *in-memory* race class and lets the remaining effort concentrate on the durable one.
