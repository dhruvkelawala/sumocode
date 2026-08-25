# Plan 085: Rebuild `/roles` as a flat, searchable palette with registry-backed model picking

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on.
> STOP conditions are binding. Your reviewer maintains `plans/README.md`.
>
> **Base branch**: `advisor/083-role-based-async-subagents` at `3b09902`.
>
> **Drift check (run first)**:
> `git diff --stat 3b09902..HEAD -- src/commands/roles.ts src/command-palette.ts src/divine-query.ts src/subagents/roles.ts`
> Expected empty. Non-empty → STOP.

## Status

- **Implementation state**: DOGFOOD — superseded by operator-approved one-level role drill-in and removal of editor/reset actions; registry search and RPC caret are implemented, but this plan's original flat-surface done criteria no longer describe the accepted UX.
- **Priority**: P2 (operator dogfood feedback — blocks /roles adoption)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/083 (branch `advisor/083-role-based-async-subagents`, PR #372)
- **Category**: dx
- **Planned at**: `3b09902`, 2026-08-25

## Why this matters

Operator feedback from first manual use of `/roles` (2026-08-25): "too
nested, and even for model selection I have to manually input the id instead
of selecting. The command palette has a better UX." The v1 flow is
role → field → (for model: two-stage inherit/custom → free-text input) —
three to four modal hops, none searchable, and the most common edit (point a
role at a model) requires typing `provider/modelId` from memory while
`ctx.modelRegistry.getAvailable()` sits right there. This plan rebuilds the
interface on the command palette's interaction model: flat searchable rows,
current values visible before you commit to anything, model chosen from the
registry list. The roles data layer (`src/subagents/roles.ts`, sparse
`roles.json` overlay semantics) is UNCHANGED — this is a UI-only rebuild.

## Current state

Verified at `3b09902` on branch `advisor/083-role-based-async-subagents`:

- `src/commands/roles.ts` — v1 implementation: `runRolesCommand(deps)` with
  injected `loadRoles/writeRolesFile/select/input/openEditor/isTTY`;
  nested `showDivineQuery` chains; model = two-stage selector + free-text
  `ctx.ui.input`. `writeRolesFile(path, mutation)` (line ~152) implements
  the sparse-overlay write (`JSON.stringify(document, null, 2)`, mode 0o600)
  — KEEP this write layer and the `RolesFileMutation` shape; only the
  interaction layer above it changes.
- `src/command-palette.ts` — the interaction exemplar:
  - `CommandPaletteSnapshot { searchQuery, activeIndex, rows }`,
    `PaletteRow { label, currentValue }`;
  - `filterPaletteRows(rows, searchQuery)` (line 127) — case-insensitive
    substring filter;
  - `handlePaletteInput` — printable chars append to `searchQuery`,
    backspace deletes, arrows/tab navigate, Enter selects, Esc exits
    (lines ~196-215);
  - render: search line with placeholder ("what shall we attend to…"),
    rows as `LABEL  currentValue`, hint row
    `↑↓ wander    ⏎ attend    ⎋ retreat` (COMMAND_PALETTE_HINT_ROW);
  - launched via `ctx.ui.custom<T>((_tui,_theme,_kb,done) => new Component(...),
    { overlay: true, overlayOptions: COMMAND_PALETTE_OVERLAY_OPTIONS })`;
  - **model picking exemplar** (line 283-289): `ctx.modelRegistry.getAvailable()`
    → pick by id → no typing.
- `src/divine-query.ts` — `showDivineQuery(ctx, title, options)`:
  NO search (letter-select a/b/c + arrows only; `updateDivineQuery` line
  173). In RPC mode it falls back to `ctx.ui.select` (line ~242) — which
  DOES have search-as-you-type in the cathedral inline selector (plan 039).
- `src/subagents/roles.ts` — `loadRoles`, `BUILT_IN_ROLES`, `SubagentRole`,
  `resolveRolesPath`; `"model": "inherit"` normalization. Do not modify.
- Conventions: tabs, strict TS, colocated tests, `src/voice.ts` lowercase
  voice, TTY-defensive (`ctx.hasUI` guard, non-TTY prints the roles.json
  path — keep v1's `instructions` fallback).
- The palette component is theme-aware via `activeThemeColors()`; match it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Focused | `pnpm vitest run src/commands/roles.test.ts` | all pass |
| Full unit | `pnpm test` | exit 0 (known flake: `src/sumo-tui/rpc/host-actions.test.ts` — if sole failure, passes 2/2 in isolation ⇒ proceed) |
| Bundles | `pnpm build:bundles` | exit 0; only `dist/` dirty |

## Scope

**In scope**:
- `src/commands/roles.ts` + `src/commands/roles.test.ts` (rebuild the
  interaction layer; keep the write layer)
- `src/commands/roles-palette.ts` + `src/commands/roles-palette.test.ts`
  (create — the reusable searchable component, extracted so roles.ts stays
  thin)
- `dist/**` via `pnpm build:bundles` only

**Out of scope**:
- `src/command-palette.ts` — read as exemplar; do NOT refactor it to share
  code in this plan (a shared palette primitive is a follow-up; copying the
  ~120-line interaction core is acceptable duplication for now — note it in
  a comment referencing this plan).
- `src/divine-query.ts`, `src/subagents/roles.ts`, everything else.

## Git workflow

- Branch `advisor/085-roles-palette-ux` from `3b09902`.
- Commits: `feat(commands): rebuild /roles as searchable palette`, then
  `chore(bundles): regenerate prebundled host and extension`.
- Do NOT push.

## Design (decided — do not re-litigate)

Two surfaces, both the SAME searchable palette component, max two hops to
any edit:

**Surface 1 — role×field rows (flat).** `/roles` opens one searchable list
of every editable cell, current value visible:

```
❯ what shall we tune…
  research model            inherit
  research thinking         inherit
  research tools            read-only
  … (6 roles × 5 fields: model, thinking, tools, worktree, visible)
  research system prompt    (built-in)
  …
  open roles.json in $EDITOR
  reset a role to built-in…
```

Typing filters across the whole row text ("imp che mo" → one row). Enter
goes straight to the value picker. Esc exits. 32+ rows is fine — search is
the navigation.

**Surface 2 — value picker (same component, one pick):**
- `model` → rows: `inherit (use parent session's model)` first, then one
  row per `ctx.modelRegistry.getAvailable()` entry (`id`, with provider as
  the dim current-value column), last row `other — type provider/modelId…`
  (escape hatch → `ctx.ui.input`; keeps unlisted models reachable).
  Selecting writes the same mutations v1 wrote (`"inherit"` literal for
  inherit — semantics unchanged).
- `thinking` → `inherit, off, minimal, low, medium, high, xhigh, max`.
- `tools` → `inherit parent / read-only (read, grep, find, ls, bash) / full built-in set`.
- `worktree` / `visible` → `inherit default / true / false`.
- `system prompt` → keep v1 behavior ($EDITOR on roles.json, seeding the
  effective prompt first).

After a write: same notify copy as v1 ("role updated — applies to the next
spawn"). Palette reopens Surface 1 with refreshed values (so multiple edits
don't require re-invoking /roles); Esc from Surface 1 ends the command.

**RPC / non-TTY — FINAL (two corrections deep, 2026-08-25):**

1. v1 spec claimed "the cathedral inline selector already searches" — FALSE:
   RPC `ctx.ui.select` renders as the lettered, non-searchable Divine Query
   modal (`src/sumo-tui/widgets/modal-layer.ts` → `renderDivineQuery`).
2. First fix claimed the RPC shell hosts custom components — ALSO FALSE:
   `ctx.ui.custom()` in RPC mode is a DOCUMENTED no-op returning `undefined`
   (pi docs/extensions.md run-modes table) — the extension-ui-adapter
   `custom<T>` is the owned-shell path, not RPC. Result: `/roles` silently
   opened nothing (operator-verified).

**Actual fix, at the modal boundary**: long selects (> `SELECT_SEARCH_THRESHOLD`
= 10 options) in `src/sumo-tui/widgets/modal.ts` become search-mode —
type-to-filter (multi-char chunk safe via `sanitizeInputChunk`), no
letter-jump, arrows/tab navigate the filtered list, Enter answers (no-op on
zero matches); `modal-layer.ts` renders a `❯` filter row and suppresses
letter labels (`divine-query.ts` gained `searchRow`/`hideLetters` render
options). Short selects keep Divine Query letter parity. `/roles` RPC path
uses `ctx.ui.select` and inherits the searchable modal; every other long
select in the product (model pickers, themes) benefits identically.
Verified live via PTY against the real shell: modal opens, filter narrows,
Enter lands in the model value picker listing real registry models.
Non-TTY → v1's instructions fallback unchanged.

## Steps

### Step 1: Extract the searchable palette component

Create `src/commands/roles-palette.ts`: a generic
`showSearchPalette(ctx, { title, placeholder, rows: { id, label, value }[] }): Promise<string | undefined>`
returning the selected row id. Copy the interaction core from
`CommandPaletteComponent` (search line, filter, arrows, Enter/Esc, hint
row, theme colors, overlay options width 80 / maxHeight 20). Pure
`filterRows` + `updatePaletteState` functions exported for tests. RPC
fallback inside: `ctx.mode === "rpc"` → `ctx.ui.select(title, rowLabels)`.
Add the duplication note pointing at plan 085.

**Verify**: `pnpm vitest run src/commands/roles-palette.test.ts` → pass
(filter matches across label+value, backspace, wraparound navigation,
Enter returns id, Esc returns undefined).

### Step 2: Rebuild roles.ts interaction layer on it

Rewrite `runRolesCommand` to the two-surface design. Keep: injected deps
(add `showPalette`, `getAvailableModels`), `writeRolesFile` and mutation
shapes, non-TTY fallback, notify copy. Delete the two-stage model flow and
the field-selector hop. Model rows come from a new injected
`getAvailableModels: () => { id: string; provider?: string }[]` wired to
`ctx.modelRegistry.getAvailable()` in the pi wiring.

**Verify**: `pnpm vitest run src/commands/roles.test.ts` → pass, including
NEW tests: surface-1 rows include every role×field with current values;
model picker lists registry models with inherit first and other… last;
selecting a registry model writes exactly one sparse mutation; other… path
routes through input; loop reopens surface 1 after a write; RPC path uses
select; cancel writes nothing.

### Step 3: Bundles + battery

(Ordering corrected 2026-08-25 after executor STOP: bundles FIRST — the
tracked-bundle freshness test fails by design until regeneration.)
`pnpm build:bundles` → exit 0, only dist newly dirty; then
`pnpm exec tsc --noEmit` → 0; `pnpm test` → 0 (flake rule); commit both
per git workflow.

## Done criteria

- [ ] `/roles` reaches any field edit in ≤2 Enter presses from open, with
      type-to-filter on both surfaces
- [ ] Model selection lists `ctx.modelRegistry.getAvailable()` — no typing
      required for registry models; `inherit` first; free-text only behind
      the explicit `other…` row
- [ ] `roles.json` write semantics byte-identical to v1 for the same edits
      (sparse overlay, `"inherit"` literal, 0o600, pretty JSON)
- [ ] `pnpm exec tsc --noEmit` and `pnpm test` exit 0; dist regenerated and
      committed; worktree clean; only in-scope files modified
- [ ] Non-TTY and RPC paths covered by tests

## STOP conditions

- Drift check non-empty.
- `ctx.ui.custom` overlay cannot host the copied component (render/input
  contract mismatch) — report, don't hack the palette itself.
- Keeping write-layer byte-compatibility would require changing
  `src/subagents/roles.ts` — out of scope, report.
- Any non-flake test failure.

## Maintenance notes

- The interaction core is deliberately DUPLICATED from command-palette.ts
  (~120 lines). Follow-up when a third palette consumer appears: extract a
  shared `src/sumo-tui/widgets/search-palette.ts` primitive and fold both in.
- If the model registry is empty (no providers configured), the picker
  degrades to `inherit` + `other…` — test covers it.
- Operator feedback loop: this plan exists because v1 shipped without an
  interactive smoke by the operator. Interactive UX plans should land behind
  a dogfood pass before being called done.
