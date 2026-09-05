# Effect v4 (`4.0.0-rc.112`) — Reality Check for SumoCode

**Date:** 2026-09-05 · **Verdict framing:** the refactor is decided; this document exists to make the plan
land on facts rather than on Effect-v3 muscle memory and vibes.

## Machine & toolchain (all measurements below)

| | |
|---|---|
| Host | Apple **M4** (10-core), 16 GB, Mac mini, macOS Darwin 25.5.0 arm64 |
| Node | v25.6.1 |
| Bun | 1.4.0 (`/opt/homebrew/bin/bun`) |
| esbuild | 0.28.2 (matches repo) |
| TypeScript | 6.0.3 (matches repo) |
| effect | 4.0.0-rc.112 |

> **Calibration caveat, stated up front.** SumoCode's quoted budget (editor-ready ≈ 182 ms, command-ready ≈ 732 ms)
> was measured on an **M3 Max**. This host is an **M4 Mac mini**. Single-thread performance is broadly comparable
> (M4 is somewhat faster), so treat the *deltas* below as trustworthy and the *absolute* ms as same-order-of-magnitude
> rather than directly substitutable into the existing budget table. Every percentage-of-budget figure is therefore
> an estimate, not a measurement.

Sample counts: import times n=11, Bun spawn n=15 (interleaved across binaries to spread thermal/scheduler drift),
micro-benchmarks n=7 (after 2 discarded warmups), RSS n=7, `tsc` n=3.

---

# Part 1 — API and stability audit

## 1.1 Module location table (stable root vs `unstable/*` vs platform package)

The `exports` map (`/tmp/effect-rc/package/package.json`) is: `"." -> dist/index.js`, `"./*" -> dist/*.js`,
`"./testing" -> dist/testing/index.js`, `"./unstable/<area>" -> dist/unstable/<area>/index.js`, and
`"./internal/*": null` (internals hard-blocked). Anything at `src/*.ts` is **stable root**.

| Module | Import path in rc.112 | Status |
|---|---|---|
| `Effect`, `Effect.fn`, `Effect.gen` | `effect` / `effect/Effect` | **stable** |
| `Scope` | `effect` / `effect/Scope` | **stable** |
| `Fiber` (+ `FiberHandle`, `FiberMap`, `FiberSet`) | `effect` | **stable** |
| `Semaphore` (+ `PartitionedSemaphore`) | `effect` | **stable** (extracted out of `Effect` in v4) |
| `Queue`, `PubSub`, `Deferred`, `Latch` | `effect` | **stable** |
| `Ref`, `SynchronizedRef`, `SubscriptionRef`, `MutableRef` | `effect` | **stable** |
| `Schedule` | `effect` | **stable** |
| `Stream`, `Sink`, `Channel`, `Pull`, `Take` | `effect` | **stable** (`Pull` is new in v4) |
| `Layer` (+ `LayerMap`, `LayerRef`) | `effect` | **stable** |
| `Context.Service`, `Context.Reference` | `effect/Context` | **stable** |
| `ManagedRuntime` | `effect` | **stable** |
| `Schema` (+ `SchemaAST`, `SchemaIssue`, `SchemaParser`, `SchemaGetter`, `SchemaTransformation`) | `effect` | **stable, in core** (no more `@effect/schema`) |
| `Schema.TaggedError`, `Schema.Class` | `effect/Schema` | **stable** |
| `Result` (replaces `Either`) | `effect/Result` | **stable** |
| `Option`, `Data`, `Cause`, `Exit`, `Duration`, `DateTime`, `Clock`, `Logger` | `effect` | **stable** |
| `FileSystem`, `Path`, `Stdio`, `Terminal` | `effect` | **stable — but interface-only, see below** |
| `TestClock`, `TestConsole`, `TestSchema`, `FastCheck` | `effect/testing` | **stable-ish subpath** (own export entry) |
| `ChildProcess`, `ChildProcessSpawner` | `effect/unstable/process` | **UNSTABLE** |
| `Ndjson`, `Msgpack`, `Sse`, `Yaml`, `Toml`, `Ini`, `SchemaBinary` | `effect/unstable/encoding` | **UNSTABLE** |
| `Worker`, `WorkerRunner`, `Transferable` | `effect/unstable/workers` | **UNSTABLE** |
| RPC (`Rpc`, `RpcGroup`, `RpcSerialization`, …) | `effect/unstable/rpc` | **UNSTABLE** |
| `Socket`, `SocketServer` | `effect/unstable/socket` | **UNSTABLE** |
| `NodeRuntime.runMain` / `BunRuntime.runMain` | `@effect/platform-node` / `@effect/platform-bun` | separate package |

### The platform story — this is the single most load-bearing structural fact

**`@effect/platform` (the v3 umbrella) is gone**, but **`@effect/platform-node` and `@effect/platform-bun` still exist
on the v4 line**, published in lockstep at `4.0.0-rc.112` under the `rc` dist-tag.

Core `effect` ships `FileSystem`/`Path`/`Terminal`/`Stdio` as **interfaces plus `Layer` keys only**. Verified:
`grep -rn "node:fs" src/` across the whole core package returns exactly **one** hit, in an unrelated
HTTP-API Scalar helper. `FileSystem.ts` exports only `layerNoop`; `Path.ts` exports a pure-posix `layer`.
There is no `Effect.runMain` in core either — core exports `Runtime.makeRunMain`, a *factory* you would otherwise
have to implement yourself.

So the real implementations live in `@effect/platform-node@4.0.0-rc.112`:
`NodeFileSystem`, `NodePath`, `NodeRuntime` (`runMain`), `NodeStream`, `NodeSink`, `NodeTerminal`, `NodeStdio`,
`NodeChildProcessSpawner`, `NodeWorker`, `NodeSocket`, `NodeCrypto`, `NodeServices`.
`@effect/platform-bun@4.0.0-rc.112` mirrors it: `BunRuntime` (`runMain`), `BunFileSystem`, `BunPath`, `BunStream`,
`BunTerminal`, `BunStdio`, `BunChildProcessSpawner`, `BunWorker`, `BunSocket`.

**Landmine (measured, see §2.7):** `@effect/platform-node` depends on `undici@^8` and `mime@^4`. Importing the
**barrel** drags both into the bundle. Subpath imports do not.

## 1.2 v4 cheat sheet — what AI agents trained on v3 will get wrong

Effect v4 is **not "v3 with renames"**. Three structural shifts invalidate most v3 muscle memory:

1. **`unsafe*` prefix → `*Unsafe` suffix, universally.** `grep -E "^export const unsafe[A-Za-z]+" src/*.ts` returns **zero** matches.
   `Context.getUnsafe`, `Queue.offerUnsafe`, `Layer.makeMemoMapUnsafe`, `DateTime.makeUnsafe`.
2. **Effect subtyping is gone → `Yieldable`.** `Ref`, `Deferred`, `Fiber`, `Queue` are no longer `Effect`s and are not
   even `Yieldable`. `yield* ref` no longer compiles; you must write `yield* Ref.get(ref)`.
3. **Package consolidation.** `@effect/platform`, `@effect/rpc`, `@effect/cluster`, `@effect/cli`, `@effect/ai`,
   `@effect/sql`, `@effect/experimental` now ship *inside* `effect` under `effect/unstable/*`.

### Top 15 traps (WRONG v3 → RIGHT v4)

| # | WRONG (v3) | RIGHT (v4) |
|---|---|---|
| 1 | `Effect.catchAll(f)` | `Effect.catch(f)` — also `catchAllCause`→`catchCause`, `catchSome`→`catchFilter` |
| 2 | `Either.right(1)` / `Either.left(e)` | `Result.succeed(1)` / `Result.fail(e)` — **`Either` does not exist**; not `ok`/`err` |
| 3 | `class Db extends Context.Tag("Db")<Db, Shape>() {}` | `class Db extends Context.Service<Db, Shape>()("Db") {}` — **types first, string second** |
| 4 | `Effect.provide(Logger.Default)` | no auto `.Default`; write `static readonly layer = Layer.effect(...)`, wire with `Layer.provide` |
| 5 | `Layer.scoped(Tag, acquireRelease)` | `Layer.effect(Tag, acquireRelease)` — **`Layer.scoped` was deleted**; `Layer.effect` excludes `Scope` itself |
| 6 | `Context.unsafeGet`, `Queue.unsafeOffer` | `Context.getUnsafe`, `Queue.offerUnsafe` |
| 7 | `const v = yield* ref` | `const v = yield* Ref.get(ref)`; likewise `Deferred.await`, `Fiber.join`, `Queue.take` |
| 8 | `Effect.map(Option.some(42), f)` | `yield*` it in a generator, or `Option.some(42).asEffect()` |
| 9 | `Effect.fork(eff)` / `Effect.forkDaemon` | **`Effect.forkChild(eff)`** / `Effect.forkDetach` — plain `Effect.fork` does not exist |
| 10 | `Schema.decodeUnknown(User)` | `Schema.decodeUnknownEffect(User)`; `decodeUnknownEither` → `decodeUnknownExit` (**Exit, not Result**) |
| 11 | `Schema.Union(A, B)`, `Schema.Literal("a","b")` | `Schema.Union([A, B])`, `Schema.Literals(["a","b"])`, `Schema.Tuple([A, B])` — **arrays** |
| 12 | `import { ParseResult } from "@effect/schema"` | `SchemaIssue` (issue data + formatters) + `SchemaParser` (runners); `ParseError` → `Schema.SchemaError` |
| 13 | `class E extends Effect.TaggedError("E")<{}> {}` | `class E extends Schema.TaggedError<E>()("E", {...}) {}` — **`Effect.TaggedError` never existed in v4** |
| 14 | `Chunk.toReadonlyArray(yield* Stream.runCollect(s))` | `Stream.runCollect` already returns `Array<A>` — **Chunk is off Stream's surface** |
| 15 | `Effect.gen(this, function*(){})` / `Effect.withConcurrency(10)` | `Effect.gen({ self: this }, function*(){})` / pass `{ concurrency: 10 }` per call site — **no ambient concurrency** |

**Bonus traps:** `Cause` is now a **flat `reasons` array**, not a tree (`Cause.Empty`/`Sequential`/`Parallel` gone).
`Equal.equals({a:1},{a:1})` is now **`true`** (structural by default). **`FiberRef` is entirely gone** →
`Context.Reference` / `References.*`. **`Channel`'s 7 type parameters were reordered**
(`Channel<OutElem, OutErr, OutDone, InElem, InErr, InDone, Env>`). `Effect.async` → `Effect.callback`.
`Effect.loop`/`iterate`/`if`/`orElse` removed. `Effect<A, E, R>`, `Layer<ROut, E, RIn>`, `Stream<A, E, R>`
type-parameter orders are **unchanged**; only `Channel` moved.

**Layer memoization changed semantics:** in v4 the `MemoMap` is shared across `Effect.provide` calls, so the same
layer provided twice builds **once**. Opt out with `Effect.provide(layer, { local: true })` or `Layer.fresh`.

### What the Effect team explicitly tells agents

From `/tmp/effect-rc/package/AGENTS.md` (byte-identical to `CLAUDE.md`) — these are directives, and worth copying
verbatim into SumoCode's own `AGENTS.md`:

- *"When you need to find information about Effect, use this documentation and the Effect source code available in your
  environment. **Avoid unrelated copies of Effect or external documentation, as they may be outdated or incorrect.**"* (l.5-7)
- *"Prefer writing Effect code with `Effect.gen` & `Effect.fn("name")`."* (l.14-16)
- *"**Avoid creating functions that return an `Effect.gen`**, use `Effect.fn` instead."* (l.51-55)
- *"Pass a string to `Effect.fn` … The name string should match the function name."* / *"**Do not** use `.pipe` with `Effect.fn`"* — extra args after the body act as pipe transforms. (l.60-79)
- *"**Always return when raising an error**"* → `return yield* new SomeError({...})`. (l.30-32)
- *"All validation and domain modeling in Effect is done with `Schema`. **AVOID using predicates or manual parsing**."* (l.97-99)
- *"**NEVER** write your own helper functions like `isRecord` or `isString`"* — use `Predicate`. (l.304-310)
- Service ids should be *"package name and the subdirectory path to the service file"*, e.g. `"sumocode/rpc/HostBridge"`. (l.127-129)
- Use `DateTime`, not `Date`/`Date.now`. (l.275)
- From `migration/services.md`: *"**Prefer `yield*` over `use` in most cases** … `use` makes it easy to accidentally leak service dependencies into return values."*

**Migration guide: yes. Codemod: no.**
`https://effect.website/docs/v4/getting-started/migration/` currently **404s**. The real material is in the monorepo:
`MIGRATION.md` (index), **`migration/v3-to-v4.md` (16,611 lines, generated from the API diff)**, plus topic guides
`migration/{services,error-handling,cause,forking,generators,yieldable,scope,equality,fiberref,runtime,layer-memoization,schema}.md`
and `packages/effect/{SCHEMA,OPTIC,CONFIG,HTTPAPI,ARBITRARY}.md`. No user-facing codemod exists on npm or in-repo.

## 1.3 Release cadence, churn, and pin policy

From `npm view effect time --json`:

| Metric | Value |
|---|---|
| First 4.0.0 prerelease | `4.0.0-beta.0`, 2026-02-18 |
| Prereleases to date | **105 betas + 5 rcs** |
| rc line opened | `4.0.0-rc.108`, 2026-08-12 |
| rc.112 published | 2026-08-25 (11 days before this report — the longest quiet gap in the rc line) |
| All `4.0.0-*` in last 30 d | 11 → **one every 2.7 days** |
| All `4.0.0-*` in last 90 d | 40 → **one every 2.25 days** |
| rc→rc only | 5 in 13 days → **one every 2.6 days** |
| Changelog entries across the 5 rcs | **112** (~22 per release, ~8.6/day) |
| Latest stable v3 | 3.22.1, 2026-07-30 (v3 still maintained) |

**rc→rc breaking changes are real and are shipped under "Patch Changes".** Direct quotes from
`packages/effect/CHANGELOG.md`:

- rc.112 (Patch): *"This changes the public `Pool.State` and `Pool.PoolItem` interfaces."*
- rc.112 (Patch): *"This changes the public `Scope.State.Open` interface."*
- rc.111 (Patch): *"The fifth type argument of `Matcher` for value matchers is now `ValueFlavor`, and `ValueMatcher` has a seventh flavor argument; **update hand-written annotations accordingly**."*
- rc.112 also carries a **`### Minor Changes`** section (schema-aware RPC serialization).

Equally telling, rc.111 fixed genuine **runtime concurrency bugs** in primitives SumoCode would depend on:

- *"Fix `Deferred` completion **skipping waiters** when an earlier waiter dies during resume … the next waiter was never resumed and **hung forever**."*
- *"Fix `Effect.fn` binding the final transform as the generator body when using the `{ self }` overload."*
- *"Ensure fiber observer cancellation during exit does not skip remaining observers."*

**Risk assessment for a multi-week refactor:** at ~1 release every 2.25 days, a 4-week refactor spans **~12 releases**.
Semver is *not* protecting you: interface-breaking changes appear in patch bumps, and `^4.0.0-rc.112` will happily
float across them.

**Recommended pin policy:**
- **Exact-pin `effect` and every `@effect/*` to `4.0.0-rc.112`.** No `^`, no `~`. The whole family versions in lockstep,
  so pin them to the identical string.
- Keep them in `dependencies` (not `devDependencies`) — see §3.2.
- Add a scheduled (not automatic) upgrade ritual: bump all `@effect/*` together, read the changelog diff for
  "changes the public" / "is now" / "no longer", run typecheck + tests, and treat it as a reviewed change.
- Do **not** let Dependabot/Renovate auto-merge these.
- Re-evaluate at 4.0.0 final. The 11-day gap after rc.112 plus the rc (not beta) tag suggests final is near, which is
  a reason to expect *one* more meaningful break at the 4.0.0 boundary and then stability.

## 1.4 TypeScript 6 compatibility

- **No `peerDependencies` and no `engines` field at all** in `effect@4.0.0-rc.112`'s `package.json` (both literally absent).
  So there is no machine-enforced TS floor — only documentation.
- `README.md` "Requirements": **"TypeScript 5.9 or newer. TypeScript 7 is recommended for the best performance and
  compatibility with Effect's TypeScript tooling"**, linking `https://github.com/Effect-TS/tsgo`. Also **"Node.js 18 or newer"**
  and **`"strict": true` is mandatory**.
- SumoCode is on TS **^6.0.3** → **supported** (≥5.9), but *not* the recommended TS 7 line. Effect does recommend its
  `tsgo` fork; adopting it is optional and orthogonal — I would not couple it to this refactor.
- **Empirically verified, no issues:** all four benchmark programs typechecked clean under TS 6.0.3 with
  `strict`, `target ES2022`, `moduleResolution: Bundler`, `isolatedModules: true`, **and `skipLibCheck: false`** —
  and again under SumoCode's exact tsconfig options. Zero errors, zero workarounds. `isolatedModules` is fine because
  `dist/` ships real `.js` + `.d.ts`.

## 1.5 Testing

- **`@effect/vitest@4.0.0-rc.112` exists** on the `rc` dist-tag, in lockstep with `effect`.
- Its peer range is **`vitest: ">=4.1.0 <5.0.0"`** and `effect: "^4.0.0-rc.112"`.
  **SumoCode's `vitest ^4.1.5` satisfies this directly** — no vitest upgrade or downgrade required. This is the
  cleanest compatibility result in the whole audit.
- `effect/testing` (own export entry) exports exactly four modules: **`TestClock`, `TestConsole`, `TestSchema`, `FastCheck`**.
  Note `FastCheck` moved out of core root (v3 `effect/FastCheck`) into `effect/testing/FastCheck`.
- Idiomatic patterns (`it.effect`, `layer(...)`) are demonstrated in
  `ai-docs/src/09_testing/10_effect-tests.ts` and `20_layer-tests.ts`.

## 1.6 Bun compatibility, and the fast-check question

- **`BunRuntime.runMain` exists** (`@effect/platform-bun@4.0.0-rc.112`, `dist/BunRuntime.d.ts:27`), as does
  `NodeRuntime.runMain`. Core `effect` only gives you the `Runtime.makeRunMain` factory.
- **`bun build --compile` works cleanly.** All four benchmark programs, plus an `effect/unstable/rpc` probe, compiled and
  ran to exit 0 using SumoCode's exact flags (`--compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv`).
  No warnings, no missing-module errors.

### fast-check: **will NOT ship in the production binary** ✅

`fast-check@^4.9.0` and `msgpackr@^2.0.5` *are* hard `dependencies` of `effect` rc.112 (not optional, not peer).
But the reachability graph saves you:

- The only `import`/`export` of `fast-check` anywhere in `dist/` is **`dist/testing/FastCheck.js:89: export * from "fast-check"`**.
- `dist/Schema.js` and `dist/SchemaAST.js` mention fast-check **only in doc comments**.
- `dist/internal/schema/toArbitrary.js` — the arbitrary-derivation machinery reachable from `Schema` — has **14 import
  statements and none of them is fast-check**; it receives `fc` as an *injected parameter*.
- `"sideEffects": []` is declared, so esbuild tree-shakes aggressively.

**Empirically confirmed:** the `effect-schema` bundle contains **0** matches for `pure-rand` / `prand` / `xoroshiro`
(fast-check's PRNG core), and **0** matches for `fast-check` in the minified output. `msgpackr` is absent from all four
bundles.

**Conclusion:** as long as nothing in the shipped graph imports `effect/testing/FastCheck`, fast-check never enters the
binary. **Add a build-time guard** asserting `fast-check` is absent from the metafile — SumoCode already has exactly this
pattern (`bedrockInputs(piMetafile)` in `build-native.mjs`); mirror it.

### msgpackr: **will ship if you touch RPC serialization** ⚠️

`effect/unstable/rpc/RpcSerialization` **statically** imports `* as Msgpackr`. Measured: a bundle importing only
`RpcSerialization` is **116,686 B** minified with msgpack, and **116,684 B** with ndjson — i.e. **choosing NDJSON does
not tree-shake msgpackr away.** msgpackr's inlined code contains a `try/catch`-guarded dynamic
`require("msgpackr-extract")` (a native addon). It is guarded, so it degrades gracefully, and a `bun --compile` binary
built from it ran cleanly (verified). But it is dead weight plus a native-addon probe you did not ask for.

---

# Part 2 — Measurements

## 2.1 Bundle size (esbuild, `format: esm, platform: node, target: node22`)

| Program | externalized | bundled | **bundled + minified** | **Effect's contribution (minified)** |
|---|---:|---:|---:|---:|
| `baseline` | 977 B | 977 B | **456 B** | — |
| `effect-core` | 2,975 B | 504,557 B | **190,517 B** | **+190,061 B (+186 KB)** |
| `effect-schema` | 3,678 B | 829,347 B | **330,528 B** | **+330,072 B (+322 KB)** |
| `effect-stream` | 3,896 B | 1,012,338 B | **398,720 B** | **+398,264 B (+389 KB)** |

Tree-shaking works, but the floor is high: touching `Effect + Layer + Context + ManagedRuntime + Queue + Deferred +
Fiber + Schedule + Scope` already costs **186 KB minified**. Adding `Schema` costs **+137 KB**; adding `Stream`
costs a further **+66 KB**.

## 2.2 Node import time — and why bundling matters 2x

Time from process start to the line after the import block (`performance.now()`, n=11).

| Program | externalized median | p90 | **Δ** | bundled median | p90 | **Δ** |
|---|---:|---:|---:|---:|---:|---:|
| `baseline` | 28.28 ms | 30.11 | — | 29.50 ms | 32.40 | — |
| `effect-core` | 119.19 ms | 135.91 | **+90.92** | 66.39 ms | 67.77 | **+36.88** |
| `effect-schema` | 114.00 ms | 115.96 | **+85.73** | 72.42 ms | 74.87 | **+42.91** |
| `effect-stream` | 113.93 ms | 122.78 | **+85.65** | 79.27 ms | 83.67 | **+49.77** |

**Key result:** externalized, all three cost the *same* ~86-91 ms regardless of what you import — because
`import { Effect } from "effect"` resolves to `dist/index.js`, a **717-line barrel that re-exports all ~130 modules**.
Bundling + tree-shaking **halves** it to +37-50 ms and makes the cost proportional to what you actually use.

**Implication for SumoCode's dev/source mode (jiti, Node ≥22, unbundled): expect the full ~86-91 ms hit on every
`sumocode` invocation.** That is the *worst* Effect number in this report, and it lands on developers rather than users.
Consider `import { ... } from "effect/Effect"` subpath imports in hot startup paths to sidestep the barrel in dev.

## 2.3 Bun `--compile` binary size

Built from TS source with SumoCode's exact flags (mirroring `build-native.mjs`, which compiles `src/native/main.ts`
directly rather than an esbuild bundle).

| Program | binary | Δ vs baseline | `--minify` binary | Δ vs baseline |
|---|---:|---:|---:|---:|
| `baseline` | 63,910,514 B | — | 63,910,514 B | — |
| `effect-core` | 64,174,706 B | **+264,192 B (+258 KB)** | 64,026,098 B | **+115,584 B (+113 KB)** |
| `effect-schema` | 64,587,506 B | **+676,992 B (+661 KB)** | 64,224,242 B | **+313,728 B (+306 KB)** |
| `effect-stream` | 64,769,138 B | **+858,624 B (+839 KB)** | 64,290,290 B | **+379,776 B (+371 KB)** |

Against a **61 MB** Bun-runtime baseline, Effect adds **0.4%-1.3%**. Effectively noise for distribution.
`--minify` roughly **halves** Effect's contribution (SumoCode does not currently pass it).

## 2.4 Bun binary wall-clock startup — **the number that matters**

`hyperfine` was not available; used an interleaved spawn loop (n=15 per binary, round-robin across binaries,
page cache pre-warmed) measuring full spawn→exit.

| Binary | median | p90 | min | **Δ vs baseline** | est. % of 182 ms editor-ready |
|---|---:|---:|---:|---:|---:|
| `baseline` | 6.47 ms | 8.27 | 6.24 | — | — |
| `effect-core` | 14.33 ms | 20.90 | 13.23 | **+7.86 ms** | ~4.3% |
| `effect-schema` | 22.54 ms | 27.44 | 21.42 | **+16.07 ms** | ~8.8% |
| `effect-stream` | 25.75 ms | 28.11 | 24.61 | **+19.28 ms** | ~10.6% |

With `--minify`:

| Binary | median | p90 | min | Δ vs baseline |
|---|---:|---:|---:|---:|
| `baseline.min` | 6.93 ms | 8.84 | 6.74 | — |
| `effect-core.min` | 13.32 ms | 16.72 | 12.88 | **+6.39 ms** |
| `effect-schema.min` | 22.26 ms | 24.43 | 20.28 | **+15.33 ms** |
| `effect-stream.min` | 23.98 ms | 26.90 | 22.93 | **+17.06 ms** |

**Headline: Effect costs +8 ms (core only) to +19 ms (core + Schema + Stream) of startup in the shipped executable.**
`--minify` buys back only ~1-2 ms of startup (but halves binary size). Against the 182 ms editor-ready budget this is
a **4-11% regression**; against 732 ms command-ready it is **1-3%**.

## 2.5 Runtime overhead micro-benchmarks (n=7, medians, ns/op)

| Case | Node ns/op | Bun ns/op |
|---|---:|---:|
| (i) plain `async/await`, 3 awaits | **75.68** | **49.59** |
| (ii) `Effect.gen` 3 yields, one `runPromise` **per iteration** | **793.70** (10.5× i) | **410.18** (8.3× i) |
| (iii) `Effect.gen` 3 yields, **one** `runPromise` for the whole loop | **62.04** (0.82× i) | **82.79** (1.67× i) |
| (iv) `Schema` decode, 10-field object | **742.12** | **546.26** |
| (v) hand-written `typeof` guard, 10 fields | **8.66** | **4.85** |
| ratio (iv)/(v) | **85.7×** | **112.6×** |

> **Honesty note on (iv)/(v).** My first pass reported the guard at **0.25 ns/op on Bun** — below one clock cycle,
> i.e. the JIT had eliminated the loop, which would have inflated the ratio to a bogus 2165×. The table above is the
> re-run with dead-code elimination defeated (256 distinct input objects, an observed accumulator sink). **These are the
> trustworthy numbers.** The Node figure moved much less (710→742 ns schema, 4.21→8.66 ns guard), so the Node result was
> only mildly optimistic; the Bun guard figure was pure JIT artifact.

**Three findings that will surprise people:**

1. **The `runPromise` boundary is the entire cost — not the Effect runtime.** Crossing Promise↔Effect costs
   **~730 ns (Node) / ~360 ns (Bun)** per call.
2. **Staying inside Effect is FASTER than async/await on Node** — 62.04 vs 75.68 ns/op (0.82×), because Effect's fiber
   scheduler avoids allocating a Promise and a microtask per step. On Bun it is 1.67× slower (Bun's Promises are
   unusually fast), but still cheap in absolute terms.
3. **Schema decode is ~86-113× a hand-written guard**, at **~740 ns (Node) / ~546 ns (Bun)** per 10-field object.

### What event rates in a TUI host would actually notice?

Using the worst case (Node, 793.7 ns per `runPromise`):

| Workload | Rate | Cost of one `runPromise` each | Verdict |
|---|---:|---:|---|
| Render ticks | 60-120 /s | 0.005-0.010% of a core | **invisible** |
| Keystrokes | ~20 /s | 0.002% of a core | **invisible** |
| RPC events during streaming | ~1,000 /s | **0.08%** of a core | **invisible** |
| Token-level stream events | 10,000 /s | 0.8% of a core | **still fine** |
| Per-event `runPromise` | 100,000 /s | 7.9% of a core | first point of concern |
| Break-even (saturate one core) | ~1.26 M /s | 100% | unreachable in a TUI |

**Conclusion: Effect's runtime overhead is invisible at every event rate a TUI host will ever see.** The places that
*could* bite are **bulk** operations, not event rates: Schema-decoding 100k diff lines costs **~74 ms** (Node) versus
~0.9 ms for a hand guard. **Rule of thumb: use Schema at trust boundaries (RPC frames, config, tool args); do not use
Schema inside per-line/per-cell loops.** Likewise, batch work inside a single `runPromise` rather than one per event.

## 2.6 Memory (RSS, n=7 medians)

| Runtime | baseline | after `import` | after `ManagedRuntime` | after 1,000 idle fibers on a `Deferred` | per-fiber |
|---|---:|---:|---:|---:|---:|
| Node (bundled, `--expose-gc`) | 45.05 MB | 58.17 MB (**+13.1**) | 58.31 MB (+0.14) | 62.77 MB (**+4.6**) | **~4.7 KB** |
| Bun (compiled binary) | 12.25 MB | 16.95 MB (**+4.7**) | 18.69 MB (+1.7) | 29.05 MB (**+10.4**) | **~11.0 KB** |

Full-program RSS for the Bun binaries: `baseline` 12.25 MB, `effect-core` 23.42 MB, `effect-schema` 28.94 MB,
`effect-stream` 30.17 MB.

**Reading:** the Effect module graph costs **+4.7 MB (Bun) / +13.1 MB (Node)** just to load. Creating a
`ManagedRuntime` with 3 services is **essentially free (+0.1-1.7 MB)**. Fibers are cheap but **not free at
~4.7-11 KB each** — 1,000 idle fibers is 4.6-10.4 MB. Fibers are far cheaper than OS threads, but do not treat
`forkChild` as zero-cost in unbounded loops; use `FiberSet`/`FiberMap` and bound them.

## 2.7 Type-check tax (`tsc --noEmit`, TS 6.0.3, cold, n=3)

| Config | baseline (1 plain file) | 2 Effect-heavy files | 8 Effect-heavy files | Δ |
|---|---:|---:|---:|---:|
| `skipLibCheck: false` | 814 ms | 1,363 ms | — | **+549 ms (+67%)** |
| **`skipLibCheck: true`** (SumoCode's real setting) | **241 ms** | **499 ms** | **507 ms** | **+258 ms (+107%)** |

**The most reassuring result in the report: the Effect type-check tax is a FIXED cost, not a per-file cost.**
2 Effect files = 499 ms; **8** Effect files = 507 ms. Marginal cost per additional Effect-heavy file ≈ **1.3 ms**.
The +258 ms is a one-time charge for loading Effect's `.d.ts` graph, paid once per `tsc` invocation.

*Caveat:* the 8 files are generated variants of the same shape, so they exercise a narrower slice of the type system
than a real 200-file codebase would; deeply generic user code (custom `Layer` compositions, higher-kinded helpers)
can still be slow to check. But the "Effect makes typechecking scale badly with file count" fear is **not supported**
by this data. Budget ~+0.3 s on `tsc`, not minutes.

## 2.8 Platform-package bundling — an 8× trap (minified, `bundle: true`)

| Import style | bundle size | `undici` | `mime` |
|---|---:|---:|---:|
| `import { NodeFileSystem, NodePath } from "@effect/platform-node"` (**barrel**) | **1,388,469 B** | inlined | inlined |
| `import { layer } from "@effect/platform-node/NodeFileSystem"` (**subpath**) | **172,864 B** | absent | absent |

**Barrel imports cost +1.2 MB and drag in an HTTP client stack you are not using.** Always import platform bits by
subpath. Worth a lint rule.

## 2.9 RPC probe (SumoCode is an RPC host)

| Thing | minified bundle | note |
|---|---:|---|
| Minimal `Rpc.make` + `RpcGroup.make` | 306,981 B | includes Schema |
| `RpcSerialization` alone (msgpack) | 116,686 B | msgpackr inlined |
| `RpcSerialization` alone (ndjson) | 116,684 B | **msgpackr still inlined** |
| `bun --compile` binary delta | +264,192 B | runs clean, exit 0 |

---

## Raw measurements (JSON)

```json
{
  "meta": {
    "machine": "Apple M4 (10 core), 16 GB, macOS Darwin 25.5.0 arm64, Mac mini",
    "caveat": "SumoCode's quoted 182ms/732ms budget was measured on an M3 Max; this host is an M4 Mac mini. Treat absolute ms as same-order, not identical.",
    "node": "v25.6.1", "bun": "1.4.0", "esbuild": "0.28.2", "typescript": "6.0.3", "effect": "4.0.0-rc.112",
    "sampleCounts": { "importTimes": 11, "bunSpawn": 15, "micro": 7, "rss": 7, "tsc": 3 }
  },
  "bundleBytes": {
    "baseline":      { "externalized": 977,  "bundled": 977,     "bundledMinified": 456 },
    "effect-core":   { "externalized": 2975, "bundled": 504557,  "bundledMinified": 190517 },
    "effect-schema": { "externalized": 3678, "bundled": 829347,  "bundledMinified": 330528 },
    "effect-stream": { "externalized": 3896, "bundled": 1012338, "bundledMinified": 398720 }
  },
  "binaryBytes": {
    "baseline":      { "plain": 63910514, "minified": 63910514 },
    "effect-core":   { "plain": 64174706, "minified": 64026098 },
    "effect-schema": { "plain": 64587506, "minified": 64224242 },
    "effect-stream": { "plain": 64769138, "minified": 64290290 }
  },
  "nodeImportMs": {
    "externalized": {
      "baseline":      { "medianMs": 28.28,  "p90Ms": 30.11,  "deltaVsBaselineMs": 0 },
      "effect-core":   { "medianMs": 119.19, "p90Ms": 135.91, "deltaVsBaselineMs": 90.92 },
      "effect-schema": { "medianMs": 114,    "p90Ms": 115.96, "deltaVsBaselineMs": 85.73 },
      "effect-stream": { "medianMs": 113.93, "p90Ms": 122.78, "deltaVsBaselineMs": 85.65 }
    },
    "bundled": {
      "baseline":      { "medianMs": 29.5,  "p90Ms": 32.4,  "deltaVsBaselineMs": 0 },
      "effect-core":   { "medianMs": 66.39, "p90Ms": 67.77, "deltaVsBaselineMs": 36.88 },
      "effect-schema": { "medianMs": 72.42, "p90Ms": 74.87, "deltaVsBaselineMs": 42.91 },
      "effect-stream": { "medianMs": 79.27, "p90Ms": 83.67, "deltaVsBaselineMs": 49.77 }
    }
  },
  "bunSpawnMs": {
    "plain": {
      "baseline":      { "medianMs": 6.47,  "p90Ms": 8.27,  "minMs": 6.24,  "deltaVsBaselineMs": 0 },
      "effect-core":   { "medianMs": 14.33, "p90Ms": 20.9,  "minMs": 13.23, "deltaVsBaselineMs": 7.86 },
      "effect-schema": { "medianMs": 22.54, "p90Ms": 27.44, "minMs": 21.42, "deltaVsBaselineMs": 16.07 },
      "effect-stream": { "medianMs": 25.75, "p90Ms": 28.11, "minMs": 24.61, "deltaVsBaselineMs": 19.28 }
    },
    "minified": {
      "baseline.min":      { "medianMs": 6.93,  "p90Ms": 8.84,  "minMs": 6.74,  "deltaVsBaselineMs": 0 },
      "effect-core.min":   { "medianMs": 13.32, "p90Ms": 16.72, "minMs": 12.88, "deltaVsBaselineMs": 6.39 },
      "effect-schema.min": { "medianMs": 22.26, "p90Ms": 24.43, "minMs": 20.28, "deltaVsBaselineMs": 15.33 },
      "effect-stream.min": { "medianMs": 23.98, "p90Ms": 26.9,  "minMs": 22.93, "deltaVsBaselineMs": 17.06 }
    }
  },
  "micro": {
    "node":                { "plain_async_3awaits": 75.68, "effect_gen_runPromise_per_iter": 793.7, "effect_gen_single_run": 62.04 },
    "node_dceDefeated":    { "schema_decode_10field_ns": 742.12, "handwritten_guard_10field_ns": 8.66, "ratio": 85.7 },
    "bun":                 { "plain_async_3awaits": 49.59, "effect_gen_runPromise_per_iter": 410.18, "effect_gen_single_run": 82.79 },
    "bun_dceDefeated":     { "schema_decode_10field_ns": 546.26, "handwritten_guard_10field_ns": 4.85, "ratio": 112.6 },
    "note": "First-pass handwritten_guard was partially eliminated by the JIT (Bun reported 0.25 ns/op, below one clock cycle). The *_dceDefeated numbers use a 256-object pool and an observed sink and are the trustworthy ones."
  },
  "rss": {
    "node":        { "afterImportMB": 58.17, "afterRuntimeMB": 58.31, "after1000IdleFibersMB": 62.77, "perFiberBytes": 4784 },
    "bunCompiled": { "afterImportMB": 16.95, "afterRuntimeMB": 18.69, "after1000IdleFibersMB": 29.05, "perFiberBytes": 11026 },
    "baselineMB":  { "node": 45.05, "bunCompiled": 12.25 },
    "bunBinaryProgramRssMB": { "baseline": 12.25, "effect-core": 23.42, "effect-schema": 28.94, "effect-stream": 30.17 }
  },
  "tsc": {
    "skipLibCheckFalse": { "baseline1FileMs": [914, 798, 814], "effect2FilesMs": [1454, 1355, 1363], "medianDeltaMs": 549 },
    "skipLibCheckTrue":  { "baseline1FileMs": [286, 241, 231], "effect2FilesMs": [529, 499, 479], "effect8FilesMs": [604, 507, 507], "medianDeltaMs": 258, "marginalPerExtraEffectFileMs": 1.33 },
    "note": "Effect's type-check cost is a ~258ms FIXED cost (loading its .d.ts graph), not per-file: 2 Effect files 499ms vs 8 Effect files 507ms."
  },
  "platformBundle": {
    "barrelImportMinifiedBytes": 1388469,
    "subpathImportMinifiedBytes": 172864,
    "note": "import { NodeFileSystem } from \"@effect/platform-node\" inlines undici+mime; import { layer } from \"@effect/platform-node/NodeFileSystem\" does not."
  },
  "rpcProbe": {
    "minimalRpcGroupMinifiedBytes": 306981,
    "rpcSerializationOnlyMinifiedBytes": 116686,
    "ndjsonOnlyMinifiedBytes": 116684,
    "msgpackrInlinedWhenImportingRpcSerialization": true,
    "bunCompiledBinaryDeltaBytes": 264192,
    "note": "effect/unstable/rpc/RpcSerialization statically imports msgpackr, so choosing ndjson does NOT tree-shake msgpackr away. msgpackr's inlined code contains a try/catch-guarded dynamic require of the native addon 'msgpackr-extract'; a bun --compile binary built from it runs cleanly (verified, exit 0)."
  },
  "treeShaking": {
    "fastCheckInProductionBundle": false,
    "msgpackrInProductionBundle": false,
    "evidence": "0 matches for pure-rand/prand/xoroshiro in effect-schema.bundle.mjs; 0 matches for fast-check in the minified bundle; msgpackr absent from all four benchmark bundles. fast-check is reachable ONLY via effect/testing/FastCheck; internal/schema/toArbitrary.js takes `fc` as an injected parameter and does not import it."
  },
  "releaseCadence": {
    "first4xPrerelease": "4.0.0-beta.0 (2026-02-18)",
    "betas": 105, "rcs": 5,
    "rcLineOpened": "4.0.0-rc.108 (2026-08-12)",
    "rc112Published": "2026-08-25",
    "allPrereleasesLast30d": 11, "allPrereleasesLast90d": 40,
    "medianDaysBetweenReleasesLast90d": 2.25,
    "changelogEntriesAcross5Rcs": 112,
    "breakingInterfaceChangesShippedAsPatch": [
      "rc.112: changes the public Pool.State and Pool.PoolItem interfaces",
      "rc.112: changes the public Scope.State.Open interface",
      "rc.111: Matcher fifth type argument is now ValueFlavor; ValueMatcher has a seventh flavor argument"
    ]
  }
}
```

---

# Part 3 — Verdict: expectations vs evidence

## 3.1 Mapping the maintainer's three expectations

### "Robustness" — **RIGHT, and this is the real payoff**

The evidence supports this, but be specific about *which* mechanisms buy what:

- **Structured concurrency (`Scope`, `forkChild`).** A child fiber cannot outlive its parent scope. For an RPC host
  that spawns a Pi child, tails its stdio, runs render loops, and handles cancellation, this eliminates the entire
  class of "orphaned listener still writing after teardown". This is the strongest single argument.
- **Resource safety (`Layer.effect` with acquire/release, `Scope.addFinalizer`).** Finalizers run on **every** exit
  path — success, failure, *and* interruption. Hand-rolled `try/finally` reliably misses the interruption path.
- **Typed errors in the signature.** `Effect<A, E, R>` makes the error channel a compile-time obligation.
  `Effect.catchTag` in v4 also accepts an **array of tags** plus an `orElse`, so exhaustive handling is ergonomic.
- **`ManagedRuntime` + `Layer` as a real composition root.** Measured cost: **+0.1 MB (Node) / +1.7 MB (Bun)** and
  effectively 0 ms. Dependency wiring becomes typed and testable rather than import-time singletons.
- **Testability.** `TestClock` makes timeout/retry/debounce logic deterministic — a genuine win for a TUI with
  render ticks and streaming, where time-dependent tests are otherwise flaky.

**Counter-evidence you must weigh honestly:** rc.111 shipped a fix for *"`Deferred` completion skipping waiters …
the next waiter was never resumed and **hung forever**"*. You are moving robustness-critical primitives from your own
code (where you can debug them) into a runtime that had a hang-causing `Deferred` bug **two releases ago**. Net, I
still think it is a win — Effect's primitives get far more adversarial testing than a bespoke implementation — but
"more robust" is a medium-term claim, not an immediate one.

### "Fewer bugs" — **RIGHT, for specific and nameable bug classes**

Classes that largely disappear:

1. **Unhandled rejections / swallowed errors.** The error channel is in the type; you cannot silently drop it.
2. **Resource leaks on the cancellation path** — the single hardest class to test and the one `Scope` actually solves.
3. **Orphaned fibers/listeners after teardown** — structured concurrency makes this a type/lifetime property.
4. **Untyped/unvalidated boundary data.** `Schema` at RPC frame and config boundaries turns "cannot read property of
   undefined, three frames later" into one localized decode error with a path.
5. **Lost error context.** v4's flat `Cause` with a `reasons` array preserves multiple concurrent failures instead of
   the first one winning.
6. **Retry/timeout logic bugs.** `Schedule` is declarative and unit-testable with `TestClock`.

Classes that do **not** improve, and one that gets worse:

- Logic errors, off-by-ones, wrong TUI layout math — Effect is orthogonal.
- **A new bug class appears: agent-written v3-shaped Effect code.** With ~40 renamed/removed APIs in the cheat sheet
  above (`catchAll`→`catch`, `fork`→`forkChild`, `Either`→`Result`, `Layer.scoped` deleted, `unsafe*`→`*Unsafe`), any
  model without the v4 cheat sheet in context will produce confidently wrong code. Much of it fails to compile
  (good), but the semantic traps — **shared-MemoMap layer memoization**, **`Equal.equals` now structural by default**,
  **`Effect.provide` accepting arrays** — compile fine and change behaviour. **Mitigation: paste §1.2 into
  `AGENTS.md`, and point agents at `/tmp/effect-rc/package/ai-docs/src/**` as the canonical example corpus.**

### "Maybe some perf" — **MOSTLY WRONG. Expect a small tax, not a gain.**

| Dimension | Reality |
|---|---|
| Startup (shipped binary) | **−8 to −19 ms** (worse). 4-11% of the 182 ms editor-ready budget. |
| Startup (dev/jiti, unbundled) | **−86 to −91 ms** (worse) — the barrel import is the culprit. |
| Binary size | **+258 to +839 KB** (+113 to +371 KB with `--minify`) on a 61 MB base — negligible. |
| RSS | **+4.7 MB (Bun) / +13.1 MB (Node)** to load; runtime creation ~free; fibers ~4.7-11 KB each. |
| Steady-state compute *inside* Effect | **Neutral to slightly better.** 62.04 vs 75.68 ns/op on Node (0.82×) — genuinely faster than async/await. Bun: 1.67× slower. |
| `runPromise` boundary crossings | **~730 ns (Node) / ~360 ns (Bun)** each — the one thing to actually design around. |
| `Schema` decode | **~86-113× a hand-written guard** (742 ns vs 8.7 ns on Node). |
| Typecheck | **+258 ms fixed**, ~1.3 ms marginal per file. |

**The honest framing to put in the plan:** *"Effect costs ~10-20 ms of startup and ~5 MB of RSS. It does not make
anything faster. The one real performance rule is: minimize `runPromise` boundary crossings and keep `Schema` out of
hot loops."* There is a *narrow* perf win available — long-lived logic that stays inside a single Effect runtime beats
Promise-per-step async/await on Node — but it is not a reason to do the refactor.

## 3.2 Recommended dependency policy

```jsonc
// package.json — "dependencies", NOT devDependencies:
// the host binary and the extension bundle both inline Effect at build time,
// so it is a production dependency of the shipped artifact.
"dependencies": {
  "effect": "4.0.0-rc.112",                      // exact pin, no ^ or ~
  "@effect/platform-node": "4.0.0-rc.112",       // exact, lockstep
  "@effect/platform-bun": "4.0.0-rc.112"         // exact, lockstep — only if the host uses BunRuntime
},
"devDependencies": {
  "@effect/vitest": "4.0.0-rc.112"               // exact; peer-compatible with your vitest ^4.1.5
}
```

**Rationale and interactions:**

1. **Exact pins.** `^4.0.0-rc.112` floats across releases that ship interface breakage in *patch* bumps (§1.3).
   At ~1 release / 2.25 days, a 4-week refactor would otherwise absorb ~12 uncontrolled upgrades.
2. **All `@effect/*` move together.** Never bump one without the others; `@effect/platform-node@4.0.0-rc.112`
   declares `effect: "^4.0.0-rc.112"` as a peer.
3. **`dependencies`, not `devDependencies`** — even though it is bundled. The native binary and the extension bundle
   both inline it, and `check-dependency-audit.mjs` / provenance tooling should see it as a shipped input.
4. **Extension bundle externals rule is unaffected.** `build-extension.mjs` externalizes *only* `@earendil-works/*`
   and `typebox`, and guards against surviving bare imports. `effect` is not in that allowlist, so it gets **inlined**
   — which is exactly right (Pi's loader could not resolve it otherwise). Budget **+186 KB minified** for
   core Effect in the extension bundle, more with Schema. Verify against the existing bare-import guard after the
   first Effect import lands.
5. **Add a `fast-check` absence assertion to the native build.** Mirror the existing `bedrockInputs(piMetafile)`
   pattern: fail the build if `fast-check` appears in the metafile inputs. It is a hard dependency of `effect` and
   only one stray `effect/testing/FastCheck` import away from shipping.
6. **Add a lint rule banning `@effect/platform-node` / `@effect/platform-bun` barrel imports.** Measured 8× / +1.2 MB.
7. **Set an upgrade ritual, not an upgrade bot.** Bump all `@effect/*` together on a schedule; grep the changelog for
   `changes the public`, `is now`, `no longer`, `update hand-written`; run typecheck + tests; review as a real change.
   Exclude `@effect/*` from auto-merge.
8. **Consider adding `--minify` to `bun build --compile`.** Halves Effect's binary contribution and costs nothing;
   measure stack-trace quality first, since SumoCode surfaces errors to users.

## 3.3 Surprises to plan for

1. **`@effect/platform-node` is a required second dependency.** Core `effect` has no real `FileSystem`, no `Path` impl,
   and no `runMain`. Anyone reading "v4 consolidated everything into core" will be wrong about the part you need most.
2. **The barrel import is a 2× startup tax in dev.** `import { Effect } from "effect"` loads all ~130 modules
   (+86-91 ms unbundled). Bundled it drops to +37-50 ms. **Dev/jiti mode pays the full price.** Use `effect/Effect`
   subpath imports in hot startup paths.
3. **`@effect/platform-node` barrel import = +1.2 MB and inlines `undici`.** Subpath imports only.
4. **`RpcSerialization` inlines `msgpackr` even if you only use NDJSON** (+116 KB, plus a guarded native-addon probe
   for `msgpackr-extract`). Not avoidable by picking a serializer.
5. **Everything you need for an RPC host is `effect/unstable/*`.** `ChildProcess`, `Ndjson`, `Msgpack`, `Worker`,
   `Socket`, and all of RPC are explicitly unstable and *will* churn before 4.0.0 final. Wrap them behind your own
   thin interfaces so churn hits one file, not fifty.
6. **`fast-check` is a hard dependency of `effect`.** It tree-shakes out today (verified: 0 `pure-rand` matches), but
   that is a property of the import graph, not a guarantee. Assert it in the build.
7. **Breaking interface changes ship in *patch* releases.** Semver will not protect you. Exact-pin.
8. **AI agents will write v3 Effect.** ~40 renamed/removed APIs. Ship the cheat sheet in `AGENTS.md`.
9. **Silent semantic changes that still compile:** shared-`MemoMap` layer memoization (same layer provided twice now
   builds *once*); `Equal.equals({a:1},{a:1})` is now `true`; `Effect.provide` accepts arrays; `Stream.runCollect`
   returns `Array`, not `Chunk`.
10. **Fibers cost ~4.7-11 KB each.** Cheap, not free. Bound them with `FiberSet`/`FiberMap`.
11. **`Schema` is not a validator you sprinkle everywhere.** ~740 ns per 10-field decode. Trust boundaries only.
12. **TS 6.0.3 works fine, but Effect recommends TS 7 + its own `tsgo` fork.** Expect that recommendation to get
    louder; do not couple it to this refactor.
13. **No codemod exists.** The migration guide is a 16,611-line generated API diff. Budget human/agent reading time.
14. **`effect.website/docs/v4/getting-started/migration/` 404s today.** The source of truth is the GitHub monorepo
    (`MIGRATION.md`, `migration/*.md`) and the shipped `ai-docs/src/**` corpus — which is typechecked, idiomatic v4 and
    the single best thing to point agents at.
15. **4.0.0 final is probably close** (rc line since 2026-08-12; 11-day quiet gap after rc.112). Expect one more
    meaningful break at the 4.0.0 boundary, then stability. Plan a deliberate "move to 4.0.0 final" checkpoint.
