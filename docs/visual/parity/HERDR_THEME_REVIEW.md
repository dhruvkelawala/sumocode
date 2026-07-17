# Herdr Terminal — Visual Review (Plan 073)

- **Scenario:** `herdr-theme-active-runtime` (lane `runtime`, status `review`)
- **Command:** `pnpm visual:review -- --scenario herdr-theme-active-runtime`
- **Branch:** `advisor/073-herdr-terminal-theme` (based on `main` @ `3e39db4`; the
  plan's original base `933f33d` on `feat/on-demand-interactive-worktrees` only
  differs in worktree-command files, none of which this plan touches)
- **Capture date:** 2026-07-17
- **Isolation:** `PI_CODING_AGENT_DIR=test/fixtures/pi-agent-herdr` (committed
  fixture: `sumocode.json` with `themeName: "herdr"` plus the empty `auth.json`
  Pi writes on boot — committed so captures leave the worktree clean). The
  harness resolves scenario fixture dirs against the repo root and never
  cleans them up (`piCodingAgentDirSource: "scenario"` in capture metadata).

## Scenario result

Capture succeeded on attempt 1 with no rejection. The raw-output theme gates
all held:

- required raw patterns matched: OSC 11 `#0B0B0F` (Herdr background) and
  OSC 12 `#00E5FF` (Herdr cursor accent) were emitted;
- rejection raw patterns did NOT match: no Cathedral OSC 11 `#1A1511` or
  OSC 12 `#D97706` anywhere in the byte stream — i.e. **no Cathedral flash
  before the Herdr palette lands**;
- final-screen gates passed (no DIVINE INVOCATION residue, no fallback shell,
  no rpc error, no stack trace);
- geometry audit passed: 45 rows, no mismatches.

## Crop metrics (vs `theme-herdr-active.png` Bible target)

| Crop | Result | Pixel diff ratio | Threshold |
|---|---|---:|---:|
| full | passed | 0.0181 | 0.02 |
| top-bar | review-diff | 0.0246 | 0.02 |
| sidebar | review-diff | 0.0430 | 0.02 |
| chat-area | passed | 0.0136 | 0.02 |
| input-frame | passed | 0.0183 | 0.03 |
| hint-row | passed | 0.0048 | 0.02 |
| footer | review-diff | 0.0212 | 0.02 |

Evidence paths (generated, not committed):

- `docs/visual/out/parity/herdr-theme-active-runtime/target-full.png`
- `docs/visual/out/parity/herdr-theme-active-runtime/runtime-full.png`
- `docs/visual/out/parity/herdr-theme-active-runtime/crops/`
- `docs/visual/out/parity/herdr-theme-active-runtime/raw/styled-cell-diff.txt`
- `docs/visual/out/parity/herdr-theme-active-runtime/raw/geometry-audit.txt`

## Accepted intentional differences

1. **One-row chrome offset vs Bible target.** The Bible scene family places a
   blank row above the top bar (top bar at row 1); the live runtime paints the
   top bar at row 0. This offset is shared with the existing Cathedral
   `active-landscape-runtime` target/capture pair and is a pre-existing
   target-convention difference, not Herdr drift.
2. **Session id and timestamp.** `019f…` id and live clock differ per run
   (same mechanical classes the plan-024 equivalence masks cover for the
   Cathedral scenario).
3. **Working indicator row.** The runtime shows the live `: Working…` packet
   frame (row 36); the deterministic target omits it, matching the Cathedral
   runtime target's treatment.
4. **Footer state.** Runtime captures mid-stream (`● MEDITATING ·
   active-working · off`); target shows the canonical `● READY · gpt-5.5 ·
   medium` idle footer, mirroring the Cathedral runtime target.

## Human review

- Full scene reads as near-black operational tooling: `#0B0B0F` chassis, warm
  off-white body copy, cool grey metadata. Not Cathedral recoloured, not
  Matrix cosplay — no green body text, no glow.
- Cyan is the only active/focus signal (top-bar wordmark, active tab marker,
  input caret/prompt, CTRL+/ hint); mint reads as ready/healthy (footer READY
  dot, context meter, `stitch ok` MCP dot).
- Hierarchy holds: chat frame > sidebar surface > recessed input well are
  distinguishable at 160×45; divider grey stays decorative and never carries
  text.
- ASCII chrome is width-stable in the renderer: sharp `┌ ┐ └ ┘` frames, `▸`/`·`
  tabs, `> # @ $ %` sigils all landed at exact cell columns (geometry audit
  clean, no wide-glyph drift).
- Terminal background/cursor coherence confirmed at the byte level (raw OSC
  gates above) and visually — the pane background outside painted cells
  matches the retained cells.

## Golden policy

**No approved runtime goldens were promoted in this change.** The scenario is
registered at `review` status with zero `required` crops; promotion requires a
separate explicit human decision via `pnpm visual:promote`. Existing Cathedral
evidence (`docs/visual/parity/approved-runtime/**`, Bible targets) is
untouched; the pre-existing `active-landscape-runtime` sidebar/input-frame
Bible-diff failures were re-verified as identical on `main` (sidebar 0.1566 vs
0.1552, input-frame 0.03003 vs 0.03003) and are not affected by this plan.
