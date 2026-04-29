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
- scroll/scribe delegation blocks
- deterministic completed-response states (#90)

The structured transcript model separates **message identity/role** from **typed renderable blocks**.

## Core types

```ts
type ChatBlock =
	| { type: "markdown"; text: string }
	| { type: "code"; lang: string; source: string; collapsed?: boolean }
	| { type: "tool"; tool: ToolCallViewModel }
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
- assistant `toolCall` content parts → `tool` block with `pending` status
- `toolResult` messages → `tool` block with `success` / `error` status
- `bashExecution` messages → `tool` block named `bash`
- custom/explicit `skill` parts → `skill` block
- custom/explicit `question` parts → `question` block
- custom/explicit `delegation` / `scroll` / `subagent` parts → `delegation` block

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
				{ type: "tool", tool: { name: "bash", status: "success", output: "1 passed" } },
			],
		},
	],
};
```

## How this unblocks #89

#89 can render chat frames from `ChatMessageViewModel` rather than guessing from plain text. The renderer can switch on block type:

- `markdown` → wrapped prose inside the message frame
- `code` → Element 10 code block
- `tool` → Element 9 tool pill/ledger
- `skill` → Element 9a inline skill pill
- `question` → Element 11 Divine Query affordance
- `delegation` → Element 12 scroll/scribe delegation row

## Legacy bridge

`chatMessageViewModelToPlainText()` exists only as a bridge for the current `ChatPager` string renderer. New V2 chat renderers should consume `ChatMessageViewModel` and `ChatBlock` directly.
