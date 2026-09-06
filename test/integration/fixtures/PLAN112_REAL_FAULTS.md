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

The stale-PID denial records a real process, kills and reaps it, then submits its original authority. This is not proof that the kernel recycled the numeric PID. Forcing kernel inspection failure or safe foreign-PID recycling is not supported; ambiguous/unknown and different-original cleanup cells fail explicitly rather than substituting an OS double.

Herdr capability forwarding is explicit: `HERDR_ENV=1`, owned `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, and absolute `PLAN112_HERDR_BIN`. No other operator environment is inherited. A birth-registered controller runs the existing validated `inspectPane` query. Reachability does **not** imply visible recovery coverage: server-created pane shells do not yet have pre-execution birth admission in this wrapper. No pane is created until that accounting gap is closed. Visible cells therefore fail with a source-incomplete classification when the query succeeds, not `herdr unavailable`.

## Defects found by the first real invocation

Readiness publication now uses rename after a private complete write; file existence alone must not expose an empty JSON file. Registry inspection uses the record's immutable origin session, not an invented observer session.

Settled-result adoption no longer requires the exited child anchor. It validates retained artifacts and retains live-supervisor fencing for cooperative transfer. Dead-writer disk recovery uses the existing death-plus-expiry CAS: unfinished work becomes lost; settled work retains its completion and delivery state. No child is restarted, no old pipes are recovered, and process-effect fences are unchanged. A live or unknown old controller cannot be taken over. Unit tests retain supervisor-loss refusal and prove zero signals for settled recovery.

Runtime results and remaining failures are recorded in the worktree-local `issue-to-pr/406.md`; this document makes no green-matrix claim.
