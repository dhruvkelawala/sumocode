# Cathedral Visual Bible

Single source of truth for SumoCode runtime visuals. Each element has one
canonical mockup per dimension variant. The runtime must match these
renders pixel-by-pixel modulo font-hinting tolerance.

## Run

```bash
pnpm render:bible
```

Renders all `*.html` mockups via Playwright + chromium → PNG in `renders/`.

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
against bg). In dark cmux/Ghostty with dark-adapted eyes this reads as
intentionally subtle. In PNG export viewed on bright IDE this looks
invisible. The bible uses `--divider-mockup: #5A4D3C` (3:1 contrast) for
legibility WHILE THE RUNTIME PALETTE STAYS LOCKED. This is a design
viewing-context adjustment, not a palette change.

## Element coverage

See `CATHEDRAL_UX_SPEC_V2.md` for the spec. 13 elements × ~2 dimension
variants × 2-3 states each = ~50-70 mockups when complete.

| Element | Status |
|---|---|
| 1 — Sidebar | TODO |
| 2 — Top bar | TODO |
| 3 — Splash | TODO |
| 4 — Active input frame | ✅ landscape + portrait, empty + typed |
| 5 — Footer | TODO |
| 6 — Approval modal | TODO |
| 7 — Memory editor | TODO |
| 8 — Command palette | TODO |
| 9 — Tool pills | TODO |
| 10 — Code blocks | TODO |
| 11 — DIVINE QUERY | TODO |
| 12 — Task tool | TODO |
| 13 — Chat messages | TODO |
