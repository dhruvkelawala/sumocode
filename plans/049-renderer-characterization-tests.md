# Plan 049: Direct characterization tests for RetainedShellRenderer

> **Executor instructions**: You are a test author. Follow this plan step by
> step; run every verification command. If a STOP condition occurs, stop and
> report. SKIP updating `plans/README.md` — your reviewer maintains the index.
> This plan is TEST-ONLY: you must not modify any production source file. If
> a test you write reveals a real bug, pin the CURRENT behavior with a
> clearly-marked `// characterization: documents current behavior, see report`
> comment and flag it in your report — do not fix the source.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/shell/retained-shell-renderer.ts`
> On drift vs the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (test-only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

`src/sumo-tui/shell/retained-shell-renderer.ts` (799 lines) is the extracted
backend-neutral composition core: one `render()` owns layout sync, Yoga
measurement, full-frame compositing, overlay painting, cursor masking, frame
diffing, and terminal patch writes. It has NO direct test file — coverage is
indirect through `RpcShellAdapter`/runtime smoke tests, which can't pin the
renderer's own contracts. A follow-up plan (050) changes this render path;
these tests must exist first so that change has a safety net.

## Current state

- `src/sumo-tui/shell/retained-shell-renderer.ts:424-452` (heart of
  `render()`):

```ts
this.root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
...
const frame = new CellBuffer(rows, cols);
const result = composite(this.root, frame, this.selection ? { selection: this.selection } : {});
this.paintPendingMessages(frame, cols);
const overlayCount = this.compositeOverlays(frame, cols, rows);
...
const cursor: HardwareCursor | null = overlayCount > 0 ? null : result.hardwareCursor;
if (cursor && this.paintHardwareCursorAsSoftware) this.paintSoftwareCursor(frame, cursor);
// ... Use row diffs only.
const patches = diffFrames(this.previousFrame, frame, { detectScroll: false });
this.terminal.writeFramePatches(patches, cursor);
this.previousFrame = frame.clone();
this.lastFrame = frame;
```

- Regions of interest (read them before writing tests): overlay composition
  and clipping (~:500-539), pending steer/follow-up message painting with
  swallow-on-error (~:544-578), `dispose()` walking and detaching nodes
  (~:602-637), the constructor's options in
  `src/sumo-tui/shell/contracts.ts:88-104` (`RetainedShellRendererOptions`).
- The construction/testing pattern to copy:
  `src/sumo-tui/pi-compat/owned-shell-renderer.test.ts` builds the legacy
  wrapper with fake terminal + static components — reuse its fakes/approach
  (the wrapper at `src/sumo-tui/pi-compat/owned-shell-renderer.ts` shows
  exactly how options map onto `RetainedShellRenderer`).
- Also read `docs/SUMO_TUI_TEST_BACKEND.md` (headless retained-renderer test
  backend contract) — use `src/sumo-tui/testing/test-backend.ts` where it
  fits.
- Conventions: tabs, strict TS, test colocated as
  `src/sumo-tui/shell/retained-shell-renderer.test.ts` (new file).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| New tests | `pnpm vitest run src/sumo-tui/shell/retained-shell-renderer.test.ts` | all pass |
| Adjacent guard | `pnpm vitest run src/sumo-tui/pi-compat/owned-shell-renderer.test.ts` | still passes |

## Scope

**In scope**:
- `src/sumo-tui/shell/retained-shell-renderer.test.ts` (create)

**Out of scope**:
- ANY production file. Test-only.
- Absolute-row-position assertions that would break on cosmetic layout tweaks
  — assert local invariants (relative structure, presence, counts, ordering).

## Git workflow

- Branch: `advisor/049-renderer-characterization-tests`
- Commit style: `test(shell): ...`. Do NOT push.

## Steps

### Step 1: Build the harness

Construct a `RetainedShellRenderer` with minimal fake options (fake terminal
capturing `writeFramePatches(patches, cursor)` calls; simple static
renderables for chat/editor/footer/sidebar surfaces) modeled on
`owned-shell-renderer.test.ts`. Render once; assert a frame was produced and
patches were written.

**Verify**: `pnpm vitest run src/sumo-tui/shell/retained-shell-renderer.test.ts` → passes.

### Step 2: Pin the contracts (one `describe` each)

1. **Overlay hides hardware cursor**: with zero overlays, the cursor passed to
   `writeFramePatches` is the composite's cursor; with one visible overlay,
   it is `null`.
2. **Overlay clipping**: an overlay wider/taller than the viewport is clipped
   to bounds (no patch coordinates outside rows/cols).
3. **Pending-message painting never throws**: a pending-messages container
   whose render throws → `render()` completes and paints the rest (the
   swallow-on-error contract at ~:544-578).
4. **Row-diff only**: two consecutive renders where one middle row changes →
   patches touch only that row (asserts `detectScroll: false` semantics
   survive).
5. **Dispose idempotence**: `dispose()` twice does not throw; render after
   dispose is a no-op or throws the documented error (pin whichever the code
   does, with the characterization comment).
6. **Selection pass**: constructing with a selection option and rendering
   marks selected cells (assert via the frame's cell attributes on a known
   region, not exact colors).

**Verify**: targeted run passes; each contract is a separate `it` with a
descriptive name.

### Step 3: Guard the wrapper parity

Run the legacy wrapper suite to confirm nothing in your fakes drifted the
shared helpers.

**Verify**: `pnpm vitest run src/sumo-tui/pi-compat/owned-shell-renderer.test.ts` → passes.

## Test plan

This plan IS the test plan. High-signal contracts only — no snapshot dumps,
no assertions on private fields except through observable frames/patches.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/shell/retained-shell-renderer.test.ts` exits 0 with ≥6 contracts
- [ ] `pnpm vitest run src/sumo-tui/pi-compat/owned-shell-renderer.test.ts` exits 0
- [ ] `git status` — ONLY the new test file
- [ ] Any discovered real bug flagged in the report (not fixed)

## STOP conditions

- The renderer cannot be constructed without a live Pi/terminal dependency
  the fakes can't satisfy (report which option).
- Contract 3 or 4 reveal behavior so broken the test would pin a defect a
  user hits every render — report FIRST, then pin with the characterization
  comment if told nothing else.

## Maintenance notes

- Plan 050 (working-indicator render-path change) relies on these contracts —
  especially 4 (row-diff) — as its regression net.
- Reviewer: check tests assert observable behavior (frames/patches), and that
  no test depends on exact row indices of chrome.
