# Reproducible startup comparison

Use the comparison command for before/after startup claims. The existing single-checkout `pnpm perf:startup` snapshot remains available.

```bash
out="$(mktemp -d /tmp/sumocode-startup-compare.XXXXXX)"
pnpm perf:startup:compare -- \
  --base <git-ref> \
  --samples 15 \
  --out "$out"
```

The candidate defaults to `HEAD`; `--candidate <ref>` compares another revision. Both refs are resolved to full commit SHAs before collection and run from disposable detached worktrees. The output directory must be outside the caller checkout.

## Isolated state and cleanup

Every timed launch receives a freshly generated private agent directory. The harness sets both `PI_CODING_AGENT_DIR` and `SUMOCODE_STATE_DIR`, uses an empty project/home/config, and never reads `~/.pi` state. The terminal fixture defaults to 1,800 settled schema-v4 records containing fixed synthetic command, owner, title, and output text. Change it with `--fixture-count <count>`.

Fixtures and detached worktrees are deleted after collection. `--keep-fixture` explicitly retains the final generated state and prints its temporary path; worktrees are still removed. Both arms reuse the same absolute fixture path sequentially, rebuilding it before every sample so their metadata is byte-identical. On POSIX the harness signals and verifies the complete PTY process group. If a process tree survives escalation, collection stops and retains the campaign directory and worktrees rather than mutating files still owned by that process; the CLI reports the retained path and exits nonzero. Reports are retained in `--out`, or in the private temporary directory printed when `--out` is omitted.

Each arm uses the same caller-installed dependencies and forced source mode (`SUMOCODE_HOST_BUNDLE=0`, `SUMOCODE_EXTENSION_BUNDLE=0`). This isolates revision code changes and prevents stale generated artifacts from silently changing the workload. Tradeoff: this command does not compare dependency-lock or bundle-build changes; use a separately controlled campaign if those are the subject.

## Metrics

Samples alternate `baseline, candidate`, then `candidate, baseline`, with equal counts. The JSON records the exact order.

- **launcher**: process spawn to host preload.
- **host import**: host preload to selected source-host import completion.
- **RPC child ready**: launch to the first correlated RPC response, proving that the child can answer requests rather than merely that its process spawned.
- **terminal index ready**: the duration of the `TerminalTaskStore.refreshIndex()` scan, measured with `performance.now()` inside the store and carried as `durationMs` on the `terminal_index_ready` mark. This is the targeted Plan 093 metric; it isolates the scan itself rather than manager construction. A revision predating the store-emitted duration falls back to integer wall-clock mark subtraction and loses sub-millisecond resolution.
- **editor ready**: launch to the first editable retained frame.
- **hydration committed**: launch to the authoritative initial state/transcript commit.
- **command ready**: launch to hydrated command dispatch readiness.
- **editor-to-command gap**: command ready minus editor ready.

Terminal index duration can establish that the targeted indexing work improved. It cannot establish an overall startup improvement. Editor ready, hydration committed, command ready, and their gap are aggregate startup signals.

## Verdict policy

For each metric the report includes successful samples, failed count, median, median absolute deviation (MAD), median ± MAD interval, absolute/percentage delta, and `improved`, `regressed`, or `inconclusive`.

A directional verdict requires at least three successful samples per arm, zero failed samples, and non-overlapping intervals. Smaller smoke runs still report measurements but remain inconclusive. Any missing event, failed process, interval overlap, or conflicting metric direction makes overall startup **INCONCLUSIVE**. Reports retain every failed sample. The CLI exits nonzero after writing its artifacts when either arm collected no successful samples or a PTY survived the bounded SIGINT/SIGTERM/SIGKILL shutdown, because collection did not complete safely. These are report-only measurements, not CI wall-clock gates.

A revision that predates a required public-safe phase mark remains a failed sample; the harness does not invent or backfill readiness. Compare revisions that contain the phase diagnostics when making attributed claims.

## Privacy boundary

Comparison diagnostics use a public-startup mode that emits only required event names, timestamps, and the fixed host source/bundle mode; generic runtime, input, argv, cwd, and module-load diagnostics are suppressed. Raw JSONL diagnostics, stderr, and PTY bytes remain process-local. Reports whitelist only numeric phase values, fixed failure categories/event names, exact SHAs, source mode, fixed sanitized flags, fixture count, and coarse runtime metadata (platform, architecture, Node version, CPU count). Neither diagnostics nor reports serialize absolute home paths, prompts, environment values, provider/model names, session IDs, or extension inventory.
