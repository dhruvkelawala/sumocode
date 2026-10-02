# Effect adoption performance baseline

## v0.8 port status: pending measurement and review

The tooling from PR [#597](https://github.com/dhruvkelawala/sumocode/pull/597) is replayed onto integration base `97897ae98c052e5defde6f40e0da18ffe39a001f`. The pinned native baseline is `98406d428ff562f4c57269dbc361e8f51d4a2cef` (the completed replay, before the v0.8 measurement adaptations). Its `src/**`, dependency lockfile and Bun pin are identical to the integration base. The replay only adds measurement/build tooling; it does not adopt Effect.

The old Node 25 / pre-memory-removal timings and bundle ceilings are **not applicable**. [`adoption-baseline.json`](adoption-baseline.json) deliberately contains no replacement observations or numeric ceilings yet. Normal `perf:adoption` fails before collection until that record is explicitly reviewed. Do not collect the final observations on a shared/busy machine.

## Reconstruct the clean native baseline

Use Node 24, pnpm 10.29.2 and the locally installed Bun 1.4.0 pinned by `.bun-version`; do not use global configuration. The following workstation setup also routes subprocess calls to pnpm through the exact pinned CLI (the existing compiler checker invokes `pnpm`):

```bash
NODE24=/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin/node
PNPM_CLI=/Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs
export PATH="$(dirname "$NODE24"):$PWD/.srt-spike/bin/bun-darwin-aarch64:$PWD/.srt-spike/bin:$PATH"
export BUN_BIN="$PWD/.srt-spike/bin/bun-darwin-aarch64/bun"
run() {
  env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID \
    -u VITEST_MAX_WORKERS -u VITEST_MIN_WORKERS LEFTHOOK=0 "$@"
}
p() { run "$NODE24" "$PNPM_CLI" "$@"; }
# .srt-spike/bin/pnpm must invoke NODE24 + PNPM_CLI, never a global pnpm.
export TMPDIR="$(mktemp -d /private/tmp/sumocode-589-quiet.XXXXXX)"
export HOME="$TMPDIR/home" PI_CODING_AGENT_DIR="$TMPDIR/agent"
export SUMOCODE_CONFIG_DIR="$TMPDIR/config" SUMOCODE_STATE_DIR="$TMPDIR/state"
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$SUMOCODE_CONFIG_DIR" "$SUMOCODE_STATE_DIR"
```

A detached baseline worktree and archive may already exist at `.local/589-baseline`. If absent, create and build them:

```bash
git worktree add --detach "$PWD/.local/589-baseline" 98406d428ff562f4c57269dbc361e8f51d4a2cef
p --dir .local/589-baseline install --frozen-lockfile --ignore-scripts --store-dir "$PWD/.srt-spike/pnpm-store"
p --dir .local/589-baseline build:native
```

`build.json` binds an archive to its clean source commit. `SHA256SUMS` covers every distributed file; the comparison verifies both directions of the manifest. Bun embeds build paths, so a clean rebuild elsewhere can have different bytes: each run records the actual archive hash, not a purported reproducible binary hash. Dirty, mutated, unlisted and wrong-source archives fail before sampling. Do not remove this worktree without approval.

## Quiet-machine collection commands

From a clean committed port checkout, after the setup above:

```bash
out="$PWD/.evidence/589-quiet-$(date +%Y%m%d-%H%M%S)"
p build:native
p perf:native:compare -- \
  --baseline "$PWD/.local/589-baseline/dist/native/sumocode-0.7.6-macos-arm64" \
  --candidate "$PWD/dist/native/sumocode-0.7.6-macos-arm64" \
  --fixture-count 0 --out "$out/native"
# Run this even if the native verdict rejects the candidate; keep both reports.
p perf:adoption -- --collect-only \
  --native "$PWD/dist/native/sumocode-0.7.6-macos-arm64" --out "$out/adoption"
run "$NODE24" scripts/check-tsc-budget.mjs
```

Writes:

- `dist/native/sumocode-0.7.6-macos-arm64/**` and native metafiles (ignored build artifacts).
- `$out/native/results.json` and `report.md`: two exact source/archive identities, fixture/flags/machine, 15 raw samples per arm, medians/MAD and verdict. Failed samples retain `$out/native/NN-<arm>.jsonl`.
- `$out/adoption/results.json` and `report.md`: clean source/archive identities, Node/Bun/CPU, 15 source host-import samples, classic/RPC source/native bundle bytes and 15 in-Pi-child evaluation samples for each bundle. Successful collection is labeled **UNREVIEWED**, not a passing budget gate.

No collection command edits tracked baseline files. Host imports and Pi children use isolated HOME/config/state directories. Source extension probes retain the production dependency-leakage guard. Extension marks bracket the emitted bundle body **inside Pi**, not a host-only import. Static external module setup precedes those marks; readiness and host-import gates cover costs outside the body interval.

The candidate's budget observations carry their own source identity, distinct from the pinned native comparison arm. Runtime sources at the port are unchanged from `97897ae9`; record the budget report's source identity as `baseline.budgetSourceCommit` when reviewing it.

## Verdicts and reviewed budgets

Normal native comparisons always collect 15 alternating samples per arm under one fixture/environment. They reject incomplete collection, editor-ready median above baseline median + one baseline MAD, any command-ready median increase, or any editor-to-command gap widening. `--smoke 1` (at most 2) checks only complete collection and editor interaction, labels its report **SMOKE-ONLY**, and cannot satisfy the deterministic adoption gate. Smoke timings must not be promoted as baseline evidence.

Review the quiet-machine reports, then manually update `adoption-baseline.json` in a normal review diff: `recordedAt`, `baseline.machine`, `baseline.budgetSourceCommit`, raw `baseline.measurements`, all nine `budgets` entries, and `status: "reviewed"`. Each budget needs a measured `baseline` and an explicitly approved `max`. The old allowances (10% host-import growth, 512 KiB per bundle, 25 ms evaluation growth) are proposals to reconsider, **not approved v0.8 numbers**. Compute any approved allowance from this base's new observations, never from PR #597's obsolete values.

After review, normal `p perf:adoption -- --native <clean-candidate-archive> --out <new-dir>` requires an exact match of platform, architecture, Node, Bun and CPU. It rejects missing budgets, missing/non-finite samples, or exceeded ceilings. `--collect-only` can collect on a new machine but never certify a migration or silently refresh the committed policy.

Keep the existing source-arm comparison (`p perf:startup:compare -- --base <pre-adoption-ref> --samples 15 --out <outside-checkout-dir>`, verdict not `REGRESSED`) for production adopters. Reuse `scripts/check-tsc-budget.mjs` against `docs/perf/typecheck.json`; do **not** use its `--record` flag to absorb adoption cost. The port does not change that checker, compiler baseline or CI wiring.

## Tradeoffs

Extension evaluation cleanup reuses the source startup harness's POSIX group probe and bounded wait: TERM, 500 ms grace, KILL, then 500 ms to prove the whole detached group empty. Leader exit alone is insufficient; only `ESRCH` proves emptiness. Windows evaluation fails before spawning because this probe cannot certify its descendant tree. Unproven shutdown aborts collection, writes `shutdown-failure.json` (including PGID), and retains the evaluation directory under `--out`; other incomplete collection errors retain it too. These maintainer scripts own only freshly spawned groups, not processes that daemonize out of them.

Native comparison aborts the alternating schedule on `shutdown-failed` or any sample-runner exception. Unexpected exceptions are conservatively treated as unproven shutdown, even if the process was actually reaped: extra evidence is cheaper than contaminating the next timing by resetting live state. The incomplete report remains a failed collection, records the retained fixture path/reason, and preserves the failed sample's diagnostics; the CLI exits unsuccessfully. Ordinary sample failures with proven shutdown still collect as before.

Timing and numeric budgets remain intentionally incomplete until quiet-machine evidence and human review. The tooling is usable now, but this is not an adoption green light. Two maintainer scripts keep their existing orchestration/effect seams rather than introduce a general benchmark framework. Unexpected PTY errors now attempt process-group cleanup in `finally`; stale diagnostic directories are rejected to keep runs separate. Integration/native-contract/visual lanes and final 15-sample collection were deferred by the coordinator's shared-machine restriction.
