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

Scene review records:

- `ACTIVE_LANDSCAPE_REVIEW.md` — #86 composed active landscape runtime review

Run one scenario:

```bash
pnpm visual:review -- --scenario input-typed-component
```

Run one lane:

```bash
pnpm visual:review -- --lane component
pnpm visual:review -- --lane runtime
```

## Contract

- Visual Bible renders are the design target.
- Runtime goldens are approved implementation checkpoints, not design targets.
- `required` crops gate against committed runtime goldens after explicit promotion.
- Legacy V1 labels such as `SCRIPTOR INPUT` and 49-column sidebar assertions are historical only; V2 active input is label-less and the sidebar is 30 columns.

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
