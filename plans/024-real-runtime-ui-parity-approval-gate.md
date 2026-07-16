# Plan 024: Verify real runtime UI parity before approval

> **Executor instructions:** This is the final acceptance gate after ALL Track
> D implementation plans — 018-023 and 025-027. Do not run it while any of them is
> TODO/IN PROGRESS (check the status table in `plans/README.md` first).
> Start from the latest reviewed `codex/plan024-real-runtime-ui-parity-exec`
> commit after Plan 027 completes. Do not rerun this gate from `650b167`
> directly; Curie's rerun showed the runtime Bible target contract must be
> aligned first.
> In `$improve execute`, the worker worktree may not contain the advisor's
> uncommitted plan-index updates. If the reviewer prompt explicitly lists
> 018-023 and 025 as DONE with their commits, treat that as the dependency
> preflight source of truth instead of the stale `plans/README.md` in the
> execution worktree.
> Produce evidence, do not promote goldens, and do not claim parity without
> human review. If a real runtime parity check fails because the product still
> differs from current `main`, STOP and report the exact evidence instead of
> relaxing thresholds or redesigning UI in this plan.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** 018, 019, 020, 021, 022, 023, 025, 026, 027
- **Category:** verification
- **Planned at:** `a3966a7`, 2026-07-02
- **Reconciled at:** `93e1449`, after Plan 025 completed on 2026-07-03.
- **Execution base:** the latest reviewed
  `codex/plan024-real-runtime-ui-parity-exec` commit after Plan 027 completes.
- **Previous execution result:** BLOCKED, 2026-07-03. Executor branch
  `codex/plan024-real-runtime-ui-parity-exec` reached reviewed commit
  `69b707d` with test-only behavioral evidence, but the main-vs-candidate
  runtime parity comparison failed all runtime scenarios and no golden
  promotion was performed.
- **Retry result:** BLOCKED, 2026-07-03. Executor branch
  `codex/plan024-real-runtime-ui-parity-exec` reached reviewed commit
  `f8eeec8`. Runtime captures now use a temporary `PI_CODING_AGENT_DIR`,
  reject model-warning pollution, emit real `scenarioContract` metadata, and
  passed clean autoreview. The normalized comparison still cannot be used for
  approval because the active runtime scenarios no longer reach the intended
  deterministic active-working state under isolation: `main` remains on the
  splash/unknown prompt and RPC shows `rpc error: prompt failed: No API key
  found for the selected model.` See Plan 026.
- **Reachability unblock:** DONE, 2026-07-03. Plan 026 executed on the same
  branch in `b2193f0` and `650b167`; active runtime captures now reach
  deterministic active-working state on both candidate and disposable `main`,
  and normalized comparison reports true contract matches. The current
  `visual:compare` still exits 1, now for real UI diffs rather than
  splash/error captures. Rerun this plan as the approval gate and STOP with
  those diffs unless parity has been fixed elsewhere.
- **Gate rerun result:** BLOCKED, 2026-07-03. Curie reran this approval gate
  from `650b167` and made no code changes. Step 1a stopped because
  `pnpm visual:review -- --lane runtime` exited 1:
  `splash-runtime` passed, `active-portrait-runtime` passed, but
  `active-landscape-runtime` failed the required `chat-area` crop
  (`diffRows=29`, `diffRatio=0.020673059629799824`, threshold `0.02`,
  `dimensionMismatch=true`). Geometry passed and runtime warning/contract
  metadata were clean. The failure is a target-contract mismatch:
  deterministic active-working runtime captures are still compared against the
  richer completed/tool `scene-active` Bible target. Execute Plan 027, then
  rerun this approval gate.
- **Target-contract unblock:** DONE, 2026-07-03. Plan 027 executed in
  `codex/plan027-align-active-runtime-bible-contract-exec` (`ac061fd`,
  `7d213e9`). Reviewer verification passed
  `pnpm vitest run src/visual-parity-contract.test.ts`,
  `pnpm render:bible`, and `pnpm visual:review -- --lane runtime`.
  The normalized main-vs-candidate compare still exits 1 for visible UI diffs,
  but all three scenario contract validations report `MATCH` and both active
  roots contain the deterministic prompt plus `inspecting src/auth/session.ts`
  with no API/RPC/model-warning pollution. Rerun this plan from `7d213e9` as
  the approval gate.
- **Final approval rerun:** BLOCKED, 2026-07-03. Epicurus reran this gate from
  clean branch `codex/plan024-real-runtime-ui-parity-rerun-20260703-092057`
  at `7d213e9`. Step 1 and Step 1b passed, including
  `pnpm visual:review -- --lane runtime` and the focused PTY suite:
  `pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-scroll.test.ts test/integration/rpc-session-switch.test.ts test/integration/rpc-splash-centering.test.ts`
  (4 files / 6 tests). Step 2 produced normalized candidate and disposable
  `main` capture roots, then stopped because the approval compare failed:
  `pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc`
  exited 1. Reviewer reran the compare with output
  `docs/visual/out/parity-main-rpc-reviewer/`; all three
  `contract-validation.txt` files say `Scenario contract validation: MATCH`,
  and both active roots contain the submitted prompt plus
  `inspecting src/auth/session.ts` with no `No API key found`,
  `rpc error: prompt failed`, `Warning: No models match pattern`,
  `DIVINE INVOCATION`, `unknown · off`, or raw `^[[13u` pollution.
  Autoreview was run in local mode on the no-diff rerun branch and exited 0
  with no accepted/actionable findings.

  Evidence:
  - Candidate root: `/tmp/sumocode-plan024-candidate-parity`
  - Baseline root: `/tmp/sumocode-plan024-main-parity`
  - Executor compare summary:
    `docs/visual/out/parity-main-rpc/summary.md`
  - Reviewer compare summary:
    `docs/visual/out/parity-main-rpc-reviewer/summary.md`
  - Reviewer compare results:
    `docs/visual/out/parity-main-rpc-reviewer/results.json`

  Exact reviewer compare summary:
  - `splash-runtime`: failed, 45 styled-cell diff rows, 1/1 failed crop.
  - `active-landscape-runtime`: failed, 45 styled-cell diff rows, 7/7 failed
    crops (`top-bar`, `sidebar`, `chat-area`, `input-frame`, `hint-row`,
    `footer`, plus full review crop).
  - `active-portrait-runtime`: failed, 100 styled-cell diff rows, 6/6 failed
    crops (`top-bar`, `chat-area`, `input-frame`, `hint-row`, `footer`, plus
    full review crop).

  The remaining failures are real product-surface drift, not a harness or
  target-contract blocker. Examples from the artifacts: active-landscape `main`
  has top chrome on row 0 while the RPC candidate has it on row 1; chat frames
  differ (`╔/║/╚/═` versus `╭/│/╰/─`); sidebar rows, markers, token/cost values,
  and colors differ; active input frame colors differ; footer state/model/cost
  text differs; splash differs in status/version rows. Per this plan's scope,
  no production UI changes or golden promotion were made.

## Why this matters

The previous parity track passed tests while users could see broken splash,
footer, sidebar, keybinding, cursor, and input behavior. Final acceptance needs
real runtime evidence and a clear human approval checkpoint.

## Scope

**In scope:**

- visual runtime scenarios,
- fixture scenarios only as deterministic supplements,
- PTY integration tests,
- screenshot/video evidence under ignored output paths,
- docs describing approval criteria,
- if needed, narrow updates to `docs/visual/parity/scenarios.json`,
  `docs/visual/parity/CONTRACT.md`, or `scripts/visual-v2/*` to make the
  existing runtime evidence stricter/more explicit.

**Out of scope:**

- Promoting runtime goldens.
- Redesigning the UI.
- Shipping or pushing without Dhruv approval.
- Changing production UI behavior to make a parity check pass. This plan may
  add tests/harness/reporting only; if the product differs, STOP with evidence.
- Touching `plans/`; the reviewer updates plan status after approval.

## Steps

### Step 1: Split fixture and runtime lanes

Ensure deterministic completed states use the fixture lane. Runtime scenarios
should not use `SUMOCODE_VISUAL_RPC_FIXTURE` unless the scenario name clearly
says it is a host fixture.

Runtime scenarios must boot `./bin/sumocode.sh` and exercise:

- splash empty state,
- active landscape with sidebar,
- active portrait without sidebar,
- submitted prompt reaching working/meditating state,
- command palette via Ctrl+/,
- notification or widget region if possible.

Before changing the manifest, inspect `docs/visual/parity/scenarios.json` and
`docs/visual/parity/CONTRACT.md`. The current runtime scenarios should already
use `./bin/sumocode.sh --offline --no-extensions --no-session`; preserve that
contract. If any runtime-labeled scenario uses `SUMOCODE_VISUAL_RPC_FIXTURE`,
move it to a fixture lane or rename it so the fixture source is explicit.

### Step 1a: Make runtime captures deterministic and warning-clean

The previous Plan 024 execution produced a warning-polluted `main` splash
baseline:

```text
Warning: No models match pattern "cursor/composer-2.5"
Warning: No models match pattern "openai-codex/gpt-5.3-codex"
```

That capture cannot be used as approval evidence. Update the runtime visual
harness narrowly so every runtime capture is isolated from user-specific Pi
state:

- Use a temporary `PI_CODING_AGENT_DIR` for runtime captures unless the
  scenario explicitly provides `PI_CODING_AGENT_DIR` in `runtime.env`.
- Keep `--offline --no-extensions --no-session`; do not add fixture state to
  runtime scenarios.
- Add model-warning pollution to the runtime rejection patterns, e.g.
  `Warning: No models match pattern`, so a polluted frame fails instead of
  silently comparing.
- Ensure `capture-metadata.json` still contains `scenarioContract` for every
  runtime scenario.

Verification for this step:

```bash
pnpm visual:review -- --lane runtime
for scenario in splash-runtime active-landscape-runtime active-portrait-runtime; do
  test -f "docs/visual/out/parity/$scenario/raw/capture-metadata.json"
  grep -q '"scenarioContract"' "docs/visual/out/parity/$scenario/raw/capture-metadata.json"
  ! grep -q "Warning: No models match pattern" "docs/visual/out/parity/$scenario/raw/runtime-output.ansi"
done
```

If isolating `PI_CODING_AGENT_DIR` breaks startup, STOP and report the exact
runtime output. Do not remove the warning rejection to make the run green.

### Step 1b: Behavioral evidence (not just visual)

The migration deleted integration tests whose behaviors are exactly the
reported UX breaks. Acceptance requires PTY integration tests (spawned via
`spawnSumocodePty`, model after `test/integration/rpc-host-shell.test.ts`)
proving on the RPC host:

- `rpc-ctrl-c` — first Ctrl-C clears a typed draft, process stays alive;
  Ctrl-C during streaming aborts the response, session survives; double
  Ctrl-C on idle exits with `TERMINAL_CLEANUP_SEQUENCE`. Plan 025 already
  added draft-clear and double-press coverage in `test/integration/rpc-ctrl-c.test.ts`;
  extend it for streaming abort with a test-only RPC child. Do **not** rely on
  the real offline Pi child holding an LLM stream open: in the first Plan 024
  attempt it immediately failed with `No API key found for the selected model`,
  so Ctrl-C observed idle state and armed quit instead of aborting. Instead,
  create a temporary executable `PI_BIN` fixture inside the test that speaks
  enough JSONL RPC for `runRpcHost` startup (`get_state`, `get_commands`,
  `get_messages`, `get_session_stats`) and, on `prompt`, emits an
  `agent_start` event and intentionally holds the prompt response pending until
  it receives `{ type: "abort" }`. On abort, respond to the abort request,
  emit `agent_end`, and resolve the pending prompt response. This still boots
  the real `bin/sumocode.sh` / RPC host path via `spawnSumocodePty`; only the
  Pi child is a deterministic fixture.
- `rpc-mouse-scroll` — SGR wheel sequences scroll the transcript and never
  leak into the editor draft. Existing `test/integration/mouse-scroll.test.ts`
  covers the classic `spawnPiPty` path; add an RPC-host equivalent using
  `spawnSumocodePty`.
- `rpc-session-switch` — `/new` does not leave altscreen; chrome updates,
- `rpc-splash-centering` — splash vertically centered at 100×30 (port the
  row-math assertions from the deleted test:
  `git show c744cd2:test/integration/splash-centering.test.ts`).

### Step 2: Run canonical comparison

Use Plan 018's main-vs-branch comparison against the current branch, but do not
repeat the previous mixed-contract comparison. Both roots must be produced with
the same `docs/visual/parity/scenarios.json` and `scripts/visual-v2/*` contract
from this Plan 024 candidate branch.

Use concrete capture roots so the reviewer can inspect evidence:

```bash
# In the Plan 024 candidate worktree:
pnpm render:bible
pnpm visual:review -- --lane runtime
rm -rf /tmp/sumocode-plan024-candidate-parity
cp -R docs/visual/out/parity /tmp/sumocode-plan024-candidate-parity

# In a clean disposable main worktree, after installing deps if needed:
# Replace <candidate> with the absolute Plan 024 candidate worktree path.
rm -rf /tmp/sumocode-plan024-main-contract
git worktree add --detach /tmp/sumocode-plan024-main-contract main
cd /tmp/sumocode-plan024-main-contract
pnpm install --frozen-lockfile
rsync -a --delete <candidate>/scripts/visual-v2/ scripts/visual-v2/
cp <candidate>/docs/visual/parity/scenarios.json docs/visual/parity/scenarios.json
cp <candidate>/docs/visual/parity/CONTRACT.md docs/visual/parity/CONTRACT.md
pnpm render:bible
pnpm visual:review -- --lane runtime
rm -rf /tmp/sumocode-plan024-main-parity
cp -R docs/visual/out/parity /tmp/sumocode-plan024-main-parity

# Back in the Plan 024 candidate worktree:
pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc
```

If no clean `main` worktree exists, create or reuse one outside the user’s main
checkout. Mutating `/tmp/sumocode-plan024-main-contract` is allowed because it is
a disposable comparison worktree. Do not mutate the user's dirty checkout. Do
not commit generated Bible renders or review-pack artifacts unless the
manifest/docs/scripts were intentionally changed.

Before accepting the comparison output, verify all three scenarios report a
true contract match, not the legacy metadata bridge:

```bash
for scenario in splash-runtime active-landscape-runtime active-portrait-runtime; do
  grep -q "Scenario contract validation: MATCH" "docs/visual/out/parity-main-rpc/$scenario/raw/contract-validation.txt"
  ! grep -q "legacy capture metadata accepted" "docs/visual/out/parity-main-rpc/$scenario/raw/contract-validation.txt"
done
```

If `visual:compare` fails after this normalized capture, STOP and report the
exact scenario/crop/styled-cell summary. Do not change production UI behavior in
this plan to make the comparison pass.

Required evidence:

- styled-cell diff,
- geometry audit,
- PNG crop diff,
- full screenshots,
- review pack index,
- optional short MP4 clip of a test prompt.

### Step 3: Run full verification

Run:

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm visual:ci
```

`pnpm test` currently may exit 1 after all assertions pass because of the known
unrelated background-task `output.log` ENOENT. If that is the only failure,
record it as the known caveat and continue. If any assertion fails or any other
suite fails, record exact failing test names and stop.

### Step 4: Produce approval report

Write a short report in the executor final answer with:

- branch and commit,
- commands run,
- evidence paths,
- known deviations,
- whether golden promotion was performed (`no` unless Dhruv explicitly approved),
- whether the UI is ready for Dhruv's approval.

## Execution notes (2026-07-03)

Executor branch:

- Worktree:
  `/Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode`
- Branch: `codex/plan024-real-runtime-ui-parity-exec`
- Final commit: `69b707d`

Accepted work:

- Added a deterministic test-only `PI_BIN` RPC child fixture.
- Added/extended RPC PTY integration tests for:
  - Ctrl-C draft clear, double-press idle quit, and streaming abort followed by
    a second successful prompt.
  - SGR mouse wheel transcript scrolling with concrete visible-anchor movement
    and no editor byte leakage.
  - `/new` preserving altscreen/mouse routing while updating session chrome.
  - 100x30 splash geometry using independent row anchors for the cat glyph,
    wordmark, invocation/input, hint, and version rows.
- Focused verification passed:

```bash
pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-scroll.test.ts test/integration/rpc-session-switch.test.ts test/integration/rpc-splash-centering.test.ts
```

- Final autoreview passed with no accepted/actionable findings:

```bash
python3 /Users/sumo-deus/.codex/skills/autoreview/scripts/autoreview --mode branch --base codex/plan025-rpc-hardening-interrupt-exec --engine codex --prompt "Final review for revised Plan 024 stopped execution on SumoCode. Scope is test-only additions for RPC runtime parity evidence. Production UI/harness/golden changes are out of scope; the branch intentionally still has failed main-vs-candidate visual parity evidence, so do not request production UI fixes. Verify that the tests now meaningfully cover streaming abort recovery, mouse scroll transcript movement, /new altscreen/chrome, and independent splash centering, and that the branch stays in scope."
```

Blocked gate:

- `pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc`
  exited 1.
- Evidence:
  - `/tmp/sumocode-plan024-main-parity`
  - `/tmp/sumocode-plan024-candidate-parity`
  - `/Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode/docs/visual/out/parity-main-rpc/summary.md`
  - `/Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode/docs/visual/out/parity-main-rpc/results.json`
- Summary:
  - `splash-runtime`: failed, 26 styled-cell diff rows, 1 failed crop.
  - `active-landscape-runtime`: failed, 45 styled-cell diff rows, 7 failed
    crops.
  - `active-portrait-runtime`: failed, 100 styled-cell diff rows, 6 failed
    crops.

Reviewer caveat:

- The failed comparison is a valid stop signal because user-visible runtime
  regions still differ and approval cannot be claimed. It is not yet a clean
  one-variable parity proof: the clean `main` baseline uses older scenario
  inputs/contract metadata while the candidate branch uses stricter Track D
  runtime scenario definitions. The baseline splash capture was also polluted
  by model-warning rows. Before retrying approval, normalize the comparison so
  both baseline and candidate use the same runtime scenario contract and reject
  warning-polluted captures. After that, if required regions still differ,
  production UI fixes must happen in a separate implementation plan, not in
  this approval-gate plan.

Retry instructions:

- Continue from `codex/plan024-real-runtime-ui-parity-exec` at `69b707d`; keep
  the reviewed behavioral PTY tests intact.
- First implement Step 1a and rerun Step 2 with the disposable main worktree
  contract overlay.
- If normalized `visual:compare` passes, continue through Step 3 and Step 4.
- If normalized `visual:compare` fails, STOP with evidence. The reviewer will
  use that evidence to write the next implementation plan for remaining UI
  drift.

Retry result:

- Commit `f8eeec8` completed Step 1a and normalized contract comparison:
  - `scripts/visual-v2/runtime-capture.mjs` injects temporary
    `PI_CODING_AGENT_DIR` unless a scenario explicitly provides one, records
    `piCodingAgentDirSource`, and cleans the temp directory in a `finally`
    path.
  - Runtime scenarios reject `Warning: No models match pattern`.
  - `docs/visual/parity/CONTRACT.md` documents both rules.
  - Autoreview against `69b707d` passed with no accepted/actionable findings.
- Reviewer reran:

```bash
pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc
```

It still exited 1 with real contract matches and no warning pollution:

```text
splash-runtime: failed, 45 styled-cell diff rows, 1 failed crop
active-landscape-runtime: failed, 45 styled-cell diff rows, 7 failed crops
active-portrait-runtime: failed, 100 styled-cell diff rows, 6 failed crops
```

However, the active scenario captures are not valid active-working evidence:

- In `/tmp/sumocode-plan024-main-parity`, active scenarios remain on the splash
  prompt with `unknown · off`.
- In `/tmp/sumocode-plan024-candidate-parity`, active scenarios show
  `rpc error: prompt failed: No API key found for the selected model.`
- Probes showed candidate CSI-u Enter submits, but `main` echoes CSI-u; carriage
  return is branch-portable as raw input but still does not produce a valid
  active-working state under the temporary Pi config.

Do not treat this as final UI parity evidence. Execute Plan 026 first, then
rerun this approval gate from the repaired active-runtime harness.

Post-026 gate rerun:

- Curie reran from `650b167` and stopped before behavioral/full verification
  because the runtime lane did not pass its own Bible review.
- Command:

```bash
pnpm visual:review -- --lane runtime
```

- Result:

```text
splash-runtime                   passed
active-landscape-runtime         FAIL
active-portrait-runtime          passed
```

- Failing evidence:
  - `docs/visual/out/parity/results.json`
  - `docs/visual/out/parity/active-landscape-runtime/raw/styled-cell-diff-chat-area.txt`
  - `docs/visual/out/parity/active-landscape-runtime/raw/geometry-audit.txt`
  - `docs/visual/out/parity/active-landscape-runtime/crops/chat-area-bible-diff.png`
  - `docs/visual/out/parity/active-landscape-runtime/runtime-full.png`
  - `docs/visual/out/parity/index.html`
- Reviewer verified:
  - geometry passed;
  - runtime metadata contains `scenarioContract`;
  - model-warning pollution is absent;
  - the worktree remained clean at `650b167`;
  - post-execution autoreview in local mode exited 0 and reported there was no
    patch to review.

Do not treat this as final UI parity evidence either. Execute Plan 027 first
to align the active-runtime Bible target contract, then rerun this approval
gate.

## Done criteria

- [x] Real runtime scenarios do not depend on synthetic completed RPC fixture
  state.
- [ ] Main-vs-RPC comparison passes for required shell regions.
- [ ] Full verification commands pass, except the known `pnpm test`
  background-task ENOENT caveat if it is still the only failure.
- [x] The four behavioral PTY tests from Step 1b exist and pass
  (`pnpm test:integration`).
- [x] Evidence paths are available for Dhruv to review.
- [x] No golden promotion occurred without explicit approval.

## STOP conditions

- Required parity can only be achieved by relaxing thresholds.
- A real runtime scenario is flaky after two attempts.
- A user-visible region still differs from current main without documented
  approval.
- Streaming abort cannot be proven with the test-only `PI_BIN` fixture
  described in Step 1b.
