# Plan 054 (v2): Coordinated alignment of the visual-harness env contract with the launcher

> **Executor instructions**: Follow this plan step by step. Run every
> verification command. If a STOP condition occurs, stop and report. SKIP
> updating `plans/README.md` — your reviewer maintains the index.
>
> **v2 note**: v1 assumed a manifest-only edit and STOPPED correctly: the
> guard test value-pins `SUMO_TUI: "1"` and the capture harness defaults it.
> v2 makes the SAME alignment as one coordinated change across manifest,
> harness default, guard test, and contract text. Retargeting the guard
> test's pinned value here is the deliberate contract change — it is not
> "weakening" (the assertion structure stays; only the pinned value moves).
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- docs/visual/parity/CONTRACT.md docs/visual/parity/scenarios.json scripts/visual-v2/runtime-capture.mjs src/visual-parity-contract.test.ts`
> On excerpt mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs / harness
- **Planned at**: commit `86e5062`, 2026-07-07 (v2 same day, after v1 STOP)

## Why this matters

The documented visual runtime contract (`SUMO_TUI=1`) describes the retired
patched-runtime activation model. The launcher unconditionally exports
`SUMO_TUI=0` and selects the RPC host itself, so the value the harness sets
and the guard test pins is overridden before the product code runs. The
contract, manifest, harness default, and guard should all state the real
environment so future harness/debug work isn't pointed at removed machinery.

## Current state (v1 executor's verified findings + advisor reads)

- `docs/visual/parity/scenarios.json:234, 286, 439` — `"SUMO_TUI": "1"` in
  runtime scenario `env` blocks.
- `scripts/visual-v2/runtime-capture.mjs:317-327` — harness builds the child
  env with a `SUMO_TUI: "1"` default; scenario env spreads AFTER it
  (manifest overrides the default).
- `src/visual-parity-contract.test.ts:231` —
  `expect(splash.runtime?.env).toMatchObject({ SUMO_TUI: "1", PI_OFFLINE: "1" })`.
- `bin/sumocode.sh` exports `SUMO_TUI=0` unconditionally for every launch
  path (grep `SUMO_TUI` in the launcher); the RPC host path also exports
  `SUMO_RPC=1`. Net: the capture child's EFFECTIVE env is `SUMO_TUI=0`
  regardless of manifest/harness values — captures cannot change from this
  alignment.
- `docs/visual/parity/CONTRACT.md:56` — the runtime-lane env sentence names
  `SUMO_TUI=1`.
- Guard suite: `pnpm vitest run src/visual-parity-contract.test.ts` → 16
  tests, green at base.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Guard test | `pnpm vitest run src/visual-parity-contract.test.ts` | all 16 pass |
| JSON sanity | `node -e "JSON.parse(require('fs').readFileSync('docs/visual/parity/scenarios.json','utf8'))"` | exit 0 |
| Capture smoke (optional, if quick) | `pnpm visual:review -- --scenario <splash runtime id> --lane runtime` | exit 0 |

## Scope

**In scope**:
- `docs/visual/parity/scenarios.json` — the three `SUMO_TUI` entries only
- `scripts/visual-v2/runtime-capture.mjs` — the `SUMO_TUI` default only
- `src/visual-parity-contract.test.ts` — the pinned env value(s) only
- `docs/visual/parity/CONTRACT.md` — the env sentence only

**Out of scope**:
- Goldens, crops, capture regeneration (effective child env is unchanged).
- Any other assertion in the guard suite; any other harness behavior.
- `bin/sumocode.sh`.

## Git workflow

- Branch: `advisor/054-visual-contract-env-alignment-v2` off `86e5062`
- Commit style: `docs(visual): ...` or `test(visual): ...`. Do NOT push.

## Steps

### Step 1: Flip the four surfaces together

1. `scenarios.json`: each `"SUMO_TUI": "1"` → `"SUMO_TUI": "0"`.
2. `runtime-capture.mjs:~324`: default `SUMO_TUI: "1"` → `SUMO_TUI: "0"`,
   with a one-line comment: the launcher exports `SUMO_TUI=0` itself; this
   default documents the effective env rather than fighting it.
3. `visual-parity-contract.test.ts:~231`: pinned value `SUMO_TUI: "1"` →
   `"0"` (keep `PI_OFFLINE: "1"` and the assertion structure identical). If
   other lines in the suite pin `SUMO_TUI` (search the file), retarget them
   identically.
4. `CONTRACT.md:56`: rewrite the env mention: the launcher owns the env —
   it exports `SUMO_TUI=0` and selects the RPC host (`SUMO_RPC=1`); scenario
   env pins `SUMO_TUI=0` to document the effective environment.

**Verify**: JSON sanity → 0; `pnpm vitest run src/visual-parity-contract.test.ts` → all pass;
`grep -n '"SUMO_TUI": "1"' docs/visual/parity/scenarios.json scripts/visual-v2/runtime-capture.mjs src/visual-parity-contract.test.ts` → no matches.

### Step 2: Prove capture equivalence (cheap check)

Because the launcher overrides the variable, the change must be behaviorally
inert. If the runtime capture lane runs in your environment in a few minutes,
run the optional capture smoke command for ONE runtime scenario and confirm it
exits 0. If it cannot run (missing deps/display), say so in NOTES — the guard
suite remains the required gate.

## Test plan

No new tests; the retargeted guard assertions are the gate.

## Done criteria

- [ ] `pnpm vitest run src/visual-parity-contract.test.ts` exits 0
- [ ] scenarios.json parses; no `"SUMO_TUI": "1"` anywhere in the four files
- [ ] CONTRACT.md no longer instructs `SUMO_TUI=1`
- [ ] `git status` — only the four in-scope files changed

## STOP conditions

- The guard suite has an assertion that COUNTS or hashes env blocks such that
  the retarget cascades beyond the pinned values.
- Any harness script BRANCHES behavior on `SUMO_TUI === "1"` (v1's grep found
  only the default-and-override pattern; if a branch exists, report).

## Maintenance notes

- The launcher is the single owner of runtime env; harness/manifest/test
  document it. Any future launcher env change must update all four surfaces —
  cite this plan in the commit.
