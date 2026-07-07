# Plan 027: Align active-runtime Bible contract

> **Executor instructions:** Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report; do not improvise around it. In
> `$improve execute`, the reviewer maintains `plans/README.md`.
>
> **Execution base:** Start from
> `codex/plan024-real-runtime-ui-parity-exec` at `650b167`.
>
> **Drift check:** `git diff --stat 650b167..HEAD -- docs/visual/parity docs/ui/bible scripts src/visual-parity-contract.test.ts`
> If any in-scope file changed since `650b167`, read the changed code before
> editing and adapt only if the intent below still holds.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** 026
- **Category:** tests
- **Planned at:** `4503a4a`, 2026-07-03
- **Execution result:** DONE, 2026-07-03. Executor branch
  `codex/plan027-align-active-runtime-bible-contract-exec` landed
  `ac061fd` and follow-up `7d213e9`.
- **Reviewer verification:** `pnpm vitest run src/visual-parity-contract.test.ts`
  passed 1 file / 11 tests; `pnpm render:bible` rendered all 95 mockups;
  `pnpm visual:review -- --lane runtime` passed `splash-runtime`,
  `active-landscape-runtime`, and `active-portrait-runtime`; active runtime
  marker checks found the deterministic prompt and `inspecting src/auth/session.ts`
  with no API/RPC/model-warning pollution.
- **Normalized compare sanity:** `node scripts/visual-v2/compare-captures.mjs`
  against disposable `main` exited 1 for real visual diffs, as expected, but
  all three `contract-validation.txt` reports say `Scenario contract validation:
  MATCH` and both active roots have clean active evidence.
- **Autoreview:** `python3 /Users/sumo-deus/.codex/skills/autoreview/scripts/autoreview --mode branch --base 650b167`
  exited 0 with no accepted/actionable findings.

## Why this matters

Plan 026 fixed the hard blocker: active runtime captures now reach a real
deterministic active-working screen on both the RPC candidate and disposable
`main`. Plan 024 then stopped one step later because `active-landscape-runtime`
is compared against the wrong Bible target.

The current runtime scene is:

- submitted user prompt: `review src/auth/session.ts and tighten the return type`
- live SUMO response line: `inspecting src/auth/session.ts`
- no completed tool transcript
- deterministic harness footer: `READY · gpt-5.5 · medium`

The current Bible target `docs/ui/bible/scene-active.html` is a richer
completed/tool scene:

- user prompt: `hello, refactor the auth flow to use the new session pattern.`
- SUMO line: `Reading the auth flow.`
- completed `read` and `edit` tool rows
- second user prompt `run tests`
- completed bash/test result

That richer scene is still useful visual canon, but it is not the right target
for the runtime active-working scenario. Plan 024 must fail on real UI drift,
not on a semantic mismatch between a live active capture and a completed mockup.

## Current evidence

Curie's Plan 024 gate rerun from `650b167` stopped at Step 1a:

```text
pnpm visual:review -- --lane runtime
splash-runtime                   passed
active-landscape-runtime         FAIL
active-portrait-runtime          passed
```

The failing crop is:

```text
active-landscape-runtime chat-area
result=failed
diffRows=29
diffRatio=0.020673059629799824
threshold=0.02
dimensionMismatch=true
```

Evidence paths in the executor worktree:

- `docs/visual/out/parity/results.json`
- `docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff-chat-area.txt`
- `docs/visual/out/parity/active-landscape-runtime/raw/geometry-audit.txt`
- `docs/visual/out/parity/active-landscape-runtime/crops/chat-area-bible-diff.png`
- `docs/visual/out/parity/active-landscape-runtime/runtime-full.png`
- `docs/visual/out/parity/index.html`

Important details:

- `active-landscape-runtime` geometry audit passed: 45 rows, no mismatches.
- Runtime metadata exists and contains `scenarioContract`.
- `Warning: No models match pattern` is absent from all runtime outputs.
- Banned active markers are absent: `No API key found`, `rpc error: prompt failed`,
  `DIVINE INVOCATION`, `unknown · off`, and raw `^[[13u`.
- The active runtime snapshots contain `SUMOCODE`, the submitted prompt, and
  `inspecting src/auth/session.ts`.
- A no-change post-execution autoreview exited 0 and correctly reported no patch
  to review.

Current target source:

- `scripts/gen-bible-scene-active.mjs` generates `scene-active.html` and
  `scene-active-portrait.html`.
- `buildChatHTML()` currently hardcodes the completed/tool conversation used by
  `scene-active.html`.
- `docs/visual/parity/scenarios.json` points:
  - `active-landscape-runtime.bibleTarget` to `scene-active.png`
  - `active-portrait-runtime.bibleTarget` to `scene-active-portrait.png`
- `scripts/render-bible.mjs` regenerates all Bible HTML before rendering PNGs,
  including files produced by `scripts/gen-bible-scene-active.mjs`.

First Plan 027 executor attempt added runtime-specific targets, but stopped
before commit because `active-landscape-runtime/input-frame` still failed:

```text
active-landscape-runtime input-frame
result=failed
diffRatio=0.05289564220183486
threshold=0.03
dimensionMismatch=false
```

Reviewer diagnosis:

- The new `scene-active-runtime.html` content was semantically correct.
- The runtime capture put the input at canonical rows 38-40, and
  `geometry-audit.txt` passed with no mismatches.
- The target PNG crop visually contained the same input frame, but
  `scene-active-runtime.png` rendered at `2496x1640` while
  `runtime-full.png` rendered at `2496x1638`. The extra 2 pixels come from the
  Bible page's centered stage producing a fractional screenshot origin; the
  crop then starts on a different scanline and samples the wrong top strip.
- `parseBibleStyledGrid()` in `scripts/visual-v2/styled-cell-grid.mjs` flattens
  `<pre class="grid">` blocks in DOM order. It ignores CSS `grid-row` placement
  and the fixed `.middle` row height, so styled-cell crop diffs report blank
  target rows 38-40 even when the rendered PNG target shows the input frame.

This plan must fix both harness-side issues. Do not change production runtime
UI to satisfy this plan.

## Scope

**In scope:**

- `scripts/gen-bible-scene-active.mjs`
- generated `docs/ui/bible/*.html` for new active-runtime scene targets
- generated `docs/ui/bible/renders/*.png` only as local verification output;
  do not commit PNG render output unless this repo already tracks the exact
  changed files and the diff is intentional
- `docs/visual/parity/scenarios.json`
- `docs/visual/parity/CONTRACT.md`
- `docs/visual/parity/ACTIVE_LANDSCAPE_REVIEW.md`
- `docs/visual/parity/BASELINE_REVIEW.md`
- `docs/ui/bible/README.md`
- `src/visual-parity-contract.test.ts`
- `scripts/visual-v2/styled-cell-grid.mjs`
- `scripts/visual-v2/review-pack.mjs` only if its scenario description needs
  the new target names

**Out of scope:**

- Production UI/runtime behavior.
- Relaxing required crop thresholds to hide the mismatch.
- Golden promotion.
- Completed-state fixture injection in runtime scenarios.
- Replacing the richer completed/tool `scene-active.html` target if it is still
  used by fixture/component/review scenes. Prefer adding explicit runtime
  active-working targets instead.
- Declaring final UI parity. Plan 024 remains the approval gate.
- `plans/` edits.

## Steps

### Step 1: Add explicit active-runtime Bible targets

Extend `scripts/gen-bible-scene-active.mjs` so it can generate active-working
runtime scene targets alongside the existing richer completed/tool scenes.

Prefer adding two new files:

- `docs/ui/bible/scene-active-runtime.html`
- `docs/ui/bible/scene-active-runtime-portrait.html`

The new scenes must match the Plan 026 deterministic runtime semantics:

- top bar/sidebar/input/hint/footer composition remains the same house style as
  `scene-active.html`;
- chat contains the submitted USER frame with
  `review src/auth/session.ts and tighten the return type`;
- chat contains a SUMO frame with `inspecting src/auth/session.ts`;
- chat does not include completed tool rows, a second user prompt, or completed
  bash/test output;
- footer should match the deterministic harness footer expected by runtime:
  `READY · gpt-5.5 · medium` plus `42k/200k · $0.42`;
- portrait variant remains no-sidebar and keeps project/branch in the hint row.

For runtime target pages only, make the `[data-render-rect]` screenshot origin
deterministic:

- pin the runtime target stage to the top-left of the page;
- hide or remove the out-of-canvas stage label/blurb for runtime targets, or
  otherwise ensure they cannot affect the screenshot origin;
- after `pnpm render:bible`, `docs/ui/bible/renders/scene-active-runtime.png`
  must have the same pixel dimensions as the runtime renderer output for
  `active-landscape-runtime` (`2496x1638` at current font/device scale);
- do not apply this by changing production terminal rendering.

Do not modify production renderers to match the Bible. This plan aligns test
targets with the already-verified runtime state.

### Step 2: Make the styled-cell target parser honor scene placement

Update `scripts/visual-v2/styled-cell-grid.mjs` so Bible scene parsing matches
the rendered terminal grid instead of flattening DOM order.

The parser must place generated scene rows into their terminal coordinates:

- `grid-row: 1` -> terminal row 0;
- `grid-row: 2` -> terminal row 1;
- `grid-row: 3` -> terminal row 2;
- `.middle` starts at terminal row 3 and occupies `rows - 11` rows;
- `grid-row: 5` starts after `.middle`;
- `grid-row: 6` is the 3-row input frame;
- `grid-row: 7`, `8`, `9`, and `10` map to hint, blank, footer, and final
  blank respectively;
- landscape sidebar rows are written at the sidebar column, not into the chat
  column;
- portrait runtime targets remain no-sidebar.

Prefer a reusable scene parser over another one-off special case. It is fine to
keep the existing `scene-palette-overlay` special handling if generalizing it
would be risky.

Add a regression test that fails if
`parseBibleStyledGrid("docs/ui/bible/scene-active-runtime.html")` has blanks in
the `input-frame` crop rows. The expected row text should include the top
border on row 38, `│ >` plus the cursor cell on row 39, and the bottom border on
row 40.

### Step 3: Point runtime scenarios at the new targets

Update `docs/visual/parity/scenarios.json` so:

- `active-landscape-runtime.bibleTarget` uses `scene-active-runtime.png`;
- `active-portrait-runtime.bibleTarget` uses
  `scene-active-runtime-portrait.png`;
- required crops remain required;
- `active-landscape-runtime` keeps a required `chat-area` crop at the existing
  threshold unless the new target still has a real rendering-size mismatch after
  matching content;
- `active-landscape-runtime/input-frame` keeps a required crop; do not relax its
  threshold unless the target/runtime PNG dimensions match, styled-cell crop
  rows are correct, and the remaining diff is proven to be font antialiasing
  noise rather than layout/color drift;
- runtime inputs/rejections from Plan 026 stay intact.

Update `src/visual-parity-contract.test.ts` so it fails if active runtime
scenarios regress back to the completed/tool `scene-active` targets. Keep the
existing checks that reject raw CSI-u Enter, `SUMOCODE_VISUAL_RPC_FIXTURE`,
bad active markers, and missing active prompt evidence.

### Step 4: Refresh docs that name the active runtime contract

Update the relevant docs so future reviewers understand why there are separate
targets:

- `docs/visual/parity/CONTRACT.md`
- `docs/visual/parity/ACTIVE_LANDSCAPE_REVIEW.md`
- `docs/visual/parity/BASELINE_REVIEW.md`
- `docs/ui/bible/README.md`

The docs should say that:

- runtime active-working targets are live-submitted prompt scenes;
- richer completed/tool transcript targets remain fixture/review canon;
- runtime lanes still must not inject completed assistant/tool transcripts.

### Step 5: Verify candidate runtime review

Run:

```bash
pnpm vitest run src/visual-parity-contract.test.ts
pnpm render:bible
pnpm visual:review -- --lane runtime
```

Expected:

- the contract test exits 0;
- render exits 0;
- runtime review exits 0, or STOP if it still fails a required crop;
- `docs/visual/out/parity/active-landscape-runtime/artifacts.targetFull` and
  `runtime-full.png` have matching pixel dimensions;
- `docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff-input-frame.txt`
  no longer reports blank target rows for the input frame.

If runtime review still fails, do not relax thresholds blindly. Inspect:

```bash
cat docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff-chat-area.txt
cat docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff-input-frame.txt
cat docs/visual/out/parity/active-landscape-runtime/raw/geometry-audit.txt
```

STOP if the failure indicates production UI drift or a dimension mismatch that
cannot be explained by the target contract. Report the exact crop, diff ratio,
threshold, and artifact paths.

### Step 6: Sanity-check the normalized Plan 024 compare

After Step 5 passes, run the same disposable-main overlay compare used by Plan
026. This is not the final approval decision; it is a sanity check that the
new target contract still works on both sides.

```bash
rm -rf /tmp/sumocode-plan024-candidate-parity
cp -R docs/visual/out/parity /tmp/sumocode-plan024-candidate-parity

rm -rf /tmp/sumocode-plan024-main-contract
git worktree add --detach /tmp/sumocode-plan024-main-contract main
cd /tmp/sumocode-plan024-main-contract
pnpm install --frozen-lockfile
rsync -a --delete /Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode/scripts/visual-v2/ scripts/visual-v2/
cp /Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode/docs/visual/parity/scenarios.json docs/visual/parity/scenarios.json
cp /Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode/docs/visual/parity/CONTRACT.md docs/visual/parity/CONTRACT.md
pnpm render:bible
pnpm visual:review -- --lane runtime
rm -rf /tmp/sumocode-plan024-main-parity
cp -R docs/visual/out/parity /tmp/sumocode-plan024-main-parity

cd /Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode
pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc
```

If `visual:compare` exits 1, inspect the output. For this plan, an exit 1 is
acceptable only if:

- all three scenarios report `Scenario contract validation: MATCH`;
- active runtime snapshots in both roots contain the submitted prompt and
  `inspecting src/auth/session.ts`;
- banned splash/error markers are absent in both roots.

Do not fix production UI drift in this plan. Report remaining compare failures
so Plan 024 can make the final approval call.

### Step 7: Commit and report

Commit only the in-scope target/manifest/doc/test changes. Do not commit
ignored review-pack output or generated PNGs unless the repo already tracks
those exact render files and the change is intentional.

Report:

- final branch and commit;
- exact commands run and exit codes;
- whether `pnpm visual:review -- --lane runtime` now exits 0;
- normalized compare result and whether every contract validation matched;
- evidence paths;
- whether Plan 024 can now be rerun.

## Done criteria

- [ ] Active runtime scenarios use explicit active-runtime Bible targets, not
  completed/tool `scene-active` targets.
- [ ] `pnpm vitest run src/visual-parity-contract.test.ts` exits 0.
- [ ] `pnpm render:bible` exits 0.
- [ ] `pnpm visual:review -- --lane runtime` exits 0.
- [ ] Active runtime snapshots still reject warning/error/splash markers and
  contain submitted prompt plus faux-provider active text.
- [ ] Normalized compare artifacts show true scenario contract matches; compare
  may still fail for real main-vs-RPC UI drift, but not because of target
  contract mismatch.
- [ ] No production UI behavior, goldens, secrets, or completed-state runtime
  fixtures are changed.

## STOP conditions

- Passing the runtime review requires relaxing required thresholds instead of
  aligning the target contract.
- The only way to create the target is to inject completed assistant/tool
  transcript state into a runtime-labelled scenario.
- The runtime snapshot changed back into splash/error/unknown state.
- A production UI change appears necessary. Stop and report; that belongs in a
  separate product implementation plan, not this target-contract plan.

## Maintenance notes

Keep completed/tool scenes and active-working runtime scenes separate. The
completed/tool scenes are useful fixture/review canon; runtime active-working
scenes are proof that the real launcher, input path, provider registration, and
retained shell can reach a deterministic live state without user secrets.
