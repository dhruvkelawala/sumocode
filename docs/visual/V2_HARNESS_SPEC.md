# V2 Cathedral Visual Harness Spec

**Status:** accepted design · 2026-04-29  
**PRD:** https://github.com/dhruvkelawala/sumocode/issues/78  
**Primary command target:** `pnpm visual:review`  
**Initial mode:** review-only, with explicit promotion to approved/required

---

## 1. Purpose

The V2 Cathedral Visual Harness closes the loop between:

1. **Visual Bible targets** — design intent, rendered from `docs/ui/bible/*.html`.
2. **TUI component output** — deterministic retained-TUI/cell output from isolated renderer modules.
3. **Real runtime output** — terminal bytes emitted by actual SumoCode through a pseudo-terminal.
4. **Review packs** — human-friendly side-by-side target/runtime/diff artifacts.
5. **Approved runtime goldens** — committed snapshots that become CI regression locks only after explicit approval.

The harness must answer two different questions without confusing them:

- **Design parity:** how far is the current runtime from the Cathedral Visual Bible?
- **Regression safety:** did an already-approved runtime state change unexpectedly?

The Visual Bible remains the single source of truth for design. Runtime goldens are not design targets; they are approved implementation checkpoints.

---

## 2. Non-negotiable principles

### 2.1 Canonical capture engine: `node-pty`

Use direct `node-pty` capture as the canonical engine.

Why:

- owns terminal cols/rows exactly
- captures raw bytes for replay/debug
- works locally and in Linux CI
- integrates with existing integration helpers
- avoids an extra terminal/multiplexer layer
- can set deterministic env/config per scenario

### 2.2 `tmux` is debug-only

`tmux` is allowed only as an optional human-observe/debug mode, never as the pass/fail source of truth.

Reason: tmux introduces its own terminal behavior, status configuration, palette handling, alternate-screen behavior, and mouse encoding. Those are useful for live inspection but too noisy to define pixel parity.

### 2.3 Deterministic rendering path

The canonical pixel path is:

```txt
node-pty bytes
→ @xterm/headless terminal model
→ SumoCode DOM terminal renderer
→ Playwright screenshot
→ crop/mask/diff
→ review pack
```

Do **not** compare pixel-perfect goldens against screenshots from a developer's real terminal window. Real terminal captures remain smoke evidence only.

### 2.4 Crop-first approval

Start with component crops, not full-screen hard gates.

Initial crops:

- top bar row
- 30-col sidebar
- input frame
- hint row
- footer row
- chat area

Full-screen screenshots are always generated for review, but only component crops become required gates during V2.

### 2.5 Review-only first

Initial scenario/crop status is `review`.

CI fails only for:

- capture crash
- render crash
- missing target asset
- blank/error runtime capture
- malformed result metadata
- a `required` crop exceeding threshold

Pixel drift in `review` state is reported but does not fail CI.

---

## 3. Why not VHS for pixel parity?

VHS remains useful for T1 smoke checks because it answers: “does SumoCode boot in a terminal-like environment and produce a screenshot?”

VHS should not be the V2 pixel comparator because:

- it renders through an external terminal screenshot pipeline
- cell dimensions and font rasterization are harder to pin precisely
- cursor timing and shell timing can introduce noise
- historical T1 runs already showed invocation mismatch risk
- it is better at capturing moments than asserting semantic terminal state

V2 keeps VHS/real-runtime tapes as smoke evidence, but moves pixel parity to deterministic ANSI replay.

---

## 4. Architecture overview

```txt
                    ┌────────────────────────────┐
                    │  Visual Bible HTML targets  │
                    │  docs/ui/bible/*.html       │
                    └─────────────┬──────────────┘
                                  │ pnpm render:bible
                                  ▼
                    ┌────────────────────────────┐
                    │  Bible target PNGs          │
                    │  docs/ui/bible/renders/*    │
                    └─────────────┬──────────────┘
                                  │
                                  │
┌───────────────────┐     ┌───────▼────────┐     ┌──────────────────┐
│ Component fixture  │────▶│ Terminal model │────▶│ DOM cell renderer │
│ renderer path      │     │ @xterm/headless│     │ Playwright PNG    │
└───────────────────┘     └───────▲────────┘     └────────┬─────────┘
                                  │                       │
┌───────────────────┐             │                       │
│ Runtime pty path   │─────────────┘                       │
│ ./bin/sumocode.sh  │                                     │
└───────────────────┘                                     ▼
                                                ┌──────────────────┐
                                                │ Crop/mask/diff    │
                                                │ Bible + golden    │
                                                └────────┬─────────┘
                                                         ▼
                                                ┌──────────────────┐
                                                │ HTML review pack  │
                                                │ JSON results      │
                                                └──────────────────┘
```

There are two input lanes:

1. **Component lane** — render an isolated TUI component from deterministic fixtures.
2. **Runtime lane** — run real SumoCode through `node-pty` and capture terminal bytes.

Both lanes converge into the same terminal model and DOM image renderer. This is what allows component-level and full-screen runtime states to be compared consistently.

---

## 5. Deep modules

The implementation should be split into deep, testable modules with small stable interfaces.

### 5.1 Scenario registry

Loads and validates the scenario manifest.

Responsibilities:

- discover scenarios
- validate schema
- resolve Bible target names
- resolve crop definitions
- enforce status values
- reject missing target files
- expose normalized scenario plans to runners

Conceptual interface:

```txt
loadVisualScenarioRegistry(options) -> VisualScenarioRegistry
registry.listScenarios(filter) -> VisualScenario[]
registry.getScenario(id) -> VisualScenario
```

### 5.2 Runtime capture runner

Runs actual SumoCode through `node-pty`.

Responsibilities:

- spawn `./bin/sumocode.sh` or an explicitly resolved equivalent
- set deterministic env
- set exact cols/rows
- drive input timeline
- detect successful boot
- detect runtime error screens
- capture raw byte stream
- capture final terminal state
- emit structured metadata

Important: the runtime command must go through the same SumoCode entry contract users rely on. Do not use raw `pi -e ./src/extension.ts` for runtime capture; launch through `./bin/sumocode.sh` so the foreground RPC host owns the terminal.

Conceptual interface:

```txt
captureRuntimeScenario(plan) -> RuntimeCapture
```

### 5.3 Component capture runner

Renders isolated TUI components with deterministic fixture state.

Responsibilities:

- call component renderers without launching Pi
- convert retained TUI output/ANSI/cell buffers into a terminal byte stream or cell grid
- support fixture states matching Bible element variants
- fail if component output exceeds declared terminal dimensions

Conceptual interface:

```txt
captureComponentScenario(plan) -> ComponentCapture
```

### 5.4 ANSI replay terminal

Feeds captured bytes into `@xterm/headless`.

Responsibilities:

- instantiate a terminal with fixed cols/rows
- preserve truecolor
- preserve Unicode/wide glyphs
- support alternate-screen state
- expose stable cell snapshots
- expose plain text for semantic assertions

Conceptual interface:

```txt
replayAnsi(bytes, dimensions, options) -> TerminalSnapshot
```

### 5.5 DOM terminal renderer

Turns a `TerminalSnapshot` into deterministic HTML and PNG.

Responsibilities:

- use the same embedded JetBrains Mono assets as the Bible
- render one row per terminal row
- group adjacent cells with identical style into spans
- preserve foreground/background colors
- preserve blank cell background fills
- handle wide glyph continuation cells
- set exact cell width/line height
- expose `[data-render-rect]` for Playwright screenshots

This renderer should be browser/Playwright based rather than native canvas by default. The Bible targets are already browser-rendered; using the same browser/font stack minimizes false diffs.

Conceptual interface:

```txt
renderTerminalSnapshot(snapshot, options) -> RenderedPng
```

### 5.6 Crop planner

Maps terminal-cell crop declarations to pixel rectangles.

Responsibilities:

- compute pixel crops from cell coordinates
- validate crop bounds
- support named crop sets per scenario
- support portrait/landscape variants
- support full-screen crop as a generated artifact

Conceptual interface:

```txt
planCrops(scenario, renderMetrics) -> CropPlan[]
```

### 5.7 Image comparator

Compares target/runtime/golden images.

Responsibilities:

- crop target images and runtime images
- apply masks for volatile regions
- produce diff PNGs
- compute metrics
- respect status/threshold policy
- distinguish Bible-target comparison from runtime-golden comparison

Recommended implementation:

- `sharp` for cropping/resizing/metadata
- `pngjs` + `pixelmatch` for masks and diff PNGs
- optional `odiff-bin` only as a future fast-path, not the first dependency to build around

Why not only `odiff-bin`: masks and per-crop metadata are central to this harness; a JS image pipeline is easier to own and test.

Conceptual interface:

```txt
compareImagePair(pair, policy) -> ImageComparisonResult
```

### 5.8 Review pack reporter

Builds human and machine-readable outputs.

Responsibilities:

- write `results.json`
- write `index.html`
- group by scenario and crop
- show target/runtime/diff/golden columns
- show dimensions, thresholds, statuses, failure reasons
- link raw byte logs and terminal snapshots
- mark review/approved/required clearly

Conceptual interface:

```txt
writeReviewPack(results, outDir) -> ReviewPack
```

### 5.9 Golden promotion manager

Promotes explicitly approved runtime captures/crops into committed goldens.

Responsibilities:

- require explicit scenario/crop selection
- reject promotion from failed captures
- update runtime golden files
- update manifest status if requested
- never promote review-only outputs implicitly

Conceptual interface:

```txt
promoteGolden(selection, options) -> PromotionResult
```

---

## 6. Files and directories

Proposed layout:

```txt
docs/visual/
  V2_HARNESS_PRD.md?              # optional local copy; GitHub issue is canonical PRD
  V2_HARNESS_SPEC.md              # this file
  parity/
    scenarios.json                # declarative scenario registry
    crops.json                    # shared crop definitions, or inline per scenario
    approved-runtime/
      active-landscape/
        footer.png
        input-frame.png
        sidebar.png
    required-runtime/
      ...                         # optional split if preferred
  out/
    parity/
      index.html
      results.json
      active-landscape/
        target-full.png
        runtime-full.png
        bible-diff-full.png
        crops/
          footer-target.png
          footer-runtime.png
          footer-diff.png
        raw/
          runtime-output.ansi
          terminal-snapshot.json

scripts/visual-v2/
  index.mjs                       # CLI entrypoint
  scenario-registry.mjs
  runtime-capture.mjs
  component-capture.mjs
  ansi-replay.mjs
  terminal-dom-renderer.mjs
  crop-planner.mjs
  image-compare.mjs
  review-pack.mjs
  promote-golden.mjs
```

Alternative TypeScript implementation is acceptable if repo build config is adjusted accordingly. The current script ecosystem is mostly `.mjs`, so V2 can start as `.mjs` and extract typed TS later if needed.

---

## 7. Scenario manifest

A scenario should declare:

- stable id
- lane: `runtime` or `component`
- terminal dimensions
- Bible target
- fixture/input timeline
- crop set
- status
- thresholds
- masks
- error-screen rejection rules

Example shape:

```json
{
  "version": 1,
  "scenarios": [
    {
      "id": "active-landscape",
      "lane": "runtime",
      "status": "review",
      "dimensions": { "cols": 160, "rows": 45, "deviceScaleFactor": 2 },
      "bibleTarget": "scene-active.png",
      "command": "./bin/sumocode.sh",
      "env": {
        "SUMO_TUI": "1",
        "PI_OFFLINE": "1",
        "SUMOCODE_HARNESS": "1",
        "SUMOCODE_HARNESS_FIXTURE": "active-landscape"
      },
      "inputs": [
        { "afterMs": 800, "type": "text", "value": "the quick brown fox" }
      ],
      "settleMs": 250,
      "crops": ["top-bar", "sidebar", "chat-area", "input-frame", "hint-row", "footer"],
      "rejectIfOutputMatches": [
        "ERR_MODULE_NOT_FOUND",
        "Rendered line .* exceeds terminal width",
        "Skipping installed SumoCode extension"
      ]
    }
  ]
}
```

The exact schema can evolve, but it must remain declarative and validated.

---

## 8. Status and gating policy

### 8.1 Scenario/crop statuses

- `review` — produce artifacts and metrics, never fail CI on pixel drift.
- `approved` — committed runtime golden exists; drift is reported loudly but can remain non-blocking while still being adopted.
- `required` — committed runtime golden exists; drift beyond threshold fails CI.

### 8.2 Failure classes

Always hard-fail:

- scenario manifest invalid
- Bible target missing
- runtime capture process exits unexpectedly
- no terminal output captured
- known error screen detected
- PNG render fails
- crop rectangle out of bounds
- required crop/golden missing
- result JSON malformed

Status-dependent:

- Bible diff exceeds target threshold
- runtime-golden diff exceeds target threshold

### 8.3 Initial statuses

Initial V2 scenarios:

| Scenario | Lane | Bible target | Status | Notes |
|---|---|---|---|---|
| `active-landscape` | runtime | `scene-active.png` | review | primary daily-drive state |
| `active-portrait` | runtime | `scene-active-portrait.png` | review | Mac mini portrait state |
| `input-typed` | runtime/component | `04-active-input-typed.png` | review | first crop to promote |
| `splash` | runtime | `03-splash.png` | review | blocked from required until startup path is clean |
| `sidebar-editorial` | component | `01-sidebar-v2-editorial.png` | review | isolated component parity |
| `footer-ready` | component | `05-footer-idle.png` | review | isolated component parity |

---

## 9. Crop strategy

### 9.1 Cell-first crop definitions

Declare crops in terminal cells whenever possible.

Example:

```json
{
  "top-bar": { "x": 0, "y": 0, "cols": 160, "rows": 1 },
  "sidebar": { "x": 0, "y": 1, "cols": 30, "rows": 42 },
  "input-frame": { "x": 32, "y": 40, "cols": 126, "rows": 3 },
  "hint-row": { "x": 32, "y": 43, "cols": 126, "rows": 1 },
  "footer": { "x": 0, "y": 44, "cols": 160, "rows": 1 }
}
```

The renderer reports exact `cellWidth`, `cellHeight`, `padding`, and `deviceScaleFactor`; crop planner converts cells to pixels.

### 9.2 Masks

Masks are required for volatile areas.

Examples:

- cursor cell
- elapsed time
- token counts before deterministic fixtures exist
- cost
- random session IDs
- date/time

Mask declarations should also be cell-based when possible.

### 9.3 Component crop mapping

For isolated component targets, the component may occupy the full screenshot. The crop can be `full` or a component-local rectangle.

---

## 10. Rendering fidelity requirements

### 10.1 Font

Use the same embedded fonts as the Bible:

- JetBrains Mono Nerd Font Mono when glyph coverage is required
- JetBrains Mono for regular monospace if needed

The DOM renderer must load fonts explicitly via `@font-face`; never rely on host fallback for required comparisons.

### 10.2 Cell metrics

Use fixed metrics shared with the Bible renderer:

- stable `font-size`
- stable `line-height`
- exact `ch`-like width via measured glyph box or CSS grid
- `white-space: pre`
- no page zoom
- fixed `deviceScaleFactor`

The renderer should record measured `cellWidthPx` and `cellHeightPx` in `results.json`.

### 10.3 Colors

Preserve truecolor exactly. The xterm replay must use the same 24-bit color values emitted by runtime.

The comparator should report:

- color mismatches
- missing background fills
- unexpected terminal default background
- right-side holes in rows

### 10.4 Unicode width

Wide glyph handling is a correctness requirement.

The DOM renderer must account for:

- wide characters
- combining marks
- narrow no-break space
- Nerd Font icons
- box drawing glyphs

The renderer should be tested against known Bible strings that include `❈`, `✾`, `━`, `╭`, `╰`, `?`-style control safety, and Octicon/Nerd Font glyphs used by SumoCode.

---

## 11. Runtime capture contract

The runtime lane must launch through the SumoCode entrypoint:

```txt
./bin/sumocode.sh
```

or an equivalent resolved command that proves:

- the foreground RPC host is the interactive runtime
- Pi is spawned in RPC mode with the SumoCode extension loaded
- direct-Pi bypasses are used only for explicit non-interactive checks
- the active extension path is the current checkout
- no installed duplicate extension hijacks the run

Recommended deterministic env:

```txt
TERM=xterm-256color
COLORTERM=truecolor
NO_COLOR unset
FORCE_COLOR=3
PI_OFFLINE=1
SUMO_TUI=1
SUMOCODE_HARNESS=1
SUMOCODE_HARNESS_FIXTURE=<scenario-id>
```

The first V2 implementation may need a small runtime fixture hook so scenario states can be reached without live model/tool calls. This hook should be explicitly scoped to harness mode and impossible to activate accidentally in normal user sessions.

Hard reject output containing known startup failures:

- `ERR_MODULE_NOT_FOUND`
- `Rendered line .* exceeds terminal width`
- `Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout`
- raw Node stack traces
- raw shell prompts before altscreen capture

---

## 12. Component capture contract

The component lane should make TUI elements testable before the full runtime can reach every state.

Candidate component scenarios:

- Element 1 sidebar V2 editorial states
- Element 2 top bar states
- Element 4 active input empty/typed
- Element 5 footer states
- Element 9 compact tool ledger states
- Element 10 code block frame states
- Element 12 scroll/scribe states
- Element 13 chat box variants

The component lane should not mock private implementation internals. It should render through the same public/deep module interface the runtime uses.

If a component cannot be rendered without constructing half the runtime, that is a signal to extract a deeper renderer module.

---

## 13. CLI commands

Recommended commands:

```bash
pnpm visual:review
```

Runs all review scenarios and writes `docs/visual/out/parity/index.html`.

```bash
pnpm visual:review --scenario active-landscape
```

Runs one scenario.

```bash
pnpm visual:review --lane component
pnpm visual:review --lane runtime
```

Runs one lane.

```bash
pnpm visual:promote --scenario active-landscape --crop footer --status approved
```

Promotes the selected runtime crop to an approved golden.

```bash
pnpm visual:promote --scenario active-landscape --crop footer --status required
```

Promotes and marks it CI-blocking.

```bash
pnpm visual:ci
```

CI mode. Runs all scenarios, uploads artifacts, fails only for hard failures and `required` drift.

---

## 14. Review pack

Output root:

```txt
docs/visual/out/parity/
```

Required files:

```txt
index.html
results.json
summary.md
```

Per scenario:

```txt
<scenario-id>/
  target-full.png
  runtime-full.png
  bible-diff-full.png
  golden-diff-full.png                 # only if golden exists
  terminal.html
  terminal-snapshot.json
  raw-output.ansi
  crops/
    <crop>-target.png
    <crop>-runtime.png
    <crop>-bible-diff.png
    <crop>-golden.png                  # only if golden exists
    <crop>-golden-diff.png             # only if golden exists
```

`index.html` must show:

- scenario status
- crop status
- Bible target link
- runtime capture image
- diff image
- diff pixel count
- diff percentage
- threshold
- pass/review/fail label
- failure reason if any
- command/env summary with secrets redacted
- commit hash
- timestamp

---

## 15. CI plan

### 15.1 Initial CI

Add a workflow after V2 implementation exists:

```txt
visual-v2
  pnpm install --frozen-lockfile
  pnpm render:bible
  pnpm visual:ci
  upload docs/visual/out/parity
```

Initial CI behavior:

- fails on broken harness/capture/render
- uploads review pack
- does not fail on review-only visual drift

### 15.2 Later CI gating

As crops are approved:

1. promote crop to approved runtime golden
2. optionally mark crop required
3. CI begins failing for that crop on drift

The promotion should be a normal commit/PR so reviewers can see golden changes.

---

## 16. Tooling dependencies

Recommended initial dependencies:

- `@xterm/headless` — parse terminal bytes into a terminal model
- `sharp` — image crop/metadata/composition
- `pixelmatch` — diff pixels with masks and thresholds
- `pngjs` — pixelmatch IO
- `zod` or TypeBox — manifest/result schema validation

Already present:

- `node-pty`
- `playwright`

Optional later:

- `odiff-bin` — fast whole-image diff fast path
- `asciinema` compatible log export
- `tmux` debug attach mode
- `fast-check` fuzz/property checks

---

## 17. Implementation phases

### Phase 0 — Spec + PRD

- PRD issue created
- technical spec committed
- no harness code yet

### Phase 1 — Deterministic renderer foundation

Deliver:

- scenario manifest schema
- ANSI replay terminal
- DOM cell renderer
- one static fixture scenario
- review pack shell

Success:

- one known ANSI fixture renders to PNG deterministically
- review pack opens locally
- unit tests cover schema/replay/render output metadata

### Phase 2 — Bible target comparison

Deliver:

- consume `docs/ui/bible/renders/*.png`
- crop planner
- image comparator
- diff PNGs
- `results.json`

Success:

- component fixture compares against one Bible target
- missing target fails hard
- review-only diff does not fail CI

### Phase 3 — Component lane

Deliver:

- isolated captures for input frame, footer, sidebar
- first crop-level review pack

Success:

- Element 4 input typed crop can be reviewed against Bible
- Component output overflow fails before screenshots

### Phase 4 — Runtime lane

Deliver:

- `node-pty` runtime runner through `./bin/sumocode.sh`
- deterministic harness fixture mode
- active landscape + active portrait captures
- error-screen rejection

Success:

- runtime capture no longer accepts the known module-not-found error screen
- active landscape review pack generated from real runtime bytes

### Phase 5 — Promotion and CI

Deliver:

- `visual:promote`
- committed approved runtime golden directory
- CI artifact upload
- `required` gate behavior

Success:

- one input-frame crop is promoted to approved
- one required crop can intentionally fail/pass in tests

### Phase 6 — Expansion

Deliver:

- tool ledger states
- code block states
- modal/overlay states
- scroll/scribe states
- masks for dynamic regions
- optional tmux debug attach

---

## 18. Test strategy

### 18.1 Unit tests

Test deep modules independently:

- manifest validation
- crop planning
- mask application
- image comparison
- result status calculation
- HTML report generation
- promotion safety

### 18.2 Integration tests

Test end-to-end without launching live model calls:

- fixture ANSI bytes → xterm snapshot → DOM PNG → diff
- tiny `node-pty` process → capture → replay → render
- missing target hard failure
- error-screen hard failure
- review-only diff non-failing
- required diff failing

### 18.3 Visual tests

Visual tests should assert external artifacts:

- expected PNG files exist and are non-empty
- results JSON contains correct status
- review pack links every artifact
- no broken image links in generated `index.html`

Do not test private implementation details such as exact helper function calls.

---

## 19. Known pitfalls and mitigations

### 19.1 Error screens becoming goldens

Mitigation: known error-screen rejection and boot success assertions are hard failures.

### 19.2 Cursor blink noise

Mitigation: deterministic cursor mode or mask the cursor cell until cursor styling is under test.

### 19.3 Font mismatch

Mitigation: embedded fonts and Playwright rendering; no host font fallback for required glyphs.

### 19.4 Runtime dynamic text

Mitigation: fixture mode and masks for dynamic fields.

### 19.5 Color drift from terminal defaults

Mitigation: emit/expect explicit truecolor backgrounds; fail on default-bg holes in required crops.

### 19.6 Wide glyph drift

Mitigation: xterm-headless cell model plus DOM renderer tests for wide glyphs and box drawing.

### 19.7 Overbuilding before first use

Mitigation: first implementation should ship one excellent end-to-end path, then expand.

---

## 20. Definition of done for V2 foundation

V2 foundation is done when:

1. `pnpm render:bible` produces target PNGs.
2. `pnpm visual:review` produces `docs/visual/out/parity/index.html`.
3. At least one component scenario compares against a Bible target.
4. At least one runtime scenario captures through `node-pty` and real `./bin/sumocode.sh`.
5. Review pack contains full-screen and crop-level target/runtime/diff artifacts.
6. Review-only diffs do not fail CI.
7. Capture/render errors fail CI.
8. One crop can be promoted to an approved runtime golden.
9. One required crop can fail CI on intentional drift.
10. Docs explain how to run, review, approve, and promote.

---

## 21. Recommended first implementation slice

Build the smallest trustworthy vertical slice:

1. Add scenario manifest with `input-typed-component` and `active-landscape-runtime`.
2. Implement manifest validation.
3. Implement ANSI replay with `@xterm/headless`.
4. Implement DOM terminal renderer.
5. Implement crop planner for `input-frame` and `footer`.
6. Implement PNG crop/diff with `sharp` + `pixelmatch`.
7. Generate review pack.
8. Add `pnpm visual:review`.
9. Add CI artifact workflow in review-only mode.

Do not implement promotion until the review pack is trusted.

---

## 22. Open implementation choices

These are left for implementation discovery:

- whether the DOM terminal renderer should be pure generated HTML files or an embedded Playwright page app
- exact image diff threshold defaults
- whether crop manifests live in one JSON file or next to scenarios
- whether result schemas use Zod or TypeBox
- exact fixture hook shape in runtime code
- whether runtime fixture mode should live behind an env var, CLI flag, or both

These choices must not change the product contract: deterministic capture, crop-first review, explicit promotion, and review-only initial gating.
