# V2 Cathedral Visual Parity

Declarative scenario/crop registry and approved runtime goldens for the V2 Cathedral Visual Harness.

Read `CONTRACT.md` first for the authoritative runtime/crop/status semantics.

## Run

```bash
pnpm render:bible
pnpm visual:review
```

Review pack:

```txt
docs/visual/out/parity/index.html
```

Run one scenario:

```bash
pnpm visual:review -- --scenario input-typed-component
```

Run one lane:

```bash
pnpm visual:review -- --lane component
pnpm visual:review -- --lane runtime
pnpm visual:review -- --lane fixture
```

## Verification outputs

After a review run, each scenario writes text-level reports alongside the PNG review pack:

```txt
docs/visual/out/parity/<scenario>/raw/
  styled-cell-diff.txt     # char + fg + bg diff vs Bible HTML (primary)
  styled-cell-diff.json    # structured diff for failing rows (when applicable)
  geometry-audit.txt       # row classification + column bound checks
  geometry-audit.json      # structured mismatch list
  terminal-snapshot.json   # full xterm cell grid
```

Check text reports before inspecting PNGs:

```bash
cat docs/visual/out/parity/<scenario>/raw/styled-cell-diff.txt
cat docs/visual/out/parity/<scenario>/raw/geometry-audit.txt
```

## Scenario lanes

| Lane | Input | Purpose |
|---|---|---|
| `component` | Deterministic fixture → ANSI | Isolated TUI component captures |
| `fixture` | `TranscriptViewModel` → full scene ANSI | Deterministic completed/tool/overlay states without live Pi |
| `runtime` | `./bin/sumocode.sh` via node-pty | Real end-to-end runtime captures |

Fixture transcripts are declared in `scripts/visual-v2/fixture-capture.mjs`. Add new completed/tool/overlay states there.

## Contract

- Visual Bible renders are the design target.
- Runtime goldens are approved implementation checkpoints, not design targets.
- `required` crops gate against committed runtime goldens after explicit promotion.
- Legacy V1 labels such as `SCRIPTOR INPUT` and 49-column sidebar assertions are historical only; V2 active input is label-less and the sidebar is 30 columns.
- Styled cell diff is the primary verification layer. PNG diffs are review evidence.

See `CONTRACT.md` for the full contract.

## Runtime scenario notes

`splash-runtime` invokes the user-facing contract directly:

```bash
./bin/sumocode.sh --offline --no-extensions --no-session
```

The scenario rejects known loader/error output (`ERR_MODULE_NOT_FOUND`, terminal-width crashes, dev-checkout extension skips, and raw `Error [` screens) as hard capture failures. #71's original blank/offline splash failure is therefore not hidden by an accepted screenshot: the capture must show the V2 splash or fail before review.

The active runtime scenarios submit a prompt and capture the deterministic offline **active-working** state. They intentionally do not wait for a completed model answer because `--offline --no-session` cannot produce one deterministically. Completed-response scene captures should be fixture-backed in a later slice.

## Status model

- `review` — report Bible/runtime drift, do not fail CI on pixels.
- `approved` — runtime golden exists; drift is visible in review pack.
- `required` — runtime golden exists; drift fails CI.

Hard failures always fail:

- invalid manifest
- missing Bible target
- runtime capture crash
- known error screen in capture
- blank capture
- render failure
- crop out of bounds
- malformed results

## Promotion

Only promote after explicit developer approval:

```bash
pnpm visual:promote -- --scenario <scenario-id> --crop <crop-id> --status approved
pnpm visual:promote -- --scenario <scenario-id> --crop <crop-id> --status required
```

Promotion copies the latest runtime crop from `docs/visual/out/parity/` into `docs/visual/parity/approved-runtime/` and updates `scenarios.json` with the selected crop status.
