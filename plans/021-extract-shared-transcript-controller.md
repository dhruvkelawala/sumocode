# Plan 021: Extract shared transcript ingestion

> **Executor instructions:** Preserve Track B rendering fixes while replacing
> the RPC transcript pump with a shared controller. Treat message ordering and
> live tool folding as user-visible behavior.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** 019, 020
- **Category:** architecture / parity
- **Planned at:** `a3966a7`, 2026-07-02
- **Execution status:** DONE, 2026-07-03.
  Executed in `codex/plan021-shared-transcript-controller-exec` at
  `94d92ce`. Reviewer verified focused transcript/chat suites, integration,
  active runtime visual parity, visual CI, typecheck/build, and clean
  autoreview against `codex/plan020-scroll-preservation-fix`.

### Execution review note

Executor commit `94d92ce` added
`src/sumo-tui/transcript/controller.ts`, made
`src/sumo-tui/rpc/transcript-pump.ts` a thin wrapper, and expanded
`src/sumo-tui/rpc/transcript-pump.test.ts` for Track B blocks, cache reuse,
state pruning, task/delegation folding, and rehydration.

Reviewer verification passed:

```bash
pnpm vitest run src/sumo-tui/transcript/view-model.test.ts src/sumo-tui/widgets/chat-message.test.ts src/sumo-tui/pi-compat/chat-viewport-controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts
pnpm test:integration
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

`pnpm test` was also run during review and still exited 1 only because of the
known unrelated background-task `output.log` ENOENT after all 1124 assertions
passed.

Final branch autoreview against `codex/plan020-scroll-preservation-fix`
reported no accepted/actionable findings.

## Why this matters

RPC currently has `RpcTranscriptPump`, while the retained path has
`chat-viewport-controller.ts`. That splits live tool folding, compaction
summary handling, streaming deltas, resume hydration, and Track B parity fixes.

## Scope

**In scope:**

- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
- `src/sumo-tui/rpc/transcript-pump.ts`
- new shared transcript controller modules
- transcript view-model and ChatPager tests

**Out of scope:**

- Redesigning chat message visuals.
- Changing markdown/tool/code rendering rules except to preserve parity.

## Steps

### Step 1: Identify shared responsibilities

Extract the logic that maps session messages and events into `ChatPager`:

- initial transcript hydration,
- `message_start`,
- `message_update`,
- `message_end`,
- `agent_end`,
- `tool_execution_start/update/end`,
- `compaction_start/end`,
- live assistant replacement,
- live tool folding,
- resume profiling metadata hooks.

Leave Pi-specific container interception in `pi-compat`.

### Step 2: Create `TranscriptController`

Create a backend-neutral controller that accepts:

- a `ChatPager`,
- a render scheduler callback,
- optional resume profiler hooks,
- event objects from Pi in-process or RPC,
- initial session messages or session context.

It should be the only place that decides how events fold into chat view models.

**Performance requirements** (verified defects in the current `RpcTranscriptPump`
— see `plans/draft-rpc-host-main-brain-rebuild.md` for the audit evidence):

- No full remap per streaming delta. Today `transcript-pump.ts` calls
  `mapper.reset()` and re-maps **all** committed messages on every event,
  including each `message_update` token. The shared controller must cache the
  mapped view-models for committed messages and re-map only the draft message
  and live tools on `message_update`; invalidate the cache only on
  `message_end` / `agent_end` / rehydration (`replaceFromMessages`, `/new`,
  fork, session switch — a stale cache here renders ghost messages).
- Prune live state. The pump's `liveTools` and `taskPartials` maps are never
  cleared across turns; the controller must drop them on `agent_end` (the
  authoritative `messages` array replaces them).

### Step 3: Adapt RPC (Pi adapter is reference-only)

Per the decided single-backend scope in Plan 019's preamble: make the RPC host
delegate `onEvent` and `get_messages` hydration to the shared controller —
this is the only live consumer. Do NOT wire the in-process Pi chat viewport
bridge to the controller at runtime (its host was removed by plan 014); the
Pi-side adaptation is limited to keeping `pi-compat` compiling and covering
the shared controller with the unit fixtures extracted from
`chat-viewport-controller`'s behavior.

Delete `RpcTranscriptPump` after equivalent tests pass, or keep only a thin
wrapper around the shared controller during migration.

### Step 4: Preserve Track B parity

Add fixtures that prove RPC and Pi paths handle:

- skill envelope pills,
- edit diffs,
- compaction summaries,
- custom extension message labels,
- markdown/code blocks,
- dynamic key hints,
- live tool execution.

## Verification

```bash
pnpm vitest run src/sumo-tui/transcript/view-model.test.ts
pnpm vitest run src/sumo-tui/widgets/chat-message.test.ts
pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts
pnpm vitest run src/sumo-tui/rpc/transcript-pump.test.ts
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

## Done criteria

- [x] One shared controller owns transcript event ingestion.
- [x] RPC no longer has independent live tool/message folding rules.
- [x] Track B fixture scenarios still pass.
- [x] Real RPC runtime still streams and folds tool updates correctly.
- [x] A unit test proves committed messages are mapped once across N
  `message_update` events (spy on the mapper), and that live tool/task-partial
  state is empty after `agent_end`.
- [x] A unit test proves the committed-message cache is dropped on rehydration
  (no ghost messages after `/new` / fork / session switch).

## STOP conditions

- Event ordering differs between Pi and RPC in a way the shared controller
  cannot represent without backend-specific branches.
- Live tool folding regresses for Track B scenarios.
