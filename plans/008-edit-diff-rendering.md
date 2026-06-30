# Plan 008: Render the colored line-numbered diff Pi already computes for every file edit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ae03bc0..HEAD -- src/sumo-tui/transcript/tool-renderer.ts`
> If it changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S (core fix) — intra-line word highlight in Step 4 is an optional M stretch
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ae03bc0`, 2026-06-30
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/296

## Why this matters

Seeing what the agent changed — as a colored `+`/`-` diff with line numbers — is the single most important affordance of a coding agent. Pi computes exactly that for every edit and attaches it as `details.diff`, **a newline-joined string**. SumoCode's `renderEditBody` reads it with `arrayFromDetails(details, "diff")`, which returns `[]` for anything that is not an `Array`. So the string is discarded, every edit falls through to a one-line `"diff collapsed"` stub, and the diff never renders. This is a pure type-mismatch bug: the data is present and high-quality; SumoCode throws it away. The fix is ~10 lines and stays entirely inside the existing tool-ledger box.

## Current state

File: `src/sumo-tui/transcript/tool-renderer.ts` — renders the framed tool ledger.

**Pi attaches the diff as a STRING** (verified): `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js:219` sets `details: { diff: diffResult.diff, ... }` where `diffResult.diff = output.join("\n")` (`edit-diff.js:308`). Each diff line already carries a `+`/`-`/space prefix and an embedded, correctly-tracked line number, e.g.:

```
 12 const unchanged = true;
-14 const old = 1;
+14 const next = 2;
```

The edit tool's result *text* is just `Successfully replaced N block(s) in <path>.` (`edit.js:216`) — no `+N/-N` counts — so the existing summary fallback shows only that sentence.

**The array-only gate** (`tool-renderer.ts:180`):

```ts
function arrayFromDetails(details: Record<string, unknown> | undefined, key: string): string[] {
	const value = details?.[key];
	if (!Array.isArray(value)) return [];   // ← Pi's STRING diff is rejected here
	return value.filter((item): item is string => typeof item === "string");
}
```

**`renderEditBody`** (`tool-renderer.ts:221`):

```ts
function renderEditBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const diffLines = arrayFromDetails(details, "diff").map(terminalSafeText);

	// No explicit diff array → render summary from output/note
	if (diffLines.length === 0) {
		const note = toolNote(tool) ?? "diff collapsed";
		return renderEditSummary(note, width);
	}

	// Render actual diff lines with gutter
	const startLine = typeof details?.startLine === "number" ? details.startLine : 1;
	const rows = diffLines.slice(0, TOOL_BODY_MAX_LINES).map((line, index) => {
		const color = line.trimStart().startsWith("+") ? activeThemeColors().states.idle
			: line.trimStart().startsWith("-") ? activeThemeColors().states.approval
			: activeThemeColors().foreground;
		return renderGutterLine(startLine + index, line, width, color);   // ← prepends its OWN number
	});
	const collapsed = collapsedMarker(details, Math.max(0, diffLines.length - rows.length));
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: activeThemeColors().foregroundDim }), span(collapsed, { fg: activeThemeColors().foregroundDim })], width));
	return rows;
}
```

**Critical subtlety**: `renderGutterLine` (`tool-renderer.ts:191`) prepends `String(lineNumber).padStart(4)`. Pi's diff lines **already contain their line numbers**, so feeding Pi's string through `renderGutterLine` would produce a *doubled, wrong* number (a synthetic `startLine+index` gutter PLUS Pi's embedded number). Pi's diff must therefore render via `renderBodyLine` (no gutter), not `renderGutterLine`.

`renderBodyLine` (`tool-renderer.ts:160`) draws `│ ` + the given spans inside the ledger background. `renderEditSummary` (`tool-renderer.ts:210`) is the existing `+N/-N`/`diff collapsed` summary path — keep it as the fallback for when no diff string is present (an existing test at `tool-renderer.test.ts` relies on the `output: "+14 -6 …"` summary path).

**Conventions**: tabs; typed primitives (`span`/`renderBodyLine`); colors from `activeThemeColors()` (NOT Pi's theme). Do NOT reuse Pi's `renderDiff` for the core fix — it colors lines from Pi's interactive `theme` global, not SumoCode's Cathedral palette, so it would render off-theme. (`renderDiff` is an option only for the optional Step 4 intra-line highlight, and even then port the technique rather than the colors.)

## Commands you will need

| Purpose   | Command                                                          | Expected |
|-----------|-----------------------------------------------------------------|----------|
| Typecheck | `pnpm exec tsc --noEmit`                                         | exit 0 |
| Unit test (file) | `pnpm vitest run src/sumo-tui/transcript/tool-renderer.test.ts` | all pass |
| Full unit suite | `pnpm test`                                               | all pass |
| Visual gate | `pnpm visual:ci`                                               | pass (tool ledger is a captured surface) |

## Scope

**In scope**:
- `src/sumo-tui/transcript/tool-renderer.ts`
- `src/sumo-tui/transcript/tool-renderer.test.ts` (add tests)

**Out of scope**:
- `view-model.ts` `toolBlockFromRecord` — `details` is already passed through verbatim (`view-model.ts:189`); no change needed.
- The compact-pill `⌘O diff` hint text — plan 012.
- Default tool expansion (`expanded: true`) — separate finding, not this plan.

## Git workflow

- Branch: `advisor/008-edit-diff-rendering`
- Conventional commits, e.g. `fix(tool-renderer): render Pi's string diff for edits`.

## Steps

### Step 1: Accept a string diff in `renderEditBody`

Replace the `const diffLines = …` line and the gutter rendering. Derive lines from a string when present; render via `renderBodyLine` (no synthetic gutter) since Pi embeds the number:

```ts
function renderEditBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const rawDiff = details?.diff;
	const diffLines = (typeof rawDiff === "string"
		? rawDiff.split("\n")
		: arrayFromDetails(details, "diff")
	).map(terminalSafeText);

	if (diffLines.length === 0) {
		const note = toolNote(tool) ?? "diff collapsed";
		return renderEditSummary(note, width);
	}

	const rows = diffLines.slice(0, TOOL_BODY_MAX_LINES).map((line) => {
		const head = line.trimStart();
		const color = head.startsWith("+") ? activeThemeColors().states.idle
			: head.startsWith("-") ? activeThemeColors().states.approval
			: activeThemeColors().foregroundDim;
		return renderBodyLine([span(line, { fg: color })], width);
	});
	const collapsed = collapsedMarker(details, Math.max(0, diffLines.length - rows.length));
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: activeThemeColors().foregroundDim }), span(collapsed, { fg: activeThemeColors().foregroundDim })], width));
	return rows;
}
```

Note: the legacy synthetic-gutter array path (where SumoCode itself produced `diff` as an array) is preserved for non-string values, but those lines now also render via `renderBodyLine`. If your repo has tests asserting the synthetic-gutter array path renders WITH a `renderGutterLine` number, see STOP conditions.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Add a real `+adds / -removes` header summary line

Before the diff rows, prepend a summary computed by counting prefixes (Pi's result text has no counts, so derive them):

```ts
	const adds = diffLines.filter((l) => l.trimStart().startsWith("+")).length;
	const removes = diffLines.filter((l) => l.trimStart().startsWith("-")).length;
	const summary = renderBodyLine([
		span(`+${adds}`, { fg: activeThemeColors().states.idle }), span(" "),
		span(`-${removes}`, { fg: activeThemeColors().states.approval }),
	], width);
	return [summary, ...rows];
```

(Insert so the returned array is `[summary, ...rows, …collapsed]`.)

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Tests

In `tool-renderer.test.ts`, add (model after the existing `renderToolLedgerRows` edit test):

```ts
	it("renders Pi's string diff with +/- coloring and embedded line numbers", () => {
		const rows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/x.ts" },
			details: { diff: " 12 const a = 1;\n-14 const old = 2;\n+14 const next = 3;" },
		}, 80).map(stripAnsi);
		// header summary + 3 diff body lines + box top/bottom
		expect(rows.some((r) => r.includes("+1") && r.includes("-1"))).toBe(true);
		expect(rows.some((r) => r.includes("-14 const old = 2;"))).toBe(true);
		expect(rows.some((r) => r.includes("+14 const next = 3;"))).toBe(true);
		// no DOUBLED line number: the body line for "+14" must not also carry a synthetic gutter "   1"
		const addedRow = rows.find((r) => r.includes("+14 const next = 3;"));
		expect(addedRow).not.toMatch(/^\│\s+\d+\s+\+14/);
	});

	it("still falls back to the +N/-N summary when no diff string is present", () => {
		const rows = renderToolLedgerRows({ name: "edit", status: "success", input: { path: "src/x.ts" }, output: "+14 -6 session flow updated" }, 80).map(stripAnsi);
		expect(rows.some((r) => r.includes("+14") && r.includes("-6"))).toBe(true);
	});
```

Confirm the pre-existing edit summary test (the one using `output: "+14 -6 session flow updated"`) still passes unchanged.

**Verify**: `pnpm vitest run src/sumo-tui/transcript/tool-renderer.test.ts` → all pass.

### Step 4 (OPTIONAL stretch — intra-line word highlight)

Pi reverse-video-highlights only the changed tokens on a single-line modification (1 removed + 1 added). SumoCode's `Span` supports `inverse` (SGR 7) per `src/sumo-tui/render/primitives.ts`. If you implement this: detect a consecutive `-`/`+` pair, diff the two contents word-wise, and emit the changed tokens with `span(token, { inverse: true })`. **Only attempt this if Steps 1–3 are green and committed.** If it adds risk or fails the visual gate, drop it — it is not required for this plan to be DONE.

**Verify** (if attempted): `pnpm visual:ci` → pass.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm test` exits 0; the two new tool-renderer tests pass; pre-existing tool-renderer tests still pass
- [ ] An `edit` tool with `details.diff` (string) renders colored `+`/`-` body lines with Pi's embedded numbers and a `+N -N` header — verified by the new test
- [ ] No doubled line numbers (the new test's `addedRow` assertion holds)
- [ ] `pnpm visual:ci` passes
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report if:

- `details.diff` is NOT a string in the live Pi version (inspect `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js` around line 219). If Pi changed it to an array, the array path already works and this plan is moot — report that.
- An existing test asserts the synthetic per-line gutter number on the `diff` array path (it would now break). Report it; do not silently delete the assertion.
- The visual gate fails and the cause is not an intentional, better-looking diff (a golden may need human re-approval per `AGENTS.md` — that requires Dhruv, so STOP).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The 25-line `TOOL_BODY_MAX_LINES` cap still applies; large diffs collapse with the `… N lines collapsed` marker. Making the cap expandable via ⌘O is covered by plan 012's general expansion work.
- Reviewer should scrutinize that ordinary `read`/`bash` bodies are unaffected (they use `renderReadLikeBody`/`renderBashBody`, not `renderEditBody`).
- Pi's `renderDiff` (root-exported) remains available if a future change wants exact Pi-parity intra-line highlighting; the colors must be remapped to Cathedral tokens first.
