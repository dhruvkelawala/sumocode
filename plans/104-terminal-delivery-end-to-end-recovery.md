# Plan 104: Add real-process terminal completion and recovery coverage

> **Executor instructions**: Follow this plan step by step and run every verification command. Build tests before changing production behavior. Use isolated Pi/session/terminal roots and no credentials. Exercise the real `TerminalTaskManager` and `TerminalDeliveryCoordinator`; a fixture that calls `sendMessage` directly does not satisfy this plan. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Reconciled baseline (2026-09-04):** `9ef92fa1` (PR #449 / Plan 117). Terminal-index initialization is now deferred until after command readiness, mutations initialize synchronously on demand, and `TerminalDeliveryCoordinator.flush()` remains fail-closed while `manager.isIndexReady()` is false. Tests must preserve and exercise that boundary; never restore a blocking constructor scan to make recovery fixtures easier.
>
> **Drift check (run first)**: `git diff --stat 9ef92fa1..HEAD -- test/integration/terminal-completion-fidelity.test.ts test/integration/terminal-completion-recovery.test.ts test/integration/spawn-pi-pty.ts test/fixtures src/background-tasks/terminal-tools.ts src/background-tasks/task-manager.ts`
> **Working-tree preflight (run at the same time)**: run `git status --short` and STOP if it reports pre-existing work. Generated `dist/**` is ignored and must not be committed.
> If the drift check reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation. At dispatch, create the branch from the exact current stack top; `9ef92fa1` remains the Plan 117 semantic baseline so intervening in-scope drift stays visible.
> **Read-only runtime check**: `git diff --stat 9ef92fa1..HEAD -- src/activity/manager-bridge.ts src/extension-core.ts src/sumo-tui/rpc/host.ts src/native/main.ts src/sumo-tui/rpc/spawn-child.mjs sumo-rpc-host.js test/integration/harness-supervisor.ts test/integration/native-contract.test.ts scripts/run-integration-harness.mjs`. These own Activity takeover, the deferred startup gate, native runtime selection, and process supervision. If their contracts change in a way this plan must edit, STOP and reconcile rather than widening a coverage plan.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/issues/092.md`, `plans/093-index-terminal-store-startup.md`, `plans/issues/100.md` (security dependencies are sanitized publicly; full executor plans stay local)
- **Category**: tests
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28; reconciled to `9ef92fa1`, 2026-09-04
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/398

## Why this matters

Unit tests cover delivery claims and retries with a fake manager, while the existing integration fidelity test injects a synthetic `terminal-result` directly through `pi.sendMessage`. No real-process test proves that an actual terminal settles, is claimed once, survives host replacement, appears in the right session, and is acknowledged only after observability. These are data-loss/duplication boundaries.

## Current state

- `test/integration/terminal-completion-fidelity.test.ts` launches Pi RPC with a fixture extension whose command directly calls `pi.sendMessage`; it never starts `TerminalTaskManager` or `TerminalDeliveryCoordinator`.
- `src/background-tasks/terminal-tools.test.ts` thoroughly models claim/retry/idempotency using a fake in-memory manager.
- Production delivery in `terminal-tools.ts` uses durable completion IDs, claim tokens, leases, active-session ownership, and post-send branch observability.
- Plan 117 moved `TerminalTaskManager` index initialization off the command-ready path. `isIndexReady()` is false until a complete validated scan lands; mutations call `ensureIndexInitialized()` on demand; the coordinator returns before claiming/sending while the index is unavailable and is woken through the existing task-change notification when initialization completes.
- `ActivityManagerBridge` adds a separate durable feed writer/takeover lease.
- `test/integration/native-contract.test.ts` proves compiled terminal start/check/stop and the post-command index mark, but it does not cover passive/wake completion publication, coordinator replacement, lease recovery, or session ownership. This plan remains necessary and keeps `pnpm test:native` as a regression gate without widening its implementation scope.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| New integration | `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false` | pass |
| Existing fidelity | `pnpm vitest run test/integration/terminal-completion-fidelity.test.ts --fileParallelism=false` | pass |
| Delivery units | `pnpm vitest run src/background-tasks/task-manager.test.ts src/background-tasks/terminal-tools.test.ts src/activity/manager-bridge.test.ts --fileParallelism=false` | pass |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && BUN_BIN=${BUN_BIN:-bun} pnpm test:native` | exit 0 |

## Generated bundle policy

PR #439 superseded committed-bundle instructions: `dist/**` and native archives are generated and ignored. Build them for verification, but never commit generated output.

## Scope

**In scope**:
- `test/integration/terminal-completion-recovery.test.ts` (create).
- Test fixtures/extensions under `test/fixtures/`.
- Minimal test seams in terminal manager/coordinator only if needed for deterministic crash points.
- Existing fidelity test may be renamed/clarified but remains as Pi details serialization coverage.

**Read-only regression surface**:
- `src/activity/manager-bridge.ts` and its existing tests. Host replacement in this plan means manager/coordinator replacement for session-message delivery; Activity writer-death/takeover remains its separate tested contract.
- Plan 117's host/native startup-gate files and `test/integration/native-contract.test.ts`; exercise them through existing gates, do not add compiled-only scope unless a real gap forces a plan stop.

**Out of scope**:
- Changing delivery policy to make tests easier.
- Deleting durable records after tests outside test-owned roots.
- Live provider calls, real user sessions, or real terminal history.
- Retention/GC.

## Git workflow

- Branch: `advisor/104-terminal-delivery-recovery-tests`
- Commit: `test(terminals): cover completion recovery end to end`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Build an isolated real-Pi fixture

Create temporary `PI_CODING_AGENT_DIR`, session directory/file, terminal store, activity state, and working directory. Launch the real extension/RPC child offline. Start a deterministic short terminal command through the actual registered tool or fixture command and capture its stable terminal/completion identity without parsing presentation prose when typed details are available.

Name the first test `delivers a passive terminal once through the real coordinator`.

**Verify**: `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false -t "delivers a passive terminal once through the real coordinator"` → one pass; `rg -n "TerminalTaskManager|TerminalDeliveryCoordinator" test/integration/terminal-completion-recovery.test.ts` → both production class names are present in imports/construction.

### Step 2: Test index readiness and exact-once normal delivery

Start and settle a real terminal through an initial manager, then replace the manager/coordinator while holding the replacement manager's injected scheduled index initialization at a deterministic marker. While `manager.isIndexReady()` is false, assert that the replacement coordinator neither claims nor publishes the durable completion. Release the scan, observe the existing change notification, and then assert:
- correct owner session only;
- stable completion ID/details survive RPC replay and session hydration;
- acknowledgement occurs only after the message is observable;
- a later idle/agent-settled event does not insert a duplicate;
- session-facing output is redacted/bounded per Plan 100;
- the replacement path does not add a constructor-time scan or bypass the deferred scheduler.

Add a separate incomplete-generation case using the existing deterministic store read-fault seam: let initialization run but return `ok:true, complete:false` because an unknown durable record was skipped transiently. Assert no claim/publication while incomplete; clear the fault, run the scheduled retry, and assert the newly indexed completion is delivered once. Do not conflate “callback has not run” with “scan ran but coverage is incomplete.”

**Verify**: `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false -t "delivers a passive terminal once through the real coordinator|defers delivery for an incomplete terminal index"` → pass; the test parses the session JSONL and asserts exactly one message with the captured completion ID before and after a later settled event.

### Step 3: Test crash/replacement recovery

Introduce two fixture-level crash points without adding production callbacks. For claim-before-send, subscribe to the real manager after coordinator construction, wait until the durable snapshot first enters `deliveryState:"claimed"`, write a marker, and terminate the fixture process before `pi.sendMessage`. For send-before-ack, wrap the real fixture `pi.sendMessage`, await the real call, write a marker, and terminate before the coordinator's queued reconciliation/acknowledgement runs. Start a replacement manager/coordinator after lease expiry: the first case reclaims and inserts once; the second observes the stable completion ID and acknowledges without reinserting.

Use explicit marker files/events and supervised process exits, not sleeps, `dispose()`, or a fake manager.

Name the crash tests `reclaims a claim stopped before branch observability` and `acknowledges an observable completion without reinserting after replacement`.

**Verify**: `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false -t "reclaims a claim|acknowledges an observable"` → two passes; each test asserts one matching completion ID and durable `delivered` state.

### Step 4: Test session ownership and explicit observation races

Complete a terminal owned by session A while B is active; assert B receives nothing and A receives/reconciles on resume. Race `terminal_check`/`wait` against idle delivery and assert exactly one user-visible result path wins, matching existing unit contracts.

Name the ownership/race tests with `owner session` and `observation race` in their titles.

**Verify**: `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false -t "owner session|observation race"` → all selected tests pass and each asserts zero matching completion IDs in the wrong session plus one total user-visible result.

### Step 5: Run full gates

Ensure every child and temporary root is cleaned in `afterEach`, including failures.

**Verify**: all command-table commands pass.

## Test plan

Required scenarios: deferred-not-started index, transient `complete:false` index, passive, wake, busy owner, wrong active session, check race, wait race, crash-before-send, crash-after-send, lease expiry, persisted replay, malformed/corrupt unrelated record, child cancellation, and cleanup. The full native suite remains a regression gate, but this plan's new crash-point fixture stays source-driven unless a compiled-only behavior gap is discovered and separately reconciled.

## Done criteria

- [ ] Tests exercise real manager/store/coordinator code.
- [ ] Both deferred-not-started and transiently incomplete index states prove fail-closed publication and wake delivery exactly once after a complete validated scan.
- [ ] Normal and both crash windows prove exact-once observable delivery.
- [ ] Session ownership and observer races are covered.
- [ ] Existing direct-send fidelity test remains as serialization coverage only.
- [ ] No real user state or credentials are read.
- [ ] `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false` exits 0 with the named passive, crash, ownership, and race tests.
- [ ] Full gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 104's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- The drift check changes a Current state behavior/signature, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Passing the fixture would require a synchronous constructor scan, publishing before `isIndexReady()`, or weakening Plan 117's post-command reconciliation contract.
- Determinism requires editing or deleting the user's terminal store.
- Pi offers no observable boundary for one crash window and no safe test seam can expose it.
- The test discovers a production duplication/loss bug; stop and split a corrective plan before weakening assertions.

## Maintenance notes

Any delivery protocol change must update this integration test and the fake-manager unit suite together. Keep IDs in assertions; presentation text is not the idempotency contract.
