# Plan 012: Resolve expand hints from the live keybinding and make ⌘O expand every collapsible block, not just tools

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/transcript/tool-renderer.ts src/sumo-tui/widgets/chat-message.ts`
> Compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans 007 (skill `content`/`renderSkillRows`) and 009 (`summary` block) — this plan toggles and labels those block kinds. If 007/009 are not yet landed, apply only the parts that match the live block set and note the rest.
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/300
- **Execution**: DONE in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`); advisor
  verification accepted in the combined Track A/Track B review.

## Why this matters

Two related defects:
1. **Hardcoded `⌘O` hints.** Every "to expand" affordance hardcodes the literal `⌘O` — which is the *wrong glyph* (the real binding is `ctrl+o`) and never reflects a user's rebind. Pi resolves the live bound key via `keyText("app.tools.expand")`.
2. **⌘O only expands tools.** The global expand toggle calls `setToolExpansion`, which only flips `tool` blocks. Skill pills (plan 007) and branch/compaction summaries (plan 009) carry an `expanded` flag that nothing ever toggles — so "expand" silently does nothing for them.

This plan resolves the hint from the keybinding registry and broadens the toggle to every block kind that has an `expanded` flag.

## Current state

**Hardcoded hints**:
- `tool-renderer.ts:96` `compactHint`:
  ```ts
  function compactHint(tool: ToolCallViewModel): string {
  	if (tool.status === "error") return "⌘O error";
  	if (tool.name === "edit") return "⌘O diff";
  	if (tool.name === "bash") return "⌘O output";
  	return "⌘O expand";
  }
  ```
- `chat-message.ts:223` `renderSkillRow` (or `renderSkillRows` after plan 007): hint string `"(⌘O to expand)"`.
- Plan 009's `renderSummaryRows`, if present: same `"(⌘O to expand)"`.

**`keyText` is root-exported** (`@earendil-works/pi-coding-agent` `index.js:35`): `keyText(keybinding)` returns the formatted bound key (e.g. `"ctrl+o"`). It reads `getKeybindings()`, which is initialized in-process but **may not be in the vitest environment** — so wrap it with a fallback.

**The toggle only handles tools** (`chat-message.ts:333`):

```ts
	public setToolExpansion(expanded: boolean): boolean {
		if (!this.blocks?.some((block) => block.type === "tool")) return false;
		this.blocks = this.blocks.map((block) => block.type === "tool" ? { ...block, tool: { ...block.tool, expanded } } : block);
		this.markDirty();
		return true;
	}
```

**Callers (do not rename the method)**: `chat-pager.ts:191` `setToolExpansion(expanded)` iterates messages: `changed = message.setToolExpansion(expanded) || changed;`. `chat-viewport-controller.ts:1045` calls `snapshot.chat.setToolExpansion(expanded)`. The method name is the bridge contract — **keep the name `setToolExpansion`**; only broaden what it toggles.

**Existing test asserts the literal** (`tool-renderer.test.ts:13`): `expect(stripAnsi(line)).toBe("✓ [read]  src/auth/session.ts  · ⌘O expand");` — this must be updated.

**Conventions**: tabs; typed primitives. Import `keyText` from the package root.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit (file) | `pnpm vitest run src/sumo-tui/transcript/tool-renderer.test.ts` | pass |
| Unit (file) | `pnpm vitest run src/sumo-tui/widgets/chat-message.test.ts` | pass |
| Full unit | `pnpm test` | pass |

## Scope

**In scope**:
- `src/sumo-tui/transcript/tool-renderer.ts`
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/transcript/tool-renderer.test.ts` (update assertions)
- A small shared helper file `src/sumo-tui/transcript/expand-key.ts` (new)

**Out of scope**:
- Renaming `setToolExpansion` anywhere.
- Delegation/sub-agent expand (the `delegation` block has no `expanded` flag yet — that is a separate finding; do not add it here).
- The `app.tools.expand` keybinding wiring itself (already bridged at `chat-viewport-controller.ts:1043-1045`).

## Git workflow

- Branch: `advisor/012-keybinding-hints-and-expand-all`
- Conventional commits, e.g. `fix(transcript): resolve expand hint from keybinding; expand all block kinds`.

## Steps

### Step 1: Add an `expandKey()` helper with a test-safe fallback

Create `src/sumo-tui/transcript/expand-key.ts`:

```ts
import { keyText } from "@earendil-works/pi-coding-agent";

/** The user's bound expand key (e.g. "ctrl+o"), or a stable fallback when keybindings aren't initialized (tests). */
export function expandKey(): string {
	try {
		const key = keyText("app.tools.expand");
		return key && key.length > 0 ? key : "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Use it in the tool pill hints

In `tool-renderer.ts`, import `expandKey` and rewrite `compactHint`:

```ts
function compactHint(tool: ToolCallViewModel): string {
	const key = expandKey();
	if (tool.status === "error") return `${key} error`;
	if (tool.name === "edit") return `${key} diff`;
	if (tool.name === "bash") return `${key} output`;
	return `${key} expand`;
}
```

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Use it in skill (and summary) hints

In `chat-message.ts`, import `expandKey`. Replace the hardcoded `"(⌘O to expand)"` / `"(⌘O to collapse)"` strings in `renderSkillRows` (plan 007) — and in `renderSummaryRows` (plan 009) if present — with:

```ts
	const hint = block.expanded ? `(${expandKey()} to collapse)` : `(${expandKey()} to expand)`;
```

If plan 007 has not landed and the live function is still the single-line `renderSkillRow` with `"(⌘O to expand)"`, update that literal the same way.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 4: Broaden `setToolExpansion` to all expandable block kinds

Rewrite the body in `chat-message.ts:333` (keep the name and signature):

```ts
	public setToolExpansion(expanded: boolean): boolean {
		const expandable = (b: ChatBlock): boolean => b.type === "tool" || b.type === "skill" || b.type === "summary";
		if (!this.blocks?.some(expandable)) return false;
		this.blocks = this.blocks.map((block) => {
			if (block.type === "tool") return { ...block, tool: { ...block.tool, expanded } };
			if (block.type === "skill") return { ...block, expanded };
			if (block.type === "summary") return { ...block, expanded };
			return block;
		});
		this.markDirty();
		return true;
	}
```

(If the `summary` block kind from plan 009 isn't present yet, omit its branch and the `|| b.type === "summary"` clause; add them when 009 lands.)

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 5: Update tests

In `tool-renderer.test.ts`, update the literal assertion (line ~13) to the resolved key. In the vitest environment `expandKey()` returns its fallback `"ctrl+o"`:

```ts
		expect(stripAnsi(line)).toBe("✓ [read]  src/auth/session.ts  · ctrl+o expand");
```

Update any other test asserting a `⌘O …` literal similarly. Add a test that `setToolExpansion(true)` flips a `skill` block's `expanded` to `true` and returns `true` (construct a `ChatMessage` whose blocks include a skill block; call `setToolExpansion(true)`; assert via the rendered rows or a snapshot accessor).

**Verify**: `pnpm vitest run src/sumo-tui/transcript/tool-renderer.test.ts src/sumo-tui/widgets/chat-message.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; updated/added tests pass
- [ ] `grep -rn "⌘O" src/sumo-tui/` returns no matches in non-test source (the glyph is gone from production code)
- [ ] `setToolExpansion(true)` flips `tool`, `skill`, and (if present) `summary` blocks and returns `true` when any exist
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report if:

- `keyText` is not importable from `@earendil-works/pi-coding-agent` (check `dist/index.js`). Do not hardcode a different glyph.
- `getKeybindings()` throws *outside* a try/catch in some code path you touch — the helper's try/catch should contain it; if it doesn't, report.
- A test asserts a `⌘O` literal that you cannot map to the resolved/fallback key without changing behavior — report it.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- `expandKey()` is the single source for the expand hint; reuse it anywhere a new "to expand" affordance is added.
- The `setToolExpansion` name is now a slight misnomer (it expands all collapsible kinds). A future rename to `setExpansion` would also touch `chat-pager.ts:191` and `chat-viewport-controller.ts:1045` — deferred to keep this plan low-risk.
- When delegation/sub-agent blocks gain an `expanded` flag (separate finding), add a `delegation` branch here.
- Reviewer should confirm the visual width of pills didn't break layout — `ctrl+o` is one char longer than `⌘O`; the pill is right-aligned/rule-filled, so verify the tool-renderer width tests still pad to the exact terminal width.
