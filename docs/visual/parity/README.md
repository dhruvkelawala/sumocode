# V2 Cathedral Visual Parity

Declarative scenario/crop registry and approved runtime goldens for the V2 Cathedral Visual Harness.

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
```

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
