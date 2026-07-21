# Ultraviolet RunCat visual review

- Final automated visual rerun commit: `a4d1d825c9d5c39952b55bf71fe7d7060a75b699` (`fix(visual): remove stray metadata sequence expression`).
- Fallback target: `docs/ui/bible/renders/theme-ultraviolet-core-active.png`
- RunCat target: `docs/ui/bible/renders/theme-ultraviolet-core-runcat-active.png`
- Latest review pack: `docs/visual/out/parity/index.html`

## Commands

```bash
pnpm vitest run scripts/visual-v2/terminal-dom-renderer.test.mjs scripts/visual-v2/final-cell-contract.test.mjs scripts/visual-v2/review-pack.test.mjs src/visual-parity-contract.test.ts
rm -f docs/ui/bible/theme-ultraviolet-core-runcat-active.html
pnpm render:bible
test -f docs/ui/bible/theme-ultraviolet-core-runcat-active.html
shasum -a 256 docs/ui/bible/theme-ultraviolet-core-runcat-active.html > /tmp/runcat-bible-1.sha256
pnpm render:bible
shasum -a 256 docs/ui/bible/theme-ultraviolet-core-runcat-active.html > /tmp/runcat-bible-2.sha256
cmp /tmp/runcat-bible-1.sha256 /tmp/runcat-bible-2.sha256
pnpm visual:review -- --scenario ultraviolet-core-active-runtime
pnpm visual:review -- --scenario ultraviolet-core-runcat-active-runtime
pnpm dead-code:strict
```

## Automated evidence

- `ultraviolet-core-active-runtime`: exited 0 with result `review`; coordinate-scoped final-cell assertions enforce one violet orbital glyph at row 36 col 1, separator at col 2, and `Working…` at col 3.
- `ultraviolet-core-runcat-active-runtime`: exited 0 with result `review`; `docs/visual/out/parity/ultraviolet-core-runcat-active-runtime/raw/final-cell-contract.txt` reports `Final cell contract: PASS (3 assertion(s))`.
- RunCat geometry audit: `Geometry audit passed: 45 rows, no mismatches`.
- RunCat styled-cell diff remains review evidence (`diffRows: 41`) rather than a hard gate.
- Raw glyph evidence is required by scenario contract with `[\uE900-\uE904]` and the final-cell contract verifies the exact positioned cell, width, and foreground.
- `pnpm dead-code:strict` is not a passing scoped gate for this branch. It reproduces the same pre-existing broad Knip inventory observed on clean `main`, so it is recorded only as baseline-failure evidence.

## Human judgement

Pending two-Mac canary. Automation proves bytes, cell width, foreground, separator, and label geometry; it cannot judge whether the mapped glyph is recognizable as a cat in the live terminal font stack.
