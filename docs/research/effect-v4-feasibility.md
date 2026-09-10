# Effect v4 feasibility for SumoCode — synthesis

**Written:** 2026-09-05 against the open PR-stack tip `99b8cc4d` (PR #457, GitHub Stack #438) and
`effect@4.0.0-rc.112`. Four deep analyses back this document; read them for line-level evidence:

| Track | Report | Scope |
|---|---|---|
| A | [`effect-v4/A-lifecycle.md`](effect-v4/A-lifecycle.md) | subagents, background tasks, activity, terminal host |
| B | [`effect-v4/B-rpc-host.md`](effect-v4/B-rpc-host.md) | RPC host, Pi child supervision, native entry |
| C | [`effect-v4/C-boundaries.md`](effect-v4/C-boundaries.md) | data boundaries, errors, persistence, tests, do-not-touch map |
| D | [`effect-v4/D-effect-v4-reality.md`](effect-v4/D-effect-v4-reality.md) | rc.112 API audit, churn, benchmarks on Node 25 and Bun 1.4 |

Raw benchmark data: [`effect-v4/raw-measurements.json`](effect-v4/raw-measurements.json).
This document is the reference that `plans/110-effect-subagent-manager-pilot.md` pointed at but never
existed; it now also feeds `plans/118-effect-v4-refactor-campaign.md`.

## 1. Decision context

The maintainer decided to run a follow-up campaign after the perf campaign (plans 091–117) that adopts
Effect v4 as widely as is sensible, for correctness and fewer bugs. Plan 110's contained spike is
superseded by production adoption. This document does not argue the decision; it grounds it.

## 2. Headline findings

1. **SumoCode has re-implemented Effect's runtime by hand, repeatedly.** Three request/response
   correlation maps with timeouts, four process-signal owners, two byte-identical hydration loops,
   two duplicated escalating-backoff state machines, a `generation` counter that is `Fiber.interrupt`
   written longhand, eleven timer fields with hand `unref`/clear, six parallel id sets for one
   settlement, and a `Promise.race` manifest timeout that leaks the losing git fan-out. Git history
   names the bug classes: 16+ lifecycle fix commits in the subagent domain in six weeks, 206 commits
   on `src/sumo-tui/rpc/**`, 57 on `bin/sumocode.sh` alone.
2. **Roughly 40% of the codebase must never see the Effect runtime.** Render, transcript, widgets,
   layout, input, cathedral, themes (14,803 LOC) are synchronous and pure; `Effect.runSync` is ~50x a
   plain call. The durable stores, process-identity primitives, byte-level protocol framing, launcher
   argv classifier, pre-spawn and signal-ownership handoff are deliberately synchronous or
   security-hardened and stay plain TypeScript.
3. **Schema decode cost is a non-issue; module load cost is the real cost.** Decode adds +0.14 µs per
   streaming delta (0.014% CPU at 1,000 events/s). Importing the root `effect` barrel costs +86–91 ms
   unbundled (dev/jiti mode), +37–50 ms bundled, and +8–19 ms of wall-clock startup inside the
   Bun-compiled binary. Deep subpath imports are mandatory.
4. **Three rc.112 facts change the plan.** Core `effect` ships `FileSystem`/`Path`/`ChildProcessSpawner`
   as interfaces only; implementations live in `@effect/platform-node@4.0.0-rc.112`. `NodeRuntime.runMain`
   installs its own SIGINT/SIGTERM handlers and is incompatible with SumoCode's signal-ownership transfer.
   `ChildProcessSpawner` has no adoption constructor, so the RPC host's pre-spawned Pi child stays on
   `node:child_process` behind an Effect service. **Correction after a second pass:** the Node
   implementation does exist, in `@effect/platform-node-shared@4.0.0-rc.112` (`NodeChildProcessSpawner`,
   sole dependency `ws`). Verified: it signals the process group with `process.kill(-pid)`, falls back
   to the single pid, escalates SIGTERM to SIGKILL through `forceKillAfter`, and defaults `detached`
   on POSIX. It is therefore a viable implementation for **headless** subagent children
   (`backend-pi.ts`, `native-task-tool.ts`) but not for durable terminals, whose handle needs a
   start-time identity anchor and natural-exit-marker precedence that the spawner does not model.
   Plan 118 records this as a decision at slice 2.5, defaulting to plain Node because the interface
   lives under `effect/unstable/process` and the byte-capped `JsonLineDecoder` must be kept either way.
5. **rc churn is real.** One prerelease every ~2.25 days; interface-breaking changes ship under
   "Patch Changes" (rc.112 changed public `Pool.State` and `Scope.State.Open`). rc.111 fixed a
   `Deferred` bug that could hang waiters forever. Exact pins and a reviewed upgrade ritual are required.
6. **The codebase is above median on boundary discipline.** Zero real `as any`, zero decode-motivated
   `as unknown as`, universal `// SAFETY:` comments, byte-bounded framing. The Schema win is
   deduplication (eleven divergent `isRecord`/`isString` families, two of them wrong) and observability
   (32 of 35 caught `JSON.parse` sites swallow to a default; `onProtocolError` is dead in production).

## 3. Measured numbers (Apple M4 Mac mini; budgets were measured on an M3 Max, so treat deltas as trustworthy and absolutes as same-order)

### 3.1 Startup and size

| Arm | baseline | + Effect core | + Schema | + Stream |
|---|---:|---:|---:|---:|
| Bun `--compile` binary wall-clock startup (median, n=15) | 6.5 ms | +7.9 ms | +16.1 ms | +19.3 ms |
| Same, `--minify` | 6.9 ms | +6.4 ms | +15.3 ms | +17.1 ms |
| Bun binary size delta | 61 MB | +258 KB | +661 KB | +839 KB |
| Node import, externalized (dev/jiti mode) | 28 ms | +91 ms | +86 ms | +86 ms |
| Node import, bundled + tree-shaken | 30 ms | +37 ms | +43 ms | +50 ms |
| esbuild minified bundle contribution | — | +186 KB | +322 KB | +389 KB |
| RSS after import (Bun / Node) | — | +4.7 MB / +13.1 MB | | |

Against plan 117's native budget (editor-ready 182 ms, command-ready 732 ms) the shipped-binary tax is
4–11% of editor-ready and 1–3% of command-ready. Nothing in the 31 ms launcher path may import Effect.

### 3.2 Runtime overhead (ns/op, medians, n=7)

| Case | Node | Bun |
|---|---:|---:|
| plain async/await, 3 awaits | 76 | 50 |
| `Effect.gen` 3 yields, one `runPromise` per iteration | 794 | 410 |
| `Effect.gen` 3 yields, one `runPromise` for the whole loop | 62 | 83 |
| Schema decode, 10-field object | 742 | 546 |
| hand-written typeof guard, 10 fields | 8.7 | 4.9 |
| `Effect.runSync(prebuilt chain)` vs plain call | 179 vs 3.6 | |
| `Equal.equals` on `Data.Class` vs `JSON.stringify` compare | 21 vs 100 | |

The `runPromise` boundary is the cost, not the fiber runtime. Staying inside Effect is faster than
async/await on Node. At TUI event rates (≤10k events/s) all of this is invisible; bulk loops are the
only place Schema or per-event `runPromise` would show.

### 3.3 Tooling

| Item | Result |
|---|---|
| `tsc --noEmit` tax (skipLibCheck true) | +258 ms fixed, ~1.3 ms per additional Effect-heavy file |
| TS 6.0.3 with repo tsconfig | clean, including `skipLibCheck: false` |
| `@effect/vitest@4.0.0-rc.112` | peer `vitest >=4.1.0 <5`; repo's `^4.1.5` satisfies it |
| `effect/testing` | `TestClock`, `TestConsole`, `TestSchema`, `FastCheck` |
| `bun build --compile` | clean with the repo's exact flags |
| `fast-check` (hard dep of effect) | tree-shakes out; must be asserted absent in the native metafile |
| `msgpackr` (hard dep) | inlined by `effect/unstable/rpc/RpcSerialization` even for NDJSON; avoid that module |
| `@effect/platform-node` barrel import | +1.2 MB, inlines `undici`; subpath imports only (173 KB) |

## 4. What Effect replaces, per domain

### 4.1 Lifecycle (Track A) — adopt narrowly and deeply

| Candidate | Effect primitive | Bug class removed | Effort / risk |
|---|---|---|---|
| A1 `SubagentManager` settlement + cancellation core | `Deferred`, `Semaphore`, `Queue`, `SubscriptionRef`, `FiberMap`, `Effect.timeout`, `Scope` | duplicate settles, leaked manifest builds, three cancellation channels, six id sets | L / MED |
| A2 two escalating-backoff machines (260 LOC) | one `Schedule.min([exponential, spaced])` + `Effect.retry` | arm/disarm coupling across timers | M / LOW |
| A3 eleven-timer forest | `Scope`-owned `Effect.repeat` fibers | teardown checklists, five `disposed` guards | M / MED |
| A4 refresh notification batching | `SubscriptionRef`/`PubSub` | newer-then-stale ordering | L / MED-HIGH, last |
| A5 pane steering acks | `Deferred` + one poll fiber | four race repairs in 40 lines | S / LOW |
| A6 two `attachAbortSignal` copies | `ChildSupervisor` service; one tag, two layers: headless children on plain Node or the verified `NodeChildProcessSpawner` (decision at slice 2.5), durable terminals on plain Node + `process-tree.ts` | duplication, unfailable kills | M / MED |
| A7 hand-rolled worker pool | `Effect.forEach({ concurrency })` | no interruption propagation | S / LOW |
| A8 delivery outbox | `Queue` + `Schema.TaggedError` | mirror-set pruning | S / LOW-MED |

Stays plain: `task-store.ts`, `activity/persistence.ts` (synchronous by design, inside locks),
`process-tree.ts` identity primitives, `git/worktree.ts` sync arm, per-chunk stdout decoding, node-pty
harness. `effect/unstable/process` is adoptable only for headless children (see §2 point 4); durable
terminals need the start-time identity anchor and exit-marker precedence it does not model.

### 4.2 RPC host (Track B) — best candidate, most dangerous location

| Candidate | Effect primitive | Bug class removed | On startup path? |
|---|---|---|---|
| B1 `SumoRpcClient` correlation + child lifecycle (and two sibling maps) | `Deferred`, `Effect.timeout`, `acquireRelease`, `Effect.race` | timer/map desync, double teardown, unobserved idle child death | yes |
| B2 terminal modes + host teardown | `Scope` finalizers, `Layer.effect` | terminal stranded in raw mode/altscreen, cleanup ownership gaps | acquire yes |
| B3 hydration action gate (63 LOC) | `Latch.whenOpen` + `FiberMap` | microtask-ordering bugs (three shipped fixes) | yes, ~0 work |
| B4 prompt scheduler `generation` counter | `FiberHandle` + `Queue` + `onInterrupt` | stale dispatch outcome after rebind | no |
| B5 hydration quiet loops + 100 ms forever retry | `Effect.retry` + `Schedule` + `Clock` | unbounded fixed-interval retry, zero diagnostics | yes (command-ready) |
| B6 host composition prologue | `Layer` + `Context.Service` | use-before-init via forward `let`, ~40 `runtime?.` guards | yes, entirely |
| B7 event dispatch | do not migrate | hottest path; fiber hop would add latency | hot |
| B8 Schema on `message_update` | do not migrate; envelopes only | | hot |

Stays plain: `spawn-child.mjs`, pre-spawn + signal-ownership handoff, `JsonLineDecoder`/`BoundedUtf8Tail`,
`dispatchEvent` and everything into pi-tui, terminal escape bytes, module-load signal install in
`lifecycle.ts`, build scripts and launcher. Entry shape: `ManagedRuntime` inside the unchanged
`runRpcHost(): Promise<number>`; never `runMain` or `Layer.launch`.

### 4.3 Boundaries (Track C) — Schema at cold boundaries first, one event union later

Highest-value boundaries: `rpc/client.ts` event funnel (one `Schema.TaggedUnion`, decoded once, consumed
by four sites that currently disagree), `rpc/response.ts` (`expectRpcSuccess` gains a schema, 25 call
sites validated for free), config tiers, MCP config, roles, `native-task-params` (already `Result`-shaped),
subagent child NDJSON (unversioned wire protocol against an unvalidated `PI_BIN`).

Two live bugs found: unbounded producer-controlled `contentIndex` at `transcript/controller.ts:125-127`
(50 M synchronous allocations from one frame), and `onProtocolError` never wired in production.

Error taxonomy: one `Schema.TaggedError` per domain with a tagged `reason` field (`StoreError`,
`RpcError`, `ProcessError`, `ConfigError`), restating the existing `WorktreeErrorCode` and
`MemoryClientErrorCode` enums. Seventeen dangerous swallows ranked; the worst are fail-open lock scans
that break mutual exclusion (`task-store.ts:962`, `persistence.ts:341`) and unfailable subagent kills.

Persistence: keep the `O_NOFOLLOW`/`fchmod`/inode-comparison I/O on `node:fs`; put Schema at the decode
boundary only; `Schema.catchDecoding` for per-field recovery; `KeyValueStore` only for the advisory
chrome cache, if at all. `onExcessProperty` defaults to `"ignore"` which strips unknown keys; every
schema over a re-encoded payload must set `"preserve"`.

Tests: 26 files (198 `advanceTimers*` sites) move to `TestClock`; `vi.waitFor` deadlocks against a
virtual clock; `scripts/test-wait-classification.test.mjs` must learn TestClock vocabulary first.
`it.effect.prop` with Schema-derived arbitraries is the strongest new testing capability.

## 5. Where the expectations hold and where they do not

| Expectation | Verdict | Evidence |
|---|---|---|
| Robustness | holds | structured concurrency, finalizers on every exit path incl. interruption, typed error channel, `TestClock` determinism |
| Fewer bugs | holds for in-memory race classes; does not hold for durable/distributed ones | Track A: 7 of 16 historical fixes are Effect-shaped, 9 are ABA leases, process identity, incomplete generations. Track B: Pi protocol ambiguities and bash 3.2 `wait` remain workarounds |
| "As much as possible" | wrong as a target | ~25k of 58k LOC must stay plain; realistic footprint is ~8–10k LOC of lifecycle/host core plus ~15 boundary schemas |
| Some perf | mostly wrong | +8–19 ms shipped startup, +86–91 ms dev startup without deep imports, +5–13 MB RSS; only steady-state in-fiber code is marginally faster on Node |
| Effect is stable enough | conditionally | rc every 2.25 days, breaking in patch bumps, `Deferred` hang fixed two releases ago; exact pins and upgrade ritual mitigate |
| Effect covers child processes and fs | partly | headless children could use the verified `NodeChildProcessSpawner` (rc.112, dep `ws`); the adopted RPC child, durable terminals, and the hardened fs layer cannot; plan 118 defaults to plain Node behind services and revisits at 4.0.0 final |
| Agents will write it correctly | new bug class | ~40 renamed/removed v3 APIs; cheat sheet in §6 must be in `AGENTS.md`; semantic traps compile fine |

## 6. Effect v4 cheat sheet for agents (verified against rc.112)

| Wrong (v3 memory) | Right (rc.112) |
|---|---|
| `Effect.catchAll` | `Effect.catch`; `catchAllCause` → `catchCause`; `catchSome` → `catchFilter` |
| `Either.right/left` | `Result.succeed/fail` (`Either` is gone) |
| `Context.Tag("Db")<Db, Shape>()` | `Context.Service<Db, Shape>()("sumocode/dir/Db")` |
| `Layer.scoped(Tag, acquireRelease)` | `Layer.effect(Tag, acquireRelease)` (`Layer.scoped` deleted) |
| `Effect.fork` / `forkDaemon` | `Effect.forkChild` / `forkDetach` |
| `yield* ref` | `yield* Ref.get(ref)` (no Effect subtyping; `Deferred.await`, `Fiber.join`, `Queue.take`) |
| `unsafeGet`, `unsafeOffer` | `getUnsafe`, `offerUnsafe`, `openUnsafe`, `makeUnsafe` |
| `Schema.decodeUnknown` returns Effect | `Schema.decodeUnknownEffect`; siblings `Sync`, `Result`, `Exit`, `Option`, `Promise` |
| `Schema.Union(A, B)`, `Schema.Literal("a","b")` | `Schema.Union([A, B])`, `Schema.Literals(["a","b"])`, `Schema.Tuple([...])` |
| `Schema.parseJson` | `Schema.fromJsonString` |
| `Effect.TaggedError` | `Schema.TaggedError<E>()("E", {...})` |
| `Effect.async` | `Effect.callback`; `Stream.async` → `Stream.callback` |
| `Schedule.union` / `intersect` | `Schedule.min` / `Schedule.max` (array-taking) |
| `Effect.makeLatch` | `Latch.make` (own module) |
| `Stream.runCollect` returns `Chunk` | returns `Array` |
| `Data.struct/tuple/array` | gone; `Data.Class`, `Data.TaggedClass`, `Data.taggedEnum` |
| `FiberRef` | gone; `Context.Reference` |
| `Effect.gen(this, ...)` | `Effect.gen({ self: this }, ...)` |
| `NodeRuntime` in `effect` | `@effect/platform-node`; core exposes only `Runtime.makeRunMain` |

Semantic traps that compile: shared `MemoMap` layer memoization (same layer provided twice builds
once), `Equal.equals` structural by default, `Queue` carries an error channel and `Queue.end` vs
`shutdown`, `Queue.make()` is unbounded by default, `Clock` is a `Context.Reference` that never appears
in `R`, `CommandOptions.env` replaces the child env unless `extendEnv: true`.

Effect's own `AGENTS.md` directives to adopt verbatim: prefer `Effect.gen` and `Effect.fn("name")`;
never return an `Effect.gen` from a function, use `Effect.fn`; always `return yield* new Error(...)`;
all validation via `Schema`, never hand-rolled predicates; use `Predicate` helpers; service ids are
`"<package>/<dir>/<Service>"`; `DateTime` not `Date.now`.

## 6a. Agent skills to install (evaluated 2026-09-05)

| Source | Skill | Verdict |
|---|---|---|
| `Effect-TS/skills` (official, 87 stars, pushed 2026-08-27) | `effect-ts` | **Install.** Tiny; its whole instruction is "read `node_modules/effect/AGENTS.md` completely before writing Effect code", which matches Track D's recommendation. `effect-v3-to-v4` is a migration skill for existing v3 code; not needed for a greenfield adoption. |
| `kitlangton/skills` (317 stars, pushed 2026-08-29) | `effect` | **Install.** Opinionated v4 production defaults with eight branch references (SCHEMA, SERVICES_LAYERS, CONFIG, SCHEDULING, CACHING, STREAMS, HTTP_CLIENTS, TESTING). Its `Effect.fn("Domain.operation")`, `Schema.TaggedError`, `Context.Service` + `Layer.effect` + `Service.of`, TestClock-over-sleep, and "decode at untrusted boundaries" rules align with plan 118. Overlay needed where it conflicts with SumoCode: it prefers `Config` over `process.env` (SumoCode's launcher must stay plain), `effect/Cache` for keyed caches (the durable stores stay hand-rolled), and discourages `Schema.Class` as default modeling (fine; plan 118 uses `Schema.Struct`/`TaggedUnion` at boundaries). |
| `kitlangton/effect-solutions` (439 stars) | website + `bunx effect-solutions show <topic>` | **Reference only.** Pinned to `effect@4.0.0-beta.59`; README examples still import `@effect/platform`. Useful for rationale, not for API names. |
| `joelhooks/effectts-skills` (41 stars, pushed 2026-05-20) | `effect-ts` | **Do not install.** Written against effect-smol betas: uses `ServiceMap.Service` and `Schema.TaggedErrorClass`, neither of which exists in rc.112 (`Context.Service`, `Schema.TaggedError`). Would inject exactly the stale-name bug class Track D warns about. |
| `anomalyco/opencode` `.opencode/skills/effect/SKILL.md` and `AGENTS.md` | in-repo skill | **Borrow rules, do not install.** OpenCode runs `effect@4.0.0-beta.83` with a local patch and still names `Schema.TaggedErrorClass`. Worth copying: "do not return `Effect` from helpers unless they perform effectful work; synchronous parsing stays synchronous", "bind services to named variables before calling methods", "prefer `Schema.UnknownFromJsonString` and `decodeUnknownOption` over `JSON.parse` in `Effect.try`", "keep layer composition explicit", and `it.live` for filesystem/child-process/timing tests. |

Installed on the campaign branch with `npx skills add Effect-TS/skills --skill effect-ts` and
`npx skills add kitlangton/skills --skill effect` (recorded in `skills-lock.json`, stored under
`.agents/skills/`, symlinked from `.claude/skills/`). Skills written against betas drift from the rc;
verify any API name a skill uses against the installed package source before trusting it.

## 7. Dependency and build policy

- `effect` exact-pinned at `4.0.0-rc.112` in `dependencies` (it is inlined into the native binary and
  the extension bundle; it is not Pi-bundled so the peer-only rule does not apply).
- `@effect/vitest` exact-pinned in `devDependencies`. `@effect/platform-node` only when a slice proves
  it needs it; the current plan needs none (child processes and fs stay on Node APIs behind services).
- Lint: ban `from "effect"` root barrel and any `@effect/platform-*` barrel; deep subpaths only.
- Build assertions in `scripts/build-native.mjs` and `scripts/build-host.mjs`: no `effect` module in the
  launcher entry graph; `fast-check` and `msgpackr` absent from metafile inputs.
- Perf gate per slice: `scripts/perf-native-compare.mjs` native-vs-native, `editor_ready` median may not
  rise by more than 1 MAD, `command_ready` may not rise, `editorToCommandGapMs` may not widen.
- Upgrade ritual: bump all `@effect/*` together on a schedule, grep the changelog for "changes the
  public", "is now", "no longer", "update hand-written", typecheck + test, review as a real change.
  No auto-merge. Plan a checkpoint at 4.0.0 final.
