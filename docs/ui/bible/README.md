# Cathedral Visual Bible

Design targets for SumoCode visuals. Design locks record visual decisions, not proof that a runtime surface ships. The [V2 parity contract](../../visual/parity/CONTRACT.md) owns implementation verification: styled-cell comparisons, geometry audits and required approved-runtime crops.

## Run

```bash
pnpm render:bible
```

Regenerates all scripted HTML mockups, then renders every `*.html` via Playwright + chromium → PNG in `renders/`.

Review with `pnpm visual:review`; run required gates with `pnpm visual:ci`. Golden promotion requires explicit human approval.

## Static export + hosting

```bash
pnpm render:bible
pnpm export:bible-static
```

Exports a deployable static site to `dist/bible-site/`:

- `/index.html` redirects to `/bible/`
- `/bible/index.html` is the gallery
- `/bible/*.html` are the full mockups
- `/bible/renders/*.png` are the generated PNG thumbnails/artifacts
- `/bible/_assets/*` contains shared CSS/fonts/assets

Deploy the exported directory with Vercel CLI:

```bash
vercel deploy dist/bible-site
# or production alias:
vercel deploy dist/bible-site --prod
```

Current hosted gallery:

```txt
https://sumocode-bible-static.vercel.app/bible/
```

GitHub Actions runs the same render + export path and uploads `dist/bible-site` as an artifact. It intentionally does **not** auto-deploy to Vercel; deployment stays manual until Vercel project/org secrets and promotion rules are explicitly configured.

## Naming convention

```
<NN>-<element-name>-<state>[-portrait].html
```

- `NN` — element number per `CATHEDRAL_UX_SPEC_V2.md`
- `state` — empty / typed / streaming / approval / etc
- `-portrait` suffix for narrow / portrait dimension variants

Default dimensions: **160 cols × 45 rows** (MacBook landscape).
Portrait dimensions: **60 cols × 100 rows** (Mac mini portrait, sidebar hidden).

## Mockup conventions

- Use `_assets/tokens.css` for all palette + typography variables
- Use `<div class="term" data-render-rect>` as the screenshotable element
- Use `<div class="row">` for each terminal row (one row per div, no nested rows)
- Color helpers: `fg-accent`, `fg-dim`, `fg-fg`, `fg-divider`, `fg-idle`, `fg-think`, `fg-tool`, `fg-approve`, `fg-learn`, `fg-string`, `fg-number`, `fg-keyword`, `fg-fn`, `fg-comment`
- Bg helpers: inline `style="background: var(--surface-recess)"` etc
- Cursor: `<span style="background: var(--accent); color: var(--background);">█</span>`

## Mockup contrast disclaimer

The runtime cathedral palette uses `--divider: #3A2F25` (1.3:1 contrast
against bg). In dark Ghostty with dark-adapted eyes this reads as
intentionally subtle. In PNG export viewed on bright IDE this looks
invisible. The bible uses `--divider-mockup: #5A4D3C` (3:1 contrast) for
legibility WHILE THE RUNTIME PALETTE STAYS LOCKED. This is a design
viewing-context adjustment, not a palette change.

## Element + scene coverage

See `CATHEDRAL_UX_SPEC_V2.md` for the spec. The bible contains standalone element mockups plus full-scene compositions that combine locked elements in the actual Cathedral shell.

Inventory: **107 HTML mockups · 107 PNG renders**. Counts come from top-level HTML and renders/*.png files; the documentation checker compares them with the live inventory.

| Prefix | Group | HTML files |
|---|---|---:|
| 01- | Sidebar | 21 |
| 02- | Top bar | 11 |
| 03- | Splash | 2 |
| 04- | Active input | 4 |
| 05- | Footer | 7 |
| 06- | Approval design | 3 |
| 07- | Memory editor | 2 |
| 08- | Command palette | 6 |
| 09- | Tool pills | 7 |
| 10- | Code blocks | 2 |
| 11- | Divine Query | 3 |
| 12- | Scroll + scribe | 2 |
| 13- | Chat messages | 4 |
| scene- | Scenes | 25 |
| skill- | Skill pill | 3 |
| theme- | Themes | 5 |

Generated files establish design coverage; implementation status belongs to the [plan ledger](../../../plans/README.md) and runtime review evidence. Approval designs remain historical/dormant because [Plan 076](../../../plans/076-disable-approval-gate.md) retired active approval installation.

## Locked decisions summary

### Element 1 — Sidebar
- LOCKED: V2 EDITORIAL direction (magazine display, tracked-out masthead)
- Width 30 cols (down from 49)
- Sub-tabs: CONTEXT (`Ctrl+1`) + MEMORY (`Ctrl+2`)
- Tracked-out section names with narrow-no-break-space (`C O N T E X T`)
- Thick `━` underline rules between sections
- Hero project name (foreground weight) + `on <branch>` subtitle
- Block-fill token bar (22 cells, sage / amber / terracotta by state)
- All rows have uniform surface bg fill (no inter-section gap bug)
- METRICS HUD opt-in via `/metrics on`, `/sidebar [show|hide]` to toggle
- Backups: V3 MARGINALIA (manuscript notes) considered but rejected; V1 DENSE rejected first round

### Element 4 — Active input frame
- No label above frame (drop `INPUT`/`SCRIPTOR INPUT`)
- `>` prompt arrow inside frame in accent color
- Hint row right-aligned: `CTRL+/ · COMMANDS` (`TAB · AGENTS` deferred until agent switching is functional)
- Cursor: terminal user preference (don't override OSC 12); `/sumo:cursor block|bar|thin` to override
- Frame interior: `surface-recess` bg fill on every row

### Element 5 — Footer
- Single row, cathedral state labels (READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING)
- Left zone: `● <STATE> · <model> · <thinking>`
- Right zone: `<ctx>/<window> · $<cost>`
- Project/branch live in sidebar when visible and hint row when sidebar is hidden
- Width handling: collapse right-to-left at narrow (drop cost, then ctx progressively)
- Splash variant: dim version line (`SUMOCODE V0.4.1 · CATHEDRAL · 160 × 45 MONOSPACE`) below footer, splash only

### Scene compositions + harness
- `pnpm render:bible` now regenerates scripted HTML before rendering PNGs, so new/renamed element mockups cannot appear in the gallery without their PNG thumbnails.
- `scripts/bible-server.mjs` groups non-element mockups into **Skill pill** and **Scene compositions** sections instead of `Element ??`.
- Gallery image URLs include a render-time cache-buster (`?v=<png-mtime>`), so browsers recover from previously-missing thumbnails after re-render.
- Missing thumbnails show an explicit `PNG MISSING — run pnpm render:bible` card state.
- Runtime active-working targets are live-submitted prompt scenes: the submitted prompt plus the faux-provider `inspecting src/auth/session.ts` stream. They are separate from the richer completed/tool transcript targets, which remain fixture/review canon.
- Current scene files:
  - `scene-active.html`
  - `scene-active-portrait.html`
  - `scene-active-runtime.html`
  - `scene-active-runtime-portrait.html`
  - `scene-active-tool-ledger.html`
  - `scene-active-bash-live-view.html`
  - `scene-active-code-block.html`
  - `scene-active-skill-pill.html`
  - `scene-active-scroll-scribe.html`
  - `scene-approval-overlay.html`
  - `scene-divine-query-overlay.html`
  - `scene-memory-scriptorium-overlay.html`
  - `scene-session-selectors.html`
  - `scene-palette-overlay.html`

### Element 12 — Scroll + scribe delegated work
- LOCKED: underlying task/sub-agent work renders as `[scroll]` assigned to a `scribe`
- `[scroll]` is the visible outer tool tag; `scribe` is the nested actor label
- Avoid `child agent` in UI; avoid visible `[task]` except developer docs for Pi internals
- Outer framed pill matches Element 9 (`━━━ [scroll] ... ━━━ ▶ running`)
- Inner ledger shows `scribe · model · thinking`, nested tool calls, token counts, elapsed time
- Completion/failure use clear state labels: `✓ done`, `✗ failed`

### Element 13 — Chat messages
- LOCKED: closed-frame boxes with rounded corners `╭─╮ │ │ ╰─╯`
- **Default (single-tone)**: ALL boxes transparent interior — just the frame, no bg fill
- SUMO header has time right-aligned on top border (no model id)
- USER header has just `╭ USER ─────...───╮` (no metadata)
- 1 blank row between boxes
- Slash command `/sumo:chat-style {default | sharp | dual}` for alt variants
- Color update: `--surface-lifted: #3A342F → #3D3024` (warmer amber, was reading as cool grey)

## Backup directions (rejected, archived)

Earlier design notes recorded these rejected backups under the former docs/ui/bible/_archive/ directory; that directory is absent from the current checkout:
- `13-chat-brutalist.html` — heavy `━━━` rules, `[USER]/[SUMO]` brackets
- `13-chat-ledger.html` — numbered entries `001 │ USER`, right-aligned timestamps

Deleted (rejected during round 1 grilling): illuminated, stele, versicle, oracle.
