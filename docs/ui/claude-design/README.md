# Claude Design — Cathedral mockup (v1)

> First Claude Design output for SumoCode Cathedral direction.
> Generated 2026-04-25. Not final — starting reference for v0.2 implementation.

## Files

| File | Purpose |
|---|---|
| `SumoCode Terminal.html` | Open in browser to view interactively. Uses React 18 via CDN + Babel-standalone. Arrow keys cycle through 6 screens. |
| `tokens.css` | Cathedral design tokens (palette, fonts, layout vars). Mirror of `docs/ui/DESIGN.md`. |
| `colors_and_type.css` | Generated companion CSS with type scale and color helpers. |
| `Terminal.jsx` | Shell component: tab bar (row 1) + split-pane (rows 2-43) + separator (44) + footer (45). 160 col × 45 row grid. |
| `Sidebar.jsx` | Right pane (49 cols): CONTEXT / MCP / MEMORY sections. |
| `Screens.jsx` | Per-state left-pane content: idle / streaming / tool-running / approval / memory / palette. |
| `Modals.jsx` | Overlay modals: approval prompt, memory editor, command palette. |
| `_check/idle.png` | Preview screenshot — idle state. |
| `uploads/` | Source materials uploaded to Claude Design. |

## How to view

```bash
cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode/docs/ui/claude-design"
python3 -m http.server 8088
# open http://localhost:8088/SumoCode%20Terminal.html
# arrow keys cycle screens
```

## Status

Layout fidelity ✅ correct (no Stitch template bias).
Content accuracy ✅ matches DESIGN.md spec.
Visual polish ⚠️ starting point — needs iteration based on dogfooding.

## Next iterations

This v1 is the v0.2 implementation reference. Issues found during implementation will get fixed in:
- v1 of the actual Pi TUI extension code (not the Claude artifacts)
- Or: another round of Claude Design iteration if visual issues compound
