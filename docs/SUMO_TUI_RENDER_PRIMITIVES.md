# SumoTUI Render Primitives

**Status:** active implementation contract for P1-B / #105  
**Owner:** SumoTUI consolidation #98  
**Code:** `src/sumo-tui/render/primitives.ts`  
**Tests:** `src/sumo-tui/render/primitives.test.ts`

## Purpose

Use typed render primitives for new Cathedral/Retained SumoTUI surfaces instead of hand-rolling ANSI strings.

The primitives make three things explicit:

1. **Cell width** — padding and truncation use Pi's `visibleWidth` / `truncateToWidth` semantics.
2. **Style ownership** — foreground, background, and text attrs are typed as `Style`.
3. **Output target** — a typed `Line` can render to ANSI today and cell output for future retained backends.

This prevents the recurring bug class where a row looks correct as text but leaves unpainted background cells, leaks style resets into the rest of the terminal, or truncates by JavaScript string length instead of terminal cell width.

## Rule for agents

Before adding or substantially changing Cathedral rendering code, read this document and use `src/sumo-tui/render/primitives.ts` unless you are intentionally working in a lower-level ANSI parser/writer.

Do **not** hand-roll new Cathedral ANSI like this:

```ts
`\u001b[38;2;217;119;6m${text}\u001b[0m`
```

Prefer typed `Style`, `Span`, and `Line` values:

```ts
import { lineToAnsi, span, textLine } from "./render/primitives.js";

const row = textLine([
	span("●", { fg: CATHEDRAL_TOKENS.colors.states.idle }),
	" ",
	span("READY", { fg: CATHEDRAL_TOKENS.colors.foreground }),
], {
	bg: CATHEDRAL_TOKENS.colors.surface,
});

return lineToAnsi(row, { width });
```

Legacy ANSI helpers may remain during migration. New surfaces should use typed primitives by default.

## Core concepts

### `Style`

A typed style object:

```ts
const surfaceStyle: Style = {
	fg: CATHEDRAL_TOKENS.colors.foreground,
	bg: CATHEDRAL_TOKENS.colors.surface,
	dim: false,
};
```

Supported fields:

- `fg`
- `bg`
- `bold`
- `italic`
- `underline`
- `dim`
- `inverse`

### `Span`

A run of text with optional style overrides:

```ts
span("REGISTRY", { fg: CATHEDRAL_TOKENS.colors.accent })
```

### `Line`

A row made of spans plus an optional base style. The base style applies to spans that do not override a field and to padding cells when rendered with a width.

```ts
textLine([
	span("REGISTRY", { fg: CATHEDRAL_TOKENS.colors.accent }),
], {
	fg: CATHEDRAL_TOKENS.colors.foreground,
	bg: CATHEDRAL_TOKENS.colors.surface,
});
```

## Common patterns

### Full-row surface fill

Use a base `bg` and pass `width` to `lineToAnsi()`:

```ts
const row = textLine(["ready"], {
	fg: CATHEDRAL_TOKENS.colors.foreground,
	bg: CATHEDRAL_TOKENS.colors.surface,
});

return lineToAnsi(row, { width });
```

This paints the content **and all padding cells** with `surface`.

Tracer bullet: `surfaceLine()` in `src/sumo-tui/cathedral/ansi.ts` now uses this path so existing sidebar rows keep full mahogany background fill while the migration proceeds.

### Styled spans without reset leaks

```ts
const row = textLine([
	span("●", { fg: CATHEDRAL_TOKENS.colors.states.tool }),
	" ",
	span("ILLUMINATING"),
], {
	fg: CATHEDRAL_TOKENS.colors.foreground,
	bg: CATHEDRAL_TOKENS.colors.background,
});

return lineToAnsi(row, { width });
```

`lineToAnsi()` re-applies the base row style after each span and emits a final reset.

### Visible-width truncation

```ts
const truncated = truncateLine(textLine([
	span("argent-x", { fg: CATHEDRAL_TOKENS.colors.foreground }),
	span(" on main", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
]), width);
```

Use this instead of `slice()` for user-visible terminal rows.

### Rules

```ts
const rule = renderRule(width, {
	indent: "  ",
	char: "━",
	style: { fg: CATHEDRAL_TOKENS.colors.divider },
	lineStyle: { bg: CATHEDRAL_TOKENS.colors.surface },
});

return lineToAnsi(rule, { width });
```

### Boxes

```ts
const lines = renderBox([
	textLine(["Approve this change?"]),
], {
	width,
	style: { bg: CATHEDRAL_TOKENS.colors.surfaceRecess },
	borderStyle: { fg: CATHEDRAL_TOKENS.colors.divider },
	fillStyle: {
		fg: CATHEDRAL_TOKENS.colors.foreground,
		bg: CATHEDRAL_TOKENS.colors.surfaceRecess,
	},
});

return lines.map((line) => lineToAnsi(line, { width }));
```

## Migration guidance

Migrate Cathedral surfaces tracer-bullet by tracer-bullet. Do not pause product work to rewrite every ANSI string at once.

Good migration candidates:

- footer row
- input hints
- command palette rows
- approval modal frame
- chat message frames
- tool pills
- code blocks
- sidebar rows that currently mix nested foreground resets

For each migration:

1. Preserve the existing visual contract first.
2. Add or update unit tests for width, reset, and background behavior.
3. Run `pnpm visual:ci` if the surface affects V2 scenarios or required crops.
4. Promote runtime goldens only after explicit human visual approval.

## Allowed exceptions

It is acceptable to hand-write ANSI in these places:

- low-level ANSI parser/writer code (`src/sumo-tui/render/buffer.ts`, `ansi-writer.ts`, terminal controller escape sequences)
- compatibility shims that must mirror upstream Pi behavior byte-for-byte
- old surfaces that have not yet been migrated, as long as new code does not copy the pattern
- tests that intentionally assert ANSI escape behavior

When adding an exception in production Cathedral rendering, leave a comment explaining why typed primitives are not appropriate yet.

## Verification checklist

For new primitive-backed surfaces, tests should cover the relevant subset of:

- full-row background fill, including padded cells
- ANSI reset behavior / no leaked bold, dim, fg, or bg
- visible-width truncation
- row width equals requested terminal width
- wide characters where applicable
- cell output when future retained backends consume typed lines directly
