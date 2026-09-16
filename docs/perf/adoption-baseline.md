# Effect adoption performance baseline

This is the reviewed pre-adoption baseline for Plan 118. Raw samples, pinned source identity, and numeric ceilings live in [`adoption-baseline.json`](adoption-baseline.json). These numbers were collected after the production-boundary work and do not reuse the historical rc.112 research runs.

## Build the pinned native baseline

The comparison accepts only a checksum-verified clean archive built from the source commit pinned in the JSON record. PR [#597](https://github.com/dhruvkelawala/sumocode/pull/597) retains that commit after branch deletion or squash merge. Fetch its read-only pull ref, then rebuild in a detached clean checkout with the repository's pinned Bun version:

```bash
git fetch origin refs/pull/597/head:refs/remotes/origin/pr-597
git worktree add --detach /tmp/sumocode-effect-baseline 8135d0512bb5bcfa0f056e54bd7c484c54968ab0
pnpm --dir /tmp/sumocode-effect-baseline install --frozen-lockfile
pnpm --dir /tmp/sumocode-effect-baseline build:native
```

`build.json` binds the archive to the clean source commit. `SHA256SUMS` binds every distributed file, and the comparison rechecks every file before sampling. Bun embeds build paths, so a clean rebuild elsewhere can have a different reported artifact checksum; the reviewed policy pins the source commit rather than one machine's path-dependent archive bytes. Dirty, mutated-after-build, or wrong-source archives still fail before sampling.

## Native regression gate

Build the candidate from a clean commit, then compare exact archives:

```bash
out="$(mktemp -d /tmp/sumocode-native-regression.XXXXXX)"
pnpm perf:native:compare -- \
  --baseline /tmp/sumocode-effect-baseline/dist/native/sumocode-0.7.2-macos-arm64 \
  --candidate <candidate-archive> \
  --out "$out"
```

The harness alternates 15 samples per artifact under one fixture and environment. It fails on any incomplete sample, candidate editor-ready median above baseline median + baseline MAD, any command-ready median increase, or any widening of the editor-to-command gap. `results.json` keeps every raw timing sample and both identities. Failed samples also retain their private JSONL diagnostics in `--out`; successful-sample diagnostics are deleted.

## Source and extension budgets

Run the current clean source checkout and its matching native archive:

```bash
out="$(mktemp -d /tmp/sumocode-adoption-budget.XXXXXX)"
pnpm perf:adoption -- --native dist/native/sumocode-0.7.2-macos-arm64 --out "$out"
node scripts/check-tsc-budget.mjs
```

The first command requires the platform, architecture, Node, Bun, and CPU to match the recorded baseline machine. It then measures 15 source host imports and evaluates classic/RPC source-built and native-distributed extension bundles inside the corresponding Pi child. It also gates emitted extension-bundle bytes. The reviewed ceilings allow 10% (130 ms) for source host-import drift, 512 KiB per extension bundle for the first Effect slices, and 25 ms of extension evaluation growth. The second command is the already-shipped full-pass compiler gate over [`typecheck.json`](typecheck.json); no incremental cache or replacement baseline is added here.

Also retain the existing source startup comparison for startup-path slices:

```bash
pnpm perf:startup:compare -- --base <pre-adoption-ref> --samples 15 --out "$(mktemp -d /tmp/sumocode-source-startup.XXXXXX)"
```

## Baseline refresh policy

There is no record/update or alternate-record flag. A run always loads the committed baseline, writes only to `--out`, and never edits the record. Refreshing `adoption-baseline.json` requires a clean pre-adoption artifact, the full raw 15-sample observations, an explicit review of every new ceiling, and a normal code-review diff. A regression cannot turn itself green by running the tool again.
