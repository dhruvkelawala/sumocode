# Plan 073 — Herdr Terminal Theme

- **Status:** IN PROGRESS — implementation exists; approved v7 palette realignment and renewed visual evidence required
- **Created:** 2026-07-17
- **Revised:** 2026-07-17 after live Mac Mini canary approval and MacBook parity verification
- **Original plan commit:** `6aadc84a9e3365bd63dbbe264dce2616f16d741c`
- **Current implementation:** `6e4a3ce` on `advisor/073-herdr-terminal-theme`
- **Issue:** https://github.com/dhruvkelawala/sumocode/issues/312
- **Target branch:** `advisor/073-herdr-terminal-theme`
- **Suggested follow-up commit:** `fix(theme): align herdr with approved electric green palette`

## Goal

Ship `herdr` as SumoCode's fourth first-party theme using the electric-green, near-black and luminous-amber visual system approved in the live Ghostty + Herdr canary, while preserving the generic terminal-host lifecycle work already implemented on the branch.

The current branch is structurally sound but visually stale: it implements the superseded cyan/mint/gold proposal. This revision is a **palette and evidence realignment**, not a greenfield rebuild and not permission to replace working theme-registry or OSC lifecycle architecture.

## Approved design direction

Herdr Terminal should look like a focused operator console:

- green-black chassis and layered green-black surfaces;
- electric green as the dominant foreground, focus, frame and cursor signal;
- luminous amber for tools, warnings, durable learning and secondary accents;
- warm red for approval, failure and interruption;
- sharp terminal chrome with no teal, blue, cyan, purple, gradients or decorative rainbow;
- restrained glow only from terminal rendering; no CSS text-shadow, scanline animation or Matrix-rain effects;
- semantic hierarchy must survive without relying on colour alone.

This intentionally differs from the original Plan 073 claim that body copy should remain warm off-white. The live canary proved that electric-green body text is the preferred product direction.

## Provenance and product boundary

The live host palette was approved on the Mac Mini and then ported to the MacBook with exact Ghostty theme-file and normalized Herdr visual-token parity.

Canonical host values:

| Host role | Value |
|---|---:|
| background | `#040704` |
| electric foreground / focus / cursor | `#39FF14` |
| active surface | `#0F3D17` |
| muted host green | `#1FA82F` |
| standard amber | `#FFB000` |
| bright amber | `#FFD166` |
| error red | `#FF625F` |

SumoCode must reproduce that visual language through its existing semantic theme contract. It must **not** read personal `~/.config/ghostty` or `~/.config/herdr` files at runtime or in CI. Cross-machine host configuration generation/sync remains outside this issue.

## Current implementation state

Commit `6e4a3ce` already provides:

- `herdr` registration after `obsidian`, with Cathedral still the default;
- direct selection, selector, cycling and persisted startup;
- generic terminal palette ownership for OSC 11 background and OSC 12 cursor;
- first-frame theme application, live switching and duplicate-write suppression;
- cursor-reset opt-out across theme changes;
- suspend/resume and shutdown restoration;
- isolated Herdr runtime fixture and visual scenario;
- independent Bible target and visual review document;
- current product-truth updates for four themes.

Preserve those mechanisms unless a failing test proves a defect. The remaining work is to replace stale visual assumptions, regenerate evidence, and prove no cyan-era token survives in Herdr-owned output.

## Design contract

### Identity

- **Registry name:** `herdr`
- **Display name:** `Herdr Terminal`
- **Description:** `Electric-green operator terminal — phosphor focus, amber execution, sharp hacker chrome.`
- **Default:** unchanged; Cathedral remains the default.
- **Registry order:** `cathedral`, `amber-crt`, `obsidian`, `herdr`.

### SumoCode semantic palette

Use these exact values in `src/themes/herdr.ts`:

| Token | Value | Role / provenance |
|---|---:|---|
| `background` | `#040704` | approved Ghostty chassis and OSC 11 value |
| `surface` | `#070C08` | calm green-black content/sidebar plane |
| `surfaceRecess` | `#050905` | input/editor well |
| `surfaceLifted` | `#0F3D17` | approved active/selected surface |
| `foreground` | `#39FF14` | approved electric-green body foreground |
| `foregroundDim` | `#29B938` | accessibility-safe text derivative of host-muted `#1FA82F` |
| `divider` | `#176B22` | decorative structure; never sole carrier of text/state |
| `accent` | `#39FF14` | active frame, focus, cursor and routing |
| `states.idle` | `#29B938` | ready/healthy, quieter than active focus |
| `states.thinking` | `#39FF14` | active reasoning/routing |
| `states.tool` | `#FFB000` | tool execution and warning |
| `states.approval` | `#FF706D` | accessibility-safe text derivative of host error `#FF625F` |
| `states.learning` | `#FFD166` | durable write / learned state / bright amber |

The two derived text colours are deliberate:

- host-muted `#1FA82F` scores 3.94:1 on `#0F3D17`; `#29B938` scores 4.759:1;
- host error `#FF625F` scores 4.21:1 on `#0F3D17`; `#FF706D` scores 4.582:1.

Do not weaken the existing 4.5:1 automated contract to preserve an inaccessible literal host value. The host values remain valid for decorative/non-text use; SumoCode text uses the derivatives above.

### Contrast contract

`foreground`, `foregroundDim`, `accent`, and all five state colours must each remain at least 4.5:1 against:

- `background`;
- `surface`;
- `surfaceRecess`;
- `surfaceLifted`.

Verified minimum ratios for the proposed values:

| Colour | Lowest ratio | Worst surface |
|---|---:|---|
| `#39FF14` | 9.110:1 | `#0F3D17` |
| `#29B938` | 4.759:1 | `#0F3D17` |
| `#FFB000` | 6.742:1 | `#0F3D17` |
| `#FF706D` | 4.582:1 | `#0F3D17` |
| `#FFD166` | 8.566:1 | `#0F3D17` |

`divider` is exempt only because it is decorative and never the sole carrier of text, focus or state.

### Semantic restraint

- Electric green is dominant, but hierarchy must still come from surface depth, weight, labels and chrome.
- Amber is secondary. It must not replace focus green.
- Red is reserved for approval/failure/interruption.
- Do not introduce cyan/blue/teal/purple anywhere in the Herdr bundle, target or scenario gates.
- Do not change unrelated cyan values belonging to Amber CRT, Obsidian, shared research documents or other themes.
- No component may branch on `theme.name === "herdr"`; all consumers continue through semantic tokens.

### Chrome and working indicator

Preserve the implemented width-safe contract:

```ts
frame: {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
},
sectionGlyphs: {
  context: ">",
  memory: "#",
  mcp: "@",
  session: "$",
  registry: "%",
},
sectionTracked: false,
ruleChar: "─",
tabActive: "▸",
tabInactive: "·",
bullet: ">",
```

Preserve the eight unique width-1 indicator frames and 110 ms interval:

```ts
frames: [".", ":", "+", "*", "#", "%", "@", ">"],
intervalMs: 110,
```

The working indicator uses `states.thinking` (`#39FF14`). Reduced-motion behaviour remains shared; no Herdr-specific runtime branch.

## Scope

### Restore/update plan ledger

- Restore/update: `plans/073-herdr-terminal-theme.md`
- Update: `plans/README.md`
- Mirror final plan body to GitHub issue #312 after the plan contains its issue URL.

### Modify for palette realignment

- `src/themes/herdr.ts`
- `src/themes/herdr.test.ts`
- `src/themes/registry.test.ts`
- `src/commands/theme.test.ts`
- `src/commands/cursor.test.ts`
- `src/sumo-tui/runtime/lifecycle.test.ts`
- `src/sumo-tui/rpc/runtime.test.ts`
- `src/visual-parity-contract.test.ts`
- `docs/ui/stitch/herdr-terminal/DESIGN.md`
- `scripts/gen-bible-theme-herdr.mjs`
- generated `docs/ui/bible/theme-herdr-active.html`
- `docs/visual/parity/scenarios.json`
- `docs/visual/parity/HERDR_THEME_REVIEW.md`
- Herdr-specific present-tense wording in `README.md`, `docs/prd.md`, `docs/prd.html`, and `CHANGELOG.md`

### Preserve unless tests expose a defect

- `src/themes/index.ts`
- `src/themes/registry.ts`
- `src/themes/startup.test.ts`
- `src/commands/cursor.ts`
- `src/sumo-tui/runtime/terminal-controller.ts`
- `src/sumo-tui/rpc/runtime.ts`
- `scripts/visual-v2/runtime-capture.mjs`
- `scripts/visual-v2/scenario-registry.mjs`
- `test/fixtures/pi-agent-herdr/auth.json`
- `test/fixtures/pi-agent-herdr/sumocode.json`

### Do not modify

- Cathedral, Amber CRT or Obsidian tokens, chrome, targets or approved runtime goldens.
- `docs/visual/parity/approved-runtime/**` without separate explicit human promotion.
- shared layout, renderer ownership, breakpoints, Pi versions or dependency patches.
- personal Ghostty/Herdr configuration or cross-machine sync tooling.
- unrelated cyan mentions in `AGENTS.md`, `PLAN.md`, research docs or other theme files.
- the pre-existing untracked `.pi-subagents/` directory.

## Implementation sequence

### Phase 0 — Re-establish branch truth

1. Work on `advisor/073-herdr-terminal-theme` at or after `6e4a3ce`; do not reset the implementation commit.
2. Run `git status --short` and record pre-existing state. Current known state is only untracked `.pi-subagents/`.
3. Confirm the current branch diff from `origin/main` still contains the Herdr implementation and no unrelated staged changes.
4. Run the focused baseline:

```bash
pnpm vitest run \
  src/themes/herdr.test.ts \
  src/themes/registry.test.ts \
  src/themes/startup.test.ts \
  src/commands/theme.test.ts \
  src/commands/cursor.test.ts \
  src/sumo-tui/runtime/lifecycle.test.ts \
  src/sumo-tui/rpc/runtime.test.ts \
  src/visual-parity-contract.test.ts
pnpm typecheck
```

**Exit:** existing implementation is understood, baseline results are recorded, and unrelated state remains untouched.

### Phase 1 — Pin the approved palette in tests first

1. In `src/themes/herdr.test.ts`, replace stale metadata and token expectations with the exact v7 contract above.
2. Keep the five-state distinctness assertion.
3. Keep the all-surfaces 4.5:1 test; do not add exceptions for muted or approval text.
4. Preserve width and animation assertions.
5. Update Herdr-specific expectations in:
   - `src/themes/registry.test.ts`;
   - `src/commands/theme.test.ts`;
   - `src/commands/cursor.test.ts`;
   - `src/sumo-tui/runtime/lifecycle.test.ts`;
   - `src/sumo-tui/rpc/runtime.test.ts`;
   - `src/visual-parity-contract.test.ts`.
6. Run the focused tests and verify they fail against the stale cyan implementation for the expected old-token mismatch.
7. Update `src/themes/herdr.ts` with the exact v7 metadata and semantic palette.
8. Run the focused tests again and verify they pass.

Expected host assertions after implementation:

- first Herdr OSC 11: `#040704`;
- first Herdr OSC 12: `#39FF14`;
- live Cathedral → Herdr switch emits those values without restart;
- cursor reset + theme switch still updates background only;
- repeated selection still suppresses duplicate OSC writes;
- suspend/resume restores v7, not Cathedral or stale cyan;
- shutdown restoration remains exactly once;
- non-TTY paths emit no palette sequences;
- stopped runtime no longer reacts to theme changes.

**Exit:** semantic bundle and lifecycle tests encode v7; generic runtime architecture is unchanged.

### Phase 2 — Rewrite independent design intent and generated target

1. Rewrite `docs/ui/stitch/herdr-terminal/DESIGN.md` before generating runtime evidence. It must contain:
   - exact v7 token table;
   - live-host provenance and SumoCode accessibility derivatives;
   - state meanings;
   - chrome and indicator contracts;
   - prohibited cyan/teal/blue/purple drift;
   - explicit acceptance of electric-green body text.
2. Update `scripts/gen-bible-theme-herdr.mjs` to use the v7 values and semantics.
3. Regenerate with:

```bash
pnpm render:bible
```

4. Inspect `docs/ui/bible/theme-herdr-active.html` and rendered output. Confirm the scene exercises body, dim, accent, idle, thinking, tool, approval and learning colours.
5. Run `pnpm render:bible` a second time. The second run must produce no new Herdr target diff.
6. Do not derive the Bible target from a runtime screenshot; it remains independent design intent.

**Exit:** deterministic target expresses the approved design before runtime comparison.

### Phase 3 — Refresh runtime scenario gates and evidence

1. Update Herdr-specific values in `docs/visual/parity/scenarios.json`:
   - required OSC 11 pattern: `#040704`;
   - required OSC 12 pattern: `#39FF14`;
   - reject stale Herdr OSC values `#0B0B0F` and `#00E5FF`;
   - retain Cathedral-flash rejection for `#1A1511` and `#D97706`;
   - retain empty/fallback-shell/stack-trace rejection.
2. Keep `PI_CODING_AGENT_DIR=test/fixtures/pi-agent-herdr`; never read personal config.
3. Run:

```bash
pnpm visual:review -- --scenario herdr-theme-active-runtime
```

4. Inspect target, runtime, full diff, all configured crops, raw OSC output, geometry audit, metadata and final-screen text.
5. Rewrite `docs/visual/parity/HERDR_THEME_REVIEW.md` with the new command, commit, metrics and human observations. Do not preserve old cyan conclusions.
6. Keep scenario status `review`. Do not run `pnpm visual:promote` without separate explicit approval.

**Exit:** real runtime evidence proves v7 and rejects both Cathedral flash and stale cyan Herdr output.

### Phase 4 — Align present-tense product documentation

Update only Herdr-specific present-tense claims in:

- `README.md`;
- `docs/prd.md`;
- `docs/prd.html`;
- `CHANGELOG.md`.

Replace cyan/mint/off-white descriptions with electric-green/amber/red semantics. Preserve historical release statements and unrelated theme descriptions. Keep Cathedral as default and Herdr fourth in cycle order.

**Exit:** product copy, design contract, source tokens and runtime evidence tell the same story.

### Phase 5 — Canonical verification and human smoke

Run exact repository-supported gates:

```bash
pnpm test
pnpm typecheck
pnpm dead-code:strict
pnpm render:bible
pnpm visual:review -- --scenario herdr-theme-active-runtime
pnpm visual:ci -- --scenario active-runtime-160x45
```

Then:

1. Run `pnpm render:bible` once more and confirm no second-run generated drift.
2. Search tracked Herdr-owned files for every stale value and term:
   - `#0B0B0F`, `#0D0D14`, `#07090D`, `#1A1A2E`;
   - `#F5EFE1`, `#8F96A8`, `#3A3A4A`;
   - `#00E5FF`, `#4ECCA3`, `#FFD700`, `#FF3366`, `#F1D77A`;
   - `cyan`, `mint`, `hot pink`, `neon-blue-split-contrast`.
3. Review matches manually. Unrelated themes may legitimately contain some values/terms; Herdr-owned files may not.
4. Confirm `.pi-subagents/` remains untracked and untouched.
5. In a real TTY, verify:
   - first frame is green-black/electric green with no brown or cyan flash;
   - `/theme cathedral`, `/theme herdr` and cycle switching repaint immediately;
   - restart persists Herdr;
   - `/sumo:cursor reset` remains respected after a theme switch;
   - exit restores host terminal background/cursor.
6. Repeat launch/switch/reset/exit smoke on both Mac Mini and MacBook. Machine-specific values do not enter source.

**Exit:** automated gates, deterministic evidence and both live hosts agree.

## Acceptance criteria

### Functional

- `herdr` remains fourth in registry order; Cathedral remains default.
- Direct command, selector, cycle and persisted startup resolve one bundle.
- Retained cells, OSC 11 and active OSC 12 repaint without restart.
- First Herdr host sequences are `#040704` and `#39FF14`; no stale cyan-era Herdr sequence appears first.
- Cursor reset, suspend/resume, non-TTY and shutdown semantics remain proven.

### Visual

- The runtime reads as the approved electric-green Herdr operator terminal.
- Electric green is dominant across body, focus, frames and sidebar hierarchy.
- Amber clearly owns tool/warning/learning roles without competing with focus green.
- Red clearly owns approval/failure/interruption.
- No cyan, teal, blue or purple remains in Herdr-owned source, target or runtime evidence.
- All text/accent/state colours pass 4.5:1 against all four surfaces.
- Chrome and indicator glyphs remain width-stable.
- No approved golden is changed without explicit promotion approval.

### Quality

- Focused tests pass after a demonstrated stale-token failure.
- `pnpm test`, `pnpm typecheck` and `pnpm dead-code:strict` pass.
- Bible generation is deterministic on a second run.
- Herdr visual review completes without rejection and documents honest metrics.
- Existing Cathedral visual CI remains within its contract.
- No personal config, secret or unrelated worktree file is staged.

## Risks and mitigations

1. **Electric-green body text becomes visually flat**
   Use surface depth, `foregroundDim`, labels and weight for hierarchy; do not reintroduce cyan as a shortcut.

2. **Literal host muted/error colours fail contrast on lifted surface**
   Use the pinned text-safe derivatives `#29B938` and `#FF706D`; keep host literals only as provenance/decorative values.

3. **Generator and runtime agree for the wrong reason**
   Update the written design contract first, then generator, then runtime evidence. Do not screenshot runtime into the target.

4. **Generic terminal lifecycle regresses during recolouring**
   Preserve controller/runtime architecture and keep startup, switch, reset, resume, non-TTY and shutdown tests.

5. **Broad search causes unrelated theme churn**
   Restrict edits to Herdr-owned files and Herdr-specific product copy. Other themes may legitimately contain cyan or shared hex values.

6. **Old review metrics are presented as current evidence**
   Replace capture date, command, commit, OSC gates, crop metrics and observations after rerunning v7.

7. **Plan and issue drift again**
   Keep `plans/073-herdr-terminal-theme.md` as source of truth and edit issue #312 from the final file after all metadata is present.

## Rollback

If palette realignment fails, revert only the follow-up v7 commit and restore the cyan implementation at `6e4a3ce`; do not remove the generic terminal-palette lifecycle work. If lifecycle behaviour itself regresses, revert the runtime/controller change as one tested unit while retaining the theme bundle and design work on the branch for correction.

## Definition of done

Plan 073 is done only when the approved v7 palette is encoded in source and tests; Herdr-owned cyan-era values are absent; first-frame/live-switch/reset/resume/exit semantics remain proven; independent target and real runtime evidence have been regenerated and reviewed; canonical gates pass; both Macs pass the real-TTY smoke; issue #312 matches this committed plan; and no unrelated file or approved golden has changed.
