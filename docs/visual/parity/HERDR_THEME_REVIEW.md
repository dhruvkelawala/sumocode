# Herdr Terminal — Visual Review (Plan 073, v7 palette)

- **Scenario:** `herdr-theme-active-runtime` (lane `runtime`, status `review`)
- **Command:** `pnpm visual:review -- --scenario herdr-theme-active-runtime`
- **Branch:** `advisor/073-herdr-terminal-theme` — v7 electric-green realignment
  follow-up on top of `91df9bb` (plan-ledger) / `6e4a3ce` (initial cyan
  implementation)
- **Capture date:** 2026-07-17 (v7 realignment)
- **Palette:** approved v7 electric-green system (supersedes the cyan/mint/gold
  proposal captured in the prior revision of this document)
- **Isolation:** `PI_CODING_AGENT_DIR=test/fixtures/pi-agent-herdr` (committed
  fixture: `sumocode.json` with `themeName: "herdr"` + empty `auth.json`). The
  harness resolves the scenario fixture dir repo-relative and never cleans it
  up (`piCodingAgentDirSource: "scenario"`).

## Scenario result

Capture succeeded on attempt 1 with no rejection. The raw-output theme gates
all held for the v7 palette:

- **required** raw patterns matched: OSC 11 `#040704` (Herdr background) and
  OSC 12 `#39FF14` (Herdr electric-green cursor accent) were emitted;
- **rejection** raw patterns did NOT match: no Cathedral OSC 11 `#1A1511` /
  OSC 12 `#D97706`, **and no stale cyan-era Herdr OSC 11 `#0B0B0F` / OSC 12
  `#00E5FF`** anywhere in the byte stream — i.e. no Cathedral flash and no
  cyan regression before the v7 palette lands;
- final-screen gates passed (no DIVINE INVOCATION residue, no fallback shell,
  no rpc error, no stack trace);
- geometry audit passed: 45 rows, no mismatches.

## Crop metrics (vs `theme-herdr-active.png` v7 Bible target)

| Crop | Result | Pixel diff ratio | Threshold |
|---|---|---:|---:|
| full | review-diff | 0.0207 | 0.02 |
| top-bar | review-diff | 0.0246 | 0.02 |
| sidebar | review-diff | 0.0455 | 0.02 |
| chat-area | passed | 0.0172 | 0.02 |
| input-frame | passed | 0.0183 | 0.03 |
| hint-row | passed | 0.0050 | 0.02 |
| footer | review-diff | 0.0213 | 0.02 |

Evidence paths (generated, not committed):

- `docs/visual/out/parity/herdr-theme-active-runtime/target-full.png`
- `docs/visual/out/parity/herdr-theme-active-runtime/runtime-full.png`
- `docs/visual/out/parity/herdr-theme-active-runtime/crops/`
- `docs/visual/out/parity/herdr-theme-active-runtime/raw/styled-cell-diff.txt`
- `docs/visual/out/parity/herdr-theme-active-runtime/raw/geometry-audit.txt`

## Accepted intentional differences

1. **Target exercises the full state palette; runtime is minimal.** The v7
   Bible target adds independent-design-intent SUMO rows (`✓ [read]` idle
   green, `▶ [edit]` amber tool, `● approval` red, `★ learned` bright amber)
   so a reviewer sees every semantic colour in one image. The runtime capture
   is the minimal live scene (USER prompt + `inspecting …`), so the chat-area
   and full crops carry a review-diff. This mirrors how Cathedral pairs a rich
   `scene-active` fixture target with a minimal `scene-active-runtime` target.
2. **One-row chrome offset vs Bible target.** Shared with the Cathedral
   `active-landscape-runtime` pair; the Bible family blanks row 0 while the
   live runtime paints the top bar at row 0.
3. **Session id and timestamp.** `019f…` id and live clock differ per run.
4. **Working-indicator row / footer state.** Runtime shows the live green
   `: Working…` packet frame and mid-stream `● MEDITATING · active-working ·
   off` footer; the deterministic target shows the canonical `● READY ·
   gpt-5.5 · medium` idle footer.

## Human review

- Full scene reads as the approved electric-green operator console: `#040704`
  green-black chassis, electric-green `#39FF14` body / focus / frames / cursor,
  quieter green `#29B938` idle dots and dim metadata. No cyan, teal, blue or
  purple anywhere.
- Electric green is unambiguously dominant across body copy, message frames,
  the SUMO label, the input caret and sidebar registry/context accents.
- Hierarchy holds without colour-only cues: chat frame > sidebar surface >
  recessed input well remain distinguishable via surface depth, weight and
  labels at 160×45; divider green stays decorative.
- In the target, amber owns `▶ [edit]` / `★ learned` and red owns `● approval`
  — clearly distinct from focus green and from each other.
- ASCII chrome is width-stable (sharp `┌ ┐ └ ┘`, `▸`/`·` tabs, `> # @ $ %`
  sigils; geometry audit clean).
- Terminal background/cursor coherence confirmed at the byte level (raw OSC
  gates above) and visually.

## Golden policy

**No approved runtime goldens were promoted.** The scenario stays at `review`
with zero `required` crops; promotion requires a separate explicit human
decision via `pnpm visual:promote`. Existing Cathedral evidence
(`docs/visual/parity/approved-runtime/**`, Cathedral Bible targets) is
untouched. The pre-existing `active-landscape-runtime` sidebar/input-frame
Bible-diff failures remain out of scope and unaffected by this realignment.
