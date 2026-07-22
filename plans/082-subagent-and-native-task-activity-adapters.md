# Plan 082: Subagent and native-task Activity adapters

> **Executor instructions**: Execute in an isolated worktree based on the approved Plan 079 integration commit. This plan may run in parallel with Plan 080. Follow steps and verification; stop on a STOP condition. Preserve execution tools, security narrowing, worktree manifests, and delivery behavior. Do not delete files, touch `.pi-subagents/`, push, merge, or promote visual goldens.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat acf6ae2..origin/main -- \
>   src/activity \
>   src/native-task-tool.ts \
>   src/native-task-config.ts \
>   src/subagents \
>   src/sumo-tui/transcript/view-model.ts \
>   src/sumo-tui/transcript/controller.ts \
>   src/sumo-tui/transcript/scroll-renderer.ts \
>   src/sumo-tui/pi-compat/chat-viewport-controller.ts
> git status --short
> ```
>
> Confirm Plan 079's Activity contract exists. Preserve newer behavior; never use `git reset --hard` or `git clean`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM-HIGH
- **Category**: orchestration presentation adapters
- **Depends on**: Plan 079
- **Can execute parallel with**: Plan 080
- **Planned at**: `acf6ae2`, 2026-07-22
- **Execution status**: TODO
- **Unblocks**: Plan 081

## Decision

Map subagents and native `task` subprocesses onto Plan 079's shared `ActivitySnapshot` without unifying or replacing their execution machinery.

Keep:

- `subagent_spawn/send/check/wait/cancel/list`
- native `task`
- capacity, model/thinking inheritance, built-in tool narrowing, worktree isolation, manifests, pane behavior, and cancellation
- subagent delivery policy unless separately changed by an approved plan

This slice changes structured presentation data and transcript folding only.

## Adapter interfaces

Create:

- `src/activity/native-task-adapter.ts`
- `src/activity/native-task-adapter.test.ts`
- `src/activity/subagent-adapter.ts`
- `src/activity/subagent-adapter.test.ts`

Recommended exports:

```ts
activityFromNativeTaskRecord(record: unknown, context: { toolCallId?: string; fallbackStatus: ActivityStatus }): ActivitySnapshot
activityFromSubagentSnapshot(snapshot: SubagentSnapshot): ActivitySnapshot
activitiesFromSubagentToolRecord(record: unknown, context: { toolCallId?: string }): readonly ActivitySnapshot[]
activityFromSubagentResultRecord(record: unknown): ActivitySnapshot
```

The adapters parse unknown structural data and return bounded shared snapshots. They must not import private `SingleResult` / `TaskToolDetails` types from `native-task-tool.ts` or renderer/TUI modules.

## Native task mapping

Move task interpretation currently embedded in `src/sumo-tui/transcript/view-model.ts` into `native-task-adapter.ts`:

- single, chain, and parallel title/prompt
- task status aggregation
- nested tool events
- streaming/final assistant output
- model/thinking
- usage and elapsed time
- progress (`completed/total` plus a terse current step)

Status precedence:

1. failed
2. cancelled
3. running
4. queued
5. succeeded

Each child in parallel/chain mode has a stable child Activity ID derived from the parent tool call ID plus result index. Nested tool calls use their actual tool ID; name-only fallback must be scoped to parent/index to prevent collision.

Keep the existing mapper metadata cache so the eventual tool result can retain invocation arguments when Pi omits them.

## Subagent mapping

Map `SubagentSnapshot`:

- ID: `subagent:<snapshot.id>` with source ID retained in subject/metadata
- prompt → invocation/current context
- `liveText` → current step/output tail while running
- `finalText` → result summary when done
- `errorText` → result error when failed
- `liveTools` → child tool Activities
- model/thinking, usage, elapsed, pane/worktree summary
- interrupted/cancelled truthfully where evidence exists; do not label every manager error cancelled

Visible pane children currently do not expose structured nested tools. Render their known pane/running state; do not scrape terminal content.

## Identity and fold sequence

Support this sequence without duplication:

1. `subagent_spawn` tool call appears with tool-call Activity ID.
2. Tool result reveals canonical `sa-*` ID and correlation to the original call.
3. Manager/feed update uses canonical subagent Activity ID.
4. Passive completion custom message uses the same canonical ID and final result.

Use Plan 079 `sameActivity`/merge helpers to adopt canonical identity. If a historical payload lacks correlation data, render one standalone final Activity rather than guessing and merging unrelated work.

## Implementation steps

### 1. Add adapter tests first

Cover:

- native single running/success/failure
- mixed parallel progress and chain failure
- nested tool updates and stable IDs
- message fallback and usage aggregation
- subagent running live text/tools
- done, failed, interrupted/cancelled
- pane-only visible child
- output bounds and absent optional fields
- historical `subagent-result` without an Activity envelope

### 2. Enrich structured producer details

Modify and test:

- `src/subagents/tools.ts`
- `src/subagents/tools.test.ts`
- `src/subagents/index.ts`
- `src/subagents/index.test.ts`

Add bounded `details.activity` envelopes to spawn/check/wait/cancel and settled result payloads. Return settled snapshots for known cancelled IDs so the existing card can update even though cancellation is consumed inline.

Do not alter:

- `triggerTurn`
- idle flushing
- consumed tracking
- session-switch stale-result protection
- tool schemas/names

The envelope must be a projection, not the full unbounded transcript.

`native-task-tool.ts` already returns structured `TaskToolDetails` through live `onUpdate`; change it only if a small `details.activity` envelope materially simplifies replay and is proven to survive Pi. Do not duplicate task execution state.

### 3. Route transcript records through adapters

Modify and test:

- `src/sumo-tui/transcript/view-model.ts`
- `src/sumo-tui/transcript/view-model.test.ts`
- `src/sumo-tui/transcript/controller.ts`
- `src/sumo-tui/transcript/controller.test.ts`
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
- corresponding compatibility tests

Replace native task parsing and subagent completion `summary` blocks with Activity blocks. A completion must merge into the running card when identity exists.

Keep inventory/steering operations ordinary tools:

- `subagent_list`
- `subagent_send`

`subagent_check`, `wait`, and `cancel` may update canonical Activities when their details contain snapshots.

Both retained controller paths must use the shared matcher/merger; do not keep separate identity rules.

### 4. Render nested progress/results through Activity renderer

Use Plan 079's Activity renderer. If the old scroll renderer remains, make it a forwarding wrapper rather than a second implementation.

Required presentation:

- prompt/invocation visible when expanded
- running current step and child tools
- success summary
- error summary auto-expanded unless explicitly collapsed
- progress count for chain/parallel task modes
- metrics (turns, tokens, cost, elapsed) when present
- `waiting for output…` / `no output captured` for empty states

### 5. Documentation and fixture reconciliation

Update:

- `docs/SUMO_TUI_TRANSCRIPT_MODEL.md`
- `docs/PI_TOOL_ARCHITECTURE.md`
- `scripts/visual-v2/fixture-capture.mjs` only as needed to express the same deterministic scroll/scribe scene through Activity

Do not promote or silently rewrite approved runtime goldens.

## Verification

```bash
pnpm vitest run \
  src/activity/native-task-adapter.test.ts \
  src/activity/subagent-adapter.test.ts \
  src/native-task-tool.test.ts \
  src/subagents/tools.test.ts \
  src/subagents/index.test.ts \
  src/sumo-tui/transcript/view-model.test.ts \
  src/sumo-tui/transcript/controller.test.ts \
  src/sumo-tui/transcript/scroll-renderer.test.ts \
  src/sumo-tui/pi-compat/chat-viewport-controller.test.ts \
  src/sumo-tui/rpc/transcript-pump.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm visual:review -- --scenario fixture-scroll-scribe-landscape
pnpm visual:ci
```

Inspect the fixture's styled-cell and geometry reports. No visual golden promotion.

## STOP conditions

Stop and report if:

1. Tool-result details disappear in a real RPC run or session replay; identify the exact drop point.
2. A visible pane child would require terminal scraping to show structured progress.
3. Exact queued/running state for native parallel workers requires changing subprocess scheduling semantics.
4. Passive completion cannot correlate because Pi omits the successful spawn result; keep a standalone final card rather than guess.
5. An adapter would need to import private execution types, renderer modules, or unbounded transcripts.
6. Security narrowing, worktree manifest, capacity, cancellation, or delivery behavior changes.
7. A file deletion or visual golden promotion becomes necessary.

## Out of scope

- Changing tool names or execution semantics
- Changing subagent automatic-delivery/wake policy
- Durable cross-process feed and host ActivityStore (Plan 081)
- Live structured progress for terminal-host pane children
- Fleet dashboard, takeover, sidebar, or full transcript persistence
