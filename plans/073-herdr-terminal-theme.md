# Plan 073 — Herdr Terminal Theme

- **Status:** Draft
- **Created:** 2026-07-17
- **Prepared against:** `933f33d` on `feat/on-demand-interactive-worktrees`
- **Issue:** https://github.com/dhruvkelawala/sumocode/issues/312
- **Suggested branch:** `advisor/073-herdr-terminal-theme`
- **Suggested commit:** `feat(theme): add herdr terminal bundle`

## Purpose

Add a fourth first-party SumoCode theme, `herdr`, whose visual language matches Dhruv's Herdr/Ghostty setup: a near-black operational terminal, cyan routing/focus, mint readiness, gold execution, hot-pink danger, sharp box chrome, and an ASCII packet-pulse working indicator.

This is not a generic green “Matrix” skin. It should look like a disciplined agent-control terminal: high contrast, sparse neon, readable for long sessions, and clearly related to Herdr without copying Cathedral, Amber CRT, or Obsidian Temple.

The work also closes a real theming seam discovered during reconnaissance: retained SumoCode cells change theme live, but the terminal host's OSC 11 background and OSC 12 cursor are currently hardcoded to Cathedral (`#1A1511` and `#D97706`). A Herdr theme is incomplete until those terminal-level colours follow the active theme without restart or startup flash.

## Outcome

After implementation:

- `herdr` is the fourth registered theme, appended after `obsidian`; Cathedral remains the default.
- `/theme herdr`, `/sumo:theme herdr`, the selector, and theme cycling all work through the existing registry and persistence path.
- The complete retained UI repaints immediately: chat, editor, sidebar, overlays, Markdown, status colours, chrome glyphs, working indicator, host terminal background, and accent cursor.
- The active theme survives restart through `sumocode.json`.
- Explicit `/sumo:cursor reset` remains an opt-out: later theme changes update the background but do not silently re-enable the cursor override.
- Herdr has a deterministic Bible target and runtime visual scenario. Existing Cathedral targets and approved runtime goldens remain untouched.
- README, PRD and changelog no longer claim only three themes.

## Reconnaissance findings

### Existing theme architecture

- `src/themes/types.ts` defines `ThemeBundle`: metadata, semantic colour tokens, five state colours, chrome glyphs, and working-indicator animation.
- `src/themes/registry.ts` owns registry order, default theme, runtime activation, subscriptions and cycling.
- `src/themes/index.ts` is the public theme barrel.
- Existing bundles are `cathedral`, `amber-crt`, and `obsidian`.
- SumoTUI consumers resolve semantic tokens dynamically through `activeThemeColors()` / `activeThemeChrome()` or subscribe through `onThemeChanged()`; a separate renderer or component hierarchy is not needed.
- Startup selection comes from `themeName` in `sumocode.json`; invalid or missing values fall back to Cathedral.
- The RPC host applies startup theme before its first retained frame, and host-side `/theme` persists through `saveSumoCodeConfigPatch`.

### Confirmed gaps and constraints

1. `src/sumo-tui/runtime/terminal-controller.ts` exports a fixed Cathedral `TERMINAL_BG_SET` and defaults `setCursorColor()` to Cathedral orange. `startRetainedSession()` emits both regardless of the selected theme.
2. `src/commands/cursor.ts` says “cathedral accent” and accepts Cathedral-specific aliases. Its behaviour and copy must become theme-neutral.
3. Registry and command tests pin a three-theme order. Preserve the first three and append Herdr; do not reorder existing choices.
4. The visual parity contract requires every scenario to point to an independent Bible target. Do not compare Herdr runtime output to Cathedral artwork.
5. Runtime visual capture isolates `PI_CODING_AGENT_DIR`; use a committed test fixture containing only `sumocode.json` with `themeName: "herdr"`. Never read Dhruv's live Pi config in tests or CI.
6. Existing Cathedral approved runtime goldens are immutable unless explicitly promoted by a separate human decision. This plan creates a review scenario; it does not rewrite Cathedral evidence.
7. Existing focused baseline is green at `933f33d`: 88 theme/cursor/lifecycle/host-action tests passed, and `pnpm typecheck` passed.
8. The worktree has an unrelated untracked `.claude/` directory. Do not stage, modify or remove it.

## Design contract

### Identity

- **Registry name:** `herdr`
- **Display name:** `Herdr Terminal`
- **Description:** `Operational terminal — cyan routing, mint readiness, sharp hacker chrome`
- **Intent:** dark, technical, precise; neon is reserved for focus and state, not used as body text everywhere.

### Palette

Use these exact initial values. They are grounded in the active Herdr/Ghostty setup (`neon-blue-split-contrast`) and Herdr's configured state colours, with one adjusted dim-text value for sustained readability:

| Token | Value | Role / provenance |
|---|---:|---|
| `background` | `#0B0B0F` | Ghostty background; terminal chassis |
| `surface` | `#0D0D14` | Herdr unfocused pane fill |
| `surfaceRecess` | `#07090D` | editor/input well |
| `surfaceLifted` | `#1A1A2E` | Ghostty selection background; overlays/selected rows |
| `foreground` | `#F5EFE1` | Ghostty foreground; warm readable body text |
| `foregroundDim` | `#8F96A8` | cool operational metadata; adjusted above ANSI grey for contrast |
| `divider` | `#3A3A4A` | Ghostty bright-black; decorative structure only |
| `accent` | `#00E5FF` | Herdr active border / Ghostty cyan |
| `states.idle` | `#4ECCA3` | Herdr healthy / ready |
| `states.thinking` | `#00E5FF` | active routing / focus |
| `states.tool` | `#FFD700` | execution / warning gold |
| `states.approval` | `#FF3366` | interruption / danger |
| `states.learning` | `#F1D77A` | durable write / learned state |

Contrast acceptance:

- `foreground`, `foregroundDim`, `accent`, and all five state colours must remain at least 4.5:1 against `background`, `surface`, `surfaceRecess`, and `surfaceLifted`.
- `divider` is exempt because it is decorative and never the sole carrier of text or state; active borders use `accent`.
- Recon values already satisfy the 4.5:1 rule; the lowest checked pair is approval on lifted surface at approximately 4.81:1.
- Do not add glow effects, RGB gradients or bright green body text. Terminal restraint is part of the theme.

### Chrome

Use single-cell, width-stable characters only:

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

The ASCII sigils communicate terminal/hacker identity without changing layout measurements or introducing double-width glyph risk.

### Working indicator

Use an eight-frame ASCII packet progression:

```ts
frames: [".", ":", "+", "*", "#", "%", "@", ">"],
intervalMs: 110,
```

Requirements:

- all frames are unique;
- every frame has terminal width 1;
- colour is `states.thinking` while working;
- reduced-motion behaviour continues to use the existing indicator contract; do not special-case Herdr outside the bundle.

## Scope

### Add

- `src/themes/herdr.ts`
- `src/themes/herdr.test.ts`
- `test/fixtures/pi-agent-herdr/sumocode.json`
- `docs/ui/stitch/herdr-terminal/DESIGN.md`
- `scripts/gen-bible-theme-herdr.mjs`
- generated `docs/ui/bible/theme-herdr-active.html`
- generated `docs/ui/bible/renders/theme-herdr-active.png`
- `docs/visual/parity/HERDR_THEME_REVIEW.md`

### Modify

- `src/themes/index.ts`
- `src/themes/registry.ts`
- `src/themes/registry.test.ts`
- `src/themes/startup.test.ts`
- `src/commands/theme.test.ts`
- `src/sumo-tui/runtime/terminal-controller.ts`
- `src/sumo-tui/runtime/lifecycle.test.ts`
- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/rpc/runtime.test.ts`
- `src/commands/cursor.ts`
- `src/commands/cursor.test.ts`
- `scripts/render-bible.mjs`
- `docs/visual/parity/scenarios.json`
- `README.md`
- `docs/prd.md`
- `docs/prd.html`
- `CHANGELOG.md`

### Do not modify

- Cathedral, Amber CRT, or Obsidian token values and chrome.
- Existing Bible source targets for Cathedral.
- Existing `docs/visual/parity/approved-runtime/**` files.
- `docs/visual/parity/CONTRACT.md` unless implementation exposes a real contract ambiguity; a new review scenario already fits the documented system.
- Pi dependency versions, patches, renderer primitives, layout breakpoints, or component ownership.
- `.claude/` or any unrelated dirty/untracked file.

## Implementation sequence

### Phase 0 — Isolate and establish the baseline

1. Create `advisor/073-herdr-terminal-theme` from the intended current branch/commit. If HEAD moved, record the new base in the PR; do not silently reset the user's feature branch.
2. Confirm `git status --short` shows only known pre-existing state. Keep `.claude/` untracked and unstaged.
3. Run:

```bash
pnpm typecheck
pnpm vitest run \
  src/themes/registry.test.ts \
  src/themes/startup.test.ts \
  src/commands/theme.test.ts \
  src/commands/cursor.test.ts \
  src/sumo-tui/runtime/lifecycle.test.ts \
  src/sumo-tui/rpc/host-actions.test.ts
```

4. If baseline failures differ from the 2026-07-17 reconnaissance result, stop and classify them before changing source.

**Exit:** isolated branch, known worktree state, green focused baseline.

### Phase 1 — Add the bundle through the existing theme contract

1. Add `src/themes/herdr.ts` exporting `HERDR_THEME: ThemeBundle` with the exact metadata, palette, chrome and indicator values in this plan.
2. Export it from `src/themes/index.ts`.
3. Import it into `src/themes/registry.ts` and append it after `OBSIDIAN_THEME`:

```ts
const THEMES = [CATHEDRAL_THEME, AMBER_CRT_THEME, OBSIDIAN_THEME, HERDR_THEME] as const;
```

Do not change `DEFAULT_THEME_NAME`.

4. Update `src/themes/registry.test.ts` to prove:
   - list order is `cathedral`, `amber-crt`, `obsidian`, `herdr`;
   - default remains Cathedral;
   - next-theme wraps `obsidian -> herdr -> cathedral`;
   - direct activation returns the Herdr bundle;
   - existing immutability/error semantics are unchanged.
5. Update `src/themes/startup.test.ts` with a persisted `themeName: "herdr"` case and prove the first resolved active theme is Herdr.
6. Update `src/commands/theme.test.ts` for four choices, selector list content, direct application, persistence and cycle order. Replace brittle count-only expectations with explicit names/order where useful.
7. Add `src/themes/herdr.test.ts` to assert:
   - exact token values and metadata;
   - five state colours are distinct;
   - text/accent/state contrast rules from this plan;
   - chrome and working frames each have visible width 1;
   - all eight indicator frames are unique and interval is 110 ms.
8. Run the focused theme suite before moving on.

**Exit:** Herdr is a fully registered/persisted bundle, and no consumer requires theme-specific branching.

### Phase 2 — Make the host terminal follow the active theme

#### 2.1 Generalize terminal palette sequences

In `src/sumo-tui/runtime/terminal-controller.ts`:

1. Introduce a small terminal-palette shape containing `background` and `accent`; do not pass the whole `ThemeBundle` into this low-level owner.
2. Replace the fixed OSC 11 implementation with a validated sequence factory such as `terminalBackgroundSetSequence(hex)`, mirroring the existing cursor sequence factory.
3. Keep reset sequences unchanged (`OSC 111` for background, `OSC 112` for cursor).
4. Let `TerminalSessionOwner` retain the current palette so suspend/resume and repeated `startRetainedSession()` restore the active values rather than Cathedral.
5. Add an `applyPalette(palette)` operation with these semantics:
   - update retained palette state;
   - if altscreen is active and background painting is enabled, immediately emit the new OSC 11 background;
   - update OSC 12 only when the cursor override is currently active;
   - if `/sumo:cursor reset` made `cursorColorOverridden === false`, a palette change must preserve that opt-out;
   - preserve existing no-TTY guards and duplicate-write suppression.
6. Initial retained startup must use the selected palette before the first frame. It must not paint Cathedral and then repaint Herdr.
7. Keep compatibility exports only where they represent Cathedral fixtures used by existing tests; new production code must not depend on a fixed `TERMINAL_BG_SET` or fixed accent.

#### 2.2 Wire runtime lifecycle

In `src/sumo-tui/rpc/runtime.ts`:

1. Derive `{ background, accent }` from the active theme at `start()` and pass/apply it before terminal ownership begins.
2. Subscribe to `onThemeChanged()` while running. On change:
   - apply the new terminal palette;
   - retain the existing shell repaint behaviour;
   - avoid duplicate lifecycle subscriptions on repeated `start()` calls.
3. Unsubscribe in every `stop()` path, including stop-during-async-start, so tests and host restarts do not leak listeners.
4. Keep the theme registry as source of truth; do not add separate terminal-theme state to configuration.

Update `src/sumo-tui/runtime/lifecycle.test.ts` and `src/sumo-tui/rpc/runtime.test.ts` to prove:

- Herdr startup's first OSC 11 uses `#0B0B0F` and first OSC 12 uses `#00E5FF`;
- live Cathedral -> Herdr switch emits the Herdr background and accent without restarting the session;
- repeated selection of the same theme/palette does not spam duplicate OSC writes;
- reset cursor + theme switch updates background only;
- suspend/resume restores the current Herdr palette, not Cathedral;
- shutdown resets OSC background/cursor and terminal mode exactly once;
- non-TTY paths emit no palette sequences;
- stop removes the theme listener.

#### 2.3 Make `/sumo:cursor` theme-neutral

In `src/commands/cursor.ts`:

1. `/sumo:cursor accent` must use `activeThemeColors().accent` instead of a default Cathedral hex.
2. Replace “cathedral accent” status/notification copy with “theme accent”.
3. Accept `accent` only as the documented mode. Keep old `orange` / `cathedral` aliases only if backwards compatibility is intentional; if retained, mark them deprecated in tests/comments and still resolve the current theme accent rather than orange.
4. Keep `reset`, `default`, and `system` aliases.

Update `src/commands/cursor.test.ts` to activate Herdr, invoke `accent`, assert the exact cyan OSC 12 sequence, and restore the prior active theme in `afterEach` so the suite is order-independent.

**Exit:** host backdrop and cursor are truly theme-aware at startup, live switch, resume and shutdown, with reset semantics preserved.

### Phase 3 — Create deterministic design and runtime evidence

#### 3.1 Author the visual target

1. Add `docs/ui/stitch/herdr-terminal/DESIGN.md` as the human-readable design contract. Include:
   - the exact token table and provenance;
   - restraint rules (near-black dominant; neon only for routing/state/focus);
   - chrome/indicator glyphs;
   - state-colour meanings;
   - examples of prohibited drift: Matrix rain, green body copy, excessive glow, gradients, changed layout, Cathedral ornament.
2. Add `scripts/gen-bible-theme-herdr.mjs` that generates `docs/ui/bible/theme-herdr-active.html` from a deterministic 160x45 active-session scene. Reuse the existing layout/content structure; override only theme tokens and Herdr chrome. The generated target should visibly exercise:
   - assistant/user frame;
   - editor border and cursor;
   - sidebar tabs, divider, context bar and MCP states;
   - Markdown/code/tool content so foreground, dim, accent and states are all represented;
   - footer and working indicator.
3. Register the generator in `scripts/render-bible.mjs` and render `docs/ui/bible/renders/theme-herdr-active.png`.
4. Ensure rerunning `pnpm render:bible` is deterministic and creates no unrelated diffs.

The Bible target is independent design intent. Do not create it by screenshotting the runtime and calling that screenshot the target.

#### 3.2 Add isolated runtime selection

1. Add `test/fixtures/pi-agent-herdr/sumocode.json` containing only the minimum supported config required to select `herdr` (schema version if required by the config reader, plus `themeName`). Do not put personal paths, credentials, models or MCP data in it.
2. Add a `herdr-theme-active-runtime` scenario to `docs/visual/parity/scenarios.json`:
   - lane: `runtime`;
   - initial status: `review`;
   - dimensions: 160x45, matching the target;
   - `PI_CODING_AGENT_DIR` points to the repo-relative fixture;
   - reuse the stable active transcript fixture/environment from the current active-runtime scenario;
   - `bibleTarget`: `theme-herdr-active.png`;
   - include at least full-scene, editor, footer and sidebar crops;
   - rejection rules must catch empty capture, fallback shell, stack traces and wrong-theme evidence (for example Cathedral brown/orange sequences or missing expected Herdr accent).
3. Add/extend scenario-registry/runtime-capture tests to prove the repo-relative fixture is used deterministically and never cleaned up as a temporary directory.
4. Capture:

```bash
pnpm visual:review -- --scenario herdr-theme-active-runtime
```

5. Inspect `target-full.png`, `runtime-full.png`, `diff.png`, crop diffs, capture metadata and final-screen text. Do not judge from a single scalar score.
6. Add `docs/visual/parity/HERDR_THEME_REVIEW.md` recording:
   - command and commit;
   - scenario result and crop metrics;
   - human review of hierarchy, readability, state distinction, ASCII chrome and terminal background/cursor coherence;
   - any accepted intentional differences;
   - explicit statement that no approved runtime goldens were promoted.

**Exit:** deterministic design intent and real runtime evidence exist for Herdr, with review status honest and Cathedral evidence unchanged.

### Phase 4 — Update product truth and verify the whole change

1. Update `README.md`:
   - “three themes” -> four themes;
   - list Herdr after Obsidian;
   - cycle order includes Herdr;
   - add the Herdr visual target or runtime capture only after human review confirms it.
2. Update `docs/prd.md`:
   - “Three themes for three moods” -> four themes;
   - theme user stories/counts and cycle behaviour;
   - append Herdr after Obsidian while keeping Cathedral default/first;
   - update the theme-system section to four registered bundles and the new order;
   - preserve historical roadmap facts that intentionally describe what v0.3 shipped.
3. Mirror current product-truth changes into `docs/prd.html`; do not blindly replace historical text or alter unrelated explainer layout.
4. Add an `Unreleased` section to `CHANGELOG.md` describing:
   - Herdr Terminal as fourth theme;
   - theme-aware OSC background/cursor synchronization;
   - isolated visual evidence.
   Do not rewrite the v0.3 historical statement that three themes shipped in that release.
5. Run focused tests, then canonical gates:

```bash
pnpm test
pnpm typecheck
pnpm dead-code:strict
pnpm render:bible
pnpm visual:review -- --scenario herdr-theme-active-runtime
pnpm visual:ci -- --scenario active-runtime-160x45
```

6. Re-run `pnpm render:bible` once more and confirm `git diff --exit-code` for generated Bible assets after the second run.
7. Review final diff for accidental Cathedral token/golden changes and verify `.claude/` remains untouched/untracked.
8. Manually launch against the isolated fixture in a real TTY and verify:
   - first frame is near-black/cyan with no Cathedral flash;
   - `/theme cathedral`, `/theme herdr`, and cycle shortcut repaint immediately;
   - restart preserves Herdr;
   - `/sumo:cursor reset` survives a theme switch without re-enabling OSC 12;
   - exit restores the user's Ghostty background and cursor.
9. If available on both Macs, repeat the launch/switch/exit smoke after syncing the branch because OSC handling can vary by terminal host. This is verification only; no machine-specific theme values belong in source.

**Exit:** code, product truth, deterministic artefacts, automated gates and real-TTY behaviour agree.

## Acceptance criteria

### Functional

- `listThemes()` returns exactly `cathedral`, `amber-crt`, `obsidian`, `herdr` in that order.
- `getActiveTheme()` remains Cathedral on a fresh config.
- `setActiveTheme("herdr")` and persisted startup resolve the Herdr bundle.
- All theme entry points—direct command, selector, cycle shortcut and restart—converge on the same registry name and persistence path.
- Theme changes repaint retained UI, OSC 11 background and active OSC 12 cursor without restart.
- Explicit cursor reset remains respected across theme changes.
- Shutdown restores terminal defaults.

### Visual

- The runtime reads as near-black Herdr operational tooling, not Cathedral recoloured and not Matrix cosplay.
- Cyan is the primary active/focus signal; mint means ready/healthy; gold means execution; pink means approval/danger.
- Body copy is warm off-white; metadata is cool dim grey; all required contrast checks pass.
- Chrome and indicator glyphs are width-stable in the renderer.
- No content/layout regression appears at 160x45, and existing Cathedral active-runtime evidence remains within its current contract.
- Review documentation includes actual capture paths/metrics and human observations.

### Quality

- `pnpm test`, `pnpm typecheck`, and `pnpm dead-code:strict` pass.
- Bible generation is deterministic on a second run.
- Herdr scenario completes without empty/fallback/error rejection.
- No approved golden is changed without a separate explicit promotion decision.
- No personal configuration or secret enters the fixture.
- No unrelated worktree file is staged or modified.

## Test matrix

| Area | Automated proof | Manual proof |
|---|---|---|
| Registry/order | registry tests | selector order |
| Persistence | startup + command tests | restart with Herdr selected |
| Token contract | `herdr.test.ts` | theme-check overlay |
| Contrast/glyph width | `herdr.test.ts` | visual readability review |
| Host background | terminal lifecycle/runtime tests | no first-frame brown flash |
| Cursor semantics | cursor + runtime tests | reset then switch theme |
| Resume/exit | lifecycle tests | suspend/resume and shell restoration |
| Retained UI repaint | shell/runtime tests + visual scenario | direct and shortcut switching |
| Visual intent | Bible generation + scenario diffs | review document |
| Existing theme safety | full tests + Cathedral active runtime | switch among all four |

## Risks and mitigations

1. **Terminal palette flash at startup**
   Mitigation: pass the active palette into initial terminal ownership; do not start with a Cathedral constant and repaint later.

2. **Cursor reset preference is lost**
   Mitigation: `applyPalette` changes OSC 12 only when the owner already considers the cursor overridden; test reset -> switch.

3. **Theme listener leak**
   Mitigation: one subscription per runtime start, dispose on every stop/stop-during-start path, assert listener effects cease after stop.

4. **Visual test reads personal config**
   Mitigation: committed minimal fixture and explicit repo-relative `PI_CODING_AGENT_DIR`.

5. **Herdr becomes illegible neon**
   Mitigation: exact restrained palette, automated 4.5:1 checks, dim/body separation, human full-scene review.

6. **Historical docs become false**
   Mitigation: update current “has three themes” claims, but keep v0.3 changelog/roadmap statements describing what that release shipped.

7. **Generated Bible churn**
   Mitigation: one dedicated generator, deterministic output, second-run diff check, no edits to other generated targets.

8. **Existing Cathedral parity is weakened**
   Mitigation: Herdr starts as `review`; existing required scenarios/goldens remain unchanged and are rerun.

## Rollback

A safe rollback removes the Herdr bundle/export/registry entry, fixture, design target/scenario/review docs and current product-doc references. Keep the generic terminal-palette synchronization if it has passed independently: it fixes an existing multi-theme correctness defect for Amber CRT and Obsidian as well. If that seam itself regresses terminal restoration, revert the runtime/controller portion as one unit and restore the prior lifecycle tests before release.

## Definition of done

The task is done only when Herdr is selectable, persistent and fully repainted; terminal background/cursor match it without startup flash; reset and restoration semantics are proven; a deterministic independent target and real runtime capture have been reviewed; all canonical gates pass; and no existing theme evidence or unrelated worktree state has changed.
