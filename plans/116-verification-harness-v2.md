# Plan 116 — Verification harness v2

## Status

DONE — implemented on the Plan 116 isolated worktree based at `0a00886`.

## Motivation

The integration lane was not merely flaky. A complete run deterministically poisoned later runs:
13 tests in eight files failed in isolation until manual cleanup. Reproduction found day-old
`sumocode-fake-pi-*` loops, a 3.9 GiB compile cache inherited from another checkout, an ambient
`NODE_PATH` resolving Pi 0.84.1 instead of this worktree's 0.84.3, and tests mutating shared host
and extension artifacts. Activation failures were especially opaque because the PTY harness
captured terminal bytes but discarded the child failure context needed to explain why
`extension_activate_begin` had no matching `extension_activate_end`.

## Defects addressed

1. **Unsupervised process trees** — PTYs and direct RPC children could outlive tests and suites.
2. **Ambient process state** — children inherited arbitrary shell variables, caches, and session
   metadata; temporary state had no run-level namespace.
3. **Shared artifacts** — `rpc-host-shell` modified the checkout's `dist/host`, `dist/extension`,
   and bundle inputs while later tests were booting from those paths.
4. **Blind readiness and poor timeout evidence** — startup was inferred from escape/text patterns,
   and timeout errors contained only a small raw-output suffix.

## Design

### Run orchestrator and namespace

`package.json#test:integration` enters `scripts/run-integration-harness.mjs`. The orchestrator:

- runs the preflight before creating state;
- creates one `sumocode-harness-v2-run-*` root containing `tmp`, `node-compile-cache`, package
  snapshot, child manifest, and evidence trees;
- copies the package source into that root, links only this worktree's installed dependencies, and
  builds private host/extension bundles there;
- runs the ten harness-seam tests, then the 159-test integration lane (the original 158 tests plus
  `fixtures/focused-harness-probe.test.ts`) serially;
- audits every registered process group and removes the namespace only after a green zero-survivor
  audit. Failed runs write `evidence-retained.json` and print the retained run path.

### Process supervision

`test/integration/harness-supervisor.ts` is the shared process boundary. Direct RPC children use
`spawnSupervisedProcess`, which forces a new process group. `spawnPiPty` registers node-pty's
session/process group, and the two remaining raw-PTY call sites register through the same seam.
Cleanup targets the process group, waits after TERM, escalates to KILL, and records spawn/exit/reap
JSONL events. The supervisor stamps the shared harness signature at its boundary; PTY callers use
the same exported key/value before spawn so the child process table remains identifiable. The outer
runner repeats group cleanup on suite failure or signal and fails if the audit found any survivor,
even when escalation removed it.

### Focused fallback lifecycle and retained evidence

A focused Vitest invocation has no outer run namespace, so importing `harness-supervisor.ts`
registers an import-time `afterAll` audit. The first evidence or spawn call creates a
`sumocode-harness-v2-focused-*` fallback root with `owner.json`, pins child `TMPDIR` beneath that
root, and tracks every registered process group. The final hook performs the same TERM→KILL audit:
a green run removes its fallback root; any observed survivor retains the root and fails the test.
The focused fixture verifies that this lifecycle finishes before a following preflight.

Timeout capture marks its containing full or focused run with `evidence-retained.json`. The outer
runner does the same for build or lane failure. Preflight reports marked roots as retained evidence,
plain `--fix` preserves them, and only `--fix --purge-evidence` may remove them. This keeps failure
artifacts available without allowing a dead `owner.json` or a forged report path to authorize
arbitrary temp-directory deletion.

### Environment isolation

`buildSpawnEnv` now starts from an explicit allowlist rather than cloning `process.env`. Synthetic
per-test overrides remain possible, but run-owned `TMPDIR` and `NODE_COMPILE_CACHE` are pinned
last. `NODE_PATH`, provider credentials, Herdr variables, Pi session variables, retired SumoCode
runtime variables, and unrelated ambient keys do not cross the boundary. Existing per-child agent
roots and fake-Pi stubs now live beneath the run TMPDIR.

### Preflight

`scripts/preflight-integration.mjs` names:

- live children carrying the v2 harness signature or the historical `sumocode-fake-pi-*` signature;
- stale harness run/lock/state directories;
- a worktree `node_modules` symlink resolving outside the worktree;
- host/extension outputs inconsistent with their `.inputs.json` manifests.

`--fix` is intentionally narrow: it sends TERM→KILL only to matching harness process groups and
removes only harness-prefixed state. It does not rebuild artifacts, replace dependencies, or touch
arbitrary temp files. Ambient cache/session variables are reported as contained contamination,
not fatal contamination, because the orchestrator replaces or strips them before any test child.

### Readiness and evidence

The readiness table maps `boot`, `input`, and `app` to the diagnostics available at this base:
`boot_screen_frame`, `input_ready`, and `app_ready`. Call sites that need readiness use
`waitForReady`; semantic output waits remain output predicates. The table is deliberately a small
exported value so Plan 094's later `editor_ready`/`command_ready` events can be added without
changing callers.

Every PTY gets an evidence directory and diagnostics file. Pattern, readiness, early-exit, and
screen timeout failures write:

- `argv.txt`;
- `stderr-tail.txt`;
- `diagnostics.jsonl`;
- `raw-output.txt`;
- `final-screen.txt`.

The failure message prints that directory. node-pty exposes one merged terminal stream rather than
separate stdout/stderr descriptors, so PTY `stderr-tail.txt` contains the complete merged PTY tail;
direct RPC children retain a true stderr pipe. This preserves terminal foreground/input semantics,
which a tee wrapper broke during TDD, while still retaining activation exceptions that were
previously discarded.

### Artifact isolation

The full lane boots the RPC launcher from the run-private package snapshot. In addition,
`rpc-host-shell.test.ts` gives every case its own `mkdtemp` + `cp` package/artifact snapshot and
changes cwd only for that case. This is stricter than a sequential-last mutation bucket: a failed
restore can damage only that test's soon-deleted copy, never the next test or the checkout.

## Acceptance mapping

| Contract | Implementation and proof |
|---|---|
| A | Process-group registration in `harness-supervisor.ts`; TERM→KILL cleanup; runner abort handlers; manifest audit prints zero survivors and makes any observed survivor fatal. |
| B | Allowlisted `buildSpawnEnv`; one run root for TMPDIR/cache/state/evidence/private package; inherited NODE_PATH, caches, Herdr, Pi-session, credential, and unrelated keys stripped or replaced. |
| C | Preflight script runs before Vitest, names each poison class with remediation, and limits `--fix` to harness signatures/state prefixes. |
| D | Timeout/early-exit evidence contains argv, captured child stream or direct stderr tail, diagnostics, raw bytes, and final replayed screen; errors print the path. |
| E | Extensible diagnostic readiness table and `waitForReady` seam use `boot_screen_frame`, `input_ready`, and `app_ready` at this pre-094 base. |
| F | Run-private built package plus per-case private `rpc-host-shell` copies; no sequential shared-artifact exception required. |
| G | Ten harness-seam tests plus the 159-test integration lane run green; two consecutive full-run evidence is recorded below. |

## Verification evidence

- Consecutive run 1: seam 5/5, integration 158/158, 134 process groups, zero survivors,
  174 seconds wall clock.
- Consecutive run 2 in the same shell: seam 5/5, integration 158/158, 134 process groups,
  zero survivors, 213 seconds wall clock.
- `pnpm exec tsc --noEmit`, `pnpm build`, and `pnpm lint` pass.
- Unit assertions pass 2,618/2,618 with one worker. The default parallel command remains
  load-sensitive at this base under high machine load, matching the existing Plan 096 ledger;
  no unit/runtime source was changed by Plan 116.

## Tradeoffs

- PTY stderr cannot be separated without inserting a foreground wrapper that changes raw terminal
  ownership and signal behavior. The retained evidence therefore labels and stores the merged PTY
  stream; direct non-PTY RPC clients preserve true stderr separation.
- Preflight permits a `package.json` change limited to harness scripts when validating the committed
  extension bundle. Package scripts do not enter emitted extension bytes; all other manifest input
  drift remains fatal, and the run-private bundle is rebuilt from current inputs before testing.
- Artifact isolation copies about 5 MiB per `rpc-host-shell` case. The extra I/O is accepted because
  it removes restoration correctness from the test contract and kept the full lane under three
  minutes on the verification machine.
