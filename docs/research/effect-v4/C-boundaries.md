# Effect v4 adoption — Track C: data boundaries, errors, persistence, testing, do-not-touch

Analysis tree: `/tmp/sumocode-stack-tip` (PR-stack tip, `99b8cc4d`). Read-only.
Effect source of truth: `/tmp/effect-rc/package` = `effect@4.0.0-rc.112`.
All benchmarks below were run against `/tmp/effect-rc/package/dist` on this machine (Node 25.6.1), not recalled.

---

## 0. Verified Effect v4 facts (rc.112) — do not trust Effect 3 memory

| Claim | Verified | Where |
|---|---|---|
| `Schema` is in core `effect`, not `@effect/schema` | yes | `/tmp/effect-rc/package/src/Schema.ts` |
| `Schema.Struct`, `Schema.Union`, `Schema.Literal`, `Schema.Literals`, `Schema.Record`, `Schema.Tuple`, `Schema.TaggedUnion`, `Schema.Opaque` are **functions** | yes | `src/Schema.ts:3581, 4923, 2785, 4969, 3961, 4412, 6470, 6537` |
| `Schema.Class`, `Schema.TaggedError` | yes | `src/Schema.ts:14660, 15207` |
| `Schema.optionalKey` / `optional` / `mutableKey` | yes | `src/Schema.ts:2444, 2511, 2579` |
| `Schema.decodeUnknownSync` / `decodeUnknownResult` / `decodeUnknownOption` / `decodeUnknownEffect` | yes | `src/Schema.ts:1920, 1773, 1709, 1516` |
| `Schema.decodeSync` = alias of `decodeUnknownSync`; `decodeResult` = alias of `decodeUnknownResult` | yes | `src/Schema.ts:1953, 1808` |
| `Schema.fromJsonString(schema)` — string↔value codec | yes | `src/Schema.ts:12789` |
| `Schema.Json` / `Schema.JsonObject` — a real codec for arbitrary JSON | yes | `src/Schema.ts:16807, 16834` |
| `Schema.catchDecoding(f)` — per-field decode recovery | yes | `src/Schema.ts:5423` |
| `Schema.toStandardSchemaV1` | yes | `src/Schema.ts:1299` |
| `SchemaError extends Data.TaggedError("SchemaError")` | yes | `src/Schema.ts:1180` |
| **Either was renamed `Result<A, E>`** (success type first) | yes | `src/Result.ts:66` — `Success \| Failure`; `Result.succeed/fail/match/getOrElse/…` |
| `Option` unchanged in spirit (`some/none/match/getOrElse/getOrUndefined`) | yes | `src/Option.ts:256, 286, 403, 647, 1239` |
| `Effect.catchTag` / `catchTags` / `catchReason` / `catchReasons` / `unwrapReason` | yes | `ai-docs/src/01_effect/04_errors/10_catch-tags.ts`, `20_reason-errors.ts` |
| **`FileSystem` and `Path` moved into core `effect`** (no `@effect/platform` in v4) | yes | `src/FileSystem.ts:663`, `src/Path.ts:255`; npm `@effect/platform` has **no** `rc`/`4.x` dist-tag (latest `0.97.1`) |
| Node implementations live in `@effect/platform-node@4.0.0-rc.112` (has an `rc` dist-tag) | yes | `npm view @effect/platform-node dist-tags` |
| `FileSystem.layerNoop` / `makeNoop(partial)` — in-memory/stub layer for tests | yes | `src/FileSystem.ts:954, 825` |
| `KeyValueStore` with `layerMemory`, `layerFileSystem(dir)`, and **`toSchemaStore(kv, schema)`** | yes | `src/unstable/persistence/KeyValueStore.ts:331, 368, 782` — note **`effect/unstable/**` namespace = explicitly unstable** |
| `effect/testing` ships `TestClock`, `TestConsole`, `TestSchema`, `FastCheck` | yes | `ls /tmp/effect-rc/package/src/testing` |
| `@effect/vitest@4.0.0-rc.112` exists; peer `vitest ">=4.1.0 <5.0.0"`, `effect "^4.0.0-rc.112"` | yes | `npm view @effect/vitest@4.0.0-rc.112 peerDependencies` |
| **`Data.struct` / `Data.tuple` / `Data.array` are GONE in v4.** Only `Data.Class`, `Data.TaggedClass`, `Data.taggedEnum`, `Data.Error`, `Data.TaggedError` | yes | `src/Data.ts:48, 91, 580, 1062, 1111` |
| `effect` is **ESM-only** (`"type": "module"`, no `require` condition), deps `fast-check` + `msgpackr` | yes | `/tmp/effect-rc/package/package.json` |
| Subpath deep imports work: `"./*" -> "./dist/*.js"`, `"./testing"`, `"./unstable/persistence"` | yes | same |
| Schema parsers are **compiled once per AST and memoized**, not re-interpreted per call | yes | `src/SchemaParser.ts:1027-1029` `memoize((ast) => makeParser(...))` |

### Immediate compatibility verdict for this repo

`/tmp/sumocode-stack-tip/package.json` already pins `vitest: ^4.1.5` and `typescript: ^6.0.3`. **`@effect/vitest@4.0.0-rc.112` drops in with zero version negotiation.** That is unusually lucky and removes the single most common blocker for an Effect testing migration.

---

## 1. Measured cost — the numbers that settle the hot-path argument

I benchmarked rc.112 directly rather than speculating. Scripts: `/tmp/bench-schema.mjs`, `/tmp/bench-schema2.mjs`, `/tmp/bench-eq.mjs`, `/tmp/bench-runtime.mjs`.

### 1a. Module import cost (this is the real cost, and it is at startup)

| Import | Cold ms |
|---|---|
| `import "effect"` (root barrel, re-exports all 138 modules) | **124.8 ms** |
| `import "effect/Schema"` | **63.3 ms** |
| `import "effect/Effect"` | **20.5 ms** |

Baseline to compare against, from `/tmp/sumocode-stack-tip/docs/perf/startup.json` and `docs/perf/real-world.md`:
- `host-import` p50 ≈ **1080 ms** (samples 1901/1076/1080/…)
- `launcher-dry-run` avgMiddle **31.1 ms**
- real-world median `startup_ms` **429 ms**, `app_ready_ms` **1330 ms**

So a naive `import { Schema, Effect } from "effect"` costs ~**125 ms ≈ 9–12 % of `app_ready`**. A deep `import * as Schema from "effect/Schema"` costs ~63 ms ≈ 5 %. `effect/Effect` alone is ~20 ms ≈ 1.5 %.

**Mandate: deep imports only (`effect/Schema`, `effect/Effect`, `effect/Option`), never the root barrel.** The repo already has the gate to enforce this — `scripts/perf-startup.mjs` writes `docs/perf/startup.json` and `.github/workflows/perf.yml` runs it. Add a `host-import` budget assertion before slice 1 lands.

Note `launcher-dry-run` is 31 ms total. **Nothing in the launcher path (`src/native/main.ts` pre-spawn argv classification) may import Effect at all** — 20 ms of `effect/Effect` would be a 65 % regression on that number.

### 1b. Per-event decode cost (the objection everyone expects — it does not hold)

Small streaming-delta shape (`{type, sessionId, messageId, index, text}`), including `JSON.parse`:

| | µs/op |
|---|---|
| `JSON.parse` only | 0.290 |
| `JSON.parse` + hand-rolled `typeof` guard | **0.224** |
| `JSON.parse` + `Schema.decodeUnknownSync` | **0.361** |
| `JSON.parse` + `Schema.decodeUnknownResult` | 0.374 |
| FAIL path, hand-rolled | 0.218 |
| FAIL path, `Schema.decodeUnknownResult` | 0.768 |

Delta on the success path: **+0.14 µs per event**. At an aggressive 1 000 token-deltas/sec that is **0.14 ms of CPU per second — 0.014 %**. The decode-cost objection on the streaming path is empirically dead.

Larger nested shape (12-part assistant message with a `Schema.Union` of text/tool parts), pre-parsed object, no `JSON.parse`:

| | µs/op |
|---|---|
| hand-rolled nested guard | 0.036 |
| `Schema.decodeUnknownSync` | **1.642** |

That is a 45× *relative* multiple but **1.6 µs absolute**. Per-message, not per-token. Even 100 messages in one frame rebuild costs 0.16 ms — invisible next to the Yoga layout pass.

**Honest conclusion: Schema decode cost is a non-issue for SumoCode. The cost of Effect is module load time at startup, not decode time at runtime.** Every hot-path anxiety should be redirected to the import graph.

### 1c. Runtime and data-module cost (informs the do-not-touch map)

| | µs/op |
|---|---|
| plain sync fn call | 0.0036 |
| `Effect.runSync(Effect.succeed(1))` | 0.0099 |
| `Effect.runSync(prebuilt map chain)` | **0.1793** |
| `Equal.equals` on two `Data.Class` instances | **0.0214** |
| `Equal.equals` on two plain objects (falls back to reference eq) | 0.0249 |
| `JSON.stringify(a) === JSON.stringify(b)` | **0.0999** |
| `Option.getOrElse(Option.some(1), …)` | 0.0070 |

Two conclusions:
1. **`Effect.runSync` in a per-frame/per-cell loop is ~50× a plain call.** Keep the Effect *runtime* out of the render pipeline. This is the quantitative basis for the do-not-touch map in §6.
2. **`Equal.equals` on `Data.Class` is 4.7× *faster* than the `JSON.stringify` deep-compare the repo actually uses**, and correct where the string compare is not. That is a rare case where an Effect data module is both faster and safer — see `src/sumo-tui/transcript/controller.ts:187-193`.

---

## 2. Untrusted-data boundaries → Schema

### 2.0 The census

| Metric (non-test `src/**`) | Count |
|---|---|
| lines containing `typeof` | **440** |
| hand-rolled `is*` / `as*` boundary helper functions | **210** |
| `JSON.parse(` call sites | **37** (35 wrapped in try/catch; **32 of those swallow to a default**) |
| `as unknown as` | 8 — **none are data decode** (7 are `process.stdout.write` monkey-patching in `render-diagnostics.ts`, 1 is a Pi structural bridge) |
| `as any` | **0** (the single grep hit is the English phrase "same as any" in a comment at `src/subagents/backend-pi.ts:602`) |
| lines containing `catch` | 406 (~380 real catch sites) |

Top `typeof` density: `src/native-task-tool.ts` (46), `src/render-diagnostics.ts` (25), `src/subagents/roles.ts` (14), `src/native-task-params.ts` (11), `src/background-tasks/task-store.ts` (11).
Top `is*`/`as*` density: `task-store.ts` (14), `activity/domain.ts` (13), `transcript/view-model.ts` (11), `rpc/lovely-web-config.ts` (9), `activity/subagent-adapter.ts` (8).

**Give the repo its due first.** The `as any` count of zero, the total absence of decode-motivated `as unknown as`, the universal `// SAFETY:` comment convention, the systematic byte-bounding primitives in `src/child-protocol.ts:56-173`, and decoders like `src/sumo-tui/pi-compat/tree-navigation-command.ts` (canonical-base64url round-trip check, **exact key-set matching** at `:67-71`, per-field byte caps, control-character scans) put this well above the median TypeScript codebase. This is not a rescue job. The argument for Schema here is about **eliminating duplication and closing the observability hole**, not about cleaning up slop.

### 2.1 The structural finding: there is no central event validator, and 11 guard families disagree

`src/sumo-tui/rpc/client.ts:374-417` is the single funnel for the entire Pi event stream. Its dispatch is a **negative filter**:

```ts
parsed = JSON.parse(line) as RpcMessageLike;          // :379
if (!isMessageRecord(parsed)) return;                 // :394
if (isResponse(parsed)) { … return; }
if (isExtensionUiRequest(parsed)) { … return; }
this.dispatchEvent(parsed as AgentSessionEvent);      // :416  ← everything else
```

Anything with any `type` (or no `type`) becomes an agent event. Grepping non-test `src/**` for `isAgentSessionEvent|validateEvent|parseAgentEvent|isValidEvent` returns **zero hits**. `src/sumo-tui/rpc/host.ts:1299-1304` then fans that one object to **four consumers that each re-derive shape from scratch**:

| Consumer | Entry | Its own guard vocabulary |
|---|---|---|
| `transcript/controller.ts:407` | `asRecord(event as SessionValue)` | `isRecord`/`isString`/`isNumber`/`isBigint` (`:80-98`) |
| `rpc/state.ts:153` | `event as JsonValue` | local `JsonValue` + `isString`/`isJsonObject` (`:42-51`) |
| `rpc/prompt-scheduler.ts:186` | structural `RpcSchedulerEvent` | `Array.isArray` only (`:79`) |
| `pi-compat/chat-viewport-controller.ts:395` | `asRecord(event as SessionValue)` | `isRecord`/`isString` (`:37-46`) |

At least **eleven** near-duplicate `isRecord`/`isString` families exist (`view-model.ts:106-152`, `controller.ts:80-98`, `state.ts:46-51`, `session-reader.ts:109-127`, `session-tree.ts:30-36`, `chrome-cache.ts:43-53`, `tree-navigation-command.ts:5-11`, `bash-execution-mirror.ts:14-19`, `region-registry.ts:151-169`, `chat-viewport-controller.ts:37-46`, `lovely-web-config.ts:80-194`). **They are not consistent:**

- `tree-navigation-command.ts:6` excludes arrays.
- `view-model.ts:106-109` *deliberately* includes arrays ("Mirrors the historical coercion exactly").
- `src/sumo-tui/rpc/chrome-cache-worker-client.ts:11-13` **forgets `!== null` entirely** — verified first-hand:
  ```ts
  function isCachedChrome(value: ChromeCacheWorkerValue): value is ChromeCacheReadValue {
      return typeof value === "object";
  }
  ```
  A `null` reply from the worker passes, and `value.modelLabel` at `:84` throws a `TypeError`, masked by `catch { return undefined; }` at `:87-89`.
- `session-reader.ts:125-127`'s `isTextBlock` checks `block["type"] === "text"` but **not** that `block["text"]` is a string, so `extractTextContent` (`:129-137`) can join `"[object Object]"` into the resume list. Its sibling `session-tree.ts:34-36` checks it correctly. **Same wire shape, two implementations, one wrong.**

**This class of bug — n hand-written guards for one shape, drifting apart — is exactly what a single `Schema.Class` deletes.** One `PiAgentEvent` tagged union decoded once at `client.ts:379`, and all four consumers receive a value whose shape is a type-level fact.

### 2.2 Two live bugs the type-guard discipline did not catch

Both verified by direct read, both on the hot path.

**(a) Unbounded `contentIndex` — memory amplification from a single RPC frame.**
`/tmp/sumocode-stack-tip/src/sumo-tui/transcript/controller.ts:125-127`:
```ts
const rawIndex = event.contentIndex;
const index = isNumber(rawIndex) && rawIndex >= 0 ? Math.floor(rawIndex) : content.length;
while (content.length <= index) content.push({ type: "text", text: "" });
```
`contentIndex` is producer-controlled and checked only for `>= 0`. One `message_update` with `contentIndex: 50_000_000` pushes 50 M objects synchronously on the render thread. Every *other* numeric bound in this repo has an explicit cap (`enabled-models.ts`, `chrome-cache.ts:12`, the seven `MAX_TREE_NAVIGATION_*` constants). This one does not, and it sits in `applyAssistantStreamDelta`, the hottest decode function in the tree. A `Schema.Int.pipe(Schema.between(0, MAX_CONTENT_PARTS))` field makes this unrepresentable.

**(b) `onProtocolError` is dead code in production.**
`client.ts:66` declares it, `client.ts:384` calls it — and grep across non-test `src/**` finds **no other reference**. The only production construction site, `src/sumo-tui/rpc/host.ts:966-973`, passes only `onRpcReady`. So every malformed frame below the 3-consecutive threshold (`MAX_CONSECUTIVE_PROTOCOL_ERRORS = 3`, `client.ts:71`, reset to 0 on any success at `:390`) vanishes with **zero** observability. A producer alternating good/garbage frames drops garbage forever, silently, in the streaming path.

### 2.3 Per-boundary table

Frequency legend: **HOT** = per streaming delta (~20–100/s during a turn) · **WARM** = per message/keypress/poll · **COLD** = startup or explicit user action.

| Boundary | Decodes | Today's failure mode | Freq | Schema value |
|---|---|---|---|---|
| `rpc/client.ts:374-417` | child stdout NDJSON → response / ui-request / **open-ended event** | parse error → silent `return` (`:388`); unmatched response id → silent (`:398`); unclaimed type → `as AgentSessionEvent` (`:416`) | **HOT** | **Highest.** One `Schema.TaggedUnion` at the transport; unknown `_tag` becomes a typed `UnknownEventError` instead of a downstream mystery |
| `transcript/controller.ts:116-154, 401-422` | assistant stream deltas folded into a draft | `!record \|\| !isString(record.type)` → returns the *previous* transcript (`:408`) — invisible | **HOT** | Fixes bug (a); replaces the fold's 8 inline `isString`/`isNumber` guards |
| `rpc/state.ts:150-203` | same event, second decode | every case defaults silently; `hydrateFromRpcState:111-134` copies `sessionId/sessionName/sessionFile/thinkingLevel/isStreaming/messageCount` **with zero validation** (only `.model` is guarded) | **HOT** / per-session | Shared decoded type removes the second implementation entirely |
| `pi-compat/chat-viewport-controller.ts:392-424` | same event, third decode | `record.reason as CompactionReason` (`:419`) trusts the producer, while `state.ts:75-78` whitelists the *same field* | **HOT** | Removes a divergent trust model for one field |
| `native-task-tool.ts:749-756, 1167-1224` | subagent child NDJSON (`pi --mode json`) | `catch { return undefined; }` → **silent drop, no counter**; per-field defaults (`name: … ?? "tool"`, `isError !== true ⇒ "success"`); `as AssistantMessage["provider"]` unchecked at `:959-966` | **HOT** | Unversioned *wire* protocol against a binary chosen by an unvalidated env var — see §2.5 |
| `child-protocol.ts:197-283` | byte framing (NDJSON, 8 MiB caps) | fail-**closed**: cap breach kills the child | HOT | **Leave alone.** Byte-level, pre-JSON, correct |
| `activity/store.ts:100-123` + `activity/domain.ts:164-239` | `feed.json`/`ui.json` written by other processes | strict reject → `"corrupt"` diagnostic; **retains last known good** (`feedKnownGood`, `:397-399`) | **WARM** (25 ms debounce + 2 s poll) | Modest — already the cleanest decoder in the tree. `Schema.catchDecoding` would upgrade all-or-nothing rejection to per-activity |
| `background-tasks/task-store.ts:257-328` | `meta.json` written by concurrent SumoCode processes | 3-way `{ok\|transient\|invalid}` (`:865-902`), every path diagnosed | COLD/periodic | Modest — **best-designed decoder in the repo.** Its `TRANSIENT_READ_ERRNOS` split is the model for §3 |
| `config/sumocode-config.ts:82-89, 175-191` | `.sumocode.json` ×3 tiers (project-local ⇒ repo-controlled) | `catch { continue; }` + `if (!config) continue;` — **fully silent**; typo'd config silently reverts to defaults. Save path returns `{success:false,error}` — **read/write disagree on whether corruption matters** | COLD | High — small file, zero decode cost, currently zero diagnostics, no `schemaVersion` |
| `mcp-config-reader.ts:72-85` | 4 MCP config files (`.mcp.json` repo-controlled) | `catch { return undefined; }` — fail-closed, documented, **but silent**; `parsed as McpConfigFile` at `:80` is false for array input | COLD (memoized, never invalidated) | Medium; schema owned upstream by `pi-mcp-adapter` |
| `subagents/roles.ts:113-201` | operator `roles.json` | ⭐ **only decoder that reports structurally** — `RoleWarning` with `blocksOverlays`/`blocksRole` | COLD | Medium — but see the closed-field-set hazard in §2.5 |
| `rpc/lovely-web-config.ts:84-91` | user config JSON | **only reader with no try/catch around `JSON.parse`** (`:88`) — raw `SyntaxError` escapes | COLD | Medium |
| `rpc/enabled-models.ts:27-38, 57-83` | `settings.json` `enabledModels` | `catch { return [] }` → **fails open**: corrupt file silently disables all model filtering. Also compiles a `RegExp` from file globs (`:57-83`) — the only user-data-driven regex in the tree | COLD | Medium; fail-open direction is the real issue |
| `rpc/session-reader.ts:88-97` | Pi `.jsonl` session files | `catch { return undefined; }` at every level; **corrupt file ≡ empty file** | COLD | Medium |
| `rpc/session-tree.ts:46` | tree from session entries | ⚠️ `throw new Error("duplicate session entry id")` with **no try/catch at the call site** (`session-reader.ts:321-326`) — corrupt file crashes `/tree` | COLD | Medium |
| `rpc/chrome-cache.ts:55-73` | advisory startup cache | version-pinned, byte-capped, per-field validated, fields copied individually (prototype-pollution-safe) | COLD | **Low — already exemplary.** But its worker sibling has bug (a′) in §2.1 |
| `rpc/response.ts:8-21` | RPC responses | ⭐ **only boundary that throws.** Validates `success` + `command`, returns `.data` **entirely unvalidated** (`:20`) | WARM | High-leverage, tiny diff: `expectRpcSuccess` gains a schema param and `controls.ts`'s 25 `responseData(...)` call sites become validated for free |
| `native-task-params.ts:66-191` | **LLM-generated** tool params | ✅ `{ok:true,value} \| {ok:false,error}`, never throws, errors go back to the model | WARM | **This is already `Result`.** Mechanical port, near-zero risk — good slice-1 candidate |
| `pi-compat/tree-navigation-command.ts` | base64url smuggled payloads | ⭐ throws per violation with a specific message; exact key-set match | COLD | **Low.** Schema would be a lateral move; keep as the reference decoder |
| `executable-provenance.ts:14-24` | `PI_BIN`, `SUMOCODE_LAUNCHER` env | **no validation at all**; cannot fail; typo surfaces as an `ENOENT` from `spawn` much later | COLD | High *severity*, trivial fix — this is the root of the §2.5 wire-skew problem |
| `herdr-rpc-bridge.ts:264-274` | Pi `events` bus (`herdr:blocked`) | `report.label` assigned to `blockedMessage` with **no `isString` check** (`:270`), then `JSON.stringify`d onto a socket (`:70`) | WARM | Medium |
| `scripts/lib/host-bundle.mjs:109-136` | `dist/host/.inputs.json` | ✅ versioned (`v2`), TOCTOU stat-signature before/after hashing, `version: 0` write barrier | COLD (×2 per launch) | **Low.** Plain `.mjs`, outside `tsc`. Leave it |
| `src/native/main.ts:110-260` | **argv** | classifier that must mirror Pi's arg grammar byte-for-byte | COLD | **None — see §8** |
| `docs/perf/startup.json` | — | **no runtime consumer.** Write-only perf evidence from `scripts/perf-startup.mjs:11` | — | **None** |

### 2.4 `SessionValue` is the tell

`src/sumo-tui/transcript/view-model.ts:20-33` defines a hand-rolled recursive JSON-value union with the doc comment *"Structural on purpose: every field is re-validated by the `is*`/`as*` helpers below."* It has **69 non-test references**.

`SessionValue` exists because the repo may not write `unknown` — `anti-slop/no-unknown-type-aliases` and `no-unknown-parameters` are both `"error"` (`oxlint.config.ts:35, 34`). So it invented a JSON tree type and then paid for it with 11 guard helpers in that one file and 210 across the repo.

**Effect ships this exact type as a codec: `Schema.Json` (`src/Schema.ts:16807`) and `Schema.JsonObject` (`:16834`).** Replacing `SessionValue` with a decoded `Schema.Class` at the boundary deletes the alias, the guard family, and the lint workaround simultaneously.

### 2.5 Versioning — three formats are versioned well, three are not, and the unversioned ones are the risky ones

**Well versioned (leave the mechanism, keep it if you port):**
- `background-tasks/task-store.ts` — `TERMINAL_TASK_SCHEMA_VERSION` checked at `:260`; **legacy v2/v3 are named and quarantined** at `:880-883` rather than migrated or deleted; `create()` refuses non-current writes (`:683`).
- `activity/persistence.ts` — `ACTIVITY_SCHEMA_VERSION = 1` (`:24`), `PRIVATE_FILE_LOCK_SCHEMA_VERSION = 1` (`:32`), **plus `v1` baked into the directory path** (`:193-195`) so a v2 cannot collide.
- `scripts/lib/host-bundle.mjs:14` — `v2` with a `version: 0` write barrier at `build-host.mjs:52`. ⚠️ but its twin `src/extension-entry.ts:7` is an **independent constant that must be bumped in lockstep**.

**Not versioned, and evolvable:**
- `config/sumocode-config.ts` — hand-edited, **round-tripped** (unknown keys preserved at `:120`), no version field. Changing the meaning of `primaryAgentName` has no migration hook.
- `subagents/roles.ts` — hand-edited with a **closed** field set that warns on unknown fields (`:128`). Forward-compat is actively hostile: a field added in a newer SumoCode produces spurious warnings on older builds.
- ⚠️ **`native-task-tool.ts:1173-1215` — Pi's private print-mode NDJSON vocabulary**, matched by bare string equality with no version negotiation and no unknown-type diagnostic, against a binary selected by the **unvalidated** `PI_BIN` env var (`executable-provenance.ts:22`). A Pi version bump silently produces empty subagent output. Given this repo just shipped `3be86bca fix(pi): support 0.85 root imports`, Pi version skew is a *demonstrated*, not hypothetical, failure mode.

**What Schema gives here, concretely:** `Schema.Union([TaskEventV1, TaskEventV2])` with `Schema.decodeTo` migrations turns "silently produces nothing" into "fails with a `SchemaError` naming the field that didn't match." And `Schema.catchDecoding` (`src/Schema.ts:5423`) is the missing primitive for persistence: today one bad field rejects a whole document (`feed-publisher.ts:377` — one bad activity rejects the entire feed); `catchDecoding` recovers **per field**, keeping the rest.

### 2.6 ⚠️ Landmine: `onExcessProperty` defaults to `"ignore"`, which *strips* unknown keys

`src/SchemaAST.ts:445, 484` — the default `ParseOptions.onExcessProperty` is `"ignore"`, and ignore means **drop**. Options are `"ignore" | "error" | "preserve"`.

This matters for two SumoCode patterns that round-trip data they did not author:
- `config/sumocode-config.ts:120` deliberately preserves unknown keys on save.
- `chrome-cache`, `activity/ui.json`, and any Pi payload re-encoded downstream.

**Any schema over a payload SumoCode re-encodes must set `onExcessProperty: "preserve"`.** Getting this wrong turns "Pi 0.86 added a field" from a no-op into silent data loss — a *worse* failure than today's casts. Make it a review checklist item on every persistence schema.

---

## 3. Error handling → typed errors

### 3.1 Classification of ~380 real catch sites

| Bucket | Count |
|---|---|
| a. swallow-and-default (`catch {}` or fallback value) | **100** (88 return a fallback, 12 are literal `catch {}`) |
| a′. swallow with a justifying comment, no value, no log | **97** |
| b. log-and-continue | 53 |
| c. rethrow / wrap-and-rethrow | 58 |
| d. convert to a result object | 22 |
| e. control flow (existence probe, retry, `continue`) | 18 |
| f. `.catch(() => undefined)` promise tails | 32 |

**The (a′) bucket of 97 is the repo's actual house style and it is mostly good judgement**: `src/task-mode.ts:214` ("diagnostics must never crash the extension"), `src/approval-modal.ts:278` ("Herdr attention signalling must never affect approval safety"), `src/background-tasks/task-manager.ts:2021` ("Observers cannot break durable lifecycle transitions"). These are deliberate blast-radius firewalls, and Effect does not improve them. They should stay swallows — just typed ones.

The best-in-repo rethrow is `src/background-tasks/task-manager.ts:696-699`, which **proves the process group died** before rethrowing and otherwise throws a *louder* error. That is the standard the dangerous sites below fail to meet.

### 3.2 The dangerous swallows, ranked

These are cases where a real failure is invisible **and** produces wrong behaviour, not a cosmetic degrade.

1. **Lock takeover-marker scan fails open → mutual exclusion breaks.** `src/background-tasks/task-store.ts:962-966` and its twin `src/activity/persistence.ts:341-346`:
   ```ts
   try { return readdirSync(dirname(lockPath), …)…; } catch { return []; }
   ```
   `EACCES`/`EMFILE`/`ENFILE` is indistinguishable from "no takeover markers". `hasBlockingTakeover()` returns `false`, `acquireLock` proceeds, and **two processes hold the terminal-task lock at once**, interleaving writes to durable records. The bitter detail: `task-store.ts:132` already defines `TRANSIENT_READ_ERRNOS = ["EACCES","EIO","EMFILE","ENFILE","EAGAIN"]` and `readCandidate` at `:872` consults it correctly — this call site simply doesn't.
2. **Lock owner parse fails open → live lock treated as unowned.** `task-store.ts:444-451`, `activity/persistence.ts:318-323`. The `try` wraps both the read *and* the parse; an `EACCES` on `owner.json` returns `undefined` ≡ "no owner", so `breakAbandonedLock` steals a live, healthy lock.
3. **Subagent cancel cannot fail.** `src/subagents/backend-pi.ts:425-439` — both `process.kill(-pid)` and `proc.kill()` are swallowed and `signalGroup` returns `void`. On `EPERM` the pi child and its bash-tool grandchildren **keep mutating files** while `src/subagents/manager.ts:490` writes `Cancelled ${id}` to the UI. The doc comment at `:416-423` names grandchildren-still-mutating-files as the hazard, then the implementation makes it unobservable.
4. **Cancel timeout synthesizes a settled state over a live child.** `subagents/manager.ts:485-489` — the timeout after (3) is treated as proof of interruption; the slot frees, the queue dequeues, the old child still holds the pane. Orphan + over-subscription, both invisible.
5. **Corrupt accounts config reports zero accounts.** `src/commands/accounts.ts:173-181` → `catch { return {}; }`. Every configured Claude subscription **disappears**; the user re-authenticates and likely overwrites the file. The sibling `readDocumentForSave` at `:183-190` *throws* on the same failure — read and write paths disagree on whether corruption matters.
6. **Readiness gate write swallowed against its own comment.** `src/sumo-tui/rpc/host.ts:1170-1176`: the comment says *"a silently failed write would strand the child on its 30 s fallback"*, and the next line is `catch {}`. Every affected launch eats a 30 s stall with no diagnostic. `flag: "wx"` also means a *stale* gate throws `EEXIST` here — swallowed identically, so it is never repaired.
7. **`/reload` handshake fails silently → terminal corruption.** Writers `host.ts:1869-1871`, `host.ts:1720`, `commands/reload.ts:62`; reader `src/native/main.ts:682-694` whose own read is also `catch {}`. `restoreFailedReloadTerminal()` cannot tell "successor alive" from "successor died" and writes `RELOAD_FALLBACK_TERMINAL_CLEANUP` **over a live successor's screen**. The user is left in a broken terminal.
8. **Task exit code unreadable ≡ task has no exit code.** `task-manager.ts:190-200` → `catch { return undefined; }`. A finished task reports as running forever, or settles with pass/fail silently unknown.
9. **Task log tail read failure renders as empty output.** `task-manager.ts:243-249` → `catch { return ""; }`. The user — or the agent — reads "no output" and decides on fabricated data.
10. **Task log append failure is unbounded silent data loss.** `task-manager.ts:276-281`. The justification comment is about *status*; the thing lost is *log content*, which the durable record does not contain. `ENOSPC` truncates output with zero signal, and (9) then renders the gap as legitimately empty.
11. **Memory offline is indistinguishable from "no memories".** `src/sidebar.ts:156-160` → `catch { … return setSnapshot([], true); }`. The thrown value is a `MemoryClientError` carrying `code: "daemon_down" | "unauthorized" | "timeout" | …` (`src/memory.ts:42-47`) — **all of it discarded**. Elsewhere the repo does this right: `host-actions.ts:1239-1242` surfaces `memory unavailable: ${message}`.
12. **Subagent children spawn without their configured packages.** `subagents/backend-pi.ts:83-107` — `readSettingsPackages` wraps read + parse + shape-walk in one try, `catch { return []; }`. A malformed `settings.json` means "zero packages configured", so children run **without their extension packages**. Behaviourally different agents, no error, no visible diff.
13. **Config tiers silently vanish.** `config/sumocode-config.ts:82-88` — two silent drops in five lines. The user edits a file and observes no effect.
14. **Migration silently drops all subscriptions.** `src/commands/sync.ts:232-246` — an *unreadable existing* source (proved present by `existsSync`) falls through to writing `{"subscriptions": []}` and reports success.
15. **Unadopted child termination result discarded.** `src/native/main.ts:663-677` — both kills swallowed and the final `waitForPreSpawnedChildExit(...)` **discards its boolean**, so `terminateUnadoptedChild()` returns "success" with a child provably alive after `SIGKILL` + grace. Caller at `:1025` exits, orphaning a pi child holding the TTY.
16. **Exit-code side channel silently wrong.** `native/main.ts:934-939` + `host.ts:309-316`. The comment at `:930-932` says the channel exists *"so the consumer never substitutes a timing-dependent 143"*; on write failure the consumer does exactly that — **Ctrl-C reports 143 or 0 instead of 130** to wrapping CI.
17. **Keymap silently reverts to defaults.** `src/sumo-tui/rpc/editor.ts:669-676` → `catch { return {}; }`. The availability argument is sound; the silence is not. This one wants a warning toast, not a different control-flow shape.

Honourable mention, cited for contrast: `src/mcp-config-reader.ts:81-83` has the *same mechanical shape* as #12/#13 but the empty result is the **safe** direction and it is argued explicitly. That is how to write this pattern.

**Pattern across the list:** the recurring shape is *"a `T | undefined` return collapsing three distinct meanings — absent, malformed, and I-couldn't-read-it — into one value."* Items 2, 8, 12 and 13 are all that shape. `task-store.ts:865-902`'s `{ kind: "ok" | "transient" | "invalid" }` is the repo's own proof that separating them is both possible and cheap.

### 3.3 Current result conventions

Four idioms coexist; none is repo-wide.

1. **`T | undefined` — dominant** (~274 annotated return positions + 38 `Promise<T | undefined>`). Also the least informative, and the direct cause of dangers 2/8/12/13.
2. **`{ ok: true; … } | { ok: false; … }`** — 14 files, 134 `ok:` occurrences. Best instance: `src/git/worktree.ts:9-21`, where `WorktreeFailure` carries a **typed code**.
3. **`{ success: true } | { success: false; error }`** — ~25 occurrences (`config/sumocode-config.ts:101`, `themes/registry.ts:9`, `commands/theme.ts:28`, `pi-compat/extension-ui-adapter.ts:30`). Semantically identical to (2). **Pure duplication — two spellings of one concept.**
4. **`kind`-discriminated unions** for >2 outcomes: `task-store.ts:865` `{ok|transient|invalid}`, `subagents/domain.ts:25`, `transcript/mermaid-renderer.ts:14`, `runtime/worker-runtime.ts:99`.

Plus **37 `| null` returns**, mostly Pi-compat shims mirroring upstream (`session-reader.ts:162-163` literally documents *"matching Pi's `catch { return null; }`"*).

**Eight custom `Error` subclasses, all genuinely caught by `instanceof`:**

| Class | Location | Payload |
|---|---|---|
| `MemoryClientError` | `src/memory.ts:49` | `code: MemoryClientErrorCode`, `cause` |
| `ChildProtocolLimitError` | `src/child-protocol.ts:175` | `kind`, `limit`, `received` |
| `StaleTerminalTaskRevisionError` | `src/background-tasks/task-store.ts:107` | `id`, `expectedRevision`, `actualRevision` |
| `CorruptTerminalTaskRecordError` | `task-store.ts:117` | marker |
| `TerminalTaskLockBusyError` | `task-store.ts:118` | marker |
| `RpcPromptPreflightRejection` | `src/sumo-tui/rpc/prompt-scheduler.ts:19` | message |
| `RpcChildExitError` | `src/sumo-tui/rpc/client.ts:43` | exit details |
| `RpcTreeNavigationQuietTimeoutError` | `src/sumo-tui/rpc/host.ts:120` | `attempts`, `elapsedMs` |

They cluster in exactly two subsystems. The other ~40 modules use `throw new Error(...)` (164 sites) and **string matching** — e.g. `src/git/worktree.ts:220` does `error.message.includes("missing worktree path")`. That is the single most obviously-Effect-shaped line in the repo.

### 3.4 Existing taxonomies — the repo already invented three-quarters of this

- **`WorktreeErrorCode`** — `src/git/worktree.ts:9-21`, `"branch_already_exists" | "path_already_exists" | "git_failed" | "parse_failed"`, constructed via `failure(code, …)` / `gitFailure(cause)`. **This is the template.**
- **`MemoryClientErrorCode`** — `src/memory.ts:42-58`, mapped from HTTP status at `:134`, discriminated on at `host-actions.ts:1240` and `memory-editor.ts:388`.
- **errno classification — a de-facto taxonomy with no type.** `isErrnoCode` is exported once (`private-artifact.ts:46`) but `errorCode`/`errorMatches` is **re-implemented five times**: `task-store.ts:207`, `process-tree.ts:65`, `feed-publisher.ts:86`, `activity/persistence.ts:65`, `manager-bridge.ts:81`, plus `errnoIs` at `task-manager.ts:148`. Two named errno *sets* are the closest thing to shared vocabulary: `TRANSIENT_READ_ERRNOS` (`task-store.ts:132`) and `TERMINAL_IO_ERROR_CODES` (`runtime/terminal-errors.ts:1-7`).
- **102 distinct diagnostic event-name strings** (`diagLog("response_write_failed")`, `"control_dir_refused"`, `"subagent_delivery_failed"`, …) — an unenumerated, untyped event taxonomy.

### 3.5 Proposed `Schema.TaggedError` taxonomy

The design that fits this repo is **one tagged error per domain with a tagged `reason` field**, matching `ai-docs/src/01_effect/04_errors/20_reason-errors.ts`. That maps `WorktreeErrorCode`-style codes onto Effect's `Effect.catchReason` / `catchReasons` / `unwrapReason` without inventing a parallel vocabulary.

```ts
// src/errors/fs.ts — the highest-leverage one, replacing 6 errno re-implementations
class Transient extends Schema.TaggedError<Transient>()("Transient", {
  errno: Schema.Literals(["EACCES","EIO","EMFILE","ENFILE","EAGAIN"]), path: Schema.String })  {}
class NotFound  extends Schema.TaggedError<NotFound>()("NotFound",  { path: Schema.String }) {}
class Corrupt   extends Schema.TaggedError<Corrupt>()("Corrupt",    { path: Schema.String, issue: Schema.String }) {}
class Denied    extends Schema.TaggedError<Denied>()("Denied",      { path: Schema.String, mode: Schema.Number }) {}
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.Union([Transient, NotFound, Corrupt, Denied]) }) {}
```

Per-domain set, in descending value:

| Domain | Error | Reasons | Replaces |
|---|---|---|---|
| **fs/persistence** | `StoreError` | `Transient` / `NotFound` / `Corrupt` / `Denied` | 6 errno re-implementations; **directly fixes dangers 1, 2, 8** — a `Transient` reason cannot be mistaken for "absent" |
| **decode** | `SchemaError` (built in, `Schema.ts:1180`) | — | 210 `is*`/`as*` helpers; the 32 swallowing `JSON.parse` catches |
| **rpc** | `RpcError` | `Framing` / `Malformed` / `UnknownEvent` / `ChildExit` / `Timeout` | `RpcChildExitError`, `RpcPromptPreflightRejection`, `RpcTreeNavigationQuietTimeoutError`; **gives bug (b) a home** — `UnknownEvent` in the error channel cannot be dropped |
| **process** | `ProcessError` | `SignalRefused` / `StillAlive` / `SpawnFailed` | **directly fixes dangers 3, 4, 15** — `signalGroup` returns `Effect<void, ProcessError>` instead of `void` |
| **config** | `ConfigError` | `Unreadable` / `Malformed` / `UnknownVersion` | dangers 5, 12, 13, 14, 17; unifies `{ok:…}` and `{success:…}` |
| **git** | keep `WorktreeErrorCode` as-is, restated as reasons | | `error.message.includes(...)` at `worktree.ts:220` |
| **memory** | keep `MemoryClientErrorCode` as reasons | | danger 11 — `catchReason` forces the caller to name what it's ignoring |

**`Result` vs `Option` (verified names, rc.112):**
- `Result<A, E>` (`src/Result.ts:66`, **success type first**) is the drop-in for idioms 2 and 3. `native-task-params.ts:66-191` already returns `{ok:true,value} | {ok:false,error}` and never throws — it is a *mechanical* port and the best slice-1 target.
- `Option<A>` is the drop-in for the ~274 `T | undefined` returns **only where `undefined` genuinely means "absent"**. Where it currently means "absent OR malformed OR unreadable" — dangers 2, 8, 12, 13 — the correct target is `Effect<Option<A>, StoreError>`, not `Option<A>`. **Blanket `T | undefined` → `Option<A>` conversion would be pure churn and would preserve every bug.** Getting this distinction right per call site is where the value is; the mechanical part is worthless.

### 3.6 Where `catchTag` replaces a boolean/undefined convention

Highest value, in order:
1. `subagents/backend-pi.ts:425-439` `signalGroup(): void` → `Effect<void, ProcessError>` with `catchReason("ProcessError", "SignalRefused", …)`. Fixes 3 and 4 together.
2. `task-store.ts` / `activity/persistence.ts` lock paths → `Transient` can no longer read as "no owner"/"no markers". Fixes 1 and 2.
3. `task-manager.ts:190-249` → `Effect<Option<number>, StoreError>` distinguishes "no exit code yet" from "couldn't read it". Fixes 8 and 9.
4. `git/worktree.ts:220` string matching → `Effect.catchTag`. Small, but it is the clearest single before/after in the repo.
5. `sidebar.ts:156-160` → `Effect.catchReasons("MemoryError", { DaemonDown: …, Unauthorized: … })`. Fixes 11 and forces the empty-panel case to say *why*.

---

## 4. Persistence → Effect `FileSystem` / `KeyValueStore`?

### 4.1 What rc.112 actually offers

- `FileSystem` and `Path` are **in core `effect`** (`src/FileSystem.ts:663`, `src/Path.ts:255`). There is no `@effect/platform` v4 — npm shows latest `0.97.1` with **no `rc` tag**. The Node implementation is `@effect/platform-node@4.0.0-rc.112` (which *does* have an `rc` tag).
- `FileSystem.layerNoop(partial)` / `makeNoop(partial)` (`:954`, `:825`) give an in-memory/stub layer for tests.
- `KeyValueStore` (`src/unstable/persistence/KeyValueStore.ts`) with `layerMemory` (`:331`), `layerFileSystem(dir)` (`:368`), and — the interesting one — **`toSchemaStore(kv, schema)`** (`:782`), a schema-validated store whose `get` returns `Effect<Option<A>, KeyValueStoreError | SchemaError>`.

### 4.2 Honest verdict: **swap the decoders, keep the file I/O**

I do not recommend porting SumoCode's persistence to Effect `FileSystem`, and I want to be specific about why, because "testability via in-memory layer" is the usual argument and it does not apply here.

**The atomic writers are not generic file I/O. They are security primitives.** `activity/persistence.ts:486-521` (`atomicWritePrivateJson`) does: `O_EXCL|O_NOFOLLOW` open → `fchmod 0600` → write → `fsync` → `rename` → best-effort directory `fsync` → `finally` unlink of the temp inode. `readPrivateJson` (`:253-274`) does `lstat` → reject symlink → assert mode is exactly `0600` → `openSync(O_RDONLY|O_NOFOLLOW)` → `fstat` → compare `dev`/`ino` against the pre-open `lstat` (TOCTOU close) → size cap → parse. `task-store.ts:340-373` (`openPrivateExistingFile`) does the same plus `realpathSync(path) === path`.

Effect's `FileSystem` interface (`src/FileSystem.ts:78`) does not expose `O_NOFOLLOW`, `fchmod`-on-descriptor, `fstat`-vs-`lstat` inode comparison, or `linkSync` no-replace-create semantics — the four things these writers depend on. Porting them means either reimplementing on raw `node:fs` inside an Effect wrapper (all the churn, none of the benefit) or **silently weakening a hardened security boundary**. That would be a strictly negative trade.

`KeyValueStore.layerFileSystem` is worse still for this use: `KeyValueStore.ts:368-400` creates the directory with default permissions, `encodeURIComponent`s the key into a filename, and its `set` is a plain `writeFileString` — **no atomicity, no `0600`, no symlink defence.** For `chrome-cache.ts` (explicitly advisory) that would be acceptable; for `task-store` or `activity/persistence` it is a regression. Note also `effect/unstable/**` is flagged unstable by the library itself, and this repo persists user state across releases.

**And the testability argument is already satisfied.** `anti-slop/no-module-mocking` is `"error"` (`oxlint.config.ts:26`) and there is exactly **one** `vi.mock` in the whole tree (`task-store.test.ts:26`) behind an explicit suppression. Thirteen production files already inject `now?`/`setTimeout?` seams. The repo does not have an untestable-I/O problem that a Layer would solve.

**What I do recommend, in order:**

1. **Schema at the persistence decode boundary, plain `node:fs` underneath.** Keep `readPrivateJson` exactly as-is up to the `JSON.parse`, then feed the result to `Schema.decodeUnknownResult(ActivityFeedV1)`. This captures the whole win — typed errors, versioned unions, encode round-trip — with zero risk to the hardened path. Schemas are pure; this needs no Effect runtime at all.
2. **`Schema.catchDecoding` (`Schema.ts:5423`) to fix all-or-nothing rejection.** Today `feed-publisher.ts:377` rejects the **entire feed** for one bad activity, and `activity/domain.ts` rejects a whole snapshot for one bad field. Per-field `catchDecoding` keeps the rest. This is a real behavioural improvement that has no non-Schema equivalent.
3. **`Schema.fromJsonString` (`Schema.ts:12789`)** to fuse `JSON.parse` + validate into one codec with one error channel, deleting 32 swallowing `JSON.parse` catches.
4. **`KeyValueStore.toSchemaStore` only for `chrome-cache.ts`** — advisory, already version-pinned, already byte-capped, and explicitly documented as best-effort. It is the one store where `layerFileSystem`'s weaker guarantees are appropriate. Even there it is optional.

The mechanism the repo needs and does not have is **versioned decode with per-field recovery**, and that is a Schema feature, not a FileSystem feature.

---

## 5. Testing

### 5.1 The version stars align

`package.json` already pins `vitest: ^4.1.5`. `@effect/vitest@4.0.0-rc.112` requires `vitest ">=4.1.0 <5.0.0"` and `effect ^4.0.0-rc.112`. **No negotiation needed.** `effect/testing` exports `TestClock`, `TestConsole`, `TestSchema`, `FastCheck`.

`vitest.config.ts` is 10 lines with no `environment`, no `setupFiles`, no pool config, no `testTimeout` override. `@effect/vitest` needs none of those — it is `import { it } from "@effect/vitest"` per file. **The vitest config needs no changes at all.** (One caveat below.)

### 5.2 Blast radius of moving timers to `TestClock`

| Tier | Files | Why |
|---|---|---|
| **Must change** | **26** | every file calling `useFakeTimers`; **198** `advanceTimersBy*` call sites become `TestClock.adjust` |
| Heavy rewrites within that 26 | 5 | `task-mode.test.ts` (58 advances), `background-tasks/task-manager.test.ts` (37), `subagents/backend-pane.test.ts` (19), `activity/manager-bridge.test.ts` (17), then `sidebar/working-indicator/shell-adapter` (10 each) |
| Real structural churn | 26 | all 26 also call `useRealTimers`; `backend-pane.test.ts` toggles fake↔real **24 times**, `task-manager.test.ts` 17. TestClock has no analogue for that interleaving — these need restructuring, not translation |
| Likely change | ~21 | files with `await new Promise` (real sleeps) |
| **Hazard** | 13 | files using `vi.waitFor` (104 occurrences). **`vi.waitFor` polls in *real* time and will deadlock against a virtual clock nobody advances.** Any file mixing both breaks |
| **Gated** | 4 | see §5.4 |
| **Production prerequisite** | 13 | the `now?`/`setTimeout?` seam files must become `Clock`/`Effect.sleep`, or TestClock cannot reach code that captured the real global at construction |

~26 files must change out of 193 src tests (~13 %). The exposure is **concentrated, not diffuse**, precisely because DI discipline already kept timers out of most tests.

### 5.3 Layer-based fakes: the repo is 80 % of the way there and it is not obvious it should go the last 20 %

`vi.mock` is banned; DI is by options object. Thirteen production files expose `now?`/`setTimeout?`/`setInterval?`/`cpuUsage?` seams (`widgets/notification.ts:14-15`, `widgets/modal.ts:64`, `cathedral/metrics-hud.ts:128-132`, `runtime/frame-scheduler.ts:9`, `rpc/host.ts:116,148`, `rpc/chrome-cache.ts:33`, `pi-compat/retained-shell-transition.ts:14-15`, `activity/store.ts:56`, `activity/feed-publisher.ts:58`, `activity/manager-bridge.ts:162`, `background-tasks/task-manager.ts:121`, `subagents/backend-pane.ts:73`, `cli/open-worktree.ts:19`).

**But only 9 test files actually use those seams** — most fake-timer tests patch the *global* clock via `vi.useFakeTimers()` even where a seam exists. That is the real gap, and it has two possible fixes: adopt `Clock`/`TestClock`, or just **use the seams that already exist**. The second costs nothing and captures most of the benefit. Be honest that Effect is not required to close this gap.

Where Layers *do* add something the options object does not: **transitive requirements**. `rpc/host.ts` today threads `now`, `setTimeout`, a client, a store, and a scheduler through constructor params by hand. A Layer graph makes the requirement set type-visible at the composition root, which is the argument the (currently disabled) `no-service-constructor-imports` rule encodes.

`src/sumo-tui/testing/test-backend.ts` (191 lines) is a genuine fake — private constructor, `static async create()`, real `CellBuffer`s, clipboard writes captured into an array rather than mocked, **zero timers, zero I/O, zero `process.*`**. It is exactly the `make<Capability>`-in-tests shape the Effect rule sanctions. Surprising finding worth acting on independently of Effect: **it is imported by exactly one other test file** (`src/sumo-tui/rpc/editor.test.ts`). It is essentially unadopted infrastructure.

### 5.4 ⚠️ The gate that will bite: plan 103's WAIT-CLASS classifier

`plans/103-replace-timing-sleeps-with-state-waits.md` (DONE, issue #397) is enforced by a **real executable gate**, not a doc: `scripts/test-wait-classification.test.mjs` parses candidate files with the repo's own TypeScript compiler and requires every retained timer to carry an adjacent marker:

```
// WAIT-CLASS: negative-observation|clock-contract|fixture-delay|poll-interval — <causal reason>
```

There are 15 markers in the tree today across 4 `CANDIDATE_FILES` (`rpc/host-actions.test.ts`, `test/integration/rpc-session-switch.test.ts`, `rpc-queued-message-undo.test.ts`, `rpc-activity-cards.test.ts`).

**`scripts/test-wait-classification.test.mjs:33-42` hardcodes the 8 `vi.*Timers*` method names.** `TestClock.adjust` is invisible to it. So an Effect timer migration would silently walk *out* of a gate the repo deliberately built — the classifier must learn a TestClock vocabulary **before**, not after, any test touches TestClock. This is the single most concrete sequencing constraint in the testing domain.

Two conventions from that plan should carry into Effect verbatim:
- **Stale-state hazard:** a waiter whose predicate is already true when the wait starts asserts nothing. Both back-hop sites wait for the *forward* state and were red-checked by neutering the trigger.
- **Diagnostic timeouts must beat the runner:** `INLINE_SELECTOR_TIMEOUT_MS` is 4 s specifically so it fires before vitest's 5 s default, yielding a named failure instead of `Test timed out in 5000ms`. Under `it.effect`, ensure the equivalent Effect timeout stays inside vitest's budget.

### 5.5 Migration shape

- Add `@effect/vitest@4.0.0-rc.112` as a devDependency. No `vitest.config.ts` change.
- `it.effect` / `it.live` / `it.effect.each` / `it.effect.prop` per file; keep plain `it` everywhere else. **Do not convert the ~167 tests with no timers and no I/O** — there is nothing to gain.
- Convert the 5 timer-heavy files last and individually; the fake↔real toggling in `backend-pane.test.ts` and `task-manager.test.ts` is a redesign, not a translation.
- `it.effect.prop` with `Schema`-derived arbitraries (`effect/testing/FastCheck`) is a genuine new capability: property-testing the boundary decoders in §2 against generated payloads would find shape bugs that 193 example-based tests structurally cannot. This is arguably the strongest single testing argument for the whole migration.
- Known residual flakes the plan already declines to fix and that Effect will not help: `task-manager.test.ts` (257 real terminals against a 20 s budget — its subject *is* a budget constant) and `rpc/editor.test.ts`.

---

## 6. The DO-NOT-TOUCH map

**14 803 non-test lines across 66 files. Almost all of it is synchronous and pure. None of it should adopt the Effect runtime.**

The quantitative basis: `Effect.runSync` on a prebuilt two-step chain is **0.179 µs vs 0.0036 µs for a plain call — ~50×**. A frame rebuild touches thousands of cells. Wrapping any part of the render pipeline in Effect is a measurable regression for zero correctness gain, because these functions **cannot fail** — they take a view model and return cells.

### 6.1 Stay plain TS — verified pure (async/await/fs/timer/`process.*` all zero)

| Path | Files | LOC | Note |
|---|---|---|---|
| `src/sumo-tui/render/**` | 7 | **1 415** | `ansi-writer` 120 · `buffer` 431 · `cell` 98 · `compositor` 159 · `diff` 206 · `primitives` 349 · `truecolor` 52. Cleanest layer in the codebase |
| `src/sumo-tui/transcript/**` | 12 | **3 492** | incl. `controller` 877, `view-model` 758 — both pure state→view-model transforms |
| `src/sumo-tui/cathedral/**` (6 of 7) | 6 | 840 | `metrics-hud` excepted below |
| `src/cathedral/**` | 7 | **1 332** | one un-injected `Date.now()` at `cathedral-editor.ts:438` |
| `src/themes/**` | 10 | **789** | pure data + pure functions; `indicator.ts:9` takes `env = process.env` (already injectable) |
| `src/sumo-tui/widgets/**` (9 of 11) | 9 | 3 095 | `chat-pager` 1 628 is the largest file in the map and fully pure |
| `src/sumo-tui/input/**` (3 of 4) | 3 | 627 | |
| `src/sumo-tui/layout/node.ts` | 1 | 239 | |
| `src/footer.ts` | 1 | **398** | all zeros |
| `src/top-chrome.ts` | 1 | **369** | all zeros |
| `src/voice.ts` | 1 | 52 | all zeros |
| `src/tokens.ts` | 1 | 7 | constants |

`src/sumo-tui/themes/**` **does not exist** — themes live at `src/themes/`.

### 6.2 The five impure exceptions — and only one is worth touching

| File | LOC | Impurity | Verdict |
|---|---|---|---|
| `src/sidebar.ts` | 366 | 2 async, 2 await, 4 timers, 2 `process.env`; calls `memoryClient.query` | **The one genuinely effectful file here.** Its `catch { return setSnapshot([], true) }` at `:156-160` is danger #11 in §3.2. Worth an Effect treatment — but as part of the *memory* domain, not the render domain |
| `src/sumo-tui/cathedral/metrics-hud.ts` | 180 | injects `setInterval`, `now`, `cpuUsage`, `memoryUsage` at `:128-132`, all defaulted | Best-factored candidate in the render tree — four explicit capabilities already behind an options object. **Still not worth it**: the seams work today and nothing has ever broken here |
| `src/working-indicator.ts` | 272 | `setInterval` animation loop, `process.env`, `process.stdout.columns` | Leave. An animation loop is exactly what should own a real timer |
| `src/sumo-tui/input/shared-input-router.ts` | 453 | `process.platform` at `:196` is a **hard, non-injectable global read** (while `:195` takes `env` injectably); bare `setTimeout` at `:235`, `:340` | Fix the `process.platform` read as plain TS. Effect adds nothing |
| `src/sumo-tui/layout/yoga.ts` | 121 | the **only** `fs` read in the entire map (`readFile` of the yoga wasm) — the reason `SumoTuiTestBackend.create()` is async | Leave |

### 6.3 Pure data modules (no runtime) — where there is a real, measured win

This is the one place I will argue *for* Effect inside the do-not-touch map, because it is faster **and** more correct, and it imports `effect/Data` + `effect/Equal` (~small, no runtime, no `Effect.runSync`).

**Measured: `Equal.equals` on two `Data.Class` instances is 0.0214 µs; `JSON.stringify(a) === JSON.stringify(b)` is 0.0999 µs. 4.7× faster.**

Targets, in descending value:

1. **`src/sumo-tui/transcript/controller.ts:187-193`** — a literal deep-equal by double serialization:
   ```ts
   function messagesEqual(left: SessionValue, right: SessionValue): boolean {
       if (left === right) return true;
       try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
   }
   ```
   Key-order-sensitive, throws on cycles (silently → `false`), treats `undefined` fields as equal to absent ones, and allocates two full strings per comparison — inside `findCommittedMessageIndex`'s reverse scan (`:195-201`). If the boundary decode of §2 produces `Schema.Class` instances, `Equal.equals` replaces this outright.
2. **`src/sumo-tui/widgets/chat-message.ts:568-579`** — the `renderRowsCache`, a hand-rolled small-N cache keyed by the manual triple `(width, contentVersion, themeVersion)`, scanned with `.find()`. The `contentVersion` counter is bumped by hand at `:472` (see the comments at `:41-46`, `:339`). **This is manual invalidation standing in for structural hashing.** Correct-by-construction `Hash` deletes the version-counter bookkeeping entirely. Highest-value single conversion in the map.
3. **`src/sumo-tui/transcript/activity-fold.ts:497`** — `JSON.stringify([block.mime, block.data, block.filename ?? null])` as a composite **cache key**, where `block.data` may be a whole attachment payload. `Hash.combine` over three fields, no allocation.
4. **`src/sumo-tui/transcript/controller.ts:206`** — `JSON.stringify(message)?.length ?? 0` measures "progress" by serializing the whole message to read `.length`. A decoded model has a real field to count.
5. **`src/sumo-tui/transcript/controller.ts:566-572`** — `liveProjectionCache` invalidated by reference `===` on two fields; any structurally-equal-but-newly-allocated array busts it.

**⚠️ API landmine:** v4 **removed `Data.struct` / `Data.tuple` / `Data.array`**. Only `Data.Class`, `Data.TaggedClass`, `Data.taggedEnum`, `Data.Error`, `Data.TaggedError` remain (`src/Data.ts:48, 91, 580, 1062, 1111`). `Equal.equals` on a **plain object** falls back to reference equality (measured 0.0249 µs, and it returns `false` for structurally equal objects). Structural equality requires `Data.Class` or `Schema.Class` instances. Any plan that says "sprinkle `Equal.equals`" without also changing construction sites is wrong.

**Is it worth it at all?** For (1) and (2), yes — they are correctness bugs with a measured performance upside, and they fall out naturally once §2's decode produces classes. For `Option`/`Array`/`Record`/`Predicate` utils in render code: **no.** That is pure churn against 14 803 lines of working, tested, visually-gated code, and every line touched risks a `visual:ci` golden.

### 6.4 A hidden coupling worth naming

`src/session-cache.js` is imported by `footer.ts:15`, `top-chrome.ts:25`, `sidebar.ts:10`, `cathedral/input-hints.ts:18`, `cathedral/cathedral-editor.ts:42`. It is a **shared mutable cache module** — the reason those otherwise-pure files are testable only through a global. It also contains danger patterns of its own: `session-cache.ts:118` casts session messages and then does `input += message.usage.input ?? 0` **with no `typeof` check on the number**, so a string `"12"` silently corrupts the tally by concatenation; and `:293`/`:304` do `.catch(() => undefined)` on the git branch refresh, so a stale branch can render indefinitely.

If any part of the render layer is ever made a service, **this is the seam** — not `footer.ts`. It is also the hottest cache in the tree (the module exists because footer/sidebar/top-chrome recompute per keystroke).

---

## 7. Lint / tooling

### 7.1 Current state, read first-hand

`oxlint.config.ts` is 42 lines. **All 15 generic anti-slop rules are `"error"`**, none downgraded. `jsPlugins` registers exactly one plugin. There is **no oxlint `categories` block and no built-in oxlint rules configured** — the config is *only* the custom plugin.

Two things the analysis brief assumed that are not true in this tree:
- **`tools/oxlint/anti-slop/README.md` does not exist.** `find tools -iname "*.md"` returns nothing. The comment at `oxlint.config.ts:32` referring to "the anti-slop README" is a **stale reference to a file that is not in this repo.**
- **The Effect plugin is not enabled.** `tools/oxlint/anti-slop/effect/index.ts` is fully implemented but is **not listed in `jsPlugins`**, so `anti-slop-effect/no-service-constructor-imports` never runs.

### 7.2 `no-runtime-typeof` — the single highest-leverage change

```ts
// oxlint.config.ts:31-34
// Schema-free codebase: Pi/RPC payloads are decoded by hand-rolled boundary
// parsers. Per the anti-slop README, permit typeof checks inside type
// predicates (the sanctioned decode pattern) while rejecting ad hoc checks.
"anti-slop/no-runtime-typeof": ["error", { "allowInTypeGuards": true }],
```

The rule's own default is `allowInTypeGuards: false` (`tools/oxlint/anti-slop/rules/no-runtime-typeof.ts:47`). This repo opted out **specifically because it has no schema layer**. Adopting Schema lets that option flip to `false`, which is the *mechanical* enforcement of "decode at the boundary, never hand-roll a guard."

And the connection is not theoretical. `chrome-cache-worker-client.ts:11-13` — `return typeof value === "object";`, missing `!== null` — is **inside a type guard**, which is exactly what `allowInTypeGuards: true` permits. **The escape hatch that exists because there is no Schema is what let that bug through.** Flipping this flag is the concrete, checkable end-state of the whole boundary migration.

Recommended staging: keep `allowInTypeGuards: true` globally; add per-directory overrides flipping it to `false` as each boundary is converted; delete the option when the last one lands.

### 7.3 Anti-slop rules vs Effect signatures — mostly a non-issue, with one real friction

I read the rule sources rather than guessing, and two common fears are unfounded:

- **`no-object-parameters` does NOT ban options objects.** `tools/oxlint/anti-slop/rules/no-object-parameters.ts:52-70` (`resolvesToObject`) bans the literal `object` *type keyword* and aliases resolving to it. Effect's pervasive options-object style (`fs.makeDirectory(path, { recursive: true })`, `Schema.Struct({...})`) is unaffected.
- **`no-unknown-parameters` is real friction, and Schema resolves it.** `tools/oxlint/anti-slop/rules/no-unknown-parameters.ts:47` bans `x: unknown` params except one named `cause`. A hand-written `function decodeEvent(raw: unknown)` violates it — which is *why* `SessionValue` exists (§2.4). With Schema you never write that parameter: `Schema.decodeUnknownEffect(Ev)` keeps `unknown` inside Effect's own (unlinted, `node_modules`) signature, and your boundary function takes `line: string` and returns `Effect<Event, SchemaError>`. **Adoption improves compliance rather than fighting it** — a genuinely good argument to lead with.

Rules whose burden *drops* once Schema exists: `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion`, `no-known-value-widening`, `no-unsafe-dictionary-type`, `no-unknown-type-aliases` (deletes `SessionValue`). Rules unaffected: `no-reflect-apply`, `no-reflect-get`, `no-shape-in-symbol-names`, `no-conditional-empty-object-spread`.

`no-module-mocking` deserves special note: it bans `vi.mock`/`vi.doMock`/`jest.unstable_mockModule` in favour of *"real interfaces"*. That is the same principle as the Effect service rule, applied at the test end. The two are complementary halves of "you may not reach around the seam."

### 7.4 Enable `anti-slop-effect/no-service-constructor-imports` — **before**, not after

The rule bans project-local named imports matching `/^make[A-Z]/` in non-test files, telling you to *"Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root."* Test/spec files are exempt — deliberately, because tests *should* build services directly with hand-made fakes. That is precisely the `SumoTuiTestBackend` pattern already in use.

**I checked: there are currently 0 project-local `make[A-Z]` named imports in non-test `src/**`.** The repo uses `create*`. So the rule is a **free, zero-diff guardrail today** and gets exponentially more expensive to adopt once service constructors proliferate. Turn it on in the same PR that introduces the first Effect service, not later.

Known escape hatches to be aware of (each deliberate): bare/package imports pass; namespace imports (`import * as M` then `M.makeFoo()`) are invisible; `type`-only imports are *not* distinguished and will false-positive.

### 7.5 Typecheck time — the measured risk and how to bound it

`tsconfig.json` is one file for the whole repo. No project references, no variants. `strict: true` + `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`. **`skipLibCheck: true`** — this materially reduces the cost of adding a type-heavy dependency, since Effect's own `.d.ts` files are not checked; only *instantiations in your code* cost.

**`incremental` and `composite` are OFF.** grep across `tsconfig.json`, `package.json`, and all 8 workflows returns nothing. **Every `tsc --noEmit` is a cold full build**, and CI caches only the pnpm store (`cache: pnpm`), so there is no `.tsbuildinfo` and nothing to cache. `typecheck` shares a **10-minute** `timeout-minutes` box with lint *and* the full unit suite (`ci.yml:17`, `:41`).

Coverage gap worth knowing: `include` is `src/**/*.ts` only — **`test/integration/**`, `tools/oxlint/**`, and `scripts/**` are not typechecked at all.**

Recommended, in order:
1. **Measure before touching anything.** `tsc --noEmit --extendedDiagnostics` for a baseline (`checkTime`, `instantiations`, `memoryUsed`), and `--generateTrace` for a flamegraph. There is currently **no timing instrumentation anywhere** in the repo, so any claim about Effect's tsc impact would be unfalsifiable.
2. **Turn on `incremental: true` with a cached `.tsbuildinfo` before the migration, not after.** This is the cheapest available mitigation and it is independently worth doing.
3. Set a CI budget on `instantiations` and fail on a >2× jump.
4. `knip` is **non-blocking** (`ci.yml:78`, `knip --no-exit-code`), so transitional dead code will be reported and never fail. A strict variant (`dead-code:strict`) exists but is unwired — consider wiring it for the migration window only.

### 7.6 Packaging landmines

- **`effect` is ESM-only** (`"type": "module"`, no `require` export condition). `src/**` runs through jiti and the bundles are `format: "esm"`, so this should be fine — but it must be verified against jiti's resolution of `effect/unstable/**` subpath exports early, not late.
- **`packages: "external"`** in `scripts/build-host.mjs:23` means Effect is *not* bundled and must resolve from `node_modules` at runtime. Bundle size is a non-issue; **`node_modules` size and install time are not** (`dist` alone is 32 MB across 138 modules).
- `effect` pulls two runtime deps: `fast-check` and `msgpackr`. **`msgpackr` ships optional native accelerators**, which interacts with `scripts/build-native.mjs` and the release archive. Check this before the first PR.
- AGENTS.md says Pi-bundled deps go in `peerDependencies`. Effect is **not** Pi-bundled, so it becomes a real `dependencies` entry and must clear `scripts/check-dependency-audit.mjs` (policy currently has zero records).

---

## 8. Slice order for this domain

**Schemas are pure values.** `Schema.decodeUnknownResult(X)(raw)` returns a `Result` with no fiber, no runtime, no `Effect.runSync`. Every slice below can land **before any Effect runtime adoption**, and slices 0–4 are independently revertable.

| # | Slice | Why here | Gate |
|---|---|---|---|
| **0** | Enable `incremental: true` + `.tsbuildinfo` CI cache; capture `--extendedDiagnostics` baseline; wire an `effect/Schema` import-time budget into `scripts/perf-startup.mjs` | Without a baseline, every later perf claim is unfalsifiable. Costs nothing, useful regardless | `startup.json` regenerated; `host-import` p50 recorded |
| **1** | Teach `scripts/test-wait-classification.test.mjs` a TestClock vocabulary | §5.4 — **must precede** any test touching TestClock or the gate silently stops working | gate green on 4 candidate files |
| **2** | `src/native-task-params.ts` → `Schema` + `Result` | Already `{ok:true,value} \| {ok:false,error}`, never throws, errors go to the model as text. Pure mechanical port, **zero blast radius**, proves the toolchain | existing tests pass unchanged |
| **3** | `src/config/**` + `src/mcp-config-reader.ts` + `src/subagents/roles.ts` → `Schema.Class` + `ConfigError` | COLD path, small files, tiny decode cost, currently **fully silent**. Adds `schemaVersion` where absent (§2.5). Fixes dangers 5/12/13/17 | new tests asserting a malformed file yields a named error |
| **4** | `src/git/worktree.ts` + `src/memory.ts` → `Schema.TaggedError` reasons | Both already have code enums; this is restating them. Kills `error.message.includes(...)` at `worktree.ts:220`. Fixes danger 11 | `catchReason` at `sidebar.ts:156` names the failure |
| **5** | `src/errors/fs.ts` `StoreError` taxonomy; apply to `task-store.ts` + `activity/persistence.ts` lock paths | Fixes dangers **1, 2, 8** — the fail-open mutual-exclusion bugs, the most severe in the report. Deletes 6 errno re-implementations. **Decoders only — do not touch the `O_NOFOLLOW`/`fchmod`/inode-comparison I/O** (§4.2) | integration harness green; zero-survivor audit unchanged |
| **6** | `ProcessError` on `subagents/backend-pi.ts:425-439` + `native/main.ts:663-677` | Fixes dangers **3, 4, 15** — orphaned children with grandchildren still mutating files | `test:integration` zero-survivor audit |
| **7** ⚠️ | **`PiAgentEvent` schema at `rpc/client.ts:379`** — one `Schema.TaggedUnion`, decoded once, consumed by all four §2.1 sites. Bounds `contentIndex`. Wires `onProtocolError` | **The big one.** Deletes ~5 guard families, fixes bugs (a) and (b). **HOT path — requires the benchmark** | see below |
| **8** | Flip `no-runtime-typeof` to `allowInTypeGuards: false` per converted directory; enable `anti-slop-effect` plugin | The mechanical end-state (§7.2, §7.4) | oxlint clean |
| **9** | `@effect/vitest` + `TestClock`, 5 timer-heavy files last | Depends on slice 1 and on production `Clock` seams | wait-classification gate green |

**Hot-path slices needing a benchmark before merge: slice 7 only.** Everything else is COLD or WARM. The benchmark is not "is Schema fast enough" — §1b already answers that (+0.14 µs/event, 0.014 % CPU at 1 000 events/s). The benchmark that matters is **`host-import` and `app_ready_ms` in `scripts/perf-startup.mjs`**, because `effect/Schema` costs 63 ms of module load against a 1 080 ms budget. Run `pnpm perf:startup` before and after; budget ≤5 % on `app_ready_ms`.

**Prerequisite for slice 7, and it is a real one:** the four consumers (`controller.ts`, `state.ts`, `prompt-scheduler.ts`, `chat-viewport-controller.ts`) must first be reconciled to agree on what a valid event *is*. Today they disagree (arrays-as-records in `view-model.ts:106` vs not in `tree-navigation-command.ts:6`; `compaction.reason` trusted in `chat-viewport-controller.ts:419` and whitelisted in `state.ts:75-78`). **Writing the schema is the easy part; agreeing on the union is the work.** Budget accordingly, and treat any disagreement discovered during that reconciliation as a bug report, not a merge conflict.

**Do NOT touch, in slice order or ever:**
- `src/native/main.ts` argv classification (`:110-260`) — see §9.
- `src/child-protocol.ts` byte framing — pre-JSON, correct, fail-closed.
- `scripts/lib/host-bundle.mjs` — plain `.mjs`, outside `tsc`, already versioned with a TOCTOU guard.
- The `O_NOFOLLOW`/`fchmod`/`realpath`/inode-comparison layer of `activity/persistence.ts` and `task-store.ts`.
- `src/sumo-tui/pi-compat/tree-navigation-command.ts` — Schema would be a lateral move; keep it as the reference decoder.

---

## 9. Honest section — where this does not pay

### 9.1 Where Schema adds ceremony without removing a bug

- **`src/native/main.ts:110-260` — CLI argv. Effect's `unstable/cli` is actively wrong here.** This is not SumoCode's CLI grammar; it is a *classifier* that must mirror Pi's `args.js` byte-for-byte to decide direct-Pi vs RPC-host (the `PI_PASSTHROUGH_FLAGS` list at `:110-120`, the `--flag=value` single-token handling at `:151`, the `--` delimiter semantics at `:130`, the `--print @file` lookahead at `:163`). A schema-driven parser would impose *its* grammar on a passthrough problem and break the direct-Pi bypass that AGENTS.md explicitly protects. **Also: `launcher-dry-run` is 31 ms total; a 20 ms `effect/Effect` import is a 65 % regression on that number.** Nothing in the launcher path may import Effect at all.
- **`src/sumo-tui/pi-compat/tree-navigation-command.ts`** is already stricter than an idiomatic Schema would be — exact key-set matching (`:67-71`), canonical-base64url round-trip verification (`:60-65`), control-character scanning (`:82-85`), per-field byte caps. Porting it is a lateral move that risks a regression in a security-relevant decoder.
- **`src/sumo-tui/rpc/chrome-cache.ts:55-73`** is version-pinned, byte-capped, per-field validated, and copies fields individually (prototype-pollution-safe). Schema buys tidiness, not correctness.
- **`scripts/lib/host-bundle.mjs`** is plain `.mjs` outside `tsc`, already versioned (`v2`) with a `version: 0` write barrier and a before/after stat-signature TOCTOU guard. Adding a TS dependency to the launcher's freshness check would be strictly worse.
- **`docs/perf/startup.json` has no runtime consumer at all.** Only `scripts/perf-startup.mjs:11` writes it. There is nothing to decode.
- **The 97 "swallow with a justifying comment" catch sites** (§3.1) are deliberate blast-radius firewalls — *"diagnostics must never crash the extension"*, *"observers cannot break durable lifecycle transitions"*. Typed errors let you name what you're swallowing; they do not make swallowing wrong. Do not convert these into recoveries.
- **`activity/domain.ts:164-239`** is the cleanest decoder in the tree — depth-capped recursion, `optionalFiniteNumber` rejecting `NaN`/`Infinity`, `default: return undefined` on unknown body kinds, zero casts. The only genuine improvement Schema offers is `catchDecoding` for per-field recovery; the validation itself is already right.

### 9.2 Where decode cost could regress — and where it actually can't

The expected objection is per-event decode cost. **§1b measures it away**: +0.14 µs per delta on the streaming path (0.014 % CPU at an aggressive 1 000 events/s), and 1.6 µs for a 12-part message that is decoded once per message, not per token. Schema parsers are compiled to closures once per AST and memoized (`SchemaParser.ts:1027-1029`), so there is no per-call AST walk.

**The real regression risk is module import time, and it is 5–10× larger than the decode risk:**
- `import { Schema } from "effect"` (root barrel, eagerly loads all 138 modules) = **125 ms** against a 1 080 ms `host-import` and a 1 330 ms `app_ready_ms`. That is a 9–12 % startup regression from a single import statement.
- Deep `effect/Schema` = 63 ms (~5 %). `effect/Effect` = 20 ms.
- Nothing in the 31 ms `launcher-dry-run` path may import Effect.

Two second-order costs are also real:
- The **failure** path is 3.5× the hand-rolled guard (0.768 µs vs 0.218). Irrelevant at normal rates, but if a malformed producer floods frames, Schema amplifies the cost of dropping them. Keep the `MAX_CONSECUTIVE_PROTOCOL_ERRORS` circuit breaker.
- `activity/store.ts` re-decodes on every fs event (25 ms debounce) **and unconditionally every 2 s**, over documents capped at 64 MiB. That is WARM, not HOT, but it is the one persistence path where a decode-cost check is worth doing rather than assuming.

### 9.3 Where the existing discipline is already adequate

Genuinely: **zero real `as any`. Zero decode-motivated `as unknown as`.** A universal `// SAFETY:` convention. Systematic byte-bounding (`child-protocol.ts:56-173`, `MAX_CACHE_BYTES`, seven `MAX_TREE_NAVIGATION_*` constants). Explicit iterative cycle detection with no unbounded recursion (`session-tree.ts:78-97`, `:148-208`). `vi.mock` banned and honoured (1 suppressed use in 243 test files). Fail-closed byte framing. `task-store.ts`'s three-way `{ok|transient|invalid}` and its named legacy-schema quarantine. `manifest.ts:107-109` deliberately keeping `dirty` as `undefined` ("unknown") rather than rendering "checkout clean" from a failed read.

**A migration that treats this codebase as sloppy will make it worse.** The three defensible wins are narrow and specific:

1. **Deduplicate the eleven divergent guard families into one decoded event type** (§2.1). The bugs are in the *drift* between implementations, not in any one of them.
2. **Separate "absent" from "malformed" from "unreadable"** in the ~274 `T | undefined` returns (§3.2 dangers 1/2/8/12/13). The repo already proved this works with `TRANSIENT_READ_ERRNOS`; it just didn't apply it everywhere.
3. **Close the observability hole.** 32 of 35 caught `JSON.parse` sites swallow to a default, and `onProtocolError` is dead in production. There is no counter, no rate metric, no debug surface for "how much are we dropping." Typed errors in a channel that must be handled is the only mechanism that makes this structurally impossible to forget.

Everything else in this analysis is a nice-to-have.

### 9.4 Two things that will be tempting and are wrong

- **Blanket `T | undefined` → `Option<A>`.** It preserves every bug in §3.2 while touching ~274 return positions, because it keeps collapsing three meanings into one. Only convert where `undefined` genuinely means absent; elsewhere the target is `Effect<Option<A>, StoreError>`.
- **Sprinkling `Equal.equals` / `Option` / `Array` utils through the render layer.** 14 803 lines of pure, tested, visually-gated code where the functions cannot fail. `Effect.runSync` is ~50× a plain call. The only two justified touches are `controller.ts:187-193` and `chat-message.ts:568-579` (§6.3), and both fall out for free once §2's decode produces classes — they are not independent work.

---

## Appendix — reproduction

```
Effect API facts:  /tmp/effect-rc/package/{src,ai-docs}   (effect@4.0.0-rc.112)
npm dist-tags:     npm view @effect/{vitest,platform-node} dist-tags --json
Benchmarks:        node /tmp/bench-schema.mjs   # small delta decode
                   node /tmp/bench-schema2.mjs  # nested message decode
                   node /tmp/bench-eq.mjs       # Equal/runSync/JSON.stringify
Repo census:       grep -rn "typeof" src --include="*.ts" | grep -v "\.test\.ts" | wc -l           # 440
                   grep -rnE "^(export )?function (is|as)[A-Z][A-Za-z]*\(" src --include="*.ts" \
                     | grep -v "\.test\.ts" | wc -l                                                # 210
                   grep -rn "catch" src --include="*.ts" | grep -v "\.test\.ts" | wc -l            # 406
```
