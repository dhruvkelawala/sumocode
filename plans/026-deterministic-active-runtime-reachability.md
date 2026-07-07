# Plan 026: Repair deterministic active runtime reachability

> **Executor instructions:** Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If any STOP condition occurs, stop and report; do not improvise
> around it. In `$improve execute`, the reviewer maintains `plans/README.md`.
>
> **Drift check:** `git diff --stat f8eeec8..HEAD -- docs/visual/parity scripts/visual-v2 src/visual-parity-contract.test.ts`
> If any in-scope file changed since `f8eeec8`, read the changed code before
> editing and adapt only if the intent below still holds.

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** 024 retry commit `f8eeec8`
- **Category:** tests
- **Planned at:** `4503a4a`, 2026-07-03
- **Execution result:** DONE, 2026-07-03. Executor branch
  `codex/plan024-real-runtime-ui-parity-exec` reached `b2193f0`, then
  autoreview found missing `SUMOCODE_HARNESS` determinism and the executor
  fixed it in `650b167`. Reviewer verified focused contract tests, candidate
  and disposable `main` active-runtime reachability, normalized contract-match
  comparison output, and clean autoreview for the full `f8eeec8..650b167`
  diff.

## Why this matters

Plan 024 now rejects warning-polluted captures and compares `main` and RPC under
the same scenario contract. That uncovered a different blocker: the active
runtime scenarios no longer reach the state they are supposed to verify under
deterministic isolation. A parity gate that compares splash/error screens cannot
prove 1:1 UX parity. This plan repairs the active runtime harness so Plan 024
can make a fair approval decision.

## Current state

Accepted Plan 024 retry commit:

- Branch: `codex/plan024-real-runtime-ui-parity-exec`
- Commit: `f8eeec8`
- Worktree:
  `/Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode`

What `f8eeec8` fixed:

- `scripts/visual-v2/runtime-capture.mjs` injects a temporary
  `PI_CODING_AGENT_DIR` for runtime captures unless a scenario explicitly
  provides one.
- Runtime capture metadata records `piCodingAgentDirSource`.
- Temp dirs are cleaned in a `finally` path.
- Runtime scenarios reject `Warning: No models match pattern`.

The remaining failure is scenario reachability, not yet product UI parity:

- `/tmp/sumocode-plan024-main-parity/active-landscape-runtime/raw/terminal-snapshot.json`
  replays to the splash prompt instead of active-working state. The bottom rows
  include `DIVINE INVOCATION` and `unknown · off`.
- `/tmp/sumocode-plan024-candidate-parity/active-landscape-runtime/raw/terminal-snapshot.json`
  contains `rpc error: prompt failed: No API key found for the selected model.`
- The same pattern exists for `active-portrait-runtime`.
- Probes from the reviewer showed:
  - CSI-u Enter (`\u001b[13u`) submits in the RPC candidate but is echoed by
    current `main`.
  - Carriage return (`\r`) is branch-portable as a raw byte, but with the
    temporary Pi agent dir the active scenarios still do not reach
    deterministic active-working state.

Existing docs define the intended semantics:

- `docs/visual/parity/BASELINE_REVIEW.md`: active runtime scenarios submit a
  prompt with Enter and capture deterministic offline active-working state.
- `docs/visual/parity/ACTIVE_LANDSCAPE_REVIEW.md`: the scenario validates real
  startup/input/submit composition, while completed model responses stay in
  fixture lanes.
- `docs/visual/parity/CONTRACT.md`: runtime-labelled scenarios must not use
  `SUMOCODE_VISUAL_RPC_FIXTURE` or completed-state injection.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused contract tests | `pnpm vitest run src/visual-parity-contract.test.ts` | exit 0 |
| Active landscape capture | `pnpm visual:review -- --scenario active-landscape-runtime` | may exit 1 for visual diff, but must produce valid active-working final screen evidence |
| Active portrait capture | `pnpm visual:review -- --scenario active-portrait-runtime` | may exit 1 for visual diff, but must produce valid active-working final screen evidence |
| Full runtime lane | `pnpm visual:review -- --lane runtime` | may exit 1 for visual diffs, but all runtime captures must be reachable and warning/error-clean |
| Main/candidate compare | `pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc` | may exit 1 only for real UI diffs after reachability passes |

## Scope

**In scope:**

- `scripts/visual-v2/runtime-capture.mjs`
- `scripts/visual-v2/scenario-registry.mjs` only if the manifest needs a typed
  logical key or wait step.
- `docs/visual/parity/scenarios.json`
- `docs/visual/parity/CONTRACT.md`
- `docs/visual/parity/ACTIVE_LANDSCAPE_REVIEW.md`
- `docs/visual/parity/BASELINE_REVIEW.md`
- `src/visual-parity-contract.test.ts`
- A new small helper under `scripts/visual-v2/` only if needed to make
  reachability assertions machine-checkable.

**Out of scope:**

- Production UI/runtime behavior.
- Golden promotion.
- User/private Pi config changes or copying secrets.
- Any completed-response runtime fixture injection.
- `plans/` edits.

## Steps

### Step 1: Make active runtime input branch-portable

Inspect the active runtime scenario inputs in
`docs/visual/parity/scenarios.json`. Replace raw branch-specific Enter bytes
with a branch-portable input contract. Prefer one of these approaches:

- use raw carriage return (`\r`) if both current `main` and RPC can submit with
  it after the editor is ready, or
- add a manifest-level logical key such as `{ "type": "key", "value":
  "Enter" }` and teach `runtime-capture.mjs` to map it to the correct bytes
  without encoding branch-specific behavior in the scenario.

Also make input timing readiness-based if fixed delays are the real problem:
add a narrow `waitForOutput` or `waitForFinalScreenMatches` runtime input step
so text is sent only after the splash editor is ready. Do not guess with ever
longer sleeps if a deterministic readiness signal exists.

**Verify:**

```bash
pnpm vitest run src/visual-parity-contract.test.ts
```

Expected: exit 0, and tests should fail if active runtime scenarios use raw
CSI-u Enter bytes that `main` cannot consume.

### Step 2: Restore deterministic active-working state without user secrets

Find why the temporary `PI_CODING_AGENT_DIR` leaves `main` at `unknown · off`
and makes RPC report `No API key found`. Do not copy user auth or secret
values. Acceptable fixes include:

- create a minimal non-secret runtime visual Pi config in a temp dir before
  spawn, if Pi supports a documented offline active-working mode without
  credentials;
- add a runtime-capture option that preserves deterministic startup while
  avoiding the model-selection warning pollution that caused Plan 024's first
  bad baseline; or
- explicitly reject active runtime captures that cannot reach active-working,
  then STOP with the evidence if no non-secret deterministic path exists.

The active final screen must not contain any of these strings:

- `No API key found`
- `rpc error: prompt failed`
- `DIVINE INVOCATION`
- `unknown · off`
- raw key bytes such as `^[[13u`

It must contain real active shell evidence such as the top bar and submitted
prompt frame, and it should show the working/meditating state described in the
baseline docs.

**Verify:**

```bash
pnpm visual:review -- --lane runtime || true
node - <<'NODE'
const fs = require("fs");
for (const scenario of ["active-landscape-runtime", "active-portrait-runtime"]) {
  const snapshot = JSON.parse(fs.readFileSync(`docs/visual/out/parity/${scenario}/raw/terminal-snapshot.json`, "utf8"));
  const text = snapshot.plainText;
  for (const bad of ["No API key found", "rpc error: prompt failed", "DIVINE INVOCATION", "unknown · off", "^[[13u"]) {
    if (text.includes(bad)) throw new Error(`${scenario} contains invalid active-runtime marker: ${bad}`);
  }
  if (!text.includes("SUMOCODE")) throw new Error(`${scenario} missing top-bar shell evidence`);
  if (!text.includes("review src/auth/session.ts and tighten the return type")) throw new Error(`${scenario} missing submitted prompt evidence`);
}
NODE
```

Expected: the node assertion exits 0. `visual:review` may still exit 1 because
the visual diff is not yet approved; reachability is the gate for this plan.

### Step 3: Rerun the normalized Plan 024 comparison

Use the same disposable-main overlay flow from Plan 024, but only after Step 2
passes in the candidate worktree:

```bash
pnpm render:bible
pnpm visual:review -- --lane runtime || true
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
pnpm visual:review -- --lane runtime || true
rm -rf /tmp/sumocode-plan024-main-parity
cp -R docs/visual/out/parity /tmp/sumocode-plan024-main-parity

cd /Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode
pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc
```

If `visual:compare` fails, inspect the active scenario snapshots before
reporting. The failure is acceptable for this plan only if both active
scenarios now reach valid active-working state in both roots. If they do not,
STOP and report the remaining reachability blocker.

### Step 4: Commit and report

Commit the harness/doc/test changes. Do not update `plans/README.md`.

Report:

- final branch and commit,
- exact commands run and exit codes,
- whether active runtime reachability is fixed for candidate and disposable
  `main`,
- evidence paths,
- whether Plan 024 can now be rerun as a true UI parity gate.

## Done criteria

- [ ] Active runtime scenarios no longer rely on branch-specific raw CSI-u Enter
  bytes unless `main` can consume them too.
- [ ] Candidate active landscape and portrait captures reach valid
  active-working state with temporary/deterministic Pi state.
- [ ] Disposable `main` active landscape and portrait captures reach valid
  active-working state under the same scenario contract.
- [ ] Active captures reject or fail on `No API key found`, `rpc error:
  prompt failed`, `DIVINE INVOCATION`, `unknown · off`, and raw key-byte echoes.
- [ ] `pnpm vitest run src/visual-parity-contract.test.ts` exits 0.
- [ ] Normalized `visual:compare` has real contract matches and no legacy
  metadata bridge. It may still fail for visual diffs after reachability is
  fixed.
- [ ] No production UI behavior, user config, secrets, or goldens are changed.

## STOP conditions

- A deterministic active-working runtime state requires copying user secrets or
  auth files.
- Current `main` and RPC cannot share any runtime input contract without
  branch-specific behavior in the scenario manifest.
- The active scenario can only be made reachable by using completed-state
  fixture injection in a runtime-labelled scenario.
- You cannot produce a machine-checkable assertion that distinguishes
  active-working state from splash/error state.

## Maintenance notes

Plan 024 is the approval gate and should not be marked DONE until this plan
makes active runtime reachability trustworthy. Reviewers should scrutinize any
solution that quietly falls back to user-local Pi config; that may make the
developer's machine pass while CI or another reviewer fails.

## Execution notes (2026-07-03)

Executor branch:

- Worktree:
  `/Users/sumo-deus/.codex/worktrees/plan024-real-runtime-ui-parity/sumocode`
- Branch: `codex/plan024-real-runtime-ui-parity-exec`
- Commits:
  - `b2193f0` — introduced logical Enter readiness waits, visual-only faux
    provider, final-screen rejection markers, and active-runtime contract tests.
  - `650b167` — restored `SUMOCODE_HARNESS=1` deterministic runtime metadata
    after autoreview found local branch/sidebar/cost state could otherwise leak
    into visual captures.

Reviewer verification:

- `pnpm vitest run src/visual-parity-contract.test.ts` exited 0.
- `pnpm visual:review -- --lane runtime` exited 1 because
  `active-landscape-runtime` still differs visually, but both active runtime
  snapshots rejected `No API key found`, `rpc error: prompt failed`,
  `DIVINE INVOCATION`, `unknown · off`, and `^[[13u`; both contained
  `SUMOCODE`, the submitted prompt, and `inspecting src/auth/session.ts`.
- Disposable `main` overlaid with the same harness contract produced the same
  clean active-runtime reachability markers.
- `pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root /tmp/sumocode-plan024-candidate-parity --lane runtime --out docs/visual/out/parity-main-rpc`
  exited 1 with real visual diffs, but every scenario reported
  `Scenario contract validation: MATCH`.
- `python3 ~/.codex/skills/autoreview/scripts/autoreview --mode branch --base f8eeec8`
  exited 0 with no accepted/actionable findings.
