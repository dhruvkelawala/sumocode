# Plan 117: Ship SumoCode as a native executable

> **Status:** Implemented in open [PR #449](https://github.com/dhruvkelawala/sumocode/pull/449) at `9ef92fa1`, stacked on Plan 107. GitHub CI is green and the PR is mergeable. Nothing is merged.

## Decision

Installed macOS arm64 releases use prebuilt Bun 1.4.0 executables. Repository development remains source-based through `bin/sumocode.sh`, `pnpm dev`, and `pi -e .`. Generated executables and `dist/**` remain untracked; tagged release automation produces checksummed archives.

The archive contains separate host and Pi-child executables, required Pi and SumoCode sidecars, a canonical extension bundle for direct-Pi launches, and a lean RPC-child extension bundle. The compiled child intentionally omits AWS Bedrock registration; source development retains it. This is an explicit owner-approved compatibility boundary.

## Dependencies

- PR #439: generated bundles removed from development-branch version control.
- PR #444: reproducible startup comparison and phase attribution.
- PR #446: lean source-mode RPC child extension entry.
- PR #447 / Plan 107: exact predecessor for the published implementation.

## Shipped scope

- Native launcher/runtime selection, direct-Pi bypass, doctor/diagnostics, reload, and signal forwarding.
- Native asset, worker, terminal-runner, child executable, and extension-bundle resolution.
- macOS arm64 build, checksum, release archive, installer, and compiled-artifact contract suite.
- Static host slash commands at the first editor frame and refresh of an already-open slash menu after child command discovery.
- Terminal-index reconciliation deferred until after command readiness while mutations and completion delivery remain fail-closed until the index is authoritative.

## Measured result

Deterministic M3 Max PTY comparison, Bun 1.4.0, 15 samples per arm:

| Fixture | Node editor ready | Native editor ready | Delta | Node command ready | Native command ready | Delta |
|---|---:|---:|---:|---:|---:|---:|
| 0 records | 549 ± 30 ms | 182 ± 9 ms | **−367 ms** | 920 ± 52 ms | 732 ± 25 ms | **−188 ms** |
| 1,800 records | 540 ± 13 ms | 189 ± 4 ms | **−351 ms** | 1,434 ± 21 ms | 1,303 ± 11 ms | **−131 ms** |

A configured interactive profile improved command readiness from **2,199 ms to 1,008 ms** (−54%). The durable claims are structural: static slash suggestions are available before child discovery, and terminal scanning begins after command readiness. Absolute timings vary with cache warmth and machine contention.

## Preserved contracts

- Hydration and readiness ordering remain truthful.
- Terminal delivery remains unavailable until reconciliation is authoritative.
- Revision CAS, claim leases, process identity, canonical paths, and no-follow file validation remain intact.
- Prompt transport stays out of argv where supported by Pi's modes.
- Source/dev behavior and non-interactive direct-Pi paths remain available.

## Verification status

- GitHub checks at `9ef92fa1`: all green; mergeable.
- Typecheck, build, lint, focused host/editor/terminal suites, deterministic startup gate, and visual CI passed.
- Native aggregate local run: 44/45; the sole failure rotated among unchanged load-sensitive PTY timing tests and each passed in isolation. CI integration is green. Preserve this residual rather than claiming a fully green local aggregate.
- No visual golden was promoted.

## Deferred work

- Plan 108 / #402: preserve executable provenance through every nested child path.
- Plan 102 / #396: dependency advisory remediation.
- Plan 104 / #398: real-process terminal completion and recovery coverage.
- Issue #448: pre-hydration model/thinking key cycles.
- Linux/Windows archives, signing/notarization, and npm publication.

## Done criteria

- [x] A reproducible native archive is built without committing generated output.
- [x] Installed and direct-Pi runtime-selection contracts are covered against the compiled artifacts.
- [x] Editor-ready improves by at least 250 ms at 0 and 1,800 records; command-ready does not regress.
- [x] Static slash completion works at the first editor frame and refreshes after child discovery.
- [x] Terminal scanning is off the command-ready path without weakening delivery correctness.
- [x] Release archives are checksummed and produced from tags.
- [ ] Human acceptance of PR #449 and any later release/signing decision.
