# Plan 016: Compose the RPC runtime from the existing Cathedral shell surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dcd99c1..HEAD -- src/sumo-tui/rpc/runtime.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/cathedral src/cathedral src/footer.ts src/top-chrome.ts src/sidebar.ts docs/visual/parity/scenarios.json scripts/visual-v2`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 014, 015
- **Category**: bug
- **Planned at**: commit `dcd99c1`, 2026-07-02

## Why this matters

The RPC host currently works, but it does not look like SumoCode. It paints a
minimal shell with `SUMOCODE RPC`, no sidebar, simplified footer, and different
empty-state composition. The current/original SumoCode UX is the Cathedral
shell: splash, top chrome, footer, sidebar, input hints, portrait/sidebar
policy, and retained transcript composition. This plan makes the RPC runtime
reuse those existing surfaces instead of inventing a second visual language.

## Current state

`src/sumo-tui/rpc/runtime.ts:168-254` hand-paints the frame. Key mismatches:

```ts
const TOP_CHROME_ROWS = 2;
const FOOTER_ROWS = 2;
const EDITOR_ROWS = 4;
```

```ts
line: splitLine(
	[span(" sumocode", accent), span(" · rpc host", dim)],
	[span(label, label === "READY" ? idle : tool), span(" ", base)],
	columns,
	base,
),
```

```ts
if (!hasMessages) {
	lines.push(
		{ row: centerRow, line: centeredLine([span("SUMOCODE", accent), span(" RPC", tool)], columns, base) },
		{ row: centerRow + 2, line: centeredLine([span("empty transcript", dim)], columns, base) },
		{ row: centerRow + 3, line: centeredLine([span(session, base)], columns, base) },
		{ row: centerRow + 4, line: centeredLine([span(model, dim)], columns, base) },
	);
}
```

That is the UI seen in the recorded demo. It is useful for proving the RPC
host works, but it is not UX parity.

Existing Cathedral pieces to reuse:

- `src/sumo-tui/cathedral/splash-tree.ts:51-63` creates the Yoga-centered
  splash from `renderSplashContent`.
- `src/sumo-tui/cathedral/sidebar-tree.ts:136-204` implements the responsive
  sidebar host and hides the sidebar while the splash has no messages.
- `src/sumo-tui/cathedral/footer-tree.test.ts:21-45` proves the
  `RegionRegistry` shell pins footer to the last row.
- `src/cathedral/cathedral-editor.ts:285-354` already renders the Cathedral
  input frame and has splash-vs-active behavior.

Post-014/015 reconciliation:

- Plan 014 removed the legacy `sumo-interactive-mode` runtime and the
  `getActiveSumoRuntime()` publication path from `src/sidebar.ts` and
  `src/top-chrome.ts`. Do **not** reintroduce that seam. RPC parity should use
  pure render helpers, Cathedral tree nodes, or small RPC-local adapters.
- Plan 015 made the runtime visual gates required and added
  `rejectIfFinalScreenMatches` for `SUMOCODE RPC`, `empty transcript`, and
  `sumocode · rpc host`. Do **not** relax those statuses, thresholds, or
  rejection patterns to make this plan pass.
- Required RPC runtime crops now gate against the Bible target before golden
  promotion. Do not run `pnpm visual:promote`; the executor produces review
  evidence only.

The current shell policy from `AGENTS.md` still applies:

- V2 sidebar width is `30` columns.
- Wide sidebar starts at `SIDEBAR_MIN_TERMINAL_WIDTH = 120`.
- Portrait runtime is `60 x 100` and no-sidebar for V1.
- Active V2 input frame is label-less; do not reintroduce legacy input labels.
- Footer right zone is context/window + cost only. Project/branch live in the
  sidebar when visible or hint row when hidden.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| RPC runtime unit | `pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/cathedral/splash-tree.test.ts src/sumo-tui/cathedral/sidebar-tree.test.ts src/sumo-tui/cathedral/footer-tree.test.ts` | all pass |
| Visual scenario | `pnpm visual:review -- --scenario splash-runtime` | required crops pass |
| Visual scenario | `pnpm visual:review -- --scenario active-landscape-runtime` | required crops pass |
| Visual scenario | `pnpm visual:review -- --scenario active-portrait-runtime` | required crops pass |
| Full visual | `pnpm visual:ci` | exit 0 |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |

## Scope

**In scope:**

- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/rpc/runtime.test.ts`
- Small adapters under `src/sumo-tui/rpc/` if needed to map `RpcHostChromeState`
  to existing Cathedral snapshots
- Existing Cathedral modules under `src/sumo-tui/cathedral/` only if they need
  tiny adapter seams for RPC state
- `docs/visual/parity/scenarios.json` only for tiny timing/crop-name fixes if a
  crop is objectively pointed at the wrong stable region. Required status,
  placeholder rejection, and thresholds from Plan 015 are not to be relaxed.
- `scripts/visual-v2` only if a bug in the new Plan 015 final-screen gate is
  proven by this implementation; do not weaken the gate.

**Out of scope:**

- Reintroducing `SUMO_LEGACY`, `SUMO_TUI_MODULE`, or any in-process Pi patch
  seam.
- Changing transcript rendering for Plans 007-013. That is Plan 017.
- Promoting visual goldens.
- Redesigning the UI. This is parity, not a new look.
- Reintroducing `getActiveSumoRuntime()` publication from classic extension
  modules.
- Changing required visual gates to review-only.

## Git workflow

- Branch: `codex/rpc-migration-no-seam`
- Commit message example: `fix: restore cathedral shell in rpc runtime`
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Replace hand-painted RPC top/footer with existing chrome adapters

Create small pure functions that map `RpcHostChromeState` into the data shape
expected by the existing footer/top chrome renderers. Prefer importing and
adapting existing modules over duplicating strings. If the existing modules are
tightly coupled to Pi context, extract pure render helpers first.

Remove the literal `sumocode · rpc host` and `SUMOCODE RPC` labels from the
normal user-facing runtime. A hidden/debug label is acceptable only in
diagnostics, not visible chrome.

**Verify:**

```bash
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts
rg "SUMOCODE RPC|empty transcript|rpc host" src/sumo-tui/rpc src/sumo-tui/cathedral src/cathedral
```

Expected: tests pass; no user-facing RPC placeholder strings remain in
production rendering.

### Step 2: Use `createSplashTree` for empty sessions

In `RpcHostRuntime`, replace the centered placeholder rows with the existing
Cathedral splash tree. The RPC empty state must render the same splash content
as the current original runtime, including the input frame and hint placement.
The sidebar must remain hidden while `hasMessages` is false.

**Verify:**

```bash
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/cathedral/splash-tree.test.ts
pnpm visual:review -- --scenario splash-runtime
```

Expected: no `SUMOCODE RPC`/`empty transcript`; splash crop matches the
canonical target within required threshold.

### Step 3: Use `createSidebarTree` for active landscape and portrait policy

Wrap the chat/transcript area and sidebar in the existing sidebar tree. Use
`RpcHostChromeState` plus any available host data to populate:

- active project/branch/session rows,
- context token meter,
- model/thinking state,
- memory/MCP rows when available,
- hidden sidebar for empty splash and portrait/no-sidebar policy.

Do not make a decorative placeholder sidebar. If a sidebar datum is unavailable
over RPC, either source it from the host (for git/project data) or render the
same empty/default state the current original UI would render.

**Verify:**

```bash
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/cathedral/sidebar-tree.test.ts
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
```

Expected: landscape shows the 30-column sidebar at width 160; portrait hides
the sidebar; both pass required geometry.

### Step 4: Restore input hints and footer semantics

The RPC editor already uses `CathedralEditor`, but the surrounding hint/footer
policy must match current original behavior:

- active input frame remains label-less,
- splash input frame uses `DIVINE INVOCATION`,
- hint row shows project/branch when sidebar is hidden,
- footer right zone stays context/window + cost only,
- state dot/label follows `READY / MEDITATING / ILLUMINATING / DEFERRING /
  INSCRIBING`.

**Verify:**

```bash
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
```

Expected: required input, hint, and footer crops pass.

### Step 5: Re-run full gates and produce reviewer evidence

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test:integration
pnpm visual:ci
pnpm perf:startup
```

Also produce a short offline runtime clip or poster frames for the reviewer.
Store generated media outside tracked goldens, e.g. `/tmp/sumocode-rpc-demo`.

Expected:

- Required visual crops pass.
- Visual review pack path is reported.
- MP4/poster paths are reported if generated.
- Startup perf does not time out.

## Test plan

- Unit tests in `src/sumo-tui/rpc/runtime.test.ts` asserting:
  - empty state no longer contains `SUMOCODE RPC` or `empty transcript`,
  - active landscape reserves sidebar width,
  - portrait hides sidebar,
  - footer state label matches streaming/compacting state.
- Existing Cathedral tree tests stay green.
- Visual runtime scenarios are the primary UI parity proof.

## Done criteria

ALL must hold:

- [x] No user-facing `SUMOCODE RPC`, `empty transcript`, or `rpc host` labels in
  rendered production surfaces.
- [x] `splash-runtime` required crops pass.
- [x] `active-landscape-runtime` required top/sidebar/chat/input/hint/footer
  crops pass.
- [x] `active-portrait-runtime` required top/chat/input/hint/footer crops pass.
- [x] Sidebar policy matches current original decisions.
- [x] Footer and input hint policy match current original decisions.
- [x] `pnpm visual:ci` exits 0.
- [x] Reviewer evidence path is reported.

## STOP conditions

Stop and report if:

- Existing Cathedral shell modules cannot be reused without large rewrites.
- A required sidebar/footer datum has no RPC or host-side source.
- Passing the visual gate would require changing Bible goldens.
- The fix starts reintroducing the legacy seam.

## Maintenance notes

This plan should make the RPC host visually boring in the best way: it should
look like the current SumoCode UI, just backed by Pi RPC. Reviewers should be
skeptical of "close enough" screenshots. The claim is 1:1 UX parity.

## Execution review

**Status:** DONE on `codex/rpc-migration-no-seam`.

**Advisor verdict:** APPROVE. The accepted implementation removes the provisional
RPC shell labels from the visible runtime and composes the RPC host from existing
Cathedral splash, top chrome, sidebar, input, footer, and transcript surfaces.
Runtime visual scenarios now use a harness-only deterministic RPC fixture
(`SUMOCODE_HARNESS=1` + `SUMOCODE_VISUAL_RPC_FIXTURE`) for active transcript
parity, while normal RPC launches still hydrate transcript/state from Pi.

**Verification rerun by advisor:**

- `pnpm exec tsc --noEmit && pnpm build` — passed.
- `pnpm vitest run src/cathedral/input-frame.test.ts src/sumo-tui/rpc/runtime.test.ts` — passed, 2 files / 46 tests.
- `pnpm vitest run test/integration/rpc-host-shell.test.ts test/integration/narrow-width.test.ts test/integration/cursor-visibility.test.ts test/integration/multiline-paste.test.ts` — passed, 4 files / 9 tests.
- `pnpm test:integration` — passed, 15 files / 33 tests.
- `pnpm visual:review -- --lane runtime` — passed all runtime scenarios.
- `pnpm visual:ci` — passed all required crops; review pack at `docs/visual/out/parity/index.html`.
- `pnpm perf:startup` — passed; app-ready averaged about 1682 ms in the middle runs. Generated perf snapshot changes were reverted before commit.

**Review notes:** no visual goldens were promoted. The portrait input crop passes
the required PNG gate and geometry audit; its crop-level styled-cell artifact is
known to be noisy when cropping CSS-grid-positioned full-scene HTML and is not
used as the gate for this plan.
