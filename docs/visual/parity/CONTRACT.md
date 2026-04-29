# V2 Visual Parity Contract

**Status:** active contract for V2 harness work  
**Owner:** SumoTUI consolidation #99  
**Related:** `docs/visual/V2_HARNESS_SPEC.md`, `docs/visual/parity/scenarios.json`

This document defines what the V2 Cathedral Visual Harness is allowed to assert. It exists to keep tests, runtime captures, and review packs aligned while SumoCode moves through the hybrid Pi/SumoTUI consolidation phase.

## 1. Sources of truth

1. **Visual Bible targets** (`docs/ui/bible/*.html` → `docs/ui/bible/renders/*.png`) are the design target.
2. **Scenario manifest** (`docs/visual/parity/scenarios.json`) is the machine-readable capture/crop contract.
3. **Runtime goldens** (`docs/visual/parity/approved-runtime/**`) are approved implementation checkpoints, not design targets.
4. **Review packs** (`docs/visual/out/parity/index.html`) are evidence for human review and remain uncommitted artifacts.

If these disagree, update the Bible/manifest first, then regenerate review evidence, then promote a runtime golden only after explicit developer approval.

## 2. Capture engine

The canonical V2 path is:

```txt
node-pty bytes
→ @xterm/headless replay
→ DOM terminal renderer
→ Playwright screenshot
→ crop/mask/diff
→ HTML review pack
```

`tmux`, cmux/Ghostty screenshots, and live terminal captures are debugging aids only. They must not define CI pass/fail for V2 pixel parity.

Runtime scenarios invoke SumoCode through the user-facing entry contract:

```bash
./bin/sumocode.sh --offline --no-extensions --no-session
```

Runtime scenarios must set deterministic terminal env in the manifest (`PI_OFFLINE=1`, `SUMO_TUI=1`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=3`).

## 3. V2 dimensions and layout constants

The manifest owns scenario dimensions. Current locked V2 dimensions are:

- Component input frame: `160 × 4`
- Component footer: `160 × 1`
- Component top bar: `160 × 1`
- Component sidebar: `30 × 26`
- Landscape runtime scenes: `160 × 45`
- Portrait runtime scenes: `60 × 100`

V2 sidebar width is **30 columns**. Legacy 49-column sidebar references are historical V1/mockup material and must not be used for new V2 assertions.

P0-F portrait policy is **Option A**: portrait/narrow layouts hide the sidebar and let the footer/hint row absorb essential context. The canonical `60 × 100` portrait runtime scene is therefore a no-sidebar scene; it must not add a sidebar crop, bottom-registry crop, or portrait overlay crop in V1.

For 160-column full-screen crops, the sidebar crop starts at `x=130` and spans `30` columns. Chat/runtime content should reserve the matching right-side space only when the runtime sidebar policy says the sidebar is visible.

## 4. Input and cursor contract

The active V2 input frame is label-less. Tests and captures must not wait for or assert legacy labels such as:

- `SCRIPTOR INPUT`
- `INPUT`
- `INPUT PROTOCOL AWAITING COMMAND`

Splash/empty-state captures may show `DIVINE INVOCATION`; active typed component captures must keep the frame label-less and use the prompt/caret row as the semantic anchor.

Hardware cursor visibility is a Pi/TUI runtime preference. PTY integration tests that assert hardware cursor behavior must opt in with `PI_HARDWARE_CURSOR=1` and wait for the stable post-render cursor state, not the first incidental `?25h` emitted during startup.

Visual parity screenshots should not rely on terminal cursor color. The V2 terminal ownership contract is: terminal cursor color remains the user's preference unless an explicit future SumoCode cursor command changes it. `TerminalSessionOwner` therefore does not emit OSC 12 during normal startup; cursor color overrides are opt-in only.

## 5. Crop status semantics

Each crop resolves its status from the crop entry or its parent scenario:

- `review` — compare Bible/runtime/golden where available, report drift, do not fail CI on pixels.
- `approved` — a runtime golden is present and drift is visible in review packs, but pixel drift remains non-blocking.
- `required` — a runtime golden is present and drift from that golden fails CI when the threshold is exceeded.

For `required` crops, the runtime golden is the regression gate. Bible diffs remain review evidence until implementation and design converge. Required crops must not be added without a committed approved runtime golden.

Hard failures always fail, regardless of crop status:

- invalid scenario manifest
- missing Bible target or required runtime golden
- runtime capture crash
- known error screen/output rejection
- blank capture
- ANSI replay/render failure
- crop out of bounds
- malformed result metadata

## 6. Current required runtime goldens

The required V2 crop gates currently are:

- `input-typed-component/input-frame` — threshold `0.03`
- `footer-ready-component/footer` — threshold `0.04`
- `top-bar-default-component/top-bar` — threshold `0.08`

Sidebar editorial parity is review-approved by inspection but not yet promoted as a required crop.

## 7. Promotion and review loop

Promotion is human-in-the-loop only:

```bash
pnpm visual:promote -- --scenario <scenario-id> --crop <crop-id> --status approved
pnpm visual:promote -- --scenario <scenario-id> --crop <crop-id> --status required
```

Before promotion, generate and inspect a review pack:

```bash
pnpm render:bible
pnpm visual:review -- --scenario <scenario-id>
```

Use `/bible-verify/` for local visual review when available. Raw review-pack artifacts stay gitignored; only approved runtime goldens and manifest status changes are committed.
