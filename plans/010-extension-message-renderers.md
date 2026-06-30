# Plan 010: Recover provenance for custom (extension) messages — label them instead of dumping undifferentiated text

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/transcript/view-model.ts src/sumo-tui/widgets/chat-message.ts`
> Compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/298

## Why this matters

Pi's `addMessageToChat` `custom` case consults `extensionRunner.getMessageRenderer(customType)` and, when no renderer exists, renders a bold `[<customType>]` label + the content in the custom-message style. SumoCode's retained renderer only special-cases custom types `skill`/`question`/`delegation`; **every other custom type — including SumoCode's own `answers`, `slate`, `sumo:worktree`, and `sumocode-theme-result` — falls through to plain markdown of the content with no `[customType]` label and no distinct styling.** The viewer cannot tell which extension produced the message, and a renderer-only message (empty `content`, relying on `details`) is dropped entirely because the live path bails on empty plaintext. This plan recovers **provenance and visibility** for all custom messages — the achievable, box-compatible win. (Full hosting of extension-registered *live Components* inside the box is deferred — see Maintenance; it overlaps the RPC migration's `extension_ui` work in plan 003.)

## Current state

Files:
- `src/sumo-tui/transcript/view-model.ts` — custom-message dispatch.
- `src/sumo-tui/widgets/chat-message.ts` — block rendering.

**SumoCode's own custom types** (these all currently render as unlabeled raw text under the retained renderer):
- `answers` — `src/answer-tool.ts:375`
- `slate` (`SLATE_CUSTOM_TYPE`) — `src/slate.ts:92`
- `sumo:worktree` — `src/commands/worktree.ts:41`
- `sumocode-theme-result` (`THEME_RESULT_CUSTOM_TYPE`) — `src/commands/theme.ts:36`, registered via `pi.registerMessageRenderer(...)` at `theme.ts:98` returning a live `ThemeResultComponent`.

**The custom dispatch only handles three types** (`view-model.ts:641`):

```ts
	if (record.role === "custom" && typeof record.customType === "string") {
		if (record.customType === "skill") return [skillBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "question") return [questionBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "delegation") return [delegationBlockFromRecord(asRecord(record.details) ?? record)];
	}

	const blocks = blocksFromContent(record.content);   // ← unknown customType → unlabeled markdown
	if (blocks.length > 0) return blocks;
	const errorMessage = asString(record.errorMessage);
	return errorMessage ? [{ type: "markdown", text: errorMessage }] : [];
```

**Hidden custom messages are already filtered** (`view-model.ts:656`): `if (record.role === "custom" && record.display === false) return undefined;` — so this plan only affects `display !== false` custom messages.

**The live path drops empty plaintext** (`chat-viewport-controller.ts:647`), so a renderer-only custom message (`content: ""`) is lost. Adding a `[customType]` label gives it non-empty plaintext and rescues it.

**Conventions**: tabs; typed primitives; `activeThemeColors()`. SumoCode declares `customMessageLabel`/`customMessageText` theme tokens (referenced in `src/theme-check.ts`) — prefer those for the label if present, else `accent`/`foregroundDim`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit (file) | `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts` | pass |
| Full unit | `pnpm test` | pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/view-model.ts`
- `src/sumo-tui/transcript/view-model.test.ts` (add)

**Out of scope**:
- Hosting live `Component` instances (e.g. `ThemeResultComponent`) inside the retained box — deferred (see Maintenance; overlaps RPC plan 003). Do NOT attempt to wire `getMessageRenderer` / mount Components in this plan.
- `skill`/`question`/`delegation` handling — unchanged.
- `chat-message.ts` — no new renderer needed; the label is emitted as a markdown block.

## Git workflow

- Branch: `advisor/010-extension-message-renderers`
- Conventional commits, e.g. `fix(transcript): label unknown custom messages`.

## Steps

### Step 1: Add a labeled fallback for unrecognized custom types

In `blocksFromMessage`, replace the custom branch so an unrecognized `customType` still emits a provenance label before its content:

```ts
	if (record.role === "custom" && typeof record.customType === "string") {
		if (record.customType === "skill") return [skillBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "question") return [questionBlockFromRecord(asRecord(record.details) ?? record)];
		if (record.customType === "delegation") return [delegationBlockFromRecord(asRecord(record.details) ?? record)];
		// Unrecognized custom type: preserve provenance (mirrors Pi's CustomMessageComponent default).
		const labeled: ChatBlock[] = [{ type: "markdown", text: `[${record.customType}]` }];
		labeled.push(...blocksFromContent(record.content));
		return labeled;
	}
```

This recovers a non-empty plaintext (`[answers]`, `[sumocode-theme-result]`, …) for every custom message, so the live path no longer drops renderer-only messages, and the viewer sees which extension produced it.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Tests

In `view-model.test.ts`:

```ts
	it("labels an unrecognized custom message with its customType", () => {
		const m = chatMessageViewModelFromPiMessage({ id: "x1", role: "custom", customType: "sumocode-theme-result", display: true, content: "switched to obsidian" });
		expect(m?.blocks).toEqual([
			{ type: "markdown", text: "[sumocode-theme-result]" },
			{ type: "markdown", text: "switched to obsidian" },
		]);
	});

	it("rescues a renderer-only custom message (empty content) via the label", () => {
		const m = chatMessageViewModelFromPiMessage({ id: "x2", role: "custom", customType: "answers", display: true, content: "" });
		expect(m?.blocks).toEqual([{ type: "markdown", text: "[answers]" }]);
		expect(chatMessageViewModelToPlainText(m!)).toContain("[answers]");
	});

	it("still hides display:false custom messages", () => {
		const m = chatMessageViewModelFromPiMessage({ id: "x3", role: "custom", customType: "answers", display: false, content: "secret" });
		expect(m).toBeUndefined();
	});
```

**Verify**: `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; the three new tests pass
- [ ] An unrecognized custom message renders `[<customType>]` + its content (never undifferentiated, never dropped)
- [ ] `display: false` custom messages are still hidden
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report if:

- The current `blocksFromMessage` custom branch differs from the excerpt (drift).
- Removing the unlabeled fallthrough breaks an existing test that expects an unknown custom type to render WITHOUT a label — report it; the label is intended, but flag the conflict.
- You are tempted to mount `ThemeResultComponent` (or any live Component) to make `theme_result` render richly — that is the deferred, out-of-scope part. STOP and note it as a follow-up rather than building it here.

## Maintenance notes

- **Deferred follow-up (the L part)**: hosting extension-registered live `Component`s inside the retained box so `sumocode-theme-result` (and any third-party extension renderer) renders richly rather than as a labeled text blob. This needs a controller-level bridge from `extensionRunner.getMessageRenderer(customType)` into a new `ChatBlock` kind that `chat-message.ts` can mount. It overlaps the RPC migration's `extension_ui` responder (`plans/003-extension-ui-responder-selectors.md`) — coordinate there rather than building a parallel mechanism. Track as a separate finding.
- Reviewer should confirm `slate`, `answers`, and `sumo:worktree` messages now show their label and that none of them previously depended on the *absence* of a label.
- Once richer rendering lands for a given customType, replace its labeled-markdown fallback with the dedicated path.
