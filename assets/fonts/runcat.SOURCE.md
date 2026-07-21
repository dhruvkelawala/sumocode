# RunCat font provenance

SumoCode vendors only the RunCat font asset from Fredy Sandoval's `pi-runcat` project.

- Upstream repository: https://github.com/FredySandoval/pi-runcat
- Pinned commit: `44a35444464755d8a2ade22ab8a7211cd1069c45`
- Original filename: `runcat.ttf`
- Repository path: `assets/fonts/runcat.ttf`
- SHA-256: `3c5be14dc51cd0d21b34cbd40fe147ff61480ce03655eb43571008975b395d94`
- Size: 3,532 bytes
- Internal family/PostScript name: `icomoon`
- Covered codepoints: `U+E900` through `U+E904`
- Licence: 0BSD, copied in `assets/fonts/runcat.LICENSE`
- Source announcement: https://x.com/devfredy/status/2059960736709808403

SumoCode adapts the five RunCat PUA codepoints and upstream 167 ms cadence into its existing working-indicator system. Upstream frame strings include trailing spacing for the original extension; SumoCode intentionally removes that spacing because the product renders its own ` <frame> Working…` row geometry.

The cat glyphs are authored by Fredy Sandoval, not SumoCode.
