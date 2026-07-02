# Plan 009: Render branchSummary and compactionSummary messages instead of dropping them to empty boxes

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/transcript/view-model.ts src/sumo-tui/widgets/chat-message.ts src/sumo-tui/pi-compat/chat-viewport-controller.ts`
> Compare the "Current state" excerpts against the live code; on a mismatch, treat as STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the live event pump that RPC plan 002 also rewires — see Maintenance)
- **Depends on**: none (interactive ⌘O expansion is finished by plan 012)
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/297
- **Execution**: DONE in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`); advisor
  verification accepted in the combined Track A/Track B review.

## Why this matters

Pi persists two transcript messages SumoCode silently loses:
- **`branchSummary`** — a sub-agent/branch's summary, rendered by Pi as a `[branch]` collapsible pill.
- **`compactionSummary`** — after context compaction, Pi inserts a persistent `[compaction] Compacted from N tokens` pill into the scrollback (both live and on resume).

SumoCode's `roleFromMessage` maps both to `system`, and `blocksFromMessage` has no branch for either, so it reads `record.content` (which is empty for these messages — their text lives in `record.summary`). The result is an **empty SYSTEM box** (or, live, the message is dropped because its plaintext is empty). The user loses the branch summary entirely, and after a compaction sees no record of what happened. This plan adds a single reusable "summary pill" block and wires both message kinds to it, matching Pi.

## Current state

Files:
- `src/sumo-tui/transcript/view-model.ts` — message → block mapping.
- `src/sumo-tui/widgets/chat-message.ts` — block → framed rows.
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts` — live event pump.

**Pi's formats** (verified):
- `compaction-summary-message.js`: collapsed `[compaction] Compacted from {tokensBefore.toLocaleString()} tokens (<key> to expand)`; expanded `**Compacted from N tokens**` + `message.summary` as markdown.
- `branch-summary-message.js`: collapsed `[branch] Branch summary (<key> to expand)`; expanded `**Branch Summary**` + `message.summary`.
- On `compaction_end`, Pi calls `addMessageToChat(createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, ...))`. On resume, the session re-emits the same `compactionSummary` message from the persisted entry.

**SumoCode role mapping drops them** (`view-model.ts:106`; `blocksFromMessage` is at `view-model.ts:631`):

```ts
function roleFromMessage(record: Record<string, unknown>): ChatMessageRole {
	if (record.role === "user") return "user";
	if (record.role === "assistant") return "sumo";
	return "system";
}
```

**`blocksFromMessage` has no summary branch** (`view-model.ts:619`) — it falls through to `blocksFromContent(record.content)`; for these messages `content` is undefined, so blocks are empty and `chatMessageViewModelFromPiMessage` substitutes `[{type:"markdown", text:""}]` → empty box.

**The live pump only flags the compaction reason** (`chat-viewport-controller.ts:578`) — it never inserts a summary:

```ts
			case "compaction_start":
				setCompactionReason(record.reason as CompactionReason);
				break;
			case "compaction_end":
				setCompactionReason(null);
				break;
```

**The live path drops empty-plaintext messages** (`chat-viewport-controller.ts:647`): `if (!viewModel || chatMessageViewModelToPlainText(viewModel).length === 0) return;` — so the new block MUST yield non-empty plaintext (`view-model.ts:706`).

**Existing skill-pill block** is the rendering pattern to mirror (after plan 007, the skill block carries `content` and `renderSkillRows` renders a collapsed header + expandable body). Build the summary block the same way.

**Conventions**: tabs; typed primitives; `wrapPlainText(text, width)` for the expandable body (markdown renderer is plan 011); colors from `activeThemeColors()`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit (file) | `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts` | pass |
| Unit (file) | `pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` | pass |
| Full unit | `pnpm test` | pass |
| Integration | `pnpm test:integration` | pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/view-model.ts`
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
- `src/sumo-tui/transcript/view-model.test.ts` (add)
- `src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` (add)

**Out of scope**:
- The transient compaction progress bar (`src/compaction-indicator.ts`) — keep it as the in-progress indicator; this plan adds the *persistent* summary only.
- ⌘O toggle wiring — plan 012.
- Markdown rendering of the body — plan 011.

## Git workflow

- Branch: `advisor/009-branch-compaction-summaries`
- Conventional commits, e.g. `fix(transcript): persist branch/compaction summaries`.

## Steps

### Step 1: Add a reusable `summary` ChatBlock

In `view-model.ts:44` extend the `ChatBlock` union:

```ts
	| { readonly type: "summary"; readonly kind: "branch" | "compaction"; readonly label: string; readonly content: string; readonly expanded: boolean }
```

Add a builder:

```ts
function summaryBlockFromRecord(record: Record<string, unknown>, kind: "branch" | "compaction"): ChatBlock {
	const content = firstString(record.summary, record.text, asString(record.content)) ?? "";
	const tokens = typeof record.tokensBefore === "number" ? record.tokensBefore.toLocaleString() : undefined;
	const label = kind === "compaction"
		? (tokens ? `[compaction] Compacted from ${tokens} tokens` : "[compaction] Compacted")
		: "[branch] Branch summary";
	return { type: "summary", kind, label, content, expanded: false };
}
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Dispatch the two roles in `blocksFromMessage`

Add, near the other role checks at the top of `blocksFromMessage` (before `blocksFromContent`):

```ts
	if (record.role === "branchSummary") return [summaryBlockFromRecord(record, "branch")];
	if (record.role === "compactionSummary") return [summaryBlockFromRecord(record, "compaction")];
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Render the summary block

In `chat-message.ts`, add a renderer mirroring `renderSkillRows` (from plan 007; if 007 hasn't landed, model it on the existing `renderSkillRow`):

```ts
function renderSummaryRows(block: Extract<ChatBlock, { type: "summary" }>, width: number): string[] {
	const hint = block.expanded ? "(⌘O to collapse)" : "(⌘O to expand)";
	const header = lineToAnsi(textLine([
		span(block.label, { fg: activeThemeColors().accent }),
		span(" "),
		span(hint, { fg: activeThemeColors().foregroundDim }),
	]));
	if (!block.expanded || !block.content) return [header];
	const body = wrapPlainText(block.content, width).map((row) =>
		lineToAnsi(textLine([span(row, { fg: activeThemeColors().foregroundDim })]), { width }));
	return [header, ...body];
}
```

Add the case in `renderBlockRows`:

```ts
			case "summary":
				rows.push(...renderSummaryRows(block, width));
				break;
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 4: Keep plaintext non-empty

In `chatMessageViewModelToPlainText` (`view-model.ts:707` switch), add a case so the live path does not drop these messages:

```ts
				case "summary":
					return block.label;
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 5: Insert the compaction summary live on `compaction_end`

In `chat-viewport-controller.ts` `handleAgentEvent`, change the `compaction_end` case to insert a persistent summary message into the transcript when the event carries a result. The event shape is `{ type: "compaction_end", result: { summary, tokensBefore } }`. Build a view-model message and add it the same way the controller adds other system messages (find how this controller appends a non-folded message — look for `this.chat.addViewModel` / `addMessage` usage nearby and reuse that path):

```ts
			case "compaction_end": {
				setCompactionReason(null);
				const result = asRecord(record.result);
				if (result && (typeof result.summary === "string")) {
					const vm = this.viewModelMapper.messageFromPiMessage({
						role: "compactionSummary",
						summary: result.summary,
						tokensBefore: result.tokensBefore,
					});
					if (vm) this.chat.addViewModel(vm);   // use the same append API the controller already uses for system messages
				}
				break;
			}
```

**If `this.chat.addViewModel` is not the correct append method**, search the controller for the method it already calls to add a completed (non-streaming) message to `this.chat` and use that. Do NOT invent a new ChatPager API. (`branchSummary` arrives only via session context / `get_messages`, not as a live event, so Steps 1–4 cover it; only compaction needs the live insert.)

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 6: Tests

In `view-model.test.ts`:

```ts
	it("maps a compactionSummary message to a summary pill", () => {
		const m = chatMessageViewModelFromPiMessage({ id: "c1", role: "compactionSummary", summary: "did stuff", tokensBefore: 120000 });
		expect(m?.blocks).toEqual([{ type: "summary", kind: "compaction", label: "[compaction] Compacted from 120,000 tokens", content: "did stuff", expanded: false }]);
	});
	it("maps a branchSummary message to a summary pill", () => {
		const m = chatMessageViewModelFromPiMessage({ id: "b1", role: "branchSummary", summary: "branch did stuff" });
		expect(m?.blocks).toEqual([{ type: "summary", kind: "branch", label: "[branch] Branch summary", content: "branch did stuff", expanded: false }]);
	});
```

In `chat-viewport-controller.test.ts`, add a test that feeding a `{ type: "compaction_end", result: { summary, tokensBefore } }` event through `handleAgentEvent` results in a summary message being added to the chat (use the existing controller test harness / fake `chat` in that file as the pattern).

**Verify**: `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts src/sumo-tui/pi-compat/chat-viewport-controller.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; new view-model + controller tests pass
- [ ] `pnpm test:integration` exits 0
- [ ] A `compactionSummary`/`branchSummary` message renders a `[compaction]`/`[branch]` pill — never an empty box
- [ ] `compaction_end` with a result inserts a persistent summary into scrollback
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report if:

- The controller has no existing method to append a completed message to `this.chat` (so Step 5 would require a new ChatPager API). Report what append methods exist.
- The `compaction_end` event does not carry `result.summary`/`result.tokensBefore` in the live Pi version (inspect how Pi emits it). The resume/static path (Steps 1–4) still ships; flag the live path.
- The "Current state" excerpts don't match (drift).
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **RPC migration interaction**: plan 002 (`plans/002-host-shell-transcript-chrome.md`) rewires `onEvent → handleAgentEvent` and `get_messages → replaceViewModels`. Steps 1–4 (the view-model summary block) carry forward unchanged under RPC. Step 5's live insert must be re-pointed at the RPC `onEvent` pump if/when 002 lands — note this in the 002 plan's cross-references during reconcile.
- Once plan 011 lands, render the expanded body via the markdown renderer (Pi renders the summary as Markdown).
- ⌘O expansion is wired by plan 012, which must include `"summary"` in the set of toggled block kinds.
- Reviewer should confirm the transient compaction bar and the new persistent pill don't double-report (bar = in-progress, pill = done).
