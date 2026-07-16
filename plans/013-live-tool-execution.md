# Plan 013: Show live running state and streaming output for all tools, not just `task`

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. **This is the highest-risk
> plan in the set** — it changes when/how tools appear and could double-render.
> Do Step 0 first and honor its STOP. If anything in "STOP conditions" occurs,
> stop and report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/pi-compat/chat-viewport-controller.ts`
> Compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH (changes live transcript composition; duplication risk)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/301
- **Execution**: DONE in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`). Visual CI
  review pack was produced; no golden promotion was run.

## Why this matters

Pi mounts a live `ToolExecutionComponent` on `tool_execution_start`, streams partial output on `tool_execution_update`, and finalizes on `tool_execution_end` — so every tool shows a running state and live output. SumoCode's `handleToolExecutionEvent` **early-returns for every tool except `task`** (`if (record.toolName !== "task") return;`), so regular tools (read/edit/bash/grep/MCP/…) never get a live running component or streaming partials — they only appear once their final `toolResult` message lands. The result is a dead-feeling transcript during long tool calls. This plan removes the task-only gate and feeds non-task tool events through the same fold machinery, keyed by `toolCallId` so nothing double-renders.

## Current state

File: `src/sumo-tui/pi-compat/chat-viewport-controller.ts`.

**The task-only gate** (`chat-viewport-controller.ts:613`):

```ts
	private handleToolExecutionEvent(record: Record<string, unknown>): void {
		if (record.toolName !== "task") return;              // ← drops every non-task tool
		this.markRenderDirty();
		if (record.type !== "tool_execution_end" && record.partialResult === undefined) return;
		const result = record.type === "tool_execution_end" ? record.result : record.partialResult;
		const resultRecord = asRecord(result);
		const viewModel = this.viewModelMapper.messageFromPiMessage({
			role: "toolResult",
			toolCallId: record.toolCallId,
			toolName: "task",
			name: "task",
			arguments: record.args,
			content: resultRecord?.content ?? [],
			details: resultRecord?.details,
			isError: record.isError,
		});
		if (!viewModel || !isFoldableOnlyViewModel(viewModel) || !this.liveAssistant) return;
		this.foldBlocksIntoAssistant(viewModel.blocks);
		this.runtime.requestRender();
	}
```

**The fold machinery dedupes by `toolCallId`** (`chat-viewport-controller.ts:216` `upsertFoldableBlock`): a `tool` block is matched by `tool.id` (= `toolCallId`) and merged via `mergeToolBlock`; only unmatched blocks are appended. So an event-driven tool block and a later message-driven block **with the same `toolCallId` merge into one** — this is what makes removing the gate safe, *provided the existing path also folds by id*.

**`isFoldableBlock`** (`chat-viewport-controller.ts:170`) accepts `tool` and `delegation`. **`isFoldableOnlyViewModel`** requires every block be foldable.

**`toolBlockFromRecord`** (`view-model.ts:175`) derives status: for a `toolResult` role it is forced to `success` (`view-model.ts:636-639`); for a `type:"tool"` content part it uses the record's `status` (`view-model.ts:588-592`). So to render a *running* tool you must feed a record that yields `status: "running"`, not a `toolResult` role.

**Conventions**: tabs; reuse the existing `foldBlocksIntoAssistant` + `upsertFoldableBlock`; never invent a new ChatPager API.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit (file) | `pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` | pass |
| Full unit | `pnpm test` | pass |
| Integration | `pnpm test:integration` | pass |
| Visual evidence | `pnpm visual:review` | review pack (do not promote) |

## Scope

**In scope**:
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
- `src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` (add)

**Out of scope**:
- `view-model.ts` mapping logic (reuse as-is).
- Per-tool elapsed/`Took Xs` timers (separate finding).
- Promoting visual goldens.

## Git workflow

- Branch: `advisor/013-live-tool-execution`
- Conventional commits, e.g. `fix(transcript): live running state + streaming for all tools`.

## Steps

### Step 0 (MANDATORY investigation — STOP gate)

Determine how a regular non-task tool currently renders, so you can prove removing the gate won't duplicate it. Do this:

1. `grep -n "toolCall\|tool_call\|toolResult\|foldBlocksIntoAssistant\|isFoldableOnlyViewModel" src/sumo-tui/pi-compat/chat-viewport-controller.ts` and read `handleMessageStart`/`handleMessageEnd`/`handleMessageUpdate`.
2. Establish: does a regular tool's `toolResult` message currently fold into the live assistant (via the `isFoldableOnlyViewModel` path at `chat-viewport-controller.ts:648`), or render as its own standalone message?

**STOP and report** if you cannot confirm that regular tool results fold by `toolCallId` into the live assistant. If they render as standalone messages, removing the gate would produce a duplicate (one event-driven folded block + one standalone message), and this plan needs redesign — report your findings instead of proceeding.

Only continue to Step 1 if you confirmed the fold-by-id dedup path covers regular tools.

### Step 1: Handle non-task tools in `handleToolExecutionEvent`

Replace the gate and build a tool block with the correct status. For `tool_execution_end` use success/error; for `tool_execution_start`/`update` use `running`. Construct the record so `toolBlockFromRecord` yields the right status (use a `type:"tool"` content part for running, the `toolResult` role for end):

```ts
	private handleToolExecutionEvent(record: Record<string, unknown>): void {
		this.markRenderDirty();
		const isEnd = record.type === "tool_execution_end";
		const toolName = asString(record.toolName) ?? "tool";

		// On start with no partial output, still surface a running block.
		const result = isEnd ? record.result : record.partialResult;
		const resultRecord = asRecord(result);

		const viewModel = this.viewModelMapper.messageFromPiMessage(
			isEnd
				? { role: "toolResult", toolCallId: record.toolCallId, toolName, name: toolName, arguments: record.args, content: resultRecord?.content ?? [], details: resultRecord?.details, isError: record.isError }
				: { role: "assistant", content: [{ type: "tool", name: toolName, toolCallId: record.toolCallId, status: "running", arguments: record.args, content: resultRecord?.content ?? [] }] }
		);
		if (!viewModel || !isFoldableOnlyViewModel(viewModel) || !this.liveAssistant) return;
		this.foldBlocksIntoAssistant(viewModel.blocks);
		this.runtime.requestRender();
	}
```

Notes:
- Keep `task` working: `task` still flows through here; `toolBlockFromRecord`/`taskBlockFromRecord` already special-case `name === "task"`, so the task delegation path is preserved (verify with the existing task test).
- Because `upsertFoldableBlock` matches by `tool.id` (`toolCallId`), the running block created on start/update and the final block on end merge into one.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Tests

In `chat-viewport-controller.test.ts` (use the existing controller test harness / fake `chat` + a started live assistant as the pattern):

```ts
	it("folds a running non-task tool, then finalizes it to one block", () => {
		// 1. start a live assistant message
		// 2. handleAgentEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "t1", args: { path: "a.ts" } })
		//    → live assistant has ONE tool block, status running
		// 3. handleAgentEvent({ type: "tool_execution_end", toolName: "read", toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] } })
		//    → still ONE tool block (same toolCallId), status success — NOT two blocks
	});
	it("still folds task delegations as before", () => {
		// regression: the existing task test must still pass unchanged
	});
```

**Verify**: `pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` → all pass.

### Step 3: Integration + visual evidence

Run `pnpm test:integration` (PTY/real-Pi) to confirm no regression in tool rendering, and `pnpm visual:review` to eyeball that tools don't duplicate. Do not promote goldens. If the visual review shows duplicated tool blocks, that is a STOP.

**Verify**: `pnpm test:integration` exits 0; `pnpm visual:review` shows one block per tool call.

## Done criteria

ALL must hold:

- [ ] Step 0 confirmed the fold-by-id dedup path covers regular tools (documented in the PR)
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; new controller tests pass; the existing task-fold test still passes
- [ ] `pnpm test:integration` exits 0
- [ ] A non-task tool shows a running block on start and exactly one block (merged) after end — verified by the new test
- [ ] No duplicated tool blocks in `pnpm visual:review`
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row for 013 updated

## STOP conditions

Stop and report if:

- Step 0 cannot confirm dedup (regular tools render as standalone messages) — the plan would duplicate them.
- Removing the gate causes any tool to render twice (visual or test).
- The live-event record shape differs from `{ type, toolName, toolCallId, args, partialResult, result, isError }` in the installed Pi version — report the actual shape.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **RPC migration interaction**: plan 002 rewires `onEvent → handleAgentEvent`. This change lives inside `handleToolExecutionEvent`, which the RPC pump also calls — it carries forward, but re-verify dedup under RPC during 002's reconcile.
- Streaming partial output assumes `partialResult.content` accumulates (Pi sends growing partials). If Pi sends deltas instead of cumulative snapshots, `mergeToolBlock` (which replaces `output`) would show only the latest chunk — re-check against Pi's update semantics; note this for the reviewer.
- Follow-up (separate finding): per-tool elapsed/`Took Xs` timer; generic tool body for find/grep/ls/MCP (`renderToolBody` currently shows `preview collapsed` for unknown tools).
- Reviewer should scrutinize the `task` regression test and the duplication check above all else.
