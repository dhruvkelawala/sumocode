# Audit issue publication manifest

Published 2026-08-28 to `dhruvkelawala/sumocode` (public) as issues #385–#409 after maintainer confirmation. The plan files/index remain authoritative. Post-review body synchronization completed against planning baseline `6eb9c6c`; Plan 105 was subsequently rejected after the cheap-agent execution trial and issue #399 was closed with that evidence. Plan 101 was reconciled to the landed Pi 0.84.3 baseline before publication to `main`.

The repository currently has only the open `v0.4` GitHub milestone. These issues therefore carry internal milestone M1–M6 in their title/body and remain unassigned to a GitHub milestone. Existing labels only are used; this workflow does not create labels or milestones.

Security issue bodies are sanitized. Their full executor plans remain local, are explicitly ignored by `plans/.gitignore`, and must not be pasted or committed to this public repository.

| Plan | Public title | Body source | Labels | Internal milestone |
|---|---|---|---|---|
| 091 | `[P0 · M1] Isolate extension-install tests from real Pi state` | full plan | enhancement, ready-for-agent | M1 |
| 092 | `[P0 · M1] Make PTY test children credential-safe and state-hermetic` | `plans/issues/092.md` | bug | M1 |
| 093 | `[P0 · M1] Index terminal state and collapse startup reconciliation` | full plan | enhancement | M1 |
| 094 | `[P0 · M1] Expose editor-ready and command-ready states truthfully` | full plan | bug, sumo-tui | M1 |
| 095 | `[P1 · M1] Make visible steering acknowledgements settlement-aware and honest` | full plan | bug, ready-for-agent | M1 |
| 096 | `[P1 · M1] Mirror Pi option consumption without corrupting the initial prompt` | full plan | bug | M1 |
| 097 | `[P0 · M2] Keep prompts out of process metadata and diagnostics` | `plans/issues/097.md` | bug | M2 |
| 098 | `[P1 · M2] Harden visible-subagent task artifact handling` | `plans/issues/098.md` | bug | M2 |
| 099 | `[P1 · M2] Bound child-process protocol buffers` | `plans/issues/099.md` | bug | M2 |
| 100 | `[P1 · M2] Redact sensitive terminal data before session publication` | `plans/issues/100.md` | bug | M2 |
| 101 | `[P1 · M3] Test every published Pi patch in the advertised supported range` | full plan | enhancement | M3 |
| 102 | `[P1 · M2] Remediate reachable dependency advisories` | `plans/issues/102.md` | bug | M2 |
| 103 | `[P2 · M3] Replace timing sleeps with observable-state waits` | full plan | enhancement | M3 |
| 104 | `[P1 · M3] Cover terminal completion and recovery end to end` | full plan | enhancement | M3 |
| 105 | `[P2 · M3] Keep the integration lane integration-only` | full plan | enhancement, ready-for-agent | M3 |
| 106 | `[P2 · M3] Scale terminal supervision with active work` | full plan | enhancement | M3 |
| 107 | `[P2 · M3] Bound retained streaming work with long history` | full plan | enhancement, sumo-tui | M3 |
| 108 | `[P1 · M3] Preserve parent executable provenance in nested work` | full plan | bug | M3 |
| 109 | `[P1 · M3] Contain localized subagent lifecycle failures` | full plan | bug | M3 |
| 110 | `[P2 · M4] Evaluate Effect v4 behind the subagent lifecycle seam` | full plan | enhancement | M4 |
| 111 | `[P2 · M4] Extract a plain-TypeScript RPC host lifecycle seam` | full plan | enhancement, sumo-tui | M4 |
| 112 | `[P2 · M5] Preserve delegated work across session replacement` | full plan | enhancement | M5 |
| 113 | `[P2 · M5] Add an explicit worktree result disposition loop` | full plan | enhancement | M5 |
| 114 | `[P3 · M5] Add visible subagent budgets and stall warnings` | full plan | enhancement | M5 |
| 115 | `[P2 · M6] Reconcile active documentation with RPC-first SumoCode` | full plan | documentation | M6 |
