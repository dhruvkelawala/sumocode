# Plan 011: Render assistant/thinking markdown with pi-tui's Markdown component instead of literal text

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report. This plan changes captured visual
> surfaces — **you may NOT promote visual goldens; that requires human approval
> (see STOP conditions).** When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/widgets/chat-message.ts src/sumo-tui/transcript/view-model.ts`
> Compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes visual goldens → human approval gate)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/299

## Why this matters

SumoCode renders all non-code markdown as literal text: `## Plan` shows the hashes, `**bold**` shows the asterisks, `` `flag` `` shows the backticks, lists/tables/links/blockquotes all appear as raw source. This is the user's explicitly-named #2 complaint. Pi renders assistant text through pi-tui's `Markdown` component, which parses markdown (via `marked`) and emits ANSI-styled lines — headings, bold/italic/strikethrough, inline code, bullet/ordered/nested lists, task checkboxes, blockquotes, horizontal rules, links (with OSC-8), and box-drawn GFM tables. **That component is already a dependency of this repo** (`@earendil-works/pi-tui`) and is standalone-callable: `new Markdown(text, 0, 0, theme).render(width)` returns styled lines. This plan routes markdown (and thinking) blocks through it, inside the existing per-message box.

## Current state

File: `src/sumo-tui/widgets/chat-message.ts`.

**Markdown blocks are word-wrapped as plain text** (`chat-message.ts:256`, inside `renderBlockRows`):

```ts
			case "markdown":
				rows.push(...wrapPlainText(block.text, width));
				break;
```

`wrapPlainText`/`wrapParagraph` only split on newlines and word-wrap graphemes — no token parsing, no styling. (The in-file comment at `chat-message.ts:282` even notes "Markdown block parsing lands in #89/#90".)

**Thinking blocks** are also plain (`chat-message.ts:231` `renderThinkingRows` → `wrapPlainText` with a `✦/◌` prefix + italic).

**The box pipeline**: `renderBlockRows` returns body strings; each is wrapped by `frameBody(row, renderWidth)` (`chat-message.ts:204`), which calls `fitAnsiText` and **passes ANSI through unchanged** (it pads to the inner width using `visibleWidth`, which ignores ANSI). So body rows that already contain ANSI styling render correctly inside the `│ … │` frame. The `width` passed into `renderBlockRows` is `bodyWidth = renderWidth - 4` (`chat-message.ts:380`).

**`Markdown` is standalone-callable** (verified): `node_modules/@earendil-works/pi-tui/dist/components/markdown.d.ts` — `constructor(text, paddingX, paddingY, theme: MarkdownTheme, defaultTextStyle?, options?)` and `render(width: number): string[]`. `getMarkdownTheme()` is exported from `@earendil-works/pi-coding-agent` root (`index.js:37`). SumoCode runs **in-process as a Pi extension**, so Pi's theme + terminal capabilities are already initialized.

**ANSI helpers available**: `src/sumo-tui/widgets/chat-message.ts` already imports `fgHex, RESET` from `../cathedral/ansi.js` and `activeThemeColors` from `../../themes/index.js`. Use these to tint the Markdown theme with Cathedral colors.

**Conventions**: tabs; typed primitives for new lines; existing `frameBody` for the frame. Keep `wrapPlainText` for non-markdown uses (it is still used elsewhere).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit (file) | `pnpm vitest run src/sumo-tui/widgets/chat-message.test.ts` | pass |
| Full unit | `pnpm test` | pass |
| Visual capture (evidence only) | `pnpm visual:review` | produces review pack; **do not promote** |

## Scope

**In scope**:
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/widgets/chat-message.test.ts` (add)
- A new file `src/sumo-tui/transcript/markdown-theme.ts` (Cathedral MarkdownTheme builder)

**Out of scope**:
- Promoting/updating visual goldens (`pnpm visual:promote`, `docs/ui/bible/**`, `docs/visual/out/**`) — human approval required.
- `markdownAndCodeBlocksFromText` / fenced-code splitting — unchanged; fenced code still becomes `code` blocks rendered by `code-renderer.ts`.
- Skill/summary expandable bodies (plans 007/009) — they may adopt this renderer later, but do not change them here.

## Git workflow

- Branch: `advisor/011-adopt-pi-markdown`
- Conventional commits, e.g. `feat(transcript): render markdown via pi-tui Markdown`.

## Steps

### Step 1: Build a Cathedral-tinted MarkdownTheme

Create `src/sumo-tui/transcript/markdown-theme.ts`. Start from Pi's `getMarkdownTheme()` (so every required theme function exists and stays in sync with Pi) and override the color-bearing ones with Cathedral hexes:

```ts
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { fgHex, RESET } from "../cathedral/ansi.js";
import { activeThemeColors } from "../../themes/index.js";

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const wrap = (text: string, hex: string, sgr = "") => `${sgr}${fgHex(hex)}${text}${RESET}`;

export function cathedralMarkdownTheme(): MarkdownTheme {
	const c = activeThemeColors();
	return {
		...getMarkdownTheme(),
		heading: (t) => wrap(t, c.accent, BOLD),
		bold: (t) => `${BOLD}${t}${RESET}`,
		italic: (t) => `${ITALIC}${t}${RESET}`,
		code: (t) => wrap(t, c.accent),
		listBullet: (t) => wrap(t, c.accent),
		link: (t) => wrap(t, c.accent),
		linkUrl: (t) => wrap(t, c.foregroundDim),
		quoteBorder: (t) => wrap(t, c.divider),
		hr: (t) => wrap(t, c.divider),
	};
}
```

Adjust the override set to the actual `MarkdownTheme` function names (the type is in `node_modules/@earendil-works/pi-tui/dist/components/markdown.d.ts` — `heading, link, linkUrl, code, codeBlock, codeBlockBorder, quote, quoteBorder, hr, listBullet, bold, italic, strikethrough, underline`). Only override the ones above; the spread keeps the rest.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Route markdown blocks through Markdown

In `chat-message.ts`, add imports:

```ts
import { Markdown } from "@earendil-works/pi-tui";
import { cathedralMarkdownTheme } from "../transcript/markdown-theme.js";
```

Replace the markdown case in `renderBlockRows` (`chat-message.ts:256`):

```ts
			case "markdown": {
				const lines = new Markdown(block.text, 0, 0, cathedralMarkdownTheme()).render(width);
				rows.push(...(lines.length > 0 ? lines : [""]));
				break;
			}
```

`width` is the body width (`renderWidth - 4`); `frameBody` wraps each returned line. Keep the empty-array guard so a blank block still yields one row.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Route thinking blocks through the same renderer (italic default style)

In `renderThinkingRows` (`chat-message.ts:231`), render the thinking text with `Markdown` using a `DefaultTextStyle` of `{ italic: true, color: (t) => wrapThinking(t) }`, keeping the `✦/◌ ` prefix as a per-line gutter. Mirror the structure of the current function but replace the `wrapPlainText(block.text, …)` call with `new Markdown(block.text, 0, 0, cathedralMarkdownTheme(), { italic: true }).render(width - prefixWidth)`, prefixing each line. If threading the prefix is awkward, it is acceptable to keep thinking on `wrapPlainText` and note it as a follow-up — thinking markdown is the lowest-priority part of this plan.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 4: Tests

In `chat-message.test.ts`, add tests asserting markdown is no longer literal (use the file's existing render harness + `stripAnsi`):

```ts
	it("renders bold and headings as styled, not literal markdown", () => {
		// build a ChatMessage / call the block renderer with a markdown block "# Title\n**bold** text"
		// then: stripAnsi(rows.join("\n")) must NOT contain "**" or a leading "# "
		// and the raw rows MUST contain a bold SGR ([1m)
	});
	it("renders a bullet list with a styled bullet", () => {
		// markdown block "- one\n- two" → stripAnsi shows the items; bullets present
	});
```

Fill these in following the existing assertions style in `chat-message.test.ts` (it constructs messages and asserts on `stripAnsi(...)`). Assert: no literal `**`, no literal leading `# `, and presence of a bold SGR escape.

**Verify**: `pnpm vitest run src/sumo-tui/widgets/chat-message.test.ts` → all pass.

### Step 5: Produce visual evidence (then STOP for human review)

Run `pnpm visual:review` to regenerate the review pack and inspect the markdown surfaces. Do **not** run `pnpm visual:promote` and do **not** edit any golden. Per `AGENTS.md`, golden promotion requires Dhruv's explicit approval. Report the review-pack location and STOP for human sign-off.

**Verify**: `pnpm visual:review` produces a review pack under `docs/visual/out/` (exit 0). Then STOP.

## Done criteria

ALL must hold (the executor's portion):

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; new chat-message markdown tests pass
- [ ] `grep -n "wrapPlainText(block.text" src/sumo-tui/widgets/chat-message.ts` no longer matches the markdown case (it now uses `Markdown`)
- [ ] `pnpm visual:review` regenerated evidence; review pack path reported
- [ ] Visual goldens NOT modified (`git status` shows no changes under `docs/ui/bible/**` or `docs/visual/out/**` staged for commit)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row for 011 updated to **BLOCKED (awaiting golden approval)** if the visual diff is intentional, else DONE if no golden change is required

## STOP conditions

Stop and report if:

- `pnpm visual:ci` would require promoting/changing a golden — that needs Dhruv. Produce the evidence (`visual:review`) and STOP; never run `visual:promote`.
- `Markdown` cannot be constructed/rendered standalone (e.g. it throws needing a TUI context) — report the error; do NOT fall back to leaving markdown literal silently.
- `getMarkdownTheme()` throws because Pi's theme isn't initialized in this context — report it (the in-process assumption would be wrong).
- A verification fails twice after a reasonable fix.

## Maintenance notes

- Markdown is now rendered by Pi's `marked`-based renderer; if Pi upgrades change `MarkdownTheme`'s shape, `markdown-theme.ts`'s spread keeps new fields but the executor/reviewer should re-check the overrides.
- Wide GFM tables fall back to raw markdown when the terminal is too narrow (pi-tui behavior) — acceptable.
- Reviewer should scrutinize: (1) the box frame still aligns (ANSI passes through `fitAnsiText` correctly), (2) selection/copy of rendered markdown (plan-independent, but worth a glance), (3) no double-rendering of fenced code (fenced code is split out before this block and rendered by `code-renderer.ts`).
- Follow-up: tint the remaining `MarkdownTheme` functions (codeBlock, quote, strikethrough, underline) to Cathedral tokens if the first pass leaves any off-palette.
