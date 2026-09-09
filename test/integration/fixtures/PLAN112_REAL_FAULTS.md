# Real recovery fault adapter

`subagent-recovery.test.ts` keeps the same 38 names in both modes. Real mode dispatches each fault name explicitly and never enters the fake fixture. Run through `scripts/run-plan112-recovery.mjs` in a new owned 0700 root. The wrapper pins checkout-local Pi 0.84.4 and generates a synthetic provider in that root.

## Cut points

- starting: spawn DI, after the supervisor/writer record, before backend spawn.
- pre-release: existing launch gate DI, before `beforePrompt`; the externally registered anchor is alive and launch intent is durable.
- running: provider receipt and ready record, before normal controller work.
- settling: existing manifest-builder DI, after result persistence.
- post-manifest: `onManifestWritten` dependency, after durable manifest creation and before verification/pointer publication. No environment flag or production caller enables this callback.
- delivery admission/send/notice: the test ExtensionAPI recorder or public registry admission call holds the real controller. The external supervisor kills it, waits for actual lease expiry, and starts a birth-registered replacement.

Held processes are killed only through `signalVerifiedProcessTree` with their original registrations. Each cell and the wrapper retain unknown-failing zero-owned audits. The lifetime census pauses real anchor IPC after Pi exit but before backend cleanup; it does not manufacture a census result.

## Limits and tradeoffs

Lifecycle handoffs and tool/delivery calls use the installed extension APIs in real Node controllers, not an interactive TUI command dispatcher. The completion recipient is a recording ExtensionAPI boundary, not a network/session transport. Fixed provider text and real Pi/parser/persistence are used. Writer takeover waits for the actual 60s lease, rather than moving the clock or editing its expiry. A stale-writer operation is submitted with the original credentials after the original process dies; this proves fencing, not execution by a dead process.

The stale-PID denial records a real process, kills and reaps it, then submits its original authority. This is not proof that the kernel recycled the numeric PID. The different-original cleanup cell likewise checks the original verification is `different` after bounded death observation, denies the stale signal, and confirms cleanup. It does not assert that an unrelated live group occupies the same PGID. The fake cell retains that stronger negative case. A refused cleanup now waits through the existing bounded process-tree emptiness operation rather than requiring instantaneous disappearance; `unknown` never becomes empty and no refused signal is retried.

Three cells still fail explicitly without launching: ambiguous-identity handoff, unknown-anchor PID denial, and unknown-original cleanup. An unprivileged real runner cannot deterministically force the kernel identity oracle to return unknown without substituting the oracle or disturbing foreign processes. These are capability failures, not skips or fake fallback.

### Visible admission

Herdr capability forwarding is explicit: `HERDR_ENV=1`, owned `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, and absolute `PLAN112_HERDR_BIN`. No other operator environment is inherited. The real adapter uses `RetainedVisibleSupervisor` and `backend-pane`, not a fake pane or headless substitute:

1. Herdr creates a pane; `beforeRun` preserves its ID as private evidence, queries the production protocol-20 validator, captures the shell's original process-tree birth, and waits for external ledger registration before command submission. A refused admission does not close by pane ID. An unverified created pane blocks both cell and wrapper zero-owned audits.
2. A short `exec env -i /bin/bash <private-command-file>` strips inherited shell startup overrides before bash. The private command file supplies only the fresh cell allowlist, then execs the backend's nonce-bearing held wrapper. The server-created shell's own initial startup predates admission; no claim is made to gate Herdr's shell startup itself.
3. The backend captures wrapper command and birth; the adapter verifies the SAME original shell PID/birth across exec. The existing retained supervisor independently queries pane→foreground-process association and persists pane/child evidence. External registration of the held wrapper command observation precedes release. The second command observation is not replacement kernel-birth authority; the original shell observation remains in the ledger.
4. The backend releases only after the writer/identity fences. Actual source Pi runs in the pane with the synthetic provider and the existing task-mode extension (zero auto-exit grace for this fixture). Steering is acknowledged by the production consumed-file watcher. Visible role instructions remain the backend's prompt preamble, not a true appended system prompt; the provider receipt checks that documented transport.

The fixture launcher selects the actual checkout Pi CLI directly, rather than the native/retained-TUI product launcher. This proves pane backend/task-mode recovery, not native packaging, retained UI rendering, or interactive slash dispatch. Same-process completion is observed at the ExtensionAPI recorder; cross-process successors still detach before owner completion. All three visible cells require later live-Herdr verification. Fake-host tests exercise the actual JSON query shape, both admission holds, and changed-birth refusal without contacting Herdr.

## Defects found by the first real invocation

Readiness publication now uses rename after a private complete write; file existence alone must not expose an empty JSON file. Registry inspection uses the record's immutable origin session, not an invented observer session.

Settled-result adoption no longer requires the exited child anchor. It validates retained artifacts and retains live-supervisor fencing for cooperative transfer. Dead-writer disk recovery uses the existing death-plus-expiry CAS: unfinished work becomes lost; settled work retains its completion and delivery state. No child is restarted, no old pipes are recovered, and process-effect fences are unchanged. A live or unknown old controller cannot be taken over. Unit tests retain supervisor-loss refusal and prove zero signals for settled recovery.

Runtime results and remaining failures are recorded in the worktree-local `issue-to-pr/406.md`; this document makes no green-matrix claim.
