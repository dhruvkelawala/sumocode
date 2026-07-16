# Plan 007: Render skill invocations as a collapsed [skill] pill instead of dumping the whole SKILL.md body

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/transcript/view-model.ts src/sumo-tui/widgets/chat-message.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (interactive ⌘O expansion of the new body is completed by plan 012; the content-recovery fix here ships independently)
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/295
- **Execution**: DONE in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`); advisor
  verification accepted in the combined Track A/Track B review.

## Why this matters

When a user runs a skill (e.g. `/deep-research ...`), Pi delivers it as an ordinary `user` message whose text is a `<skill name=".." location="..">…full SKILL.md body…</skill>` envelope. Pi's native TUI parses that envelope and renders a one-line collapsed `[skill] <name>` pill. SumoCode never parses it, so the **entire SKILL.md body — hundreds of lines — plus the user's real trailing message get dumped as a raw markdown blob inside a YOU box.** This is the most visible "renders full skill data" regression. Pi already exports the exact parser (`parseSkillBlock`), so this is a small, parity-exact fix. After it lands, a skill invocation shows as a tidy collapsed pill that expands to the body, matching Pi.

## Current state

Files:
- `src/sumo-tui/transcript/view-model.ts` — maps Pi messages → `ChatBlock[]`. The skill envelope is never recognized here.
- `src/sumo-tui/widgets/chat-message.ts` — renders `ChatBlock`s into framed rows; `renderSkillRow` draws the pill.

**Pi delivers the skill as a `user` string-content message.** Pi's parser (already exported from the package root — confirmed at `node_modules/@earendil-works/pi-coding-agent/dist/index.js:5`):

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:41
export function parseSkillBlock(text) {
    const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
    if (!match) return null;
    return { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() || undefined };
}
```

**SumoCode's `ChatBlock` skill variant has no `content` field** (`view-model.ts:50`):

```ts
	| { readonly type: "skill"; readonly name: string; readonly expanded: boolean }
```

**`skillBlockFromRecord` only captures name + expanded** (`view-model.ts:196`):

```ts
function skillBlockFromRecord(record: Record<string, unknown>): ChatBlock {
	return {
		type: "skill",
		name: firstString(record.name, record.skill, record.skillName) ?? "unknown-skill",
		expanded: asBoolean(record.expanded) ?? false,
	};
}
```

**`blocksFromMessage` has no skill-envelope branch; `user` string content flows straight to markdown** (`view-model.ts:631`):

```ts
function blocksFromMessage(record: Record<string, unknown>): ChatBlock[] {
	if (record.role === "bashExecution") { /* ... */ }
	if (record.role === "toolResult") { /* ... */ }
	if (record.role === "custom" && typeof record.customType === "string") {
		if (record.customType === "skill") return [skillBlockFromRecord(asRecord(record.details) ?? record)];
		/* question / delegation */
	}

	const blocks = blocksFromContent(record.content);   // ← string content → markdownAndCodeBlocksFromText → raw dump
	if (blocks.length > 0) return blocks;
	const errorMessage = asString(record.errorMessage);
	return errorMessage ? [{ type: "markdown", text: errorMessage }] : [];
}
```

`textFromContent` (`view-model.ts:154`) extracts a message's text (handles both `string` content and `[{type:"text",text}]` arrays) — reuse it to get the text to parse.

**The pill renderer always renders ONE line** regardless of `expanded` (`chat-message.ts:222`):

```ts
function renderSkillRow(block: Extract<ChatBlock, { type: "skill" }>): string {
	const hint = block.expanded ? "(expanded)" : "(⌘O to expand)";
	return lineToAnsi(textLine([
		span("[skill]", { fg: activeThemeColors().accent }),
		span(` ${block.name} `, { fg: activeThemeColors().foreground }),
		span(hint, { fg: activeThemeColors().foregroundDim }),
	]));
}
```

`renderBlockRows` calls it (`chat-message.ts:268`): `case "skill": rows.push(renderSkillRow(block)); break;` — note it pushes a single string, so to render a multi-row expanded body you must push multiple rows.

**The plaintext projection** (`view-model.ts:720`) — this MUST stay non-empty for any skill block, because the live path (`chat-viewport-controller.ts:647`) drops a message whose `chatMessageViewModelToPlainText` is empty:

```ts
				case "skill":
					return `[skill] ${block.name}${block.expanded ? " (expanded)" : " (⌘O to expand)"}`;
```

**Conventions**: tabs for indentation; typed render primitives (`span`/`textLine`/`lineToAnsi`) — never hand-rolled ANSI (see `AGENTS.md` "Do not hand-roll new ANSI"). Deep-import of Pi internals is an established pattern, but here import from the package **root** since `parseSkillBlock` is root-exported. Markdown body rendering uses `wrapPlainText(text, width)` today (the dedicated markdown renderer is plan 011) — render the expanded skill body with `wrapPlainText` for now so this plan does not depend on 011.

## Commands you will need

| Purpose   | Command                                                        | Expected |
|-----------|---------------------------------------------------------------|----------|
| Typecheck | `pnpm exec tsc --noEmit`                                       | exit 0, no errors |
| Build     | `pnpm build`                                                  | exit 0 (alias for typecheck) |
| Unit test (file) | `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts` | all pass |
| Unit test (file) | `pnpm vitest run src/sumo-tui/widgets/chat-message.test.ts`  | all pass |
| Full unit suite | `pnpm test`                                             | all pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/view-model.ts`
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/transcript/view-model.test.ts` (add tests)
- `src/sumo-tui/widgets/chat-message.test.ts` (add tests)

**Out of scope** (do NOT touch):
- The interactive ⌘O toggle wiring (`setToolExpansion` in `chat-message.ts`) beyond what is needed to render the `expanded` flag — making ⌘O flip skill blocks is plan 012. This plan only renders the two states given the flag.
- `markdownAndCodeBlocksFromText` and the markdown renderer — plan 011.
- Pi's `dist/` files — never edit vendored Pi.

## Git workflow

- Branch: `advisor/007-skill-envelope-pill`
- Conventional commits (repo style, e.g. `fix(transcript): parse skill envelope into a pill`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `content` to the skill ChatBlock

In `view-model.ts:50`, extend the skill variant:

```ts
	| { readonly type: "skill"; readonly name: string; readonly expanded: boolean; readonly content?: string }
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Parse the skill envelope in `blocksFromMessage`

At the top of `view-model.ts`, add: `import { parseSkillBlock } from "@earendil-works/pi-coding-agent";`

In `blocksFromMessage`, BEFORE the final `const blocks = blocksFromContent(record.content);` line, add a branch that runs only for `user` messages:

```ts
	if (record.role === "user") {
		const text = textFromContent(record.content);
		const skill = parseSkillBlock(text);
		if (skill) {
			const blocks: ChatBlock[] = [{ type: "skill", name: skill.name, expanded: false, content: skill.content }];
			if (skill.userMessage) blocks.push(...markdownAndCodeBlocksFromText(skill.userMessage));
			return blocks;
		}
	}
```

`parseSkillBlock` returns `null` for non-skill text, so ordinary user messages are unaffected.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Render the body when expanded

In `chat-message.ts`, rewrite `renderSkillRow` to return `string[]` and render the body when expanded. Use `wrapPlainText` (already imported in this file) for the body, and emit a bold name header mirroring Pi:

```ts
function renderSkillRows(block: Extract<ChatBlock, { type: "skill" }>, width: number): string[] {
	const hint = block.expanded ? "(⌘O to collapse)" : "(⌘O to expand)";
	const header = lineToAnsi(textLine([
		span("[skill]", { fg: activeThemeColors().accent }),
		span(` ${block.name} `, { fg: activeThemeColors().foreground }),
		span(hint, { fg: activeThemeColors().foregroundDim }),
	]));
	if (!block.expanded || !block.content) return [header];
	const body = wrapPlainText(block.content, width).map((row) => lineToAnsi(textLine([
		span(row, { fg: activeThemeColors().foregroundDim }),
	]), { width }));
	return [header, ...body];
}
```

Update the call site in `renderBlockRows` (`chat-message.ts:268`):

```ts
			case "skill":
				rows.push(...renderSkillRows(block, width));
				break;
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 4: Keep the plaintext projection non-empty and body-aware

In `view-model.ts:720`, the skill case already returns a non-empty string — leave it returning at least `[skill] <name>`. (Do not return the full body here; this string is used for liveness/dedup, not display.) Confirm it still reads:

```ts
				case "skill":
					return `[skill] ${block.name}${block.expanded ? " (expanded)" : " (⌘O to expand)"}`;
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 5: Tests

In `view-model.test.ts`, add (model after the existing `chatMessageViewModelFromPiMessage` tests at the top of the file):

```ts
	it("parses a skill envelope into a collapsed skill block", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "u-skill",
			role: "user",
			content: '<skill name="deep-research" location="/skills/dr/SKILL.md">\nfull body line 1\nfull body line 2\n</skill>\n\nplease research foxes',
		});
		expect(message?.blocks).toEqual([
			{ type: "skill", name: "deep-research", expanded: false, content: "full body line 1\nfull body line 2" },
			{ type: "markdown", text: "please research foxes" },
		]);
	});

	it("leaves a non-skill user message as markdown", () => {
		const message = chatMessageViewModelFromPiMessage({ id: "u1", role: "user", content: "hello **sumo**" });
		expect(message?.blocks).toEqual([{ type: "markdown", text: "hello **sumo**" }]);
	});
```

In `chat-message.test.ts`, add a test that an expanded skill block renders the header plus body rows and a collapsed one renders a single header row. Use the existing test harness in that file as the structural pattern (it constructs a `ChatMessage` / calls the row renderer and asserts on `stripAnsi`).

**Verify**: `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts src/sumo-tui/widgets/chat-message.test.ts` → all pass, including the new tests.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; the two new view-model tests and the chat-message skill test pass
- [ ] `grep -n "parseSkillBlock" src/sumo-tui/transcript/view-model.ts` shows the import and the call
- [ ] A `user` message whose content is a `<skill …>…</skill>` envelope yields a `skill` block (collapsed) + the trailing user markdown — never a raw dump of the body
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report (do not improvise) if:

- `parseSkillBlock` is NOT importable from `@earendil-works/pi-coding-agent` (check `node_modules/@earendil-works/pi-coding-agent/dist/index.js` for the export). Do not re-implement the regex without flagging it.
- The "Current state" excerpts don't match the live code (drift).
- `textFromContent` does not exist or has a different signature than described.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The expanded skill body uses `wrapPlainText`; once plan 011 (pi-tui Markdown) lands, route the body through the markdown renderer for parity with Pi's `SkillInvocationMessageComponent` (which renders the body as Markdown).
- The ⌘O interactive toggle for skill blocks is completed by plan 012 (it generalizes `setToolExpansion`). Until then the block renders correctly for whichever `expanded` value it carries, but pressing ⌘O only toggles `tool` blocks.
- Reviewer should confirm an ordinary user message containing a literal `<skill` substring that is NOT a full envelope (e.g. pasted code) still renders as markdown — `parseSkillBlock`'s regex is anchored with `^…$`, so partial matches return `null`; a test for this is worth adding.
