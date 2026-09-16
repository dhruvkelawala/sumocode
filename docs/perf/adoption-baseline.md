# Effect adoption performance baseline

This is the reviewed pre-adoption baseline for Plan 118. Raw samples, source identity, native artifact identity, and numeric ceilings live in [`adoption-baseline.json`](adoption-baseline.json). These numbers were collected after the production-boundary work and do not reuse the historical rc.112 research runs.

## Build the pinned native baseline

The comparison accepts only the clean archive whose source commit and checksum identity match the JSON record. Rebuild it in a detached clean checkout with the repository's pinned Bun version:

```bash
git worktree add --detach /tmp/sumocode-effect-baseline 8135d0512bb5bcfa0f056e54bd7c484c54968ab0
pnpm --dir /tmp/sumocode-effect-baseline install --frozen-lockfile
pnpm --dir /tmp/sumocode-effect-baseline build:native
```

`build.json` binds the archive to the clean source commit. `SHA256SUMS` binds every distributed file. The comparison rechecks every file and requires artifact identity `5464ad17cd2ad3246aba3a54015f870d664379a4bd4a27ab88751db5d743f360`; a dirty, mutated, wrong-source, or differently rebuilt baseline fails before sampling.

## Native regression gate

Build the candidate from a clean commit, then compare exact archives:

```bash
out="$(mktemp -d /tmp/sumocode-native-regression.XXXXXX)"
pnpm perf:native:compare -- \
  --baseline /tmp/sumocode-effect-baseline/dist/native/sumocode-0.7.2-macos-arm64 \
  --candidate dist/native/sumocode-0.7.2-macos-arm64 \
  --out "$out"
```

The harness alternates 15 samples per artifact under one fixture and environment. It fails on any incomplete sample, candidate editor-ready median above baseline median + baseline MAD, any command-ready median increase, or any widening of the editor-to-command gap. `results.json` keeps every raw timing sample and both identities.

## Source and extension budgets

Run the current clean source checkout and its matching native archive:

```bash
out="$(mktemp -d /tmp/sumocode-adoption-budget.XXXXXX)"
pnpm perf:adoption -- --native dist/native/sumocode-0.7.2-macos-arm64 --out "$out"
node scripts/check-tsc-budget.mjs
```

The first command measures 15 source host imports and evaluates classic/RPC source-built and native-distributed extension bundles inside the corresponding Pi child. It also gates executable bundle bytes. The reviewed ceilings allow 100 ms for source host-import drift, 512 KiB per extension bundle for the first Effect slices, and 25 ms of extension evaluation growth. The second command is the already-shipped full-pass compiler gate over [`typecheck.json`](typecheck.json); no incremental cache or replacement baseline is added here.

Also retain the existing source startup comparison for startup-path slices:

```bash
pnpm perf:startup:compare -- --base <pre-adoption-ref> --samples 15 --out "$(mktemp -d /tmp/sumocode-source-startup.XXXXXX)"
```

## Baseline refresh policy

There is no record/update flag. A run writes only to `--out`; it never edits the committed baseline. Refreshing `adoption-baseline.json` requires a clean pre-adoption artifact, the full raw 15-sample observations, an explicit review of every new ceiling, and a normal code-review diff. A regression cannot turn itself green by running the tool again.
