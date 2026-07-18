# Ultraviolet Core Visual Review

- **Date:** 2026-07-18
- **Branch:** `advisor/075-ultraviolet-core-application-theme`
- **Implementation commit under review:** `989b2f5` (`test(visual): add ultraviolet application review scenarios`)
- **Issue:** https://github.com/dhruvkelawala/sumocode/issues/319
- **Review pack:** `docs/visual/out/parity/index.html`
- **Result scope:** review evidence only; no approved runtime golden was promoted.

## Commands run

```bash
pnpm render:bible
pnpm visual:review -- --scenario fixture-ultraviolet-core-tool-ledger
pnpm visual:review -- --scenario fixture-ultraviolet-core-code-block
pnpm visual:review -- --scenario fixture-tool-ledger-landscape
pnpm visual:review
```

The final `pnpm visual:review` run regenerated a combined 21-scenario review pack so the Ultraviolet runtime, Ultraviolet fixtures, and Cathedral regression artifacts sit in one output tree.

## Runtime evidence

Scenario: `ultraviolet-core-active-runtime`

- lane: `runtime`
- status: `review`
- result: `review`
- geometry audit: passed, no mismatches
- runtime command exited 0
- fixture config: `test/fixtures/pi-agent-ultraviolet-core`
- captured OSC evidence:
  - `#06050B` appeared once in raw runtime output (OSC 11 background)
  - `#B974FF` appeared once in raw runtime output (OSC 12 cursor)
  - stale/Cathedral values `#1A1511`, `#D97706`, and stale canary cursor `#BB7DFF` did not appear

Crop summary:

| Crop | Result | Diff ratio | Notes |
|---|---:|---:|---|
| full | passed | 0.01991 | within review threshold |
| top-bar | review-diff | 0.02457 | expected review-only chrome drift |
| sidebar | review-diff | 0.04620 | expected runtime/Bible sidebar content drift |
| chat-area | passed | 0.01574 | active message area within threshold |
| input-frame | passed | 0.01834 | within threshold |
| hint-row | passed | 0.00499 | within threshold |
| footer | review-diff | 0.02114 | expected review-only footer drift |

## Themed fixture evidence

### `fixture-ultraviolet-core-tool-ledger`

- lane: `fixture`
- fixture: `tool-ledger`
- selected theme: `ultraviolet-core`
- result: `review`
- geometry audit: passed, no mismatches
- full crop: passed at `0.01704`
- chat-area crop: review-diff at `0.02386`
- input-frame crop: review-diff at `0.05406` because it compares against the shared Cathedral input component target

Snapshot colour evidence confirms application-role routing:

- tool surface `#17100D` present
- tool border `#6B4A1C` present
- tool label `#FFC857` present
- tool body/target `#FFE1A6` present
- tool muted body `#C7A96D` present
- violet structural colours (`#56347A`, `#B974FF`) remain present outside the ledger

Judgement: tool bodies are amber-tinted and localized to the ledger; the whole scene remains violet-dominant.

### `fixture-ultraviolet-core-code-block`

- lane: `fixture`
- fixture: `code-block`
- selected theme: `ultraviolet-core`
- result: `passed`
- geometry audit: passed, no mismatches
- full crop: passed at `0.00716`
- chat-area crop: passed at `0.00752`

Snapshot colour evidence confirms code-role routing:

- code surface `#100A1D` present
- code border `#56347A` present
- foreground `#DCC7FF` present
- gutter/comment `#9B7BBE` present
- keyword `#B974FF` present
- string/function ice `#75E8FF` present

Judgement: code blocks use violet/ice/lavender semantic syntax without leaking the legacy Cathedral comment colour from the renderer.

## Existing-theme regression evidence

Scenario: `fixture-tool-ledger-landscape`

- selected theme: Cathedral fallback (`capture.theme = "cathedral"`)
- result: `review`
- geometry audit: passed, no mismatches
- required chat-area crop: passed at `0.00653`
- full crop: passed at `0.00633`

Judgement: introducing application roles did not break the required Cathedral tool-ledger crop. Remaining review diffs are existing review-lane differences, not a required-gate failure.

## Human review notes

- Ultraviolet Core reads as a violet-black command layer, not a pale generic theme with purple accents.
- Expanded tool ledgers now have a distinct amber-tinted application surface/body while retaining violet outer structure.
- Code blocks use theme-owned syntax roles and no longer require renderer-local Cathedral syntax constants.
- Runtime selection proves the first/live host background and cursor paths use the persisted Ultraviolet fixture.
- All Ultraviolet scenarios remain `review`; no `docs/visual/parity/approved-runtime/**` file was modified or promoted.
