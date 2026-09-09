# SumoCode visual verification

The [V2 parity contract](parity/CONTRACT.md) is canonical. Component fixtures, full transcript fixtures and real RPC-host runtime captures converge on ANSI replay through xterm/headless, a cell snapshot and a DOM terminal renderer.

Styled-cell comparison is the primary content/style evidence. Geometry audits check row categories and column bounds. PNG crops support visual review and required approved-runtime-golden checks. Browser screenshots do not prove identical font fallback across terminal emulators.

## Run

```bash
pnpm render:bible
pnpm visual:review
pnpm visual:ci
```

Review one scenario or lane:

```bash
pnpm visual:review -- --scenario input-typed-component
pnpm visual:review -- --lane fixture
```

Generated evidence lives under docs/visual/out/parity: index.html, results.json and each scenario's raw styled-cell-diff.txt and geometry-audit.txt, followed by PNG captures and crop diffs. Inspect the text reports first. Outputs stay ignored.

CI rejects capture/render failures and drift in required approved crops. Review-only scenes remain evidence until explicitly approved. Bible differences do not automatically authorize runtime changes or golden promotion. `pnpm visual:promote` requires Dhruv's explicit approval of the particular capture.

## Add or change a scenario

Edit `docs/visual/parity/scenarios.json` using an existing scenario in the appropriate component, fixture or runtime lane. Fixture captures use production view-model/rendering seams; runtime captures launch `./bin/sumocode.sh --offline --no-extensions --no-session` through the owned PTY harness. Keep input deterministic and inspect all generated reports before requesting review.

The worktree disposition fixture renders the production retained Activity summary and Divine Query action menu; it is review-only. Existing approved goldens are unchanged. The [Bible inventory](../ui/bible/README.md) describes design targets; a design lock is not implementation approval.

Legacy VHS/tape experiments are historical and do not define the active workflow. Live terminal captures are debugging aids; V2 parity defines the CI gate.
