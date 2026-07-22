# SumoTUI Structured Transcript Model

**Status:** active view-model contract for P1-D / #107  
**Owner:** SumoTUI consolidation #98  
**Code:** `src/sumo-tui/transcript/view-model.ts`  
**Tests:** `src/sumo-tui/transcript/view-model.test.ts`

## Purpose

SumoTUI needs a deterministic transcript model before V2 chat frames and fixture runtime states can become durable.

Before this slice, retained chat rendering mostly flattened Pi/session messages into plain strings. That is enough for scroll smoke tests, but it cannot reliably render or fixture:

- boxed user/Sumo chat frames (#89)
- code blocks
- tool calls/results and future tool ledgers
- inline skill pills
- Divine Query/question blocks
- nested task/subagent Activity progress
- deterministic completed-response states (#90)

The structured transcript model separates **message identity/role** from **typed renderable blocks**.

## Core types

```ts
type ChatBlock =
	| { type: "markdown"; text: string }
	| { type: "code"; lang: string; source: string; collapsed?: boolean }
	| { type: "activity"; activity: ActivitySnapshot }
	| { type: "skill"; name: string; expanded: boolean }
	| { type: "question"; question: QuestionViewModel }
	| { type: "delegation"; delegation: DelegationViewModel };

type ChatMessageViewModel = {
	id: string;
	role: "user" | "sumo" | "system";
	displayName: string;
	timestamp?: Date;
	blocks: ChatBlock[];
};
```

Source of truth lives in `src/sumo-tui/transcript/view-model.ts`.

## Conversion boundary

Use:

```ts
chatMessageViewModelFromPiMessage(message, index)
transcriptFromSessionContext(sessionContext)
```

The converter accepts current Pi/session message shapes as `unknown` and normalizes known forms:

- Pi `user` / `assistant` text content → `markdown` / `code` blocks
- assistant `toolCall` content parts → `activity` block with `queued` status
- `toolResult` messages → the same ID-correlated `activity` block with `succeeded` / `failed` status
- `bashExecution` messages → terminal-bodied `activity` block named `bash`
- custom/explicit `skill` parts → `skill` block
- custom/explicit `question` parts → `question` block
- native `task` calls/results → `activity` blocks via `native-task-adapter.ts`
- `subagent_spawn/check/wait/cancel` envelopes and passive completions → canonical `activity` blocks via `subagent-adapter.ts`
- custom/explicit legacy `delegation` / `scroll` / `subagent` parts → compatibility `delegation` blocks

Hidden custom messages (`role: "custom", display: false`) are filtered out at the session transcript boundary.

## Fixture use

#90 fixture-backed runtime states should build `TranscriptViewModel` objects directly instead of replaying nondeterministic live Pi output. This keeps completed-response, tool, skill, code, question, and delegation states deterministic.

Example fixture shape:

```ts
const transcript: TranscriptViewModel = {
	messages: [
		{
			id: "m1",
			role: "sumo",
			displayName: "SUMO",
			blocks: [
				{ type: "markdown", text: "I will inspect the failing test." },
				{ type: "activity", activity: { id: "bash-1", kind: "tool", title: "bash", status: "succeeded", body: { kind: "terminal", command: "pnpm test", text: "1 passed" } } },
			],
		},
	],
};
```

## How this unblocks #89

#89 can render chat frames from `ChatMessageViewModel` rather than guessing from plain text. The renderer can switch on block type:

- `markdown` → wrapped prose inside the message frame
- `code` → Element 10 code block
- `activity` → Element 9 universal Activity pill/ledger
- `skill` → Element 9a inline skill pill
- `question` → Element 11 Divine Query affordance
- `delegation` → legacy compatibility input forwarded through the Activity renderer

## Activity identity and presentation state

Ordinary tools project into the renderer-neutral `ActivitySnapshot` contract in `src/activity/domain.ts`. Native tasks project structurally through `src/activity/native-task-adapter.ts`; subagent manager snapshots and bounded tool-result envelopes project through `src/activity/subagent-adapter.ts`. The adapters never import private execution result types, renderer modules, or unbounded transcripts.

Live records require a stable tool-call ID. Historical ordinary tools without one receive deterministic message-and-block-scoped IDs, never a name-only ID. Native chain/parallel children and name-only nested tools receive parent/index-scoped IDs. Subagents adopt `subagent:<sa-id>` after the successful spawn result correlates it to the spawn tool-call ID. Passive completion then uses that canonical ID; historical completions without correlation remain standalone rather than guessing.

Both retained controller paths use the shared Activity block matcher/merger. Reducers merge children and updates by stable ID through `sameActivity()` / `mergeActivitySnapshot()`; terminal states cannot regress to queued or running.

Expansion does not live in `ActivitySnapshot`. `ChatPager` owns per-Activity overrides keyed by Activity ID and reapplies them during incremental replacement, hydration, and virtualization. Running Activities default expanded, first-seen settled Activities default collapsed, failures auto-expand only when no explicit override exists, and a running card keeps its current state when it settles.

## Legacy bridge

`chatMessageViewModelToPlainText()` exists only as a bridge for string consumers. Retained V2 chat renderers consume `ChatMessageViewModel` and `ChatBlock` directly. `tool-renderer.ts` remains a forwarding compatibility wrapper for legacy `ToolCallViewModel` callers. `scroll-renderer.ts` likewise projects legacy `DelegationViewModel` values into `ActivitySnapshot` and forwards to the universal Activity renderer; it is not a second implementation. Ordinary, native-task, and subagent transcript records emit `activity` blocks.
