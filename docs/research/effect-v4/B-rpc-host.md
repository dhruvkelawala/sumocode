# Track B — RPC host + Pi child supervision: Effect v4 adoption analysis

**Tree analysed:** `/tmp/sumocode-stack-tip` (PR-stack tip, includes plan 117's Bun-compiled native executable). Read-only.
**Effect version of record:** `effect@4.0.0-rc.112` at `/tmp/effect-rc/package` (`package.json` — `"type": "module"`, `"sideEffects": []`).
**Scope:** `src/sumo-tui/rpc/**`, `src/sumo-tui/runtime/**`, `src/sumo-tui/shell/**`, `src/native/**`, `src/child-protocol.ts`, `sumo-rpc-host.js`, `scripts/build-*.mjs`.

---

## 0. Verdict up front

This domain is the single best Effect candidate in SumoCode, and also the single most dangerous place to put Effect on the startup path.

Three facts dominate the design:

1. **The host has re-implemented Effect's runtime, badly, four times.** There are three separate request/response correlation maps with timeouts, four separate process-signal owners, two identical hydration quiet-loops, a hand-rolled fiber-interruption mechanism (`generation` counters), and a hand-rolled reverse-order finalizer chain. Every one of these is a named Effect primitive.
2. **`effect` core in rc.112 ships no Node child-process implementation.** `ChildProcessSpawner` is a `Context.Service` interface only (`/tmp/effect-rc/package/src/unstable/process/ChildProcessSpawner.ts:252-295`); the implementation comes from `@effect/platform-node`'s `NodeServices.layer` (`ai-docs/src/60_child-process/10_working-with-child-processes.ts:6,101`), a **separate npm package not present in this rc tarball**. Same for `NodeRuntime.runMain` / `BunRuntime.runMain` (`ai-docs/src/01_effect/06_running/10_run-main.ts:5-6`). Version-compat with `4.0.0-rc.112` is unverified and is a hard gate on slices 5+.
3. **`runMain` installs its own SIGINT/SIGTERM handlers** (`ai-docs/src/01_effect/06_running/10_run-main.ts:22-23`). SumoCode's most delicate invariant is a hand-choreographed *transfer* of SIGINT/SIGTERM ownership from the pre-spawn entry to the host at child-adoption time (`sumo-rpc-host.js:183-184,286`; `src/sumo-tui/rpc/host.ts:1783-1790`; twelve integration tests pin it). `runMain` cannot own signals here without rewriting that protocol. This is the reason the entry point must **not** be the first thing migrated.

Recommendation in one line: **do plan 111's plain-TS lifecycle seam first as the contract oracle, then migrate inward-out (client/protocol → schedulers/gates → lifecycle), and leave `src/native/main.ts` / `sumo-rpc-host.js` / the pre-spawn + signal-ownership dance in plain TypeScript indefinitely.**

> **Read Appendix A before writing any migration code.** rc.112 renamed or removed a dozen APIs that Effect-3 muscle memory will reach for — `Effect.fork`, `Effect.disconnect`, `Layer.scoped`, `Effect.Service`, `Schema.parseJson`, `Schema.decodeUnknown`, `Stream.async`, `Schedule.intersect`, `Effect.makeLatch`, and the whole `unsafeX` → `xUnsafe` convention. Every claim in this report was verified against `/tmp/effect-rc/package/src/**`.

---

## 1. Inventory of hand-rolled mechanisms

### 1.0 Churn, as a proxy for where the bugs live

Commits touching each in-scope path (repo at `99b8cc4d`, 1319 commits total):

| Path | commits |
|---|---|
| `src/sumo-tui/rpc/**` | 206 |
| `test/integration/**` | 151 |
| **`bin/sumocode.sh`** | **57** |
| `src/sumo-tui/runtime/**` | 41 |
| `src/native/**` | 16 |
| `sumo-rpc-host.js` | 10 |
| `src/sumo-tui/shell/**` | 8 |
| `src/child-protocol.ts` | 6 |

A bash script has more commits than the entire native launcher + runtime + shell layers combined, and nearly all of them are `fix(launcher)` / `fix(reload)`. **Process supervision is the single most-repaired seam in the codebase.** A grep for `TODO|FIXME|HACK|XXX` across all in-scope paths returns *zero* real hits — this codebase parks async problems in 6–15-line prose doc-comments on the mechanism (`client.ts:90-110`, `:216-224`, `:419-431`; `host.ts:1071-1077`; `runtime.ts:555-575`), not in comment markers. Those comment blocks are the TODO list.

`git log --grep=deadlock` returns **zero** results. Everything else clusters into: child exit/reaping (13 commits), reload/handoff (20), readiness/hydration (14), interrupt ordering (8), queue/scheduler races (8), terminal mode restoration (12), stale observers/idempotency (14), test flake (7).

### 1.1 Child process spawn / adoption / reload / kill — **three implementations of the same protocol**

| Where | Lines | What it does |
|---|---|---|
| `sumo-rpc-host.js:180-204` | 25 | Node entry: pre-spawns Pi *before* importing the host, installs early SIGINT/SIGTERM, stamps async spawn errors onto the child via `Symbol.for("sumocode.rpc.preSpawnError")` (`:196-198`) |
| `src/native/main.ts:963-984` | 22 | Native entry: byte-for-byte the same protocol, `Reflect.set(preSpawnedChild, preSpawnErrorSymbol, error)` (`:976-978`) |
| `src/sumo-tui/rpc/client.ts:192-307` | 116 | `SumoRpcClient.start()`: adopts either a pre-spawned child or spawns its own, attaches 7 listeners, reads back the stamped pre-spawn error (`:266-279`), then a 50 ms spawn-establishment gate (`:292-305`) |

Kill/reap sequences, also triplicated:
- `sumo-rpc-host.js:119-133` `terminateUnadoptedChild()` — SIGTERM → 250 ms → SIGKILL → 250 ms.
- `src/native/main.ts:663-677` — identical.
- `src/sumo-tui/rpc/client.ts:309-335` `stop()` — `stdin.end()` → SIGTERM → `Promise.race([once(exit), 2000 ms])` → SIGKILL → `waitForChildClose` (which is itself a fourth timeout, `:98-111`).
- `src/sumo-tui/rpc/client.ts:486-492` `terminateChild()` — a *fifth* SIGTERM→SIGKILL escalation for the crash path.

Exit-boundary reconciliation is hand-rolled state: `exited` / `exitNotified` / `rpcReadyNotified` flags (`client.ts:145,150,151`), `exit`-precedes-`close` handling with a 1 s `closeFallback` timer (`client.ts:243-257`), and a comment explaining that pipe-holding *descendants* can prevent `close` forever (`client.ts:253-255`).

The reload handoff is a fourth process-lifecycle protocol: exit code 100 propagated through `RpcChildExitError` (`client.ts:43-53`), `createRpcExitHandler` (`host.ts:683-714`), `preserveTerminal` on `runtime.stop` (`host.ts:1714`), a `SUMOCODE_RELOAD_READY_FILE` handshake file written from **three** places (`host.ts:1721`, `host.ts:1869`, `sumo-rpc-host.js:146`), and an out-of-band exit-code file because bash 3.2's `wait` lies (`host.ts:272-306`).

### 1.2 stdout framing / decoding

- `src/child-protocol.ts:197-283` — `JsonLineDecoder`: byte-level newline scan (`indexOf(0x0a)`), doubling `Buffer.allocUnsafe` with a 64 KiB retained-capacity shrink (`:260-268,273`), two independent byte caps (`CHILD_JSON_FRAME_MAX_BYTES` 8 MiB, `CHILD_UNTERMINATED_MAX_BYTES` 8 MiB, `:8-10`), UTF-8-safe head decode that never splits a codepoint (`:43-53`).
- `src/child-protocol.ts:124-173` — `BoundedUtf8Tail`: a fixed 64 KiB ring buffer for stderr that never splits a codepoint.
- Wiring: `client.ts:205-215` — `child.stdout.on("data", chunk => this.stdoutFrames?.write(chunk))`, fully synchronous, no backpressure.

### 1.3 Request/response correlation — **three independent copies**

| Copy | Lines | Timeout mechanism |
|---|---|---|
| `client.ts:146,337-357` — `pending: Map<string, PendingRequest>` | 21 | per-request `setTimeout`, default 30 s, cleared in 4 places (`:352,400,497`, plus `:344`) |
| `chrome-cache-worker-client.ts:75,109-117` — `pending: Map<number, resolve>` | 9 | **none** — a lost worker reply resolves `undefined` only via `settlePending()` on error/exit (`:177-180`) |
| `pi-compat/tree-navigation-command.ts:265-292` — `waiters: Map<string, {resolve,reject,timer}>` | 28 | per-request `setTimeout`, 20 min (`controls.ts:47`) |

All three re-implement: id allocation, map insert, timer arm, timer clear on resolve, bulk-reject on teardown. `client.ts:494-500` `rejectPending`, `chrome-cache-worker-client.ts:177-180` `settlePending`, `tree-navigation-command.ts:288-292` `cancel`.

### 1.4 Readiness state machines

Four distinct readiness concepts, four distinct mechanisms:

- **editor-ready** — a once-flag + diagnostic emit, `runtime.ts:333-345` (`editorReadyMarked`), reached either from cold start (`runtime.ts:404`) or from a reload adopting a predecessor's painted frame (`host.ts:1862`).
- **stable-chrome-ready / command-ready** — two more once-flags, `runtime.ts:411-431` (`chromeStableMarked`, `commandReadyMarked`), each silently dropped if `!this.shell` (tested: `runtime.test.ts:672` *"drops command_ready silently before start() and still emits it once after"*).
- **initial-hydration gate** — `host.ts:1150-1153` builds a bare `Promise<void>` with an escaping `resolve` (`let releaseInitialHydration!: () => void`), consumed by `InitialHydrationActionGate` (`initial-hydration-action-gate.ts:16-63`), which keeps one *latest intent per action key* in a `Map`, re-drains in a `while (this.pending.size > 0)` loop (`:25-35`), then flips `ready`. This is a `Latch` + a keyed `FiberMap`, hand-built.
- **child-side terminal-index gate** — a filesystem file written with `flag: "wx"` from the gate's `onReady` (`host.ts:1157-1176`), polled by the RPC child. Failure is swallowed by `catch {}` at `host.ts:1175`, with a comment noting the child otherwise strands on a 30 s fallback.

Plus **two byte-identical hydration quiet-loops** — `host.ts:1355-1376` (session change) and `host.ts:1918-1936` (initial boot): both are `for (attempt < 4) { markHydrationBarrier(); refreshState(); readMessages(); if (!hasEventsAfterHydrationBarrier) break; }`. A third variant exists as an extracted pure function, `hydrateSameSessionTreeNavigation` (`host.ts:188-212`). Backing them: `RpcSessionEventBuffer` (`host.ts:343-401`), a three-watermark event replay buffer (`replayStart`, `failureReplayStart`, `active`).

### 1.5 Prompt scheduling — a hand-rolled fiber-interruption mechanism

`prompt-scheduler.ts:97-390`. State: `queue`, `busy`, `dispatching`, `pausedAfterFailure`, `sessionId`, **`generation`**, `agentStartCount`, `agentSettledCount`, `turnEndCount`, `piSteeringQueue`, and a 6-field `forceSteerState` record (`:108-116`).

`generation` is the giveaway. `dispatch()` checks `generation !== this.generation` at **three** points — before start (`:329`), after the await (`:339`), and in the catch (`:349`) — and again in `finally` (`:378`). `rebindSession` (`:249-259`) and `restoreAll({discardInFlight})` (`:238-244`) bump it. That is precisely `Fiber.interrupt` + `FiberHandle.set` re-entrancy, written by hand. It has a named test for the case it still gets subtly wrong: `prompt-scheduler.test.ts:736` *"does not claim a force-send entry was restored when generation invalidation races its outcome"*.

### 1.6 Interrupt handling

Pure decision function `interrupt.ts:21-38` (good — keep it). Impure wiring `host.ts:756-831`: `armedQuitUntil` timestamp arithmetic (`:826`), a canonical-ESC replay trick to reuse the tier logic from the editor's `app.interrupt` action (`host.ts:1772`), and `void notifyOnError(...)` fire-and-forget for the abort branch (`host.ts:812-815`).

The `submitInFlight` field (`host.ts:735-741,1765`) exists because of `fe6cf058` — **two sources of truth for one lifecycle state, updated out of order.** `onBeforeSend` painted a synthetic `isStreaming: true` into `runtime.update` but *never into the `stateStore` the interrupt decision reads*, so in the submit→`agent_start` window a double Ctrl-C read `isStreaming: false`, armed quit, and **exited the app instead of aborting**. Worse, a send *failure* left the fake streaming state stuck until the next 5 s stats poll. Same commit also fixed Esc aborting a stream while the autocomplete dropdown was open. Tests: `host.test.ts:686` *"treats the submit-in-flight window as streaming: double Ctrl-C aborts instead of quitting"*, `:724` *"falls back to arm-quit/quit once submitInFlight clears"*; `interrupt.test.ts:43` *"passes Escape to the editor when the autocomplete dropdown is open, even while streaming"*.

### 1.7 Timers — 21 production sites

`client.ts:108,250,297,324,342,489`; `git.ts:34`; `host.ts:133,223,684,1034,1399,1734,1809,1820,1972`; `chrome-cache-worker-client.ts:47`; `chrome-cache-worker.ts:62,105`; `shell-adapter.ts:557`; `frame-scheduler.ts:21-22`. Eleven need `.unref?.()` (`client.ts:251,490`, `git.ts:35`, `host.ts:227,710,1040,1403`, …) because a referenced timer would hold the process open past terminal restoration — `git.ts:31-34` documents this explicitly ("execFile's own `timeout` option installs a REFERENCED timer"). Three (`host.ts:1809,1820`; `sumo-rpc-host.js:25`) are **test-only delay seams shipped in production code** guarded by `NODE_ENV === "test"`.

Coalescing is hand-rolled twice: `scheduleChromeCacheState` (`host.ts:1029-1041`, `setImmediate` + pending slot) with a matching `flushChromeCacheState` drain loop (`host.ts:1042-1055`), and `RpcHostRuntime.scheduleRender` (`runtime.ts:576-583`, microtask + `renderScheduled` flag).

### 1.8 Terminal mode restoration — the cleanup byte string exists in three copies

`terminal-controller.ts:69-76` `TERMINAL_CLEANUP_SEQUENCE`, `sumo-rpc-host.js:74-82` `RELOAD_FALLBACK_TERMINAL_CLEANUP`, `src/native/main.ts:34-42` again. A test compares them for drift (per the comments at `sumo-rpc-host.js:72-73`). The owner, `TerminalSessionOwner` (`terminal-controller.ts:135+`), is a duplicate-suppressing state machine (`altscreenActive`, `mouseSGREnabled`, `backgroundPainted`, `cursorColorOverridden`, `restored`, `terminalUnavailable`).

Restoration is triggered from **six** places: `runtime.stop()` (`runtime.ts:544`), `LifecycleRuntime.restoreTerminal()` on 4 exit signals + `exit` + `uncaughtException` (`lifecycle.ts:229-241,269-287`), the reload-window branch in `host.stop` (`host.ts:1715-1719`), `sumo-rpc-host.js:140-148`, `native/main.ts` `restoreFailedReloadTerminal`, and SIGTSTP/SIGCONT (`lifecycle.ts:289-323`).

### 1.9 Signal handling — four owners with hand-choreographed handoff

1. `sumo-rpc-host.js:183-184` / `native/main.ts:966-967` — early entry owners, installed **before** spawn.
2. `host.ts:1783-1790` `adoptChildAndArmHostSignals` — arms host handlers, *then* calls `onPreSpawnedChildAdopted` which removes the entry's (`sumo-rpc-host.js:286`). The comment at `host.ts:1784-1785` states the ordering requirement.
3. `host.ts:1777-1782` `handleHostSignal` with a `handlingHostSignal` re-entrancy guard, removed in `finally` (`host.ts:1985-1988`).
4. `lifecycle.ts:219-242,269-323` — a **module-load-time global** (`lifecycle.ts:357-365`) installing SIGINT/SIGTERM/SIGHUP/SIGQUIT/SIGTSTP/SIGCONT/`exit`/`uncaughtException` re-raising handlers, stored on `globalThis["__sumoDefaultLifecycleRuntime"]`.

Plus `process.on("unhandledRejection")` and `process.once("uncaughtException")` sharing one handler (`host.ts:1069-1080`) — the comment at `:1071-1077` records that plan 025 shipped only the former and a sync throw from the event→render path left the terminal in raw mode.

### 1.10 Worker client

`chrome-cache-worker-client.ts:71-181`. Lazy `ensureWorker()` with two construction paths (native embedded entry vs `eval:true` jiti bootstrap, `:124-147`), `worker.unref()` (`:148`), three teardown listeners each with an identity re-check (`if (this.worker !== worker) return`, `:151,164,169`), and a `drainChromeCacheForShutdown` that races drain+dispose against a 2.5 s grace and then fires a second `void dispose()` (`:31-57`).

### 1.11 Retry / backoff

There is **no backoff anywhere**. Every retry is either a fixed 100 ms timer or a bounded attempt count:
- session hydration failure → fixed 100 ms `setTimeout`, unbounded repetitions (`host.ts:1396-1404`)
- tree-navigation recovery → fixed 100 ms, single-shot guarded by a timer-presence check (`host.ts:218-235`)
- hydration quiet-loops → `attempt < 4`, no delay (`host.ts:1355`, `:1918`, `:194`)
- tree-navigation quiet poll → 100 ms fixed, 300 attempts, 30 s deadline (`host.ts:105-107,141-161`)
- spawn-establishment → single 50 ms cap (`client.ts:297`)

### 1.12 Listener / event dispatch

`client.ts:147-148` — two `Set`s of callbacks. `dispatchEvent` (`client.ts:432-440`) runs each listener in its own `try/catch` and `console.error`s failures; the 12-line comment at `:419-431` documents that a synchronous throw here previously crashed the host. Unsubscribe is a returned closure (`client.ts:168-171,183-186`) and it is the caller's job to call it — `host.ts` stores exactly one (`unsubscribeActivityStore`, `:1013`) and drops the `onEvent`/`onExit` handles entirely, relying on process exit.

### 1.13 Error-swallowing catches

**105 `catch` sites** across the domain; **~72 are empty or `.catch(() => undefined)`**. Notable ones where swallowing hides a real failure mode:

| Site | What it hides |
|---|---|
| `host.ts:1387-1392` | The *entire* session-hydration failure. No error is logged; the only signal is the retry loop firing again. |
| `host.ts:1175` (`catch {}`) | Terminal-index gate write failure → the RPC child silently waits out a 30 s fallback |
| `host.ts:1904` | Chrome-cache read failure during startup |
| `host.ts:225` | Any tree-navigation retry failure |
| `host.ts:1426` | Tree-navigation reconcile failure |
| `client.ts:403` | `onRpcReady` observer throw |
| `chrome-cache-worker-client.ts:87,95` | Every worker read/write failure |
| `initial-hydration-action-gate.ts:31-33` | Every deferred-action failure ("Individual handlers own their own error reporting" — but `run()` at `:51-56` also `void action()`s the ready path) |
| `git.ts:98,117,132` | Every git failure |
| `session-reader.ts:94,169,206,275,305` | Every session-file read failure |
| `native/main.ts` × 14 | Kickoff-file, ready-file, exit-code-file, kill, and temp-file failures |

`notifyOnError` (`safe-send.ts:16-25`) is the *good* pattern — it at least surfaces to a toast — but it is used at only ~8 call sites.

### 1.14 Test infrastructure that exists purely to tame async nondeterminism

This is the strongest structural signal in the domain: **every layer grew its own bespoke async-taming apparatus.**

- **Four independent hand-rolled `deferred()` helpers**: `host.test.ts:58`, `prompt-scheduler.test.ts:10`, `controls.test.ts:34`, `runtime/worker-runtime.test.ts:4`.
- **Four independent hand-rolled microtask `flush()` helpers** (all `Promise.resolve().then(…)` chains): `host.test.ts:41`, `host-actions.test.ts:276`, `prompt-scheduler.test.ts:20`, `editor.test.ts:922`.
- **Thirteen distinct polling `waitFor` implementations**, one per file: `client.test.ts:28`, `host-actions.test.ts:308`, `editor.test.ts:148`, `spawn-pi-pty.ts:443,466`, `rpc-host-shell.test.ts:48,59,71`, `native-contract.test.ts:136,169,284,290`, `rpc-queued-message-undo.test.ts:53,66,148,221`, `harness-supervisor.ts:162,222`, …
- **`vi.useFakeTimers` at 15 sites**, driving production timing logic: `host.test.ts:347,1144,1179,1198,1215`; `client.test.ts:65,706`; `runtime.test.ts:1081,1186`; `shell-adapter.test.ts:916,989`; `extension-ui-responder.test.ts:63`; `frame-scheduler.test.ts:6,22,36,57`.
- **Residual naked sleeps in the integration lane**: `rpc-activity-cards.test.ts:115` is an **8-second `setTimeout`**; `rpc-queued-message-undo.test.ts` has seven fixed 250–300 ms sleeps (`:274,309,361,372,454,498,540`).
- The most telling one: `3de1fce6` *"await autocomplete render readiness"* — `waitForRenderedText` (`editor.test.ts:148`) polled 50× at 10 ms and then **silently returned the last stale render**, so an autocomplete-readiness regression would have passed green. It was rewritten to be event-driven off Pi's real `requestRender` with an `AbortSignal`.

Effect's `TestClock` (`effect/testing/TestClock`, `src/testing/TestClock.ts:436` `layer`, `:507` `adjust`) plus `Deferred`/`Latch` collapse the first three categories into library primitives. It does **not** help the PTY-level integration lane, where the nondeterminism is real processes.

---

## 2. Ranked candidates

Scoring: bug class removed × evidence strength ÷ (startup risk + migration risk).

### B1 — `SumoRpcClient` request/response + child lifecycle → `Deferred` + `FiberHandle` + `Scope`

- **What:** `client.ts:137-501` (365 LOC), plus the two other correlation maps (`chrome-cache-worker-client.ts:109-117`, `tree-navigation-command.ts:265-292`) collapsing onto one shared shape.
- **Effect v4 primitives:** `Deferred.make` / `Deferred.await` (`src/Deferred.ts:171`, `:1449` for `succeed`, `:1382` `isDoneUnsafe` for the sync-callback bridge); `Effect.timeout` (`src/Effect.ts:8293`) replacing the per-request `setTimeout`+clear-in-4-places; `Effect.acquireRelease` (`src/Effect.ts:12928`) for the child handle; `Effect.onInterrupt` (`:14227`) for the SIGTERM→SIGKILL escalation; `Effect.race` (`:8836`) for `stop()`'s exit-vs-grace; a `Map<string, Deferred>` closed over by the service, drained by a scope finalizer instead of `rejectPending`.
- **Bug class removed:** *timer/pending-map desynchronisation*. Today a `clearTimeout` must be paired with a `pending.delete` at 4 sites (`client.ts:344-345,352-353,399-400,497`) and a missed pairing leaks a timer that fires on a dead id. `Effect.timeout` makes the pairing structural. Second class: *double-teardown*. `exited`/`exitNotified` exist only to stop `handleExit` and `stop()` from both terminating and both rejecting (`client.ts:312-317,462-467`); a `Scope` finalizer runs exactly once by construction. Third: *no supervisor for an idle child*.
- **Historical evidence (each of these is one shipped fix):**
  - `4327ce60` *"notify and tear down RPC host when the child exits idle"* — child death was only observable by rejecting in-flight requests. Die while idle → no pending promise → **nothing observed it**: the host kept rendering against a corpse, modals/overlays dangled forever, and the 5 s `refreshStats` poll swallowed the "not running" error every tick. `exitNotified` was added purely so a deliberate `stop()` — whose own `once("exit")` still runs `handleExit` — didn't fire a spurious crash teardown.
  - `a92dba3b` *"guard child.stdin against the EPIPE unhandled-error window"* — no `error` listener on `child.stdin` at all; the `this.exited` guard only covers post-`exit`, not the window where the kernel pipe is closed but Node hasn't delivered `exit`. A fire-and-forget UI response could kill the host.
  - `a7db49e6` then `f6898ac5` — **two commits for one race.** The first moved teardown from `exit` to `close` because `exit` can precede the final stdout frame (the actual awaited response was being discarded). The second discovered that a grandchild holding the pipe means `close` never fires, and added the unref'd 1 s fallback timer. That is a hand-rolled `Effect.race(exit, close, timeout)`.
  - `7f0db7ba`, `2bb0d469`, `dfb9aa22`, `78ffa48e`, `7a6108d1`, `0cbc10f8` — the rest of the same seam.
  - Tests: `client.test.ts:152` *"transfers ownership after lifecycle listeners attach but before startup grace resolves"*, `:764` *"fires onExit exactly once when the child crashes while idle"*, `:811` *"does not fire onExit for a deliberate stop()"*, `:667` *"drains a final response between unexpected exit and stdio close"*, `:705` *"bounds an unexpected exit when stdio close never arrives"*, `:793` reload-100-vs-crash, `:833` post-destroy `sendUiResponse`.
- **LOC:** ~365 rewritten, ~40 net deleted (the three correlation maps become one). **Effort: L. Risk: HIGH** (it *is* the transport) — but the unit suite is 891 lines and behaviour-level.
- **Startup path:** ON. `client.start()` is awaited at `host.ts:1815`.

### B2 — Terminal modes + host teardown → `Scope` / `Effect.acquireRelease` finalizers

- **What:** the `stop` closure (`host.ts:1702-1741`, 40 LOC) ordering nine teardown steps by hand, plus `stopPromise` idempotency, plus the `finally` block's four `removeListener` calls (`host.ts:1985-1988`), plus `runtime.stop()`'s 8-step disposal (`runtime.ts:523-547`), plus `TerminalSessionOwner` (`terminal-controller.ts:135-419`).
- **Effect v4 primitives:** `Effect.acquireRelease` (`src/Effect.ts:12928`), `Effect.addFinalizer` (`:13112`), `Effect.scoped` (`:12815`), `Layer.effect` (`src/Layer.ts:1347`). Acquire = `startRetainedSession()`; release = `exitTerminal()` — the pair becomes lexically adjacent instead of 600 lines apart.
- **Bug class removed:** *terminal left in raw mode / altscreen after an abnormal exit*, and *cleanup ownership transferring mid-flight*. This is the codebase's single most-repaired class.
- **Historical evidence:**
  - `9371b8a4` *"close post-adoption cleanup gap"* — **child ownership transfers before `runtime` exists.** If the child died in that window `runtime?.stop()` was a no-op and the entry fallback no longer owned cleanup → terminal stranded in altscreen. The fix added the explicit `adoptRetainedSession(); exitTerminal()` branch now at `host.ts:1715-1719` — *plus a test-only env knob `SUMOCODE_TEST_POST_ADOPTION_DELAY_MS`* (`host.ts:1817-1822`) purely to widen the race window enough to test. A production knob existing only to make a window observable is the clearest possible marker that the window is otherwise unreachable.
  - `ce6d7ed6` *"keep interrupts live during hydration"* — a reload successor called `adoptRetainedTerminal()` but not `start()`, so the input listener was never attached: **Ctrl-C did nothing for the entire off-screen hydration window.** Fix extracted `startInput()` behind an `inputStarted` flag (`runtime.ts:319-327`), because `stop()` was otherwise removing a listener that was never added.
  - `50add7b4` *"drop terminal writes after restore"*, `b1e33773` *"pin defaultTerminalSessionOwner to globalThis"*, `8123bbb2` *"retire stale lifecycle observers"*, `cadef4ae` *"re-acquire raw mode on session_start"*, `b749b2d0`/`fc354dad`/`8dd04ec2`/`775b0a6b` (the reload-terminal saga) — six more.
  - Comments: `host.ts:1071-1077` (plan 025 shipped `unhandledRejection` only; a sync throw stranded the terminal); `lifecycle.ts:229-236` "Edge case 5.3"; `:279-283` "5.1"; `:296-301` "5.4" (Ctrl-Z).
  - Tests: `altscreen-cleanup.test.ts:16` *"exits altscreen, pops kitty keyboard, and shows cursor after SIGINT (EC-5.1)"*; `terminal-controller.test.ts:110` *"altscreen enter/cleanup pair is symmetric for keyboard modes"*, `:189` *"drops writes after exitTerminal so post-cleanup renders cannot leak into main screen"*, `:431` *"double cleanup is a no-op after the restored flag is set"*, `:441`; `lifecycle.test.ts:281` *"cleanup runs once even if called twice"*, `:144` *"registers process signal handlers exactly once"*; `runtime.test.ts:1387` *"shutdown after %s resets OSC background/cursor and terminal mode exactly once"*; `rpc-host-shell.test.ts:631`/`:667`/`:702`/`:765`.
- **LOC:** ~120 rewritten. **Effort: M. Risk: MEDIUM-HIGH** — the reload path deliberately *skips* restoration (`preserveTerminal`, `runtime.ts:531,544`), which is an "acquire, then hand ownership to a successor process" pattern with no direct Effect analogue. It has to be modelled as a finalizer that reads a mutable `Ref<"restore" | "hand-off">`.
- **Startup path:** acquisition is; teardown is not.

### B3 — `InitialHydrationActionGate` → `Latch` + `FiberMap`

- **What:** `initial-hydration-action-gate.ts:1-63` (63 LOC) + the escaping-resolve promise at `host.ts:1150-1153` + the 10 `hydrationActionGate.run(KEY, …)` call sites at `host.ts:1244-1256`.
- **Effect v4 primitives:** `Latch.make` (`src/Latch.ts:196`) with `Latch.await`, `latch.openUnsafe()` (`:75-79`, callable from sync code), and `latch.whenOpen(effect)` (`:110-116`) — `whenOpen` is *literally* this module's `run()`. Keyed latest-intent → `FiberMap` (`src/FiberMap.ts`) or a `Map<string, Effect>` drained by `Effect.forEach`.
- **Bug class removed:** *microtask-ordering bugs in a hand-rolled gate*. The `while (this.pending.size > 0)` re-drain at `:25-35` exists because an intent enqueued *during* the drain was lost. `run()` at `:51-56` branches on `this.ready` — a check-then-act race that `whenOpen` eliminates.
- **Historical evidence — a trilogy of three shipped fixes on one 63-line file:**
  - `79756268` *"distinguish editor and command readiness"* — "ready" was one undifferentiated concept; the editor accepts text at first paint, but a *submit* must wait for scheduler session ownership to rebind or the send is consumed by the pre-hydration scheduler generation.
  - `f9a37908` *"settle hydration gate before launch-seeded kickoff submit"* — **`releaseInitialHydration()` only resolves the promise; the gate publishes `isReady` on a *later microtask*.** So the seeded kickoff read `isReady === false` and printed "finishing startup · command queued" on *every* `sumocode "<prompt>"` launch. A pure microtask-ordering defect in a hand-built gate — exactly what `Latch` has defined semantics for.
  - `b3e0d432` *"report reload editor readiness before hydration"* — a *throwing advisory ready-observer could reject submit waiters after hydration had already settled*. The `catch {}` at `:39-42` is the scar.
  - Tests: `initial-hydration-action-gate.test.ts:5`, `:27` *"settles submit waiters when the ready observer throws"*, `:58` *"keeps only the latest inverse intent under a shared key"*, `:74`, `:100`; `host.test.ts:127` *"notifies immediately and dispatches pre-ready text exactly once"*, `:155` *"keeps quit immediate and silent before command readiness"*, `:173`; `rpc-host-shell.test.ts:506`/`:879`/`:897`.
- **LOC:** 63 + ~20 call-site edits. **Effort: S. Risk: LOW.** Tiny, self-contained, has its own 121-line test file.
- **Startup path:** ON, but the gate itself is ~0 ms of work; the cost is only Effect module evaluation, which B1/B4 already paid for.

### B4 — Prompt scheduler `generation` counter → `FiberHandle` + real interruption

- **What:** `prompt-scheduler.ts:97-390` (293 LOC).
- **Effect v4 primitives:** `FiberHandle.make` (`src/FiberHandle.ts:146`, scoped — returns `Effect<FiberHandle<A,E>, never, Scope>`), `FiberHandle.run` (`:709`) / `set` (`:459`) — setting a new fiber interrupts the previous; `FiberHandle.clear` (`:649`) for `rebindSession`; `Queue.bounded`/`unbounded` (`src/Queue.ts:500,611`) for the FIFO, with `Queue.end` (`:1058`) for graceful drain; `Effect.onInterrupt` (`src/Effect.ts:14227`) for requeue-on-cancel.
- **Bug class removed:** *stale dispatch outcome applied to a new session generation*. Four `generation !== this.generation` guards (`:329,339,349,378`) is the manual version of "this fiber was interrupted".
- **Historical evidence:** `7ce530ab` *"avoid idle follow-up queue race"* — the follow-up handler awaited `scheduler.submit(…, {forceQueue:true})` then **unconditionally cleared the editor draft and pushed history, even when the scheduler declined (`"ignored"`) — silently eating the user's text**; separately, `agent_settled` arriving before the in-flight dispatch ack left queued entries undrained. Fix introduced the discriminated result *and* `restoreAll(text, {discardInFlight:true})`. Then `045e0367` *"preserve active dispatch on queue undo"*, `ebb82102` *"own queued prompt undo in host"*, `44ab8e5e` *"drain prompt queue after manual compaction"*, `48949b5a` *"distinguish handled host command from idle follow-up decline"* — four more on the same 293-line file.
- Tests: `prompt-scheduler.test.ts:173` *"drains queued entries when agent_settled arrives before dispatch ack resolves"*, `:243` *"restores old generation entries on rebind so a later settle has nothing stale to deliver"*, `:259` *"ignores stale in-flight dispatch failures after a session rebind"*, `:488` *"does not drain the next entry when the current turn settles before steering acknowledgement"*, `:713`, `:736` *"does not claim a force-send entry was restored when generation invalidation races its outcome"*.
- **LOC:** 293 rewritten, ~60 net deleted. **Effort: M. Risk: MEDIUM.** Caveat: the `forceSteerState` machine (`:108-116,292-318`) encodes *Pi's* ambiguity about whether a steer was queued or started; Effect removes none of that. Expect the file to shrink by a third, not by half.
- **Startup path:** constructed at `host.ts:1125`, but no scheduler work happens before `editor_ready`. Effectively OFF.

### B5 — Session hydration quiet-loop → `Effect.retry` + `Schedule` + `Effect.timeout`

- **What:** three near-duplicate loops — `host.ts:1355-1376`, `host.ts:1918-1936`, `host.ts:188-212` — plus the unbounded fixed-100 ms retry timer at `host.ts:1396-1404` and the `waitForTreeNavigationQuiet` poll at `host.ts:141-161`. ~130 LOC total.
- **Effect v4 primitives:** `Schedule.exponential` (`src/Schedule.ts:1090`), `Schedule.jittered` (`:1441`), `Schedule.spaced` (`:1546`), `Effect.retry`, `Effect.timeout` (`src/Effect.ts:8293`), `Effect.timeoutOption` (`:8410`). `Clock` + `effect/testing/TestClock` makes the 30 s deadline testable without the injected `now`/`wait` seams already carried at `host.ts:113-118`.
- **Bug class removed:** *unbounded fixed-interval retry against a wedged child*. `host.ts:1396-1404` retries forever at 100 ms with no ceiling and no diagnostic (the `catch` at `:1387` is empty). Under a genuinely stuck child that is a 10 Hz busy loop with zero observability. Evidence for the fragility of the surrounding boundary: `rpc-host-shell.test.ts:844` *"exits promptly when startup hydration is stalled"*, `:863` *"handles /quit while startup hydration is stalled"*.
- **LOC:** ~130 → ~50. **Effort: M. Risk: MEDIUM** — the loops are subtle (the barrier watermarks in `RpcSessionEventBuffer` interleave with the awaits, `host.ts:1355-1372`).
- **Startup path:** **ON, and it is the dominant term in `command_ready`** (native configured command-ready is 1,008 ms per plan 117's row in `plans/README.md`). Do not change its *shape* while migrating; only its retry policy.

### B6 — Host composition → `Layer` + `Context.Service`

- **What:** `runRpcHost`'s 250-line construction prologue (`host.ts:909-1160`), with ~15 forward-declared mutable bindings (`let runtime`, `let actions`, `let requestHostExit`, `let handleAppInterrupt`, `let stopHost`, `let releaseInitialHydration!`, …). The `createLazyChatSink` indirection (`host.ts:411-460`) exists *solely* because `RpcTranscriptPump` is constructed before `RpcHostRuntime` — its 20-line doc comment is a confession of a Layer-ordering problem solved by hand.
- **Effect v4 primitives:** `Context.Service` double-call form (`ai-docs/src/01_effect/03_services/01_service.ts`; e.g. `ChildProcessSpawner` at `src/unstable/process/ChildProcessSpawner.ts:252`), `Layer.effect` (`src/Layer.ts:1347`), `Layer.mergeAll` (`:1652`), `Layer.launch` (`:3897`).
- **Bug class removed:** *use-before-initialisation via forward-declared `let`*. Every `runtime?.` in the file (there are ~40) is defensive against exactly this. Layers make the dependency order a type error instead of an `undefined` check.
- **LOC:** ~250 restructured. **Effort: L. Risk: MEDIUM** — mechanical but wide; touches nearly every line of the largest file.
- **Startup path:** ON, entirely. Layer construction is where Effect's fixed init cost lands.

### B7 — Child event dispatch → `PubSub` (or: **don't**)

- **What:** `client.ts:147,432-440` — `Set<listener>` + per-listener `try/catch`.
- **Effect v4 primitives:** `PubSub.unbounded` (`src/PubSub.ts:467`) / `PubSub.sliding` (`:427`), `PubSub.subscribe` (`:1304`, scoped so unsubscribe is automatic).
- **Bug class removed:** *listener leak on reload* (nothing calls the unsubscribe closures returned at `client.ts:171,186`) and *one poisoned listener aborting the dispatch loop* (already mitigated by the per-listener catch).
- **Why it's ranked low:** this is the **hottest path in the process**. Every `message_update` delta from Pi lands here and synchronously drives transcript ingestion plus a render request. Moving it to a PubSub inserts a fiber-scheduling hop between "byte arrived" and "frame scheduled", competing directly with `runtime.ts:561-570`'s deliberate choice of microtask-over-`setImmediate` for input-echo latency. **Recommend: keep the synchronous `Set` dispatch. Optionally add `Queue.offerUnsafe` (`src/Queue.ts:708`) as a *second* consumer for non-render subscribers only.**
- **LOC:** ~15. **Effort: S. Risk: MEDIUM (latency, not correctness).**

### B8 — Protocol decoding → `Schema` (**recommend against for the hot frame path**)

- **What:** `client.ts:374-417` `handleLine` — `JSON.parse` in a try, then three structural predicates (`isMessageRecord`, `isResponse`, `isExtensionUiRequest`, `:124-135`), then an unchecked `as AgentSessionEvent` cast at `:416`.
- **Effect v4 primitives:** `Schema.TaggedError` (`src/Schema.ts:15207`), `Schema.Union` (`:4923`), `Schema.TaggedUnion` (`:6470` — note it takes a *record keyed by tag*, not an array), `Schema.fromJsonString` (`:12789`), and decoding via `Schema.decodeUnknownEffect` (`:1516`) / `decodeUnknownSync` (`:1920`) / `decodeUnknownResult` (`:1773`) — or the same family re-exported from `effect/SchemaParser` (`decodeEffect` `:271`, `decodeSync` `:561`, `decodeResult` `:489`).
- **There is also a purpose-built NDJSON channel** — `effect/unstable/encoding` → `Ndjson` (`src/unstable/encoding/Ndjson.ts`): `decodeSchema` (`:233`), `decodeSchemaString` (`:259`), `decodeString` (`:174`), `NdjsonError` (`:33`), applied via `Stream.pipeThroughChannel` (`src/Stream.ts:15495`). It does cross-chunk line splitting + `JSON.parse` + schema validation in one back-pressured channel.
- **Honest assessment — recommend against for the frame path.** The `as AgentSessionEvent` cast at `client.ts:416` is a genuine unvalidated boundary and Schema would close it. But: `Schema.js` is **332 KB**; the decode runs once per event at streaming rates; and `Ndjson` cannot replace `JsonLineDecoder` without losing its byte caps (§4.3). Also a bundle trap: `import { Ndjson } from "effect/unstable/encoding"` pulls the barrel, which re-exports `Msgpack`, which pulls the **`msgpackr` runtime dependency**. Use the deep path `effect/unstable/encoding/Ndjson` (permitted by the `"./*"` catch-all in `package.json:51`). **Recommend: Schema for the low-frequency, high-stakes envelopes only** — `RpcResponse` and `RpcExtensionUIRequest`. Never on `message_update`.
- **LOC:** ~45. **Effort: M. Risk: LOW-MEDIUM (correctness), HIGH (startup/bundle).**

### Considered and rejected: `effect/unstable/rpc` as the transport

`RpcServer.layerProtocolStdio` (`src/unstable/rpc/RpcServer.ts:1347`) + `RpcSerialization.layerNdjson` (`src/unstable/rpc/RpcSerialization.ts:659`) is a complete typed NDJSON-over-stdio RPC transport — and it is the wrong tool here for three reasons. (1) It is **server-side only**: there is no `RpcClient.makeProtocolStdio` in rc.112 (the client protocols are `makeProtocolHttp` `:901`, `makeProtocolSocket` `:1037`, `makeProtocolWorker` `:1251`). SumoCode is the *parent* talking to a child's stdio — the missing half. (2) The wire format is **Pi's**, not SumoCode's; the host cannot choose it. (3) It would require modelling Pi's `extension_ui_request` reverse channel and its unsolicited event stream, neither of which is request/response.

### Considered and deferred: the reload respawn loop as a `Schedule` restart policy

`runDirectPiBranch`'s `for(;;)` loop (`src/native/main.ts:1035-1055`) and the host's exit-100 propagation are a supervised-restart policy — the thing `Schedule` + `Effect.retry` model natively. History says this is where the pain is: **57 commits on `bin/sumocode.sh`**, culminating in `50c733c0` deleting an `installReloadRespawnHandler` built on `process.on("exit")` + `spawnSync` re-exec in favour of the in-process loop, and `00b6637c` needing a *filesystem side-channel* to get a trustworthy exit code out of bash 3.2 (`host.ts:272-306`). **But it lives in `native/main.ts`, before the host import, on the pre-spawn path (§4.2). Leave it in plain TypeScript.** This is the most tantalising and the least advisable candidate in the domain.

---

## 3. Startup-path caution and the measurement gate

### 3.1 What "startup path" means here, precisely

The native binary's ordering (`src/native/main.ts:1063-1068` → `launcherFlow` → `:960-1030`):

```
process start → EXEC_DIR/realpath (main.ts:47-52) → argv parsing →
  spawn Pi child (main.ts:970)          ← nothing may precede this
  → await import("../sumo-tui/rpc/host.js") (main.ts:995)   ← module eval cost lands HERE
  → host.runRpcHost() (main.ts:1015)
      → setCapabilities / applyStartupTheme (host.ts:921,963)
      → new ChromeCacheWorkerClient (host.ts:952)
      → await loadYoga() (host.ts:1097)                     ← wasm compile
      → await client.start() (host.ts:1815)
      → new RpcHostRuntime + await start() (host.ts:1830,1875) → editor_ready ≈ 182 ms
      → hydration quiet-loop (host.ts:1918-1936) → hydration_committed
      → configureAutocomplete, markChromeStable, releaseInitialHydration (host.ts:1957-1961) → command_ready
```

Everything from `import host.js` onward pays Effect's module-evaluation cost **once**, before `editor_ready`.

### 3.2 The measured cost, concretely

`dist/` sizes in `/tmp/effect-rc/package`:

| Module | Built JS |
|---|---|
| `dist/Effect.js` | 257 KB |
| `dist/internal/effect.js` | 117 KB |
| `dist/Stream.js` | 231 KB |
| `dist/Schema.js` | 332 KB |
| `dist/Layer.js` | 67 KB |
| all `dist/**/*.js` | 13 MB |

Two arms, two different costs:

- **Node arm (`sumo-rpc-host.js` → `dist/host/sumo-rpc-host.bundle.mjs`):** `scripts/build-host.mjs:23` sets **`packages: "external"`**. `effect` would *not* be bundled — Node resolves and evaluates it from `node_modules` at runtime, uncached, unminified, with no tree-shaking. Importing `Effect` + `Layer` + `Deferred` + `Latch` + `Queue` alone is ≳400 KB of parse+eval on the critical path. Budget **15–40 ms** and measure.
- **Native arm (`bin/sumocode`, `scripts/build-native.mjs:206-219`):** `bun build --compile` with **no `--minify`** and no `--bytecode`. Bun bundles and tree-shakes ESM, and `"sideEffects": []` in Effect's `package.json` makes that effective — so the *shipped* subset is much smaller than 13 MB. But the parse cost still lands at process start. This arm is where the 182 ms number lives and where the regression will show first.

Adding `effect` also takes SumoCode from **3 runtime dependencies** (`grok-mermaid`, `jiti`, `yoga-wasm-web` — `package.json`) to 4, and `@effect/platform-node` / `@effect/platform-bun` would make 5–6. Effect itself declares two runtime deps (`/tmp/effect-rc/package/package.json:94-97`): **`fast-check` ^4.9.0** (reachable only via the `effect/testing` barrel) and **`msgpackr` ^2.0.5** (reachable via the `effect/unstable/encoding` barrel and `RpcSerialization.msgPack`). Neither should ever enter the host bundle — import deep subpaths, never those two barrels.

Mitigations that are genuinely available: `"sideEffects": []` (`effect/package.json:28`) plus a `babel-plugin-annotate-pure-calls` pass over `dist` (`effect/package.json:88`) means the package is aggressively tree-shakeable — but only if you import `effect/Stream`, `effect/Queue`, `effect/Latch` rather than the root barrel (`src/index.ts`, ~110 `export * as` namespaces). **Make deep-subpath imports a lint rule from slice 1.**

### 3.3 On-path vs off-path

| Candidate | On startup path? | Notes |
|---|---|---|
| B1 client | **ON** | `client.start()` awaited at `host.ts:1815` |
| B2 terminal/lifecycle | **ON** (acquire) | first `startRetainedSession()` precedes first paint |
| B3 hydration gate | ON but ~0 work | pure cost is module eval, already paid by B1 |
| B4 prompt scheduler | effectively OFF | constructed at `host.ts:1125`, first used after `editor_ready` |
| B5 hydration retry | **ON** | dominates `command_ready`, not `editor_ready` |
| B6 Layer composition | **ON, entirely** | this is where Effect init cost concentrates |
| B7 event dispatch | **ON + hot** | per-event, not per-startup |
| B8 Schema decoding | **ON + hot** | `Schema.js` is the single largest module |
| chrome-cache worker | OFF | `worker.unref()`, lazy (`chrome-cache-worker-client.ts:119,148`) |
| `session-reader` / `session-tree` | OFF | only `/sessions`, `/tree` |
| `git.ts` | OFF by construction | deliberately detached (`host.ts:1877-1896`) |
| `enabled-models`, `lovely-web-config` | OFF | |

### 3.4 The gate

`scripts/perf-native-compare.mjs` is the right instrument and it is already a hard gate:

- `evaluateNativeGate` (`perf-native-compare.mjs:256-280`) requires `editorImprovementMs >= EDITOR_IMPROVEMENT_GATE_MS` (**250 ms**, `:16`), `commandRegressionMs <= 0`, and **zero failures** across all three arms (`dev-source`, `node-bundle`, `native`), using **median ± MAD over 15 samples** (`:14,244-253`).
- Required events per sample: `terminal_index_ready`, `editor_ready`, `hydration_committed`, `command_ready` (`:18`), collected through a real node-pty run with `--offline --no-extensions --no-session --approve` (`:17`).
- `scripts/perf-startup-compare.mjs` is the *directional* gate for source-arm changes: `metricComparison` (`:453-470`) calls a metric `regressed` only when the candidate's `[median−MAD, median+MAD]` interval sits entirely above the baseline's; `overallVerdict` (`:472-483`) requires `MIN_DIRECTIONAL_SAMPLES` and zero failures.
- `scripts/perf-startup.mjs` is explicitly **report-only, not a CI gate** (`:457`).

**Proposed Effect-campaign gate, per slice:**

1. Baseline `scripts/perf-native-compare.mjs --samples 15` on the pre-slice commit; record `native.editorReady.medianMs` and `native.commandReady.medianMs`.
2. After the slice, rerun. **Fail the slice if `native.editorReady` median rises by more than 1 MAD, or if `commandReady` median rises at all.** (The existing 250 ms improvement gate is written against the *node-bundle vs native* comparison and stays as-is; the Effect campaign adds a native-vs-native regression check on top.)
3. Run `scripts/perf-startup-compare.mjs` for the source arm and require verdict ≠ `REGRESSED`.
4. Add one new invariant the current harness does not check: **`editorToCommandGapMs`** (already computed at `perf-startup.mjs:69-76`) must not widen — that is where B5's retry-policy change would show.

**Migrate first, without touching startup latency: B4 (prompt scheduler) and B3 (hydration gate).** B4 is genuinely off-path, has the strongest race evidence (four named tests), and is 293 LOC in one file with a 758-line test. B3 is 63 LOC with a dedicated test file. Together they force the `effect` dependency into the graph, which lets you *measure the module-eval floor in isolation* before any on-path logic changes — that measurement is the real gate on whether B1/B2/B6 happen at all.

---

## 4. What must stay plain TypeScript

1. **`src/sumo-tui/rpc/spawn-child.mjs`** (53 LOC, plain `.mjs` by design). Its doc comment says it: *"Keeping this in plain JavaScript lets the entry point pre-spawn Pi before importing the TypeScript host runtime"* (`:38-42`). It is imported by `sumo-rpc-host.js:7` and `native/main.ts:26` before anything else. Any Effect import here directly adds to time-to-`child_spawn_start`.

2. **The pre-spawn + signal-ownership handoff** — `sumo-rpc-host.js:83-204,272-309` and `native/main.ts:918-1030`. Reasons: (a) it must run before the host module is even imported; (b) `NodeRuntime.runMain` *installs its own SIGINT/SIGTERM handlers* (`ai-docs/src/01_effect/06_running/10_run-main.ts:22-23`), which is incompatible with a protocol whose whole point is transferring signal ownership at a precise instant; (c) twelve integration tests pin the exact windows (`rpc-host-shell.test.ts:596,631,667,702,733,765`).

3. **`src/child-protocol.ts`'s `JsonLineDecoder` and `BoundedUtf8Tail`.** `Stream.decodeText` (`src/Stream.ts:16108`) + `Stream.splitLines` (`:16178`) exist and `effect/unstable/encoding/Ndjson` exists — but neither carries the two independent byte caps (`:8-10`), the shrink-on-idle retained-capacity policy (`:273`), the codepoint-safe partial decode (`:43-53`), or the ring-buffer stderr tail. Those are security/DoS properties against an 8 MiB adversarial frame, and they are what `child-protocol.ts` is *for*. Rewriting them on `Stream` would be a regression, not a migration.

4. **`client.ts:432-440` `dispatchEvent` and everything downstream of it into pi-tui.** See B7. `runtime.ts:555-575` documents a deliberate microtask-vs-`setImmediate` latency decision; the pi-tui render loop and the cell-buffer compositor are synchronous by design. Effect fibers must not appear between "stdin byte" and "frame written".

5. **`terminal-controller.ts`'s escape-byte emission.** `TerminalSessionOwner` may be *owned* by a Layer, but the byte strings and the duplicate-suppression flags stay plain — AGENTS.md's "Do not hand-roll new ANSI for Cathedral surfaces" carves out "terminal controller escape sequences" explicitly, and the three-way byte-drift test depends on them being literals.

6. **`src/sumo-tui/runtime/lifecycle.ts`'s module-load-time global handler install** (`:357-365`). It is deliberately installed at import time "so signal cleanup is registered before later extension/UI code". Effect has no equivalent of "run before anything else, at module evaluation, in a process you don't own"; and this module also runs inside the *Pi child*, where SumoCode is a guest extension.

7. **`scripts/build-host.mjs` / `scripts/build-native.mjs`** and the launcher `bin/sumocode.sh`. Build tooling; zero benefit.

---

## 5. Boundary design

### 5.1 Four boundaries, four shapes

| Boundary | Direction | Shape |
|---|---|---|
| **Effect host ↔ pi-tui components** | Effect calls in, synchronously | `Effect.runSync` (`src/Effect.ts:17674`) is wrong here. Use the *unsafe sync* constructors that exist for exactly this: `Queue.offerUnsafe` (`src/Queue.ts:708`), `Latch.openUnsafe` (`src/Latch.ts:75`), `Deferred.isDoneUnsafe` (`src/Deferred.ts:1382`). Render/keystroke callbacks stay plain functions closed over these handles. |
| **Effect host ↔ Pi RPC child stdio** | Bytes in, JSON out | `child.stdout.on("data", …)` stays a plain Node listener writing into a `Queue` via `offerUnsafe`. A forked fiber (`Effect.forkScoped`, `src/Effect.ts:17128`) drains it. Do **not** use `handle.stdout: Stream<Uint8Array>` from `ChildProcessSpawner` — the host adopts a child it did not spawn, and Effect's handle has no adoption constructor. |
| **Terminal (incl. Herdr)** | Effect owns acquisition | `Effect.acquireRelease(startRetainedSession, exitTerminal)`. Herdr is only an env-detected terminal (`HERDR_ENV`, `HERDR_PANE_ID`) affecting theme/OSC assertions — not a separate host. No boundary work needed. |
| **Entry (`sumo-rpc-host.js`, `native/main.ts`)** | Plain TS calls Effect | Plain entry keeps pre-spawn + early signals, then hands the adopted `ChildProcessWithoutNullStreams` to an Effect program. |

### 5.2 Entry-point shape — recommend `ManagedRuntime`, **not** `Layer.launch` / `runMain`

`Layer.launch` (`src/Layer.ts:3897`) returns `Effect<never, E, RIn>` and is meant to *be* the process (`ai-docs/src/01_effect/06_running/20_layer-launch.ts:23-27`). `NodeRuntime.runMain` owns signals. Neither fits: SumoCode's entry must already be running, must already own the child and the signals, and must be able to hand signal ownership *to* the host at a specific instant.

Proposed shape (`runRpcHost` keeps its exact current signature — `Promise<number>` — so `native/main.ts:1015` and `sumo-rpc-host.js:282` are unchanged):

```ts
// src/sumo-tui/rpc/host.ts — signature unchanged
export async function runRpcHost(options: RpcHostMainOptions = {}): Promise<number> {
  const runtime = ManagedRuntime.make(HostLayer(options))   // src/ManagedRuntime.ts:285
  try {
    return await runtime.runPromise(hostProgram)
  } finally {
    await runtime.dispose()        // src/ManagedRuntime.ts:208 — runs every finalizer
  }
}
```

- `ManagedRuntime.dispose()` (`src/ManagedRuntime.ts:208`) in a `finally` is the graceful-shutdown/terminal-restoration hook, and it is strictly stronger than today's `stop()` because finalizer order is derived from acquisition order rather than hand-written at `host.ts:1702-1741`. It also interrupts forked fibers, because `ManagedRuntime.make` registers them into its own scope via `onFiberStart: Fiber.runIn(scope)` (`src/ManagedRuntime.ts:293`) — that single line replaces the `stopWatchingGitBranch` / `statsTimer` / `sessionHydrationRetryTimer` / `treeNavigationRetryScheduler` teardown block at `host.ts:1704-1710`.
- Signals stay on plain `process.on` in `host.ts` (as today, `:1783-1790`); the handler's body becomes `runtime.runFork(shutdownEffect)` (`src/ManagedRuntime.ts:132`) or `runtime.runCallback(shutdownEffect, { onExit })` (`:159`) instead of `void stop(code)`. Both are synchronous entry points, which is what a signal handler needs.
- `writeExitCodeFile` (`host.ts:307-315`) stays synchronous and stays outside Effect — its doc comment is explicit that an async write racing `process.exit` can be truncated.
- **Blocked on:** confirming a `@effect/platform-node` / `@effect/platform-bun` release compatible with `effect@4.0.0-rc.112`. If none exists, B1's child-process work must be built on plain Node `spawn` wrapped in `Effect.acquireRelease` (which is fine, and arguably better given the adoption requirement).

---

## 6. Service / Layer map

| Service (`Context.Service` id) | Implemented today by | Notes |
|---|---|---|
| `sumocode/rpc/PiChild` | `client.ts:137-501` `SumoRpcClient` | `spawn`/`adopt`, `send: (cmd) => Effect<RpcResponse, RpcError>`, `events: PubSub`, `exit: Deferred`. **Must** support adopting a pre-spawned `ChildProcessWithoutNullStreams`. |
| `sumocode/rpc/ProtocolCodec` | `child-protocol.ts:197-283` + `client.ts:374-417` + `response.ts:8-21` | Keep `JsonLineDecoder` as the impl; wrap `responseData`'s `throw` (`response.ts:9-10`) as a `Schema.TaggedError`. |
| `sumocode/rpc/ReadinessGates` | `initial-hydration-action-gate.ts:16-63` + `runtime.ts:333-431` once-flags + the `terminalIndexGate` file write (`host.ts:1157-1176`) | One service, four `Latch`es: `editorReady`, `chromeStable`, `commandReady`, `hydrationSettled`. |
| `sumocode/rpc/PromptScheduler` | `prompt-scheduler.ts:97-390` | `FiberHandle` + `Queue`. |
| `sumocode/rpc/TerminalModes` | `runtime/terminal-controller.ts:135-419` | Layer with `acquireRelease`; a `Ref<"restore" \| "hand-off">` models `preserveTerminal`. |
| `sumocode/rpc/ChromeCache` | `chrome-cache-worker-client.ts:71-181` (+ `chrome-cache.ts` in-worker) | Advisory; `Effect.timeout` replaces `drainChromeCacheForShutdown`'s manual race (`:31-57`). Off-path — good first *optional* slice. |
| `sumocode/rpc/SessionReader` | `session-reader.ts` + `session-tree.ts` | `readSessionInfosWithLimit`'s hand-rolled worker pool (`:254-268`) → `Effect.forEach(…, { concurrency: 8 })`. Off-path. |
| `sumocode/rpc/HostState` | `state.ts:1-272` `RpcHostStateStore` | **Leave as plain TS.** It is already a pure snapshot store; wrapping it in `Ref` buys nothing and costs a fiber hop per event. |
| `sumocode/rpc/HostControls` | `controls.ts:75-270` | Thin RPC-command wrapper over `PiChild`; the per-command timeout constants (`:43-48`) become `Effect.timeout` arguments. |
| `sumocode/rpc/GitBranch` | `git.ts:89-147` | `Stream` + `Effect.forkScoped`. Off-path by construction. |
| `Clock` (**a `Context.Reference`, not a `Service`** — `src/Clock.ts:189`) | ad-hoc `Date.now` + injected `now`/`wait` seams (`host.ts:113-118,145-146`) | Being a `Reference` it always has a default and never appears in `R`. `effect/testing/TestClock` (`src/testing/TestClock.ts:436` `layer`, `:507` `adjust`) deletes those seams. |
| `Logger` / Diagnostics | `runtime/diagnostics.ts:65-95` `logDiagnostic` | **Do not** replace with Effect `Logger`. It is a JSONL side channel with a public/private event allowlist (`:7-35`) that the perf harness parses; and it is a no-op unless `SUMO_TUI_DIAG_FILE` is set. Keep it, and *add* `Effect.annotateLogs`/`Effect.withSpan` beside it. |

**Not services:** `interrupt.ts` (pure), `state.ts` (pure), `enabled-models.ts` (pure), `session-tree.ts` (pure), `transcript-pump.ts` (a 42-line delegate).

---

## 7. Slice order, and what to do about plan 111

### Recommendation on plan 111: **do it first, in plain TypeScript, as written.**

Plan 111 (`plans/111-extract-rpc-host-lifecycle-seam.md`) is currently `TODO` (`plans/README.md`), P2/L/HIGH, depends on 094 and 104 (both `DONE locally`). Three reasons to do it before Effect rather than absorb it:

1. **It builds the oracle.** Step 1 (`plan 111:113-121`) demands characterization tests named `characterizes lifecycle order:` covering normal exit, `/quit`, SIGINT, SIGTERM, child exit, startup rejection before *and* after child adoption, reload exit 100, runtime start failure, and chrome-cache timeout — asserting terminal restoration and no double-finalization. **That suite is exactly the contract an Effect `Scope` must satisfy.** Its own maintenance note says so: *"A future Effect host migration may replace the lifecycle implementation only after matching this contract suite"* (`plan 111:159`).
2. **It de-risks the highest-risk slice.** B2 (terminal/finalizers) is the campaign's scariest piece. Plan 111 does the *ordering* work with zero new dependencies and zero startup cost; Effect then only swaps the implementation behind a proven interface.
3. **Its STOP condition already anticipates this**: *"Effect becomes necessary to complete the plain-TypeScript seam"* (`plan 111:152`). If that triggers, you have learned something important cheaply.

Cost: plan 111 is L-effort and will be partly rewritten by B2/B6. Accept that. The characterization tests survive; only the implementation is thrown away.

### Slices

| # | Slice | Depends on | Startup risk | Ships behind |
|---|---|---|---|---|
| **0** | **Plan 111** — plain-TS `RpcHostLifecycle` + `characterizes lifecycle order:` suite | 094, 104 (done) | none | existing `runRpcHost` signature |
| **1** | Add `effect` dep; migrate **B3 hydration gate** (63 LOC) | 0 | **measure the module-eval floor here** | `InitialHydrationActionGate` interface; its 121-line test |
| **2** | **B4 prompt scheduler** → `FiberHandle` + `Queue` | 1 | off-path | `RpcPromptScheduler` interface (`prompt-scheduler.ts:44-51`); 758-line test |
| **3** | **ChromeCache + SessionReader** services (off-path warm-up on `Layer`/`Context.Service` idioms) | 1 | off-path | `ChromeCacheWorkerClient` / `listSessions` signatures |
| **4** | **B5 hydration retry** → `Schedule` + `Clock`, keeping loop shape | 1 | ON — gate on `editorToCommandGapMs` | `host.ts` local functions; `hydrateSameSessionTreeNavigation` is already extracted and testable |
| **5** | **B1 `SumoRpcClient`** → `PiChild` service (`Deferred` + `Scope` + `Effect.timeout`); folds the two other correlation maps in | 1, 2 | ON — gate on `editor_ready` | `SumoRpcClient` public API; 891-line test |
| **6** | **B2 terminal + finalizers** → `Scope`, replacing plan 111's implementation | 0, 5 | ON | plan 111's characterization suite (unchanged) |
| **7** | **B6 `Layer` composition** of `runRpcHost`'s prologue; delete `createLazyChatSink` | 5, 6 | ON — largest single risk | `runRpcHost(): Promise<number>` signature unchanged |
| — | **B7 event dispatch, B8 Schema on the event path** | — | **do not ship** | see §4 |
| — | Optional: `Schema` for `RpcResponse`/`RpcExtensionUIRequest` envelopes only | 5 | measure `Schema.js` cost first | `response.ts` |

Every slice keeps `runRpcHost(options): Promise<number>` and the four diagnostic events (`editor_ready`, `hydration_committed`, `command_ready`, `stable_chrome_ready`) byte-identical, so `test/integration/**` and both perf harnesses are unchanged throughout.

**Stop rule:** if slice 1 alone costs more than ~1 MAD of `native.editorReady` median, stop the on-path slices (4–7) and keep the campaign to the off-path ones (2, 3) plus plan 111.

---

## 8. Honest section — where Effect will not help, or will hurt

**Startup milliseconds.** This is the real risk and it is not hypothetical. Plan 117 spent an XL-effort campaign to get native `editor_ready` from 549 ms to 182 ms, and its gate demands ≥250 ms of improvement with zero command-ready regression. Effect's core is 257 KB (`Effect.js`) + 117 KB (`internal/effect.js`) of JS to parse before the first frame, and the Node arm doesn't even bundle it (`build-host.mjs:23` `packages: "external"`). Slice 1 exists specifically to measure this before committing. If it costs 20 ms, that is >10% of a hard-won budget for zero user-visible benefit.

**Bundle size inside the Bun executable.** `bun build --compile` runs with no `--minify` (`build-native.mjs:206-219`). Tree-shaking will work (`"sideEffects": []`), but `Effect.js`, `Layer.js`, `Queue.js`, `Deferred.js`, `Latch.js`, `FiberHandle.js` and their shared `internal/*` graph are heavily cross-referential; expect a meaningful fraction of the 374 KB core to survive. `Schema.js` at 332 KB should be treated as opt-in per-message-type, never as the default decoder.

**Generator overhead on per-event paths.** `Effect.gen`/`Effect.fn` allocate a generator and a fiber step per `yield*`. AGENTS.md-style Effect code is written this way by default. At `message_update` streaming rates through `client.ts:432-440` → `transcriptPump.handleAgentEvent` → `runtime.update` → `scheduleRender`, that is thousands of allocations per turn on the same thread that paints frames. `Effect.fnUntraced` (`src/Effect.ts:21998`) exists and helps, but the honest answer is: **don't put Effect on that path at all**, which is why B7 and B8 are ranked last and recommended against.

**Interplay with pi-tui's synchronous render loop.** `runtime.ts:555-575` contains a carefully-argued decision to coalesce renders on a *microtask*, explicitly rejecting `setImmediate` because it "would defer behind any other already-queued immediates/timers/I/O callbacks, which is unnecessary latency for a pure in-process repaint". Effect's `Scheduler` is a macrotask-ish yield model. Any design where a keystroke's render passes through a fiber is a latency regression against a decision the codebase already made deliberately.

**Debugging.** The current failure mode is a Node stack trace with real filenames. Effect's is a `Cause` with a fiber trace. This is *better* once the team is fluent and worse for the first few months — and this host's hardest bugs are already the kind that only reproduce in a PTY under `test:integration` with process-group supervision (`plans/116`). Effect's tracing does not reach into the Pi child, the launcher shell, or the terminal.

**Mixed-world complexity is real and unavoidable here.** The host will permanently straddle three worlds: plain-TS entry + pre-spawn (§4), Effect host core, and synchronous pi-tui rendering. Every boundary needs an explicit `*Unsafe` bridge (`Queue.offerUnsafe`, `Latch.openUnsafe`, `Deferred.isDoneUnsafe`). Those bridges are precisely where new races get introduced during the migration, and they are *not* covered by the existing tests, which test the two worlds separately.

**`runMain` is unusable here.** Worth restating: `NodeRuntime.runMain` installs SIGINT/SIGTERM handlers (`ai-docs/src/01_effect/06_running/10_run-main.ts:22-23`). SumoCode's entry-to-host signal-ownership transfer (`sumo-rpc-host.js:183-184,286` → `host.ts:1783-1790`) is pinned by six integration tests and exists because a signal arriving in the wrong microsecond either orphans the Pi child or enters altscreen behind a process that is already exiting. Effect must be a *guest* in this process, not its owner.

**Platform-package availability is an open blocker.** `@effect/platform-node` and `@effect/platform-bun` are not in the rc tarball. `ChildProcessSpawner` has no implementation in core. Slices 5–7 must not start until a compatible release is confirmed — or, better, until the team accepts that `PiChild` will wrap plain Node `spawn` in `Effect.acquireRelease` anyway (which it must, because Effect's `spawn` returns a fresh handle and this host *adopts* a child it did not create).

**What Effect genuinely will not fix.** The `forceSteerState` machine (`prompt-scheduler.ts:108-116`) exists because Pi 0.83+ does not tell the host whether a steer was queued or started (`:199-213`). The double hydration quiet-loop exists because Pi's RPC has no ordering guarantee between an event and a response (`host.ts:1800-1804`). The exit-code side-channel file exists because bash 3.2 misreports `wait` status (`host.ts:272-306`). These are protocol and environment defects. Effect makes the workarounds smaller and better-typed. It removes none of them.

---

## Appendix A — Effect-3 memories that are wrong in rc.112

Every claim below was verified against `/tmp/effect-rc/package/src/**`. These are the renames most likely to be written from memory and then silently mean something else — or, worse, to be reported as "Effect can't do X" when it can.

| You will want to write | rc.112 reality | Citation |
|---|---|---|
| `Effect.fork` | **Does not exist.** Use `Effect.forkChild` (supervised by the current fiber) | `src/Effect.ts:16990` |
| `Effect.forkDaemon` | **Does not exist.** Use `Effect.forkDetach` | `src/Effect.ts:17168` |
| `Effect.disconnect` | **Does not exist.** Nearest: `Effect.forkDetach`; `RpcServer.ts:1310` uses `Effect.ensuring(Effect.forkDetach(Fiber.interrupt(fiber), { startImmediately: true }))` as the idiom | — |
| `Layer.scoped` | **Does not exist.** `Layer.effect` now runs its effect *in the layer's scope* and eliminates the `Scope` requirement | `src/Layer.ts:1347,1358-1361`; cf. `Layer.effectDiscard` `:1512` |
| `Effect.Service` (v3's combined tag+layer helper) | **Does not exist.** `Context.Service<Self, Shape>()("id")` + a hand-written `static readonly layer = Layer.effect(Tag, …)`; construct with `Tag.of({…})` | `src/Context.ts:201,229-238` |
| `Effect.makeLatch` | **Does not exist.** `Latch` is its own root module: `Latch.make(open?)` | `src/Latch.ts:196` |
| `Stream.async` | **Renamed** to `Stream.callback`, and the emitter is now a real `Queue` terminated with `Queue.end` | `src/Stream.ts:694`; `src/Queue.ts:1058` |
| `Schedule.intersect` | **Does not exist.** `Schedule.max` (n-ary, array-taking): "recur while all schedules want to recur, using the maximum delay" | `src/Schedule.ts:826,806-807` |
| `Schedule.union` | **Does not exist.** `Schedule.min` | `src/Schedule.ts:1023` |
| `Schedule.compose` | **Does not exist.** Nearest: `Schedule.concat` (sequential), `addDelay`, `modifyDelay`, `upTo`, `passthrough` | `:548,465,1343,1702,1473` |
| `Schema.parseJson` | **Renamed** to `Schema.fromJsonString` | `src/Schema.ts:12789` |
| `Schema.decodeUnknown` (returning an Effect) | **Renamed** to `Schema.decodeUnknownEffect`; siblings `decodeUnknownSync`, `decodeUnknownResult`, `decodeUnknownExit`, `decodeUnknownOption`, `decodeUnknownPromise` | `src/Schema.ts:1516,1920,1773,1635,1709,1841` |
| `unsafeMake` / `unsafeOffer` / … | **Suffix, not prefix, in v4**: `makeUnsafe`, `offerUnsafe`, `openUnsafe`, `closeUnsafe`, `doneUnsafe`, `makeMemoMapUnsafe` | `src/Scope.ts:271`, `src/Queue.ts:708`, `src/Latch.ts:75,336`, `src/Deferred.ts:1648`, `src/Layer.ts:492` |
| `Queue` is just a buffer | **`Queue<A, E>` now carries an error channel and a first-class `Cause.Done` termination protocol.** `Queue.take` can *fail* with `E`; `Queue.end` (graceful) is distinct from `Queue.shutdown` (abrupt) and `Queue.interrupt` | `src/Queue.ts:1474,1058,1191,1153` |
| `Queue.make()` is bounded | **Default capacity is `Number.POSITIVE_INFINITY` and default strategy is `"suspend"`.** `Queue.bounded(n)` is what backpressures | `src/Queue.ts:448,457-458,500` |
| `Clock` is a service you provide | **`Clock` is a `Context.Reference`** — always has a default, never appears in `R` | `src/Clock.ts:189` |
| `Either` | **v4 uses `Result`** (`effect/Result`); the `decode*Result` family returns it | `src/Result.ts` |
| `NodeRuntime` / `BunRuntime` / `NodeServices` are in `effect` | **They are not.** Separate packages `@effect/platform-node` / `@effect/platform-bun`. `effect` ships only the factory `Runtime.makeRunMain` | `package.json:29-53` (no `./platform-node` key); `src/Runtime.ts:181`; `ai-docs/src/01_effect/06_running/10_run-main.ts:5-6` |
| `ChildProcessSpawner` can spawn out of the box | **It is an interface only.** `effect/unstable/process` contains the `Command` description + the service tag; the implementation comes from `NodeServices.layer` | `src/unstable/process/ChildProcessSpawner.ts:252`; `ai-docs/src/60_child-process/10_working-with-child-processes.ts:101-104` |
| `import { X } from "effect"` is fine | It works (`"./*": "./dist/*.js"` catch-all), but **deep subpaths are strictly safer for bundle size**: `effect/Stream`, `effect/Queue`, `effect/testing/TestClock`. `./internal/*` and `./index` are `null` (blocked) | `package.json:29-53` |

Things that **do** exist and are directly useful here, confirmed:
`Effect.acquireRelease` (`src/Effect.ts:12928`), `Effect.addFinalizer` (`:13112`), `Effect.scoped` (`:12815`), `Effect.timeout` (`:8293`, fails with `Cause.TimeoutError`), `Effect.timeoutOption` (`:8410`), `Effect.race` (`:8836`), `Effect.raceAll` (`:8760`), `Effect.onInterrupt` (`:14227`), `Effect.uninterruptible` (`:14306`), `Effect.uninterruptibleMask` (`:14341`), `Effect.forkScoped` (`:17128`), `Effect.forkIn` (`:17033`), `Effect.fn` (`:22122`), `Effect.fnUntraced` (`:21998`), `Effect.gen` (`:1947`), `Effect.runFork` (`:17312`), `Effect.runSync` (`:17674`);
`Deferred.make` (`src/Deferred.ts:171`) / `await` (`:223`) / `makeUnsafe` (`:140`) / `isDoneUnsafe` (`:1382`);
`Latch.make` (`src/Latch.ts:196`) / `open` (`:216`) / `openUnsafe` (`:239`) / `whenOpen` (`:360`);
`Queue.offerUnsafe` (`src/Queue.ts:708`) — **the sync-callback bridge**;
`FiberHandle.make/set/run/clear` (`src/FiberHandle.ts:146,459,709,649`), `FiberMap` (`src/FiberMap.ts:162,520,1268`), `FiberSet` (`src/FiberSet.ts:154,454,606`);
`FiberSet.makeRuntime` / `FiberHandle.runtime` (`src/FiberSet.ts:199`, `src/FiberHandle.ts:866`) — **the idiomatic way to call Effect from a synchronous callback with services already provided**;
`PubSub.subscribe` (`src/PubSub.ts:1304`, scoped);
`Schedule.exponential` (`src/Schedule.ts:1090`), `Schedule.jittered` (`:1441`, uniform ×[0.8, 1.2]), `Schedule.spaced` (`:1546`), `Schedule.recurs` (`:1517`);
`Layer.launch` (`src/Layer.ts:3897`), `Layer.mergeAll` (`:1652`), `Layer.provide` (`:2008`), `LayerMap` (`src/LayerMap.ts:156`), `LayerRef` (`src/LayerRef.ts:133`);
`ManagedRuntime.make` (`src/ManagedRuntime.ts:285`) / `runFork` (`:132`) / `runCallback` (`:159`) / `dispose` (`:208`) / `Symbol.asyncDispose` (`:215`);
`Stream.decodeText` (`src/Stream.ts:16108`, `TextDecoder{stream:true}` — handles split codepoints), `Stream.splitLines` (`:16178`, handles `\n`/`\r`/`\r\n` across chunks), `Stream.callback` (`:694`), `Stream.fromQueue` (`:1132`), `Stream.toQueue` (`:20256`), `Stream.runForEach` (`:18918`), `Stream.pipeThroughChannel` (`:15495`);
`Ndjson.decodeSchema` / `decodeSchemaString` / `decodeString` / `NdjsonError` (`src/unstable/encoding/Ndjson.ts:233,259,174,33`);
`Stdio` (`src/Stdio.ts:63,100`, incl. `stdinIsTerminal`/`stdoutIsTerminal` and `Stdio.layerTest` `:152`), `Terminal` (`src/Terminal.ts:31,166`);
`FileSystem` (root, `src/FileSystem.ts:663` — no live layer in-package), `Path` (root, `src/Path.ts:255`, **does** ship `Path.layer` `:867`).

### A.1 What `ChildProcessHandle` gives you, and the one thing it does not

`src/unstable/process/ChildProcessSpawner.ts:79-200` — `pid` (`:83`), `exitCode: Effect<ExitCode, PlatformError>` (`:88`), `isRunning` (`:93`), `kill(options?)` defaulting to SIGTERM (`:102`), `stdin: Sink` (`:106`), `stdout`/`stderr`/`all: Stream<Uint8Array>` (`:115,124,129`), `getInputFd`/`getOutputFd` for fd≥3 (`:141,152`), `unref: Effect<Reref>` (`:195`). `spawn` requires `Scope` (`:257`), so child lifetime is scope-bound. Documented gotchas: mixing `all` with `stdout`/`stderr` interleaves unpredictably (`:110-113`); and `CommandOptions.env` **replaces** the child environment unless `extendEnv: true` (`src/unstable/process/ChildProcess.ts:383-393`) — which would silently strip `PATH` from the Pi child.

**The thing it does not give you: adoption.** There is no constructor that wraps an already-running Node `ChildProcessWithoutNullStreams`. SumoCode's entry pre-spawns Pi *before importing the host* (`native/main.ts:970`, `sumo-rpc-host.js:187`) and hands the handle over (`host.ts:1815` → `client.ts:198`). That is the whole point of the design and it is worth ~370 ms of `editor_ready`. **`PiChild` must therefore be built on plain Node `spawn` wrapped in `Effect.acquireRelease`, not on `ChildProcessSpawner`.** This is not a limitation to work around; it is the correct shape.
