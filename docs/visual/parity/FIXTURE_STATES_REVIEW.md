# Fixture Runtime States Review

Issue: #90
Parent: #80

## Decision captured

Completed assistant/tool states are now represented by deterministic fixture scenes in the V2 harness. These fixtures build `TranscriptViewModel` objects directly, render them through the SumoTUI scene primitives, emit ANSI, and then use the same xterm replay → DOM screenshot → crop/diff review pipeline as runtime captures.

This avoids relying on `--offline --no-session` live Pi output for completed model/tool states, which is intentionally nondeterministic and often stops at active-working/meditating.

## Scenarios added

- `fixture-completed-landscape` — 160×45 completed transcript with read/edit/bash tool blocks.
- `fixture-completed-portrait` — 60×100 completed transcript under the no-sidebar portrait policy.
- `fixture-tool-ledger-landscape` — tool-heavy landscape fixture for reviewing completed tool composition.

All fixture scenarios remain `review` status. No fixture crop is promoted to `approved` or `required` in #90.

## Review command

```bash
pnpm visual:review -- --lane fixture
```

After the review run, check text-level reports before PNGs:

```bash
cat docs/visual/out/parity/<scenario>/raw/styled-cell-diff.txt   # char + fg + bg diff vs Bible
cat docs/visual/out/parity/<scenario>/raw/geometry-audit.txt     # row classification + bounds
```

Review locally at:

```txt
http://127.0.0.1:7781/bible-verify/
```

## Known deferrals

- Rich block-specific renderers (tool ledger cards, code frames, skill pills, Divine Query, delegation cards) still need dedicated component slices. The fixture lane provides deterministic scene reachability first.
- Command palette overlay requires a Scriptorium-themed palette renderer rewrite before it can be fixtured (tracked separately).
- Additional overlays (approval modal, Divine Query, memory scriptorium) should follow the fixture lane pattern once their renderers match the Bible.
- Real runtime harness fixture injection via `SUMOCODE_HARNESS_FIXTURE` remains optional future work if we need Pi extension/session chrome involved in completed states.
- Fixture crops are review evidence only until Dhruv explicitly approves a runtime/fixture golden promotion.
