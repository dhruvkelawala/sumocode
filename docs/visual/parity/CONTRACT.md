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

If these disagree, update the Bible/manifest first, then regenerate review evidence, then promote a runtime golden only after explicit developer approval. RPC-default UI parity is not approved until required crop gates pass, the styled-cell diff and geometry audit have no unapproved drift, and a human reviewer has compared the review pack against the current original UX. During the RPC migration, the current `main` retained TUI is the canonical product baseline: candidate RPC captures must be compared against a freshly captured `main` review root before parity is claimed.

## 2. Capture engine and verification layers

The canonical V2 pipeline is:

```txt
node-pty bytes OR deterministic fixture ANSI
→ @xterm/headless replay → cell snapshot (JSON)
  ├─ styled cell diff  (char + fg + bg per cell vs Bible HTML)
  ├─ geometry audit    (row categories + column bounds vs geometrySpec)
  └─ DOM terminal renderer → Playwright screenshot → crop/mask/diff → review pack
```

### Styled cell diff (primary verification)

`scripts/visual-v2/styled-cell-grid.mjs` parses Bible HTML `<pre class="grid">` spans into a per-cell `{ char, fg, bg, bold, dim }` grid and compares it cell-for-cell against the xterm runtime snapshot. This is fully deterministic and text-level — no PNG in the loop.

Known intentional differences between Bible mockup and runtime palette are declared as equivalent color pairs (e.g. `--divider-mockup` #5A4D3C ↔ `--divider` #3A2F25) and suppressed from the diff.

Output: `docs/visual/out/parity/<scenario>/raw/styled-cell-diff.txt`

### Geometry audit

`scripts/visual-v2/geometry-audit.mjs` classifies each row by content (top-bar, chat-frame-top, hint-row, footer, blank, etc.) and checks horizontal bounds against a `geometrySpec` declared per scenario in `scenarios.json`. Catches structural layout drift (e.g. input frame at the wrong row, missing breathing rows).

Output: `docs/visual/out/parity/<scenario>/raw/geometry-audit.txt`

### PNG crop/diff (review evidence)

Playwright screenshot + pixelmatch diff remains for visual review packs and human approval. It is not the primary verification gate. Use text-level reports first.

`tmux`, cmux/Ghostty screenshots, and live terminal captures are debugging aids only. They must not define CI pass/fail for V2 pixel parity.

Runtime scenarios invoke SumoCode through the user-facing entry contract:

```bash
./bin/sumocode.sh --offline --no-extensions --no-session
```

Runtime scenarios must set deterministic terminal env in the manifest (`PI_OFFLINE=1`, `SUMO_TUI=0`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=3`). The launcher owns the runtime env: `bin/sumocode.sh` unconditionally exports `SUMO_TUI=0` and selects the RPC host itself (`SUMO_RPC=1`), so the scenario env pins `SUMO_TUI=0` to document the effective environment rather than to activate anything. The runtime capture harness injects a temporary `PI_CODING_AGENT_DIR` for every runtime attempt unless a scenario explicitly declares `PI_CODING_AGENT_DIR` in `runtime.env`; this keeps review evidence isolated from user-specific Pi state. Fixture scenarios do not spawn Pi; they render deterministic `TranscriptViewModel` state through the same SumoTUI scene primitives and then enter the same ANSI replay/DOM/crop pipeline. Use fixtures for completed assistant/tool states that cannot be reached deterministically through offline runtime capture.

Runtime-labelled scenarios must not use `SUMOCODE_VISUAL_RPC_FIXTURE` or any other completed-state injection. If a scenario needs a deterministic completed assistant/tool transcript, it belongs in the `fixture` lane with a name that makes the fixture source obvious. Runtime scenarios may still script real keyboard input through `runtime.inputs`.

Active runtime scenarios additionally pass the explicit harness extension `-e ./scripts/visual-v2/runtime-faux-provider.mjs --model sumocode-visual/active-working`. This is a local non-secret provider used only to keep Pi in a streaming active-working state after real startup, typing, and submit; it is not a completed transcript fixture and must not be used for completed-response assertions. Active runtime inputs use a readiness wait, a logical `Enter` key mapped by the capture harness, and a final-screen wait that rejects splash/error markers such as `No API key found`, `rpc error: prompt failed`, `DIVINE INVOCATION`, `unknown · off`, and raw `^[[13u` echoes.

Active runtime scenarios compare against dedicated live-submitted Bible targets: `scene-active-runtime.png` and `scene-active-runtime-portrait.png`. Those targets contain only the submitted prompt (`review src/auth/session.ts and tighten the return type`) plus the faux-provider active text (`inspecting src/auth/session.ts`). The richer `scene-active.png` and `scene-active-portrait.png` targets remain completed/tool transcript canon for fixture and review lanes; runtime lanes must not inject those completed assistant/tool rows.

For RPC reviewer evidence, run the same scenario review command rather than a separate golden path:

```bash
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
```

Those commands print the review pack and results paths and write PNG poster frames under `docs/visual/out/parity/<scenario>/runtime-full.png`. These outputs are ignored review artifacts, not Bible goldens. Optional video evidence may live under `/tmp/sumocode-rpc-demo`, but it does not replace the required crop, styled-cell, geometry, and human-review checks.

For RPC migration acceptance, capture the same runtime scenarios on `main` and on the candidate branch, then compare the two review roots:

```bash
pnpm visual:compare -- --baseline-root /tmp/sumocode-main-visual/parity --candidate-root docs/visual/out/parity --lane runtime
```

The comparison first validates that both capture roots were produced from the same scenario contract (lane, dimensions, runtime command/env/inputs, fixture source, and crop definitions). It then writes `docs/visual/out/parity-main-rpc/` with per-scenario contract validation, styled-cell diffs, copied geometry audit summaries, PNG crop diffs, and `results.json`. The current duplicate RPC shell is expected to fail this comparison before the portable-shell plans land; Plan 024 is the final sign-off point where it must pass or list approved deviations.

Final RPC migration evidence should use compatible capture roots that include `capture-metadata.json.scenarioContract`, even when the baseline runs `main` code. The compare helper accepts older runtime capture metadata only as a diagnostic bridge after checking command, args, dimensions, and runtime input count; synthetic active roots that skipped scripted runtime input should fail contract validation instead of being compared as product evidence.

Runtime crash, error, and user-config warning strings belong in `rejectIfOutputMatches`; model selection pollution such as `Warning: No models match pattern` must fail the capture rather than become approval evidence. Temporary RPC shell placeholders such as `SUMOCODE RPC`, `empty transcript`, and `sumocode · rpc host` belong in `rejectIfFinalScreenMatches` so startup transitions can still produce review evidence while settled placeholder screens fail parity.

## 3. V2 dimensions and layout constants

The manifest owns scenario dimensions. Current locked V2 dimensions are:

- Component input frame: `160 × 4`
- Component footer: `160 × 1`
- Component top bar: `160 × 1`
- Component sidebar: `30 × 26`
- Landscape runtime scenes: `160 × 45`
- Portrait runtime scenes: `60 × 100`

V2 sidebar width is **30 columns**. Legacy 49-column sidebar references are historical V1/mockup material and must not be used for new V2 assertions.

P0-F portrait policy is **Option A**: portrait/narrow layouts hide the sidebar and let the footer/hint row absorb essential context. The canonical `60 × 100` portrait runtime scene is therefore a no-sidebar scene; it must not add a sidebar crop, bottom-registry crop, or portrait overlay crop in V1. It may still define crop-level evidence for the top bar, chat area, input frame, hint row, and footer.

For 160-column full-screen crops, the sidebar crop starts at `x=130` and spans `30` columns. Chat/runtime content should reserve the matching right-side space only when the runtime sidebar policy says the sidebar is visible.

## 4. Input and cursor contract

The active V2 input frame is label-less. Tests and captures must not wait for or assert legacy labels such as:

- `SCRIPTOR INPUT`
- `INPUT`
- `INPUT PROTOCOL AWAITING COMMAND`

Splash/empty-state captures may show `DIVINE INVOCATION`; active typed component captures must keep the frame label-less and use the prompt/caret row as the semantic anchor.

Hardware cursor visibility is a Pi/TUI runtime preference. PTY integration tests that assert hardware cursor behavior must opt in with `PI_HARDWARE_CURSOR=1` and wait for the stable post-render cursor state, not the first incidental `?25h` emitted during startup.

Visual parity screenshots should not rely on browser-rendered cursor color: the harness renders a fixed cursor cell, while real terminals honor cursor-color escape sequences. The V2 terminal ownership contract now applies the Cathedral accent cursor (`OSC 12 #D97706`) when retained mode starts, and resets it on terminal cleanup so the host shell regains its default. `/sumo:cursor reset` remains the explicit opt-out path during a session.

## 5. Crop status semantics

Scenario lanes:

- `component` — isolated primitive/component captures.
- `fixture` — deterministic full-scene captures from fixture transcripts.
- `runtime` — real `./bin/sumocode.sh` captures through node-pty.

Each crop resolves its status from the crop entry or its parent scenario:

- `review` — compare Bible/runtime/golden where available, report drift, do not fail CI on pixels.
- `approved` — a runtime golden is present and drift is visible in review packs, but pixel drift remains non-blocking.
- `required` — drift fails CI when the threshold is exceeded. If a runtime golden is present, the golden is the regression gate; otherwise the crop gates directly against the Bible target.

For `required` crops with runtime goldens, the runtime golden is the regression gate and Bible diffs remain review evidence until implementation and design converge. Required RPC runtime crops may be added before golden promotion so the harness fails loudly against the Bible target during cutover work.

Hard failures always fail, regardless of crop status:

- invalid scenario manifest
- missing Bible target
- runtime capture crash
- known error screen/output rejection
- blank capture
- ANSI replay/render failure
- crop out of bounds
- malformed result metadata

## 6. Current required gates

The required V2 crop gates with committed runtime goldens currently are:

- `input-typed-component/input-frame` — threshold `0.03`
- `footer-ready-component/footer` — threshold `0.04`
- `top-bar-default-component/top-bar` — threshold `0.08`

The RPC-default original-UX runtime scenarios also have required gates before golden promotion for stable regions only:

- `splash-runtime/full`
- `active-landscape-runtime/top-bar`
- `active-landscape-runtime/chat-area`
- `active-landscape-runtime/hint-row`
- `active-landscape-runtime/footer`
- `active-portrait-runtime/top-bar`
- `active-portrait-runtime/chat-area`

Active-runtime sidebar, input-frame, portrait hint-row, and portrait footer crops remain review evidence until their palette/content drift has explicit visual approval or committed runtime goldens.

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

Use `/bible-verify/` for local visual review when available. Raw review-pack artifacts stay gitignored; only approved runtime goldens and manifest status changes are committed. Golden promotion requires explicit Dhruv approval.
