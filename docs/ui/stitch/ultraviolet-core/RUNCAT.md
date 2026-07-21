# Ultraviolet Core RunCat indicator

Ultraviolet Core can opt into Fredy Sandoval's RunCat working indicator as an enhanced capability. The default remains the eight-frame ASCII orbital pulse.

## Provenance

- Upstream: https://github.com/FredySandoval/pi-runcat
- Pinned commit: `44a35444464755d8a2ade22ab8a7211cd1069c45`
- Source tweet: https://x.com/devfredy/status/2059960736709808403
- Font: `assets/fonts/runcat.ttf`
- Licence: 0BSD, copied in `assets/fonts/runcat.LICENSE`
- SHA-256: `3c5be14dc51cd0d21b34cbd40fe147ff61480ce03655eb43571008975b395d94`

## Contract

- Frames: `U+E900`, `U+E901`, `U+E902`, `U+E903`, `U+E904`
- Cadence: 167 ms
- Spacing: no leading/trailing whitespace in frame strings; SumoCode renders ` <frame>  Working…` with a TWO-cell gap (`labelGapCells: 2`) — the icomoon glyph overdraws its declared cell and a single space visually vanishes (observed live in Ghostty)
- Color: Ultraviolet accent `#B974FF`
- Label: existing dim lavender `Working…` (`#9B7BBE`)
- Width: each frame is one logical terminal cell

## Enablement

```bash
pnpm runcat:install
pnpm runcat:check
```

Ghostty/cmux mapping:

```text
font-codepoint-map = U+E900-U+E904=icomoon
env = SUMOCODE_RUNCAT_FONT=1
```

Restart Ghostty/Herdr/SumoCode after changing the mapping or env. Run `/sumo:spinner` to inspect the active resolved indicator.

Rollback:

```text
env = SUMOCODE_RUNCAT_FONT=0
```

`runcat:check` verifies the font file and hash only. It does not verify the terminal's live codepoint map.

## Visual acceptance

The enhanced runtime scenario must prove the final working row contains one violet PUA frame at the indicator cell, one separator space, and `Working…` at the same label column as the fallback scenario. Human canary review still judges recognizability: automation can prove bytes, width, color, and geometry, not that the glyph looks like a cat on every configured Mac.
