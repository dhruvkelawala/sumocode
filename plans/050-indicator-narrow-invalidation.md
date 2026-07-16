# Plan 050: Stop the working-indicator tick from re-laying-out and re-compositing the whole screen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/049-renderer-characterization-tests..HEAD -- src/sumo-tui/rpc/shell-adapter.ts src/sumo-tui/shell/retained-shell-renderer.ts`
> Your base branch is `advisor/049-renderer-characterization-tests` (its
> renderer contract tests are your regression net). On excerpt mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/049-renderer-characterization-tests.md
- **Category**: perf
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

While the agent is busy, the above-editor working indicator animates on a
real timer (DF-8 fix, correct) — but each tick calls `requestRender()`, and a
render is a FULL pipeline: Yoga `calculateLayout` over the whole tree, a fresh
full-size `CellBuffer`, whole-root composite, overlay pass, and a full-frame
diff. Themes tick every 90–180ms, so the host burns full-screen layout/
composite CPU 5–11×/sec for a one-glyph animation — precisely while streaming
render work competes for the same loop. The terminal WRITES are already
minimal (row diff); the CPU work is not.

## Current state

- `src/sumo-tui/rpc/shell-adapter.ts:416-439`:

```ts
private syncWorkingIndicatorTimer(): void {
	const busy = sumoState(this.state) !== "idle";
	if (busy === this.wasWorkingIndicatorBusy) return;
	...
	if (busy) this.startWorkingIndicatorTimer();
	else this.clearWorkingIndicatorTimer();
}

private startWorkingIndicatorTimer(): void {
	this.clearWorkingIndicatorTimer();
	const intervalMs = getActiveTheme().workingIndicator.intervalMs;
	this.workingIndicatorTimer = setInterval(() => {
		this.workingIndicatorTick += 1;
		this.requestRender?.();
	}, intervalMs);
}
```

- `src/sumo-tui/shell/retained-shell-renderer.ts:424-452` — the full render
  pipeline (layout → composite → overlays → cursor → `diffFrames(...,
  { detectScroll: false })` → `writeFramePatches` → `previousFrame = frame.clone()`).
  It already measures `layoutMs`/`compositeMs` and logs them via
  `logDiagnostic("owned_shell_render", ...)` (:454-458).
- The indicator is painted by the above-editor leaf; find where
  `workingIndicatorTick` feeds rendering (`grep -n "workingIndicatorTick\|renderWorkingIndicator" src/sumo-tui/rpc/shell-adapter.ts`) and which
  renderable/leaf owns that row (`aboveEditorLeaf` in the renderer; see
  `markDirty` calls at :424-428).
- Renderer leaves have `markDirty()`; the render entry currently marks ALL
  leaves dirty every render (:424-428) — i.e., there is no per-leaf dirty
  short-circuit today.
- Plan 049's contract tests exist in your base branch:
  `src/sumo-tui/shell/retained-shell-renderer.test.ts` — they must stay green.
- Conventions: tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/shell/retained-shell-renderer.test.ts src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/runtime.test.ts` | all pass |

## Scope

**In scope**:
- `src/sumo-tui/rpc/shell-adapter.ts`, `src/sumo-tui/shell/retained-shell-renderer.ts`
- `src/sumo-tui/rpc/shell-adapter.test.ts`,
  `src/sumo-tui/shell/retained-shell-renderer.test.ts`
- `src/sumo-tui/shell/contracts.ts` — only if a new narrow-repaint option
  must be declared on `RetainedShellRendererOptions`.

**Out of scope**:
- The timer lifecycle itself (DF-8's start/stop-on-busy semantics — its tests
  in shell-adapter.test.ts:~399-480 must pass unchanged).
- `runtime.ts` render coalescing, ChatPager, transcript pipeline.
- Any visual-harness capture or golden.

## Git workflow

- Branch: `advisor/050-indicator-narrow-invalidation` off
  `advisor/049-renderer-characterization-tests`
- Conventional commits (`perf(sumo-tui): ...`). Do NOT push.

## Steps

### Step 1: Add a scoped repaint path to the renderer (Option B — preferred)

Add `repaintRegion(leaf: "aboveEditor"): void` (narrow, explicit, ONE region
to start) to `RetainedShellRenderer`:

- Reuses the CACHED layout: no `calculateLayout` call. Reads the leaf's last
  layout rect (Yoga nodes retain computed layout between calculations —
  verify with the existing accessors; if a rect cache is needed, record the
  leaf rect during the previous full `render()`).
- Composites ONLY that leaf's subtree into a copy of `previousFrame`
  restricted to the leaf's rows (paint into a clone or directly into a
  buffer view; the resulting FULL frame must remain internally consistent).
- Skips the overlay pass unless overlays are visible — if
  `compositeOverlays` reported >0 overlays on the last full render, fall back
  to a full `render()` (overlays may overlap the indicator row).
- Diffs only the leaf's row span (`diffFrames` on the affected band or manual
  row compare), writes patches, and updates `previousFrame`/`lastFrame`
  coherently for the touched rows.

If the leaf-rect reuse or partial composite cannot be done without touching
`composite()`'s internals, STOP and report (Option A — full redesign — is out
of scope by decision).

**Verify**: new renderer test — after a full render, `repaintRegion` with a
changed above-editor renderable: (a) emits patches only within the leaf's row
span, (b) does NOT call `calculateLayout` (spy on the root yoga node), and
(c) a subsequent FULL render produces patches consistent with the narrow
repaint (no ghost rows — assert final frame equals a from-scratch render).

### Step 2: Route indicator ticks through the scoped path

In `shell-adapter.ts`, give the adapter an optional narrow-repaint callback
(threaded from wherever it holds the renderer — find how `requestRender` is
injected today via `RpcShellAdapterOptions.requestRender` and add a sibling
`requestIndicatorRepaint?: () => void` wired by the runtime/renderer owner).
The timer callback uses `requestIndicatorRepaint ?? requestRender`. All other
render triggers stay on the full path.

**Verify**: shell-adapter.test.ts — DF-8 lifecycle tests unchanged and green;
new test: with a fake narrow callback, timer ticks invoke it (not the full
render callback); without it, ticks fall back to `requestRender` (backwards
compatible).

### Step 3: Prove the CPU claim

Extend the renderer test with a counting assertion: 10 indicator ticks with a
static screen invoke zero `calculateLayout` calls and zero full-root
composites (mechanism: spies from Step 1). Note in your report the measured
`layoutMs`/`compositeMs` metadata behavior if diagnostics are enabled in the
test.

**Verify**: targeted suites all green.

## Test plan

Per steps. The 049 contract suite is the safety net — it must pass UNCHANGED
(no assertion edits in existing contracts).

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] All three targeted test files exit 0; 049 contracts unmodified
- [ ] Narrow-repaint consistency test (frame equals from-scratch render) passes
- [ ] Tick path proven layout-free by spy assertions
- [ ] Fallback (no narrow callback → full render) covered
- [ ] `git status` — only in-scope files changed

## STOP conditions

- Partial composite requires modifying `composite()` internals or
  `CellBuffer` semantics.
- Selection state (drag-select in progress) interacts with the narrow path in
  a way the tests can't make coherent — report; do not ship a path that can
  corrupt `previousFrame` under selection.
- Any 049 contract test needs modification.

## Maintenance notes

- The narrow path is single-region by design. If a second region ever needs
  it (e.g. footer clock), generalize THEN, not now.
- Reviewer: the dangerous bug class is `previousFrame` divergence — scrutinize
  the coherence test; verify overlays-visible falls back to full render.
