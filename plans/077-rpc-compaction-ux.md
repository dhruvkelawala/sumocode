# Plan 077: Show compaction progress in the RPC retained runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan is intentionally standalone; do **not**
> update `plans/README.md` unless the operator explicitly asks you to maintain
> the index.
>
> **Drift check (run first)**: `git diff --stat 780e5c9..HEAD -- src/compaction-indicator.ts src/compaction-indicator.test.ts src/compaction-status-row.ts src/sumo-tui/rpc/state.ts src/sumo-tui/rpc/state.test.ts src/sumo-tui/rpc/shell-adapter.ts src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/runtime.test.ts test/integration/rpc-child-fixture.ts test/integration/rpc-compaction-ux.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `780e5c9`, 2026-07-18

## Why this matters

Classic retained SumoCode already has a visible compaction progress row that
says `Compacting…` for manual `/compact` and `Auto-compacting…` for automatic
threshold/overflow compaction. The new RPC host receives `compaction_start` /
`compaction_end` and flips the footer to `INSCRIBING`, but its above-editor
status row still renders the generic `Working…` indicator because the RPC child
profile deliberately owns no chrome. Users lose the clearest signal that their
session is being summarized rather than merely thinking, and automatic
compaction appears as a silent stall until the transcript summary lands.

The fix should keep the generic RPC boundary intact: the host should derive a
compaction status row from RPC session events and retained-shell state, not
re-enable the classic extension widget inside the RPC child or change launcher
mode selection.

## Current state

### Files and roles

- `src/extension.ts` — installs the full classic UI profile in direct/owned-shell mode, but a reduced RPC child profile in RPC mode.
- `src/compaction-indicator.ts` — existing classic retained compaction widget and labels.
- `src/compaction-state.ts` — tiny global cache for the classic/compat compaction reason.
- `src/sumo-tui/rpc/host.ts` — receives child RPC events, updates transcript + chrome state, constructs retained runtime.
- `src/sumo-tui/rpc/state.ts` — RPC host chrome state store; currently tracks `isCompacting` but not reason.
- `src/sumo-tui/rpc/shell-adapter.ts` — retained RPC shell presenter; maps `isCompacting` to footer state but renders only generic above-editor `Working…`.
- `src/sumo-tui/transcript/controller.ts` and `src/sumo-tui/transcript/view-model.ts` — already insert persistent compaction summary pills after completion.
- `test/integration/rpc-child-fixture.ts` — fake Pi RPC child used by PTY integration tests.

### Evidence excerpts

`src/extension.ts:200-220` shows `installRpcChildProfile` does not install `installWorkingIndicator` or `installCompactionIndicator`; RPC children install non-chrome behavior only:

```ts
installQuestionTool(pi);
installAnswerTool(pi);
const backgroundTaskManager = installBackgroundTasks(pi);
installTaskModeAutoExit(pi);
registerSumoReloadCommand(pi);
installSumoInteractions(pi, { backgroundTaskManager, includeUiSurfaces: false });
```

`src/extension.ts:320-321` shows the full non-RPC profile does install both chrome widgets:

```ts
installWorkingIndicator(pi);
installCompactionIndicator(pi);
```

`src/compaction-indicator.ts:1-16` documents the existing product behavior and why it is an above-editor widget in retained mode:

```ts
/**
 * SumoCode compaction indicator — surface compaction status in the retained
 * SumoTUI chrome as an animated neon-trace bar above the editor.
 ...
 *   - `session_before_compact` → start neon-trace animation
 *   - `session_compact`        → snap to 100 %, hold briefly, then clear
 ...
 * Classic Pi (no `SUMO_TUI`) is a no-op — Pi's own `statusContainer` Loader
```

`src/compaction-indicator.ts:183-195` contains the exact labels to preserve:

```ts
const reason = getCompactionReason();
const isManual = reason === "manual" || (reason === null && event.customInstructions !== undefined);
const label = isManual ? "Compacting…" : "Auto-compacting…";
...
ctx.ui.setWidget(COMPACTION_INDICATOR_WIDGET_KEY, factory, { placement: "aboveEditor" });
```

`src/compaction-state.ts:4-15` records Pi's reason values:

```ts
* Pi fires `compaction_start` (with `reason: "manual" | "threshold" | "overflow"`)
...
export type CompactionReason = "manual" | "threshold" | "overflow";
```

`src/sumo-tui/rpc/host.ts:523-531` builds the RPC transcript pump and state store independently of the classic widget cache:

```ts
const transcriptPump = new RpcTranscriptPump({
	chat: createLazyChatSink(() => runtime),
	scheduleRender: () => runtime?.requestRender(),
});
const stateStore = new RpcHostStateStore();
```

`src/sumo-tui/rpc/host.ts:744-748` forwards every child event through transcript + state and repaints the runtime:

```ts
const transcript = transcriptPump.handleAgentEvent(event);
const state = stateStore.handleAgentEvent(event);
runtime?.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
```

`src/sumo-tui/rpc/state.ts:17-18` exposes only the boolean:

```ts
readonly isStreaming: boolean;
readonly isCompacting: boolean;
```

`src/sumo-tui/rpc/state.ts:131-135` toggles the boolean but drops `event.reason`:

```ts
case "compaction_start":
	this.state = { ...this.state, isCompacting: true, lastEventType: type };
	break;
case "compaction_end":
	this.state = { ...this.state, isCompacting: false, lastEventType: type };
```

`src/sumo-tui/rpc/shell-adapter.ts:383-417` explains that RPC host chrome must be derived directly from `RpcHostChromeState`, then renders the generic working row for every non-idle state:

```ts
* RPC-child extensions own no chrome, the host does. So this can't
* rely on the extension's `ctx.ui.setWidget(..., { placement: "aboveEditor" })`
* path ... it has to derive the same visual directly from `RpcHostChromeState`
...
if (sumoState(this.state) === "idle" || !shouldInstallWorkingIndicator(width)) return [""];
const frame = renderIndicator(this.workingIndicatorTick, theme.workingIndicator.frames, theme.tokens.colors.accent);
const label = colorHex("Working…", activeThemeColors().foregroundDim);
```

`src/sumo-tui/rpc/shell-adapter.ts:523-527` already maps compacting to the Cathedral `learning` state, which the footer renders as `INSCRIBING`:

```ts
function sumoState(state: RpcHostChromeState): SumoCodeState {
	if (state.isCompacting) return "learning";
	if (state.lastEventType === "tool_call" || state.lastEventType === "tool_execution_update") return "tool";
	if (state.isStreaming) return "thinking";
	return "idle";
}
```

`src/voice.ts:11-15` is the product-voice constraint to preserve:

```ts
*   - state labels are UPPERCASE cathedral verbs:
*       READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING
*   - other product copy stays lowercase, terse, no exclamation marks,
```

`src/sumo-tui/transcript/controller.ts:142-151` and `:444-453` show persistent summary pills are already handled at compaction end:

```ts
if (record?.type !== "compaction_end") return undefined;
const result = asRecord(record.result);
if (typeof result?.summary !== "string") return undefined;
return { role: "compactionSummary", summary: result.summary, tokensBefore: result.tokensBefore };
...
case "compaction_end": {
	this.options.setCompactionReason?.(null);
	const summary = compactionSummaryMessageFromEvent(record);
	if (summary) {
		this.committedMessages.push(summary);
```

`src/sumo-tui/transcript/view-model.ts:214-220` defines the summary label; do not change this plan's completed-summary copy:

```ts
const label = kind === "compaction"
	? (tokens ? `[compaction] Compacted from ${tokens} tokens` : "[compaction] Compacted")
	: "[branch] Branch summary";
```

Existing tests already pin part of the behavior:

- `src/compaction-indicator.test.ts:152-181` expects `Compacting…` and `Auto-compacting…` in classic retained mode.
- `src/sumo-tui/rpc/state.test.ts:73-79` expects the RPC state store to toggle `isCompacting`.
- `src/sumo-tui/rpc/runtime.test.ts:360-386` expects compacting state to render `INSCRIBING` in the footer, but does not assert the above-editor label.
- `src/sumo-tui/rpc/transcript-pump.test.ts:196-202` expects completed compaction summaries to render as `[compaction] Compacted from 42,000 tokens`.

### Repo conventions to follow

- TypeScript files use tabs and strict types; avoid unused imports/locals.
- New Cathedral/retained rendering must use typed primitives from `src/sumo-tui/render/primitives.ts`; `docs/SUMO_TUI_RENDER_PRIMITIVES.md` forbids new hand-rolled ANSI for Cathedral surfaces.
- Keep RPC host chrome in `src/sumo-tui/rpc/` and pure shared render helpers in a small module; do not route this through Pi extension `ctx.ui.setWidget` in the RPC child.
- Unit tests are colocated next to source; PTY smoke tests live under `test/integration/` and use `spawnSumocodePty` + `createRpcChildFixture`.
- Visual UI work requires deterministic or runtime evidence. For this plan, required evidence is a deterministic frame/unit assertion plus one PTY integration smoke; `pnpm visual:ci` must stay green, but no golden promotion is part of the scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0, no TS errors |
| Build alias | `pnpm build` | exit 0; same no-emit TS graph |
| All unit tests | `pnpm test` | all Vitest unit tests pass |
| Integration tests | `pnpm test:integration` | all PTY integration tests pass |
| Visual gate | `pnpm visual:ci` | required crops pass; no unapproved hard failures |
| Target classic compaction tests | `pnpm vitest run src/compaction-indicator.test.ts` | existing label/clear tests still pass |
| Target RPC state tests | `pnpm vitest run src/sumo-tui/rpc/state.test.ts` | compaction reason lifecycle tests pass |
| Target RPC shell tests | `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/runtime.test.ts` | above-editor compaction rows + footer state tests pass |
| Target PTY compaction smoke | `pnpm vitest run test/integration/rpc-compaction-ux.test.ts` | manual `/compact` shows `Compacting…` before summary |

## Scope

**In scope**:

- `src/compaction-status-row.ts` (new pure renderer/label helper).
- `src/compaction-indicator.ts` and `src/compaction-indicator.test.ts` (refactor classic component to use the shared helper without changing behavior).
- `src/sumo-tui/rpc/state.ts` and `src/sumo-tui/rpc/state.test.ts` (track `compactionReason` from RPC event data and clear it on end).
- `src/sumo-tui/rpc/shell-adapter.ts` and `src/sumo-tui/rpc/shell-adapter.test.ts` (render compaction row instead of generic `Working…` while compacting).
- `src/sumo-tui/rpc/runtime.test.ts` (deterministic full-frame assertion for the RPC retained runtime).
- `test/integration/rpc-child-fixture.ts` and `test/integration/rpc-compaction-ux.test.ts` (fake child emits compaction events; PTY confirms user-visible label).

**Out of scope**:

- `bin/sumocode.sh`, `sumo-rpc-host.js`, launcher mode selection, `SUMO_RPC`, `SUMO_TUI`.
- Re-enabling `installCompactionIndicator` in `installRpcChildProfile`; RPC-child extensions own no chrome.
- Changing Pi's RPC command/event contract or upstream Pi types.
- Changing completed compaction summary pills (`[compaction] Compacted ...`) beyond tests needed to prove they still work.
- Changing `/compact` command semantics, auto-compaction settings, or `RpcHostControls.compact` timeouts.
- Promoting visual goldens or modifying Bible targets; if visual output needs promotion, stop for human approval.
- Updating `plans/README.md` unless explicitly requested by the operator.

## Git workflow

- Branch: `advisor/077-rpc-compaction-ux` (or the operator's active branch/worktree name).
- Conventional commit, e.g. `fix(rpc): show compaction status in retained host`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Extract the existing compaction row into a pure typed renderer

Create `src/compaction-status-row.ts` with no Pi `ExtensionAPI` dependency. Move or mirror the visual constants from `src/compaction-indicator.ts` (`PLATEAU_TICKS`, `PLATEAU_RATIO`, `SPARK_FRAMES`, `GLYPH_TICK_DIVISOR`) into this file and export:

```ts
import type { CompactionReason } from "./compaction-state.js";

export type CompactionStatusLabel = "Compacting…" | "Auto-compacting…";

export function compactionStatusLabelForReason(
	reason: CompactionReason | null | undefined,
	options: { readonly fallbackManual?: boolean } = {},
): CompactionStatusLabel;

export function renderCompactionStatusRow(options: {
	readonly width: number;
	readonly label: CompactionStatusLabel;
	readonly tick: number;
	readonly completed?: boolean;
}): string[];
```

Implementation requirements:

- Use `lineToAnsi`, `span`, `textLine`, and `truncateLine` from `src/sumo-tui/render/primitives.ts`; do not hand-roll new ANSI.
- Match the current visual row shape from `CompactionStatusComponent.render`: leading space, neon trace, dim label, one returned row.
- `compactionStatusLabelForReason("manual")` returns `Compacting…`.
- `compactionStatusLabelForReason("threshold")`, `("overflow")`, `null`, or `undefined` returns `Auto-compacting…`, except `fallbackManual: true` returns `Compacting…` for the classic `customInstructions` fallback.
- Keep `COMPLETE_HOLD_MS` in `src/compaction-indicator.ts`; only the classic widget owns the completion hold timer.

Then update `CompactionStatusComponent.render` in `src/compaction-indicator.ts` to delegate to `renderCompactionStatusRow({ width, label: this.label as CompactionStatusLabel, tick: this.tick, completed: this.completed })` and update `session_before_compact` to use `compactionStatusLabelForReason(reason, { fallbackManual: event.customInstructions !== undefined })`.

**Verify**: `pnpm vitest run src/compaction-indicator.test.ts` → existing manual/auto label tests and completion-clear tests pass unchanged.

### Step 2: Carry compaction reason in RPC chrome state

In `src/sumo-tui/rpc/state.ts`:

1. Import `type CompactionReason` from `../../compaction-state.js` or define a local equivalent `RpcCompactionReason` if importing from the classic shared state would create an unwanted dependency. Prefer a type-only import if possible.
2. Add `readonly compactionReason?: CompactionReason;` to `RpcHostChromeState`.
3. Add a small validator:

   ```ts
   function compactionReasonFromEvent(event: unknown): CompactionReason | undefined {
   	const value = (event as { reason?: unknown }).reason;
   	return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
   }
   ```

4. On `compaction_start`, set `{ isCompacting: true, compactionReason: compactionReasonFromEvent(event), lastEventType: type }`.
5. On `compaction_end`, set `{ isCompacting: false, compactionReason: undefined, lastEventType: type }`.
6. In `hydrateFromRpcState`, clear stale `compactionReason` when `rpcState.isCompacting` is false; if `rpcState.isCompacting` is true and no event reason is available, preserve the previous reason only if it was already set.

Update all local `state(...)` test helpers that build `RpcHostChromeState` only if TypeScript requires it; the property should remain optional.

Add/extend tests in `src/sumo-tui/rpc/state.test.ts`:

- `compaction_start` with `reason: "manual"` sets `isCompacting: true` and `compactionReason: "manual"`.
- `compaction_start` with `reason: "threshold"` sets `compactionReason: "threshold"`.
- `compaction_start` with an unknown reason still sets `isCompacting: true` but leaves `compactionReason` undefined, so rendering falls back safely.
- `compaction_end` clears both `isCompacting` and `compactionReason`.
- Hydrating from a non-compacting `get_state` snapshot clears a stale reason.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/state.test.ts` → all state tests pass.

### Step 3: Render compaction status in the RPC above-editor row

In `src/sumo-tui/rpc/shell-adapter.ts`, update the host-derived status row so compaction wins over the generic working indicator:

1. Import `compactionStatusLabelForReason` and `renderCompactionStatusRow` from `../../compaction-status-row.js`.
2. In `renderWorkingIndicator(width)`, handle compaction first:

   ```ts
   if (this.state.isCompacting) {
   	return renderCompactionStatusRow({
   		width,
   		label: compactionStatusLabelForReason(this.state.compactionReason),
   		tick: this.workingIndicatorTick,
   	});
   }
   ```

3. Keep the existing landscape-only `shouldInstallWorkingIndicator(width)` gate for the generic `Working…` row, but do **not** apply that gate to compaction. Compaction is an explicit session mutation signal, not just the V1 landscape working affordance.
4. Do not change `RpcAboveEditorComponent` ordering unless a test proves it is necessary. Queued messages and extension rows should keep their existing priority.
5. Keep `sumoState(state)` unchanged: `isCompacting` should continue to map to `learning` so the footer remains `INSCRIBING`.

Add tests in `src/sumo-tui/rpc/shell-adapter.test.ts`:

- A 100×30 or 90×24 adapter with `state({ isCompacting: true, compactionReason: "manual", hasMessages: true, messageCount: 1 })` renders `Compacting…`, does not render `Working…`, and still renders footer `INSCRIBING`.
- A compacting state with `compactionReason: "threshold"` renders `Auto-compacting…`.
- A 60-column adapter with `isCompacting: true` renders a compaction label even though generic `Working…` is normally suppressed below 80 columns.
- An idle/non-compacting 60-column adapter still does not render `Working…`, preserving the portrait working-indicator policy.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts` → new tests pass and existing queued-message/sidebar/footer tests still pass.

### Step 4: Pin deterministic full-frame runtime behavior

Extend `src/sumo-tui/rpc/runtime.test.ts` near the existing compacting footer test (`maps streaming and compacting state to Cathedral footer labels`). Add a deterministic full-frame assertion with `renderRpcHostFrameForTest`:

- Landscape/manual case: `state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "manual" })` contains both `Compacting…` and `INSCRIBING`, and does not contain `Working…`.
- Portrait/auto case: width 60, rows 100, `compactionReason: "overflow"` contains `Auto-compacting…` and `INSCRIBING`.

Use the existing local `state(...)` helper at `src/sumo-tui/rpc/runtime.test.ts:20-37` and follow the pattern at `:360-386` for frame-to-plain-text conversion.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/runtime.test.ts -t "compacting"` → compacting-related tests pass.

### Step 5: Add a PTY integration smoke for real RPC events

Extend `test/integration/rpc-child-fixture.ts` so the fake child can simulate a slow compaction command:

- Add options:

  ```ts
  readonly compactDelayMs?: number;
  readonly compactReason?: "manual" | "threshold" | "overflow";
  readonly compactSummary?: string;
  readonly compactTokensBefore?: number;
  ```

- Add `let isCompacting = false;` in the generated fixture and return it from `state()` instead of hard-coded `isCompacting: false`.
- Handle `command.type === "compact"` by:
  1. setting `isCompacting = true`,
  2. writing `{ type: "compaction_start", reason: compactReason }`, defaulting to `"manual"`,
  3. after `compactDelayMs` (default 250 ms when options are present), setting `isCompacting = false`,
  4. writing `{ type: "compaction_end", reason: compactReason, aborted: false, willRetry: false, result: { summary, tokensBefore } }`,
  5. writing the normal RPC response for the `compact` command.

Create `test/integration/rpc-compaction-ux.test.ts` modeled after `test/integration/rpc-host-shell.test.ts` and `test/integration/rpc-session-switch.test.ts`:

1. Create a fixture with `compactDelayMs: 750`, `compactReason: "manual"`, `compactSummary: "Kept the current plan and runtime evidence."`, `compactTokensBefore: 42000`.
2. Spawn SumoCode via `spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir, PI_BIN: piBin }, cols: 100, rows: 30 })` using the same fixture wiring pattern as other RPC integration tests.
3. Wait for `PI_BOOT_SEQUENCE`, `DIVINE INVOCATION`, and command hints.
4. Send `/compact keep runtime evidence\r`.
5. Assert the PTY output/screen shows `Compacting…` before the delayed response finishes.
6. Assert the final screen/output later contains `[compaction] Compacted from 42,000 tokens`.
7. Stop the PTY and assert terminal cleanup using the existing helper pattern if the file you model uses it.

Do not attempt to force a real upstream auto-compaction threshold in an integration test; that is slow and model/provider-dependent. Auto labels are covered deterministically in Step 3/4 via `reason: "threshold" | "overflow"`.

**Verify**: `pnpm vitest run test/integration/rpc-compaction-ux.test.ts` → test passes and shows `Compacting…` during the delayed fixture compaction.

### Step 6: Run the required regression suite and collect visual evidence

Run targeted tests first, then the broader gates:

```bash
pnpm vitest run src/compaction-indicator.test.ts
pnpm vitest run src/sumo-tui/rpc/state.test.ts
pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/runtime.test.ts
pnpm vitest run test/integration/rpc-compaction-ux.test.ts
pnpm test
pnpm test:integration
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

For user-visible evidence, capture at least one of:

- PTY integration output from `test/integration/rpc-compaction-ux.test.ts` showing `Compacting…` before `[compaction] Compacted from 42,000 tokens`; or
- deterministic frame text from the new `renderRpcHostFrameForTest` assertion showing `Compacting…` / `Auto-compacting…` plus `INSCRIBING`.

If you also run a V2 review pack, use review-only output and do not promote goldens:

```bash
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
```

Then inspect the generated text reports before looking at PNGs:

```bash
cat docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff.txt
cat docs/visual/out/parity/active-landscape-runtime/raw/geometry-audit.txt
```

**Verify**: all commands above exit 0, or any visual review-only drift is documented and unrelated to compaction status. `pnpm visual:ci` required crops must pass.

## Test plan

New/updated tests:

- `src/compaction-indicator.test.ts` — existing classic retained behavior remains green after renderer extraction.
- `src/sumo-tui/rpc/state.test.ts` — reason lifecycle from `compaction_start` / `compaction_end`.
- `src/sumo-tui/rpc/shell-adapter.test.ts` — above-editor manual/auto labels, no generic `Working…` during compaction, portrait compaction visibility.
- `src/sumo-tui/rpc/runtime.test.ts` — full retained frame contains the compaction label and footer `INSCRIBING`.
- `test/integration/rpc-compaction-ux.test.ts` — real PTY/RPC path shows `Compacting…` during a delayed fake `compact` command and later shows the persistent summary pill.

Existing tests that must continue to pass:

- `src/sumo-tui/rpc/transcript-pump.test.ts` — completed compaction summaries still render correctly.
- `src/sumo-tui/rpc/controls.test.ts` — `compact` command payload and generous timeout unchanged.
- `src/sumo-tui/rpc/host-actions.test.ts` — `/compact` dispatch and auto-compaction settings unchanged.
- Full `pnpm test`, `pnpm test:integration`, and `pnpm visual:ci`.

## Done criteria

ALL must hold:

- [ ] RPC compacting state renders `Compacting…` for `reason: "manual"`.
- [ ] RPC compacting state renders `Auto-compacting…` for `reason: "threshold"` or `"overflow"`.
- [ ] During RPC compaction, the above-editor row does not show generic `Working…`.
- [ ] Footer still renders `INSCRIBING` during compaction.
- [ ] Completed compaction summaries still render as `[compaction] Compacted ...` pills.
- [ ] `installRpcChildProfile` still does not install `installCompactionIndicator` or other chrome widgets.
- [ ] No files outside the in-scope list are modified, except unavoidable test snapshot/review artifacts that are ignored and not committed.
- [ ] `pnpm vitest run src/compaction-indicator.test.ts` exits 0.
- [ ] `pnpm vitest run src/sumo-tui/rpc/state.test.ts` exits 0.
- [ ] `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/runtime.test.ts` exits 0.
- [ ] `pnpm vitest run test/integration/rpc-compaction-ux.test.ts` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm test:integration` exits 0.
- [ ] `pnpm visual:ci` exits 0 with required crops passing.
- [ ] `pnpm exec tsc --noEmit && pnpm build` exits 0.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited current-state excerpts has drifted and the planned symbols no longer exist.
- The live Pi RPC events no longer use `reason: "manual" | "threshold" | "overflow"`, or `compaction_start` no longer precedes the user-visible compaction period.
- Showing the compaction label appears to require changing `bin/sumocode.sh`, `sumo-rpc-host.js`, `SUMO_RPC`, `SUMO_TUI`, or launcher runtime selection.
- The apparent fix is to install `installCompactionIndicator` in `installRpcChildProfile`; that violates the RPC child chrome boundary.
- A visual parity change requires updating Bible targets or promoting runtime goldens; get explicit Dhruv approval first.
- The PTY fixture cannot make `Compacting…` visible without sleeping/flaking for more than 2 seconds; stop and propose a deterministic runtime-only alternative.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Keep transient and persistent compaction UX separate: above-editor row = in progress; transcript summary pill = completed compaction record.
- Reviewers should scrutinize the manual/auto label mapping and stale reason cleanup. A stale `manual` reason would mislabel the next automatic compaction.
- If Pi later adds richer compaction progress events, extend `RpcHostChromeState` in `src/sumo-tui/rpc/state.ts` and the pure renderer helper; do not add a second host-side status mechanism.
- If the visual harness gains a dedicated compaction scenario later, it should be deterministic and review-only unless Dhruv approves new goldens.
- `src/compaction-state.ts` still exists for classic/compat event ordering. The RPC host should not rely on its global mutable value for rendering because host state already receives `compaction_start` directly.
