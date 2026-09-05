# Plan 112: Preserve delegated work across session replacement with a durable subagent registry

> **Executor instructions**: Follow this plan step by step and run every verification command. Begin with a feasibility gate for headless and visible backends. Preserve children on shutdown only after durable identity, recovery, and delivery are proven. Never leave an untracked process running. Do not delete worktrees or task directories automatically. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host dist/extension src/subagents src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts src/activity/manager-bridge.ts src/activity/manager-bridge.test.ts src/task-mode.ts src/task-mode.test.ts test/integration/subagent-recovery.test.ts scripts/visual-v2/fixture-capture.mjs docs/visual/parity/scenarios.json`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension src/subagents src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts src/activity/manager-bridge.ts src/activity/manager-bridge.test.ts src/task-mode.ts src/task-mode.test.ts test/integration/subagent-recovery.test.ts scripts/visual-v2/fixture-capture.mjs docs/visual/parity/scenarios.json`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state behavior/signature, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/095-truthful-visible-steering-acks.md`, `plans/issues/097.md` (prompt transport), `plans/issues/098.md` (visible task-directory hardening), `plans/104-terminal-delivery-end-to-end-recovery.md`, `plans/109-contain-subagent-lifecycle-failures.md`
- **Category**: direction
- **Milestone**: M5 — Product durability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/406

## Why this matters

Every `/reload`, `/new`, `/resume`, or `/fork` calls `manager.disposeAll()` because subagents have no persistent registry. Active delegated work is intentionally killed to avoid orphaning, and pending delivery is cleared. This is honest but undermines durable delegation; the next manager should adopt verifiable children and deliver their final manifests exactly once.

## Current state

`src/subagents/index.ts:269-284` explicitly documents the divergence from durable terminals and kills every child on `session_shutdown`:

```ts
pi.on("session_shutdown", () => {
	clearStatusWidget(latestContext);
	// ... unsubscribe + delivery.clear()
	manager.disposeAll();
});
```

`SubagentManager` stores snapshots, queue, children, consumed IDs, and pending delivery only in memory. Headless backend stdout is pipe-parsed by the parent, while visible backend has private task-directory response/exit/control files. Completion manifests already carry base/head/branch/worktree/changed-path evidence.

Use terminal persistence as a safety pattern, not as a schema to copy blindly:
- private canonical store paths;
- schema/revision validation and task locks;
- PID/start/process-tree verification;
- explicit `lost`/ambiguous states;
- durable completion IDs, claim leases, observable acknowledgement;
- no automatic retention deletion.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Registry/subagents | `pnpm vitest run src/subagents/registry.test.ts src/subagents/*.test.ts` | pass |
| Activity/delivery | `pnpm vitest run src/activity/manager-bridge.test.ts && pnpm visual:review -- --scenario fixture-subagent-recovery-states-landscape` | pass; recovered/lost/ambiguous capture exists |
| Recovery integration | `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false` | pass |
| Full/visual | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | exit 0 |

## Generated bundle verification

After final source edits, run `pnpm build:host && pnpm build:extension` before `pnpm test`; registry/Activity contracts may enter both bundles. PR #439 and current `AGENTS.md` supersede the original committed-bundle requirement: `dist/**` is ignored verification/release output, never committed or required as a tracked test fixture. Rebuild after final integration in the assigned heavy verification lane.

## Scope

**In scope**:
- Generated host/extension bundles for verification only; no tracked `dist/**` changes.
- `src/subagents/registry.ts` and `src/subagents/registry.test.ts` (create), plus required schema/manager/backend/index changes under `src/subagents/`.
- `src/task-mode.ts` marker/heartbeat/session support required for recovery.
- Subagent Activity/delivery adapter and bridge.
- `test/integration/subagent-recovery.test.ts` and its isolated fixtures (create).
- `scripts/visual-v2/fixture-capture.mjs` and `docs/visual/parity/scenarios.json` for one deterministic review-only 160×45 fixture covering recovered, lost, and ambiguous cards. Use the existing activity-cards Bible target only as a comparison baseline; do not alter Bible/runtime goldens.

**Out of scope**:
- Automatic task-dir/worktree deletion or archival.
- Remote/distributed recovery across machines.
- Changing worktree disposition (Plan 113).
- Automatic stalled-child cancellation (Plan 114).
- Reusing terminal records as subagent records.
- Bible HTML/PNG targets, parity runtime goldens/status, required crops, or golden promotion.

## Git workflow

- Execution branch: `sumo/plan112-feasibility-and-registry-implementation`
- Pinned prerequisite: PR #457 at `99b8cc4d7e0f73fccd71c94f109903a768077d25`; the execution checkout starts at that exact commit. Publication requires a fresh top-of-stack check and integration, not an inference from GitHub mergeability.
- Commit by phase: feasibility/protocol, registry, adoption, delivery.
- Message: `feat(subagents): recover work across session replacement`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Feasibility gate both backends

Prove how each backend survives:
- same-process session factory replacement;
- host/Pi process reload;
- parent crash/restart.

Visible panes already externalize lifecycle evidence. Headless children currently depend on parent pipes; design a private append-only event/result file or session-backed continuation protocol plus detached verified process identity. If exact recovery of an already-running headless child is not possible without a Pi/private protocol change, STOP and scope v1 durability to visible children plus queued/not-started headless work—do not claim full recovery.

Write the decision/state matrix in the integration test and name cases `feasibility: <backend> across <replacement>`.

**Verify**: `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false -t "feasibility:"` → every visible/headless × factory replacement/reload/parent-crash matrix cell passes as `recoverable`, `queued-only`, or `unsupported`; no cell is omitted or called recoverable without observable result/control evidence.

### Step 2: Define durable schema and ownership lease

Create a versioned subagent record containing stable ID, owner session, backend kind, status, task directory, process identity, pane/worktree/session references, model/role labels, timestamps, completion ID, delivery claim state, and bounded manifest/result pointers. Prompt content remains in private artifacts, not metadata.

Use revision-checked atomic writes, private modes, canonical paths, and a process writer lease. Include explicit `lost` and `ambiguous` recovery outcomes.

**Verify**: `pnpm vitest run src/subagents/registry.test.ts` → round-trip, corrupt/duplicate/symlink, stale revision, lease generation, PID/start identity, and owner-isolation cases pass.

### Step 3: Persist before launch and settle durably

Write `starting` before spawning, persist verifiable identity before releasing the child start gate, then transition `running`. Settlement writes result/manifest and durable delivery state before notifying in-memory listeners. Preserve worktree and pane references on all failures.

**Verify**: `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false -t "transition crash:"` → starting/pre-release/running/settling/post-manifest crashes end in a tracked `running`, `settled`, `lost`, or `ambiguous` durable record; the test fails if its child PID/pane lacks a record.

### Step 4: Adopt on replacement instead of unconditional disposal

On session replacement/reload, the old manager enters `handoff`: stop accepting new control actions, persist its final lease generation, unregister session UI/delivery listeners, but do not signal the child. The new manager loads only owned records, verifies live identities/panes, and CAS-acquires the next lease generation before attaching control/watchers.

Use one fail-closed rule when transfer does not complete:
- if the old owner is still alive and still holds the lease, it remains the sole persist-only supervisor until settlement or a later successful handoff; the new manager mirrors read-only state and cannot signal/deliver;
- if the old owner is dead and the child identity can be revalidated, acquire only after lease expiry/generation CAS;
- if identity cannot be proven, persist `ambiguous`/`lost`, issue no signal, and expose manual inspection. Never terminate a child merely because transfer failed.

**Verify**: `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false -t "ownership handoff:"` → `/new`, `/resume`, `/fork`, `/reload`, live-old-owner, expired-owner, and ambiguous-identity cases each have exactly one control owner; blocked new managers make zero signal/delivery calls.

### Step 5: Make result delivery durable and exact-once

Persist completion IDs/claims. Check/wait/cancel/close suppress or consume pending wake exactly as terminal tools do. Replacement after insertion-before-ack must observe the completion ID and acknowledge without duplicating. Activity feed should stop converting intentionally preserved subagents to `lost` on normal session shutdown.

**Verify**: `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false -t "exact-once delivery:"` → insertion-before-ack, settle-after-handoff, check/wait/cancel/close races each produce one completion ID in the correct owner session and zero duplicates.

### Step 6: Run full gates and visual evidence

Update status/list/card copy to distinguish recovered/lost/ambiguous only using existing voice/tokens. Add fixture `subagent-recovery-states` with deterministic expanded cards for a recovered-running child, a lost child, and an ambiguous-identity child; no live process/clock dependency. Register review-only scenario `fixture-subagent-recovery-states-landscape` at 160×45, compared against the existing activity-cards Bible target. Intentional styled-cell differences must isolate the three recovery labels/evidence lines.

**Verify**: `pnpm visual:review -- --scenario fixture-subagent-recovery-states-landscape && pnpm visual:ci` → exit 0; the review pack contains candidate full/chat-area PNGs plus styled-cell/geometry reports showing all three states, and `git status --short docs/ui/bible docs/visual/parity/approved-runtime` is empty. Then run all other command-table gates.

## Test plan

Cover starting/running/settled cut points, visible/headless feasibility states, PID reuse, pane disappearance, worktree preservation, writer death/takeover, session replacement types, exact-once result, explicit cancel after recovery, corrupt records, and cleanup.

## Done criteria

- [ ] Supported child classes survive documented session replacements and are adopted once.
- [ ] Unsupported recovery is explicitly classified, never silently orphaned.
- [ ] Durable identity/revision/lease/process verification is fail-closed.
- [ ] Completion/result delivery is exact-once across replacement.
- [ ] No automatic record/worktree deletion is introduced.
- [ ] Deterministic visual review evidence captures recovered, lost, and ambiguous subagent cards.
- [ ] `pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false` passes the complete feasibility/transition/handoff/delivery matrix.
- [ ] Full gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 112's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a Current state assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Ownership transfer cannot select one controller using the lease-generation rules above; persist the blocked/ambiguous state and STOP rather than choosing termination ad hoc.
- A running child can survive but no process can prove/control its identity.
- Two managers can concurrently signal or deliver one child.
- Full headless recovery requires a private Pi patch/protocol.
- Persistence would store prompt/result content in world-readable metadata.
- Capturing recovery states would require changing a Bible target, required crop, runtime golden/status, or promoting a golden.

## Execution checkpoint: feasibility preparation only

### Contract and drift reconciliation

Issue #406's body and comments were read (no comments at dispatch). The checkout was clean at the pinned prerequisite. The dependency rows 095/097/098/104/109 record completion; the dispatch supplies the reviewed, manually verified, exact-CI-green Plan 104 prerequisite. Historical row evidence is not a replacement for that exact-head gate.

The `b34bd79..99b8cc4d` drift includes prompt privacy, task-directory validation, lifecycle failure containment, executable provenance, Activity writer/delivery recovery, and removal of tracked bundles. Preserve these changes rather than restoring old snippets:

- Plan 108: headless launches use `resolveExecutableProvenance().pi`; visible launches use `.sumocode`, including numbered-provider child bootstrap and inherited tool restrictions.
- Plan 117: native/source/installed executable selection remains owned by the existing launcher/provenance seams. No new runtime selection or native build protocol is authorized here.
- PR #439: bundles are ignored output, as corrected above.
- `installSubagents` still calls `manager.disposeAll()` on shutdown. The headless spawner still starts on its callback subscription and holds its parser/abort state in that subscription. The visible spawner still owns its pane/control/result watcher in a closure. The visible started marker contains only a PID, not a recoverable process identity.

Scope and acceptance criteria remain Steps 1–6, without a visible-only narrowing. Test seams are the existing backend factories, the future registry's public transitions, manager/session lifecycle, observable completion delivery, and the supervised integration harness. Plans 106 and 111 own terminal manager/store/supervisor and host/runtime/client lifecycle respectively; request interfaces through the coordinating owner rather than editing those files. Plan 110 owns the heavy lane during this checkpoint. Do not publish until serial publisher permission and actual-top integration are granted.

### Six-cell evidence ledger

No cell has passed the real-process feasibility gate. `pending` below describes verification work, **not** a new supported runtime state or an `unsupported` verdict.

1. **Headless / same-process factory replacement — pending.** A pure backend test retains one pipe/abort owner, swaps its event observer, then observes the later assistant result and interrupt settlement without respawn. It uses a fake process and does not exercise Pi factory shutdown, durable ownership, or PID/start verification. Candidate: retain the owner across factory replacement; rebind observers only after lease transfer. Calling the backend's event subscription again is a launch, not adoption.
2. **Visible / same-process factory replacement — pending.** A pure backend test retains one control/result watcher, swaps its observer, consumes a steering file, and reads the later result/exit through the existing backend. Filesystem and pane host are doubles. Candidate: keep the old watcher as persist-only owner until handoff succeeds. Real process/pane identity and actual task-mode acknowledgement remain unproved.
3. **Headless / host-Pi reload — pending.** Parent pipe loss cannot be repaired by finding a PID. Evaluate a SumoCode-owned supervisor that retains the existing Pi JSON parser and writes private bounded events/result artifacts, with a start gate and verified process identity. This uses Pi's public JSON output, not a proposed private Pi patch. It must preserve selected executable/model/tool provenance and stdin prompt transport.
4. **Visible / host-Pi reload — pending.** Private response/exit/control files provide candidate transport, not identity or exclusive control. Persist a task nonce plus process birth/tree identity before release; verify that identity and pane association on adoption. Reusing a pane ID alone must fail closed.
5. **Headless / parent crash-restart — pending.** The candidate supervisor must be independent of the dying parent, remain tracked before release, retain result/control evidence after pipe loss, and survive each launch/settlement cut point. Killing the supervisor itself is a separate failure boundary. An expired lease alone does not authorize takeover from a live owner.
6. **Visible / parent crash-restart — pending.** Prove durable task identity and exclusive controller takeover after the former writer dies, then observe control consumption and the final result. An existing pane or exit marker cannot substitute for the lease-generation and identity checks.

The two pure tests are characterization, not test-first implementation of recovery. They establish a useful same-process seam without changing production shutdown safety. They do not prove exact-once delivery, process survival, or any of the six matrix cells. No registry/adoption implementation should be treated as approved by these tests alone.

### Lightweight verification

- `pnpm vitest run src/subagents/backend-pi.test.ts src/subagents/backend-pane.test.ts --maxWorkers=1 -t 'same-process event observer'`: 2 passed, 80 unselected.
- `pnpm vitest run src/subagents/backend-pi.test.ts src/subagents/backend-pane.test.ts --maxWorkers=1 -t '^(?!.*real bash)'`: 81 passed; the one real-bash case deliberately excluded while the heavy lane is held elsewhere.
- `pnpm exec tsc --noEmit && pnpm build`: passed.
- `pnpm exec oxlint src/subagents/backend-pi.test.ts src/subagents/backend-pane.test.ts` and `git diff --check`: passed.
- Real-process/full/native/bundle/visual checks: not run; lane permission required. These results are not a Plan 112 feasibility pass.

### Required next evidence and interfaces

Request the heavy lane before real-process tests. Use `spawnSupervisedProcess` / `spawn-pi-pty` for every integration process group and audit zero survivors, including any durable supervisor. Build `test/integration/subagent-recovery.test.ts` with all six named `feasibility:` cases; observe stable identity, one control owner, acknowledged control and a post-replacement result, rather than asserting a declared capability constant. Test actual Pi/task-mode behavior as well as a deterministic transport fixture. Do not turn pending cases into skipped-green evidence.

Before adoption work, settle these interfaces with the coordinating owner:

- Session lifecycle: distinguish same-process extension factory replacement from host death using existing Pi extension events where sufficient. Request a Plan 111 interface only if those events cannot provide the needed owner boundary.
- Process verification: consume existing process-tree identity/signal operations read-only; do not extend the Plan 106 terminal schema or copy terminal records into the registry.
- Delivery: stable completion ID + owner session, CAS claim generation, and observable session insertion acknowledgement. A successful void `sendMessage` call is not acknowledgement.

Real feasibility, transition crash tests, registry, adoption, delivery, Activity fixture, bundle/native/full/integration/visual verification, final top integration, and parent review remain pending. Do not mark this plan DONE. If experiments establish that full running-headless recovery requires a private Pi patch, stop that scope and request the explicit visible-plus-queued v1 decision; absence of an existing durable transport is not such evidence.

## Execution checkpoint: real-process experiment stopped, not a gate pass

Continued from `94b93134` with the heavy lane assigned. No production file changed. Added `test/integration/subagent-recovery.test.ts` and its synthetic provider/parent extension under `test/integration/fixtures/`.

### Experiment boundary and tradeoffs

The Vitest process acts as an independent execution supervisor and retains the **real** `createPiChildSpawner` / `createPaneChildSpawner` handles. Separate, supervised local Pi **0.84.4** processes act as replaceable controllers. The controller uses public `session_start` / `session_shutdown`, RPC `new_session`, and a fixture shutdown command. Reload here means **graceful Pi process exit and fresh process startup**, not a claim about the SumoCode host's `/reload` path. Crash uses `signalVerifiedProcessTree(..., "SIGKILL")`, followed by tree-emptiness proof before restart.

The visible terminal host is a supervised node-pty adapter, not an operator Herdr workspace. The real pane backend creates its private task files; an isolated launcher runs explicit local Pi TUI with the real `installTaskModeAutoExit`. This proves its PTY/task-mode transport, not external Herdr pane discovery or the retained SumoCode host launcher. The synthetic provider holds its stream until a private release artifact appears; no provider network or operator config is needed. Every test has private HOME/agent/workspace/session paths. The backend spawn injection preserves its public JSON parser and stdin prompt transport but intentionally replaces provider/provenance discovery with the explicit fixture.

The supervisor journals backend events; a replacement Pi controller reads that journal from disk. A single broker fences control by controller generation and checks the child's OS start/command identity. A live contender and stale queued request are refused. Headless cells use two already-running children: one is cancelled through the adopted backend handle, the other completes **after** replacement. Visible cells observe actual task-mode steering consumption, the steered response, then graceful close and backend settlement. Wrong-start signalling is rejected without harming the real child.

**Limits:** this broker is a test-local single writer, not the durable registry/lease protocol. Supervisor death, birth identity for the supervisor itself, disk CAS/lease expiry, launch cut points, bounded journal rotation, exact-once session insertion, and real host/pane adoption remain unproved. Backend handles remain in the independent supervisor; there is no claim that closed pipes can be reopened by PID. No private Pi patch is indicated by these results.

### Reconciled six-cell matrix

Second supervised invocation: **4 passed, 2 failed**, all six executed. The classifications below apply **only to the demonstrated retained-supervisor contract**, not to current production support. `unsupported` means this candidate failed its safety gate, **not** that Pi makes recovery impossible. No `queued-only` narrowing was selected or proved.

1. **Headless / factory replacement — unsupported (gate failure).** Real `new_session`, fenced takeover, cancellation and post-replacement completed-result recovery succeeded. `afterEach` then failed closed with `unsafe cleanup`. Evidence suffix `wkleJM`.
2. **Headless / host-Pi reload — recoverable at the experimental seam.** Graceful former-controller exit, verified empty former tree, fresh controller, stale/live contender rejection, actual cancellation of one preserved child and result recovery from the other passed. Evidence suffix `jNiqos`.
3. **Headless / parent crash-restart — recoverable at the experimental seam.** Verified SIGKILL/empty former tree, fresh controller, exclusive control, cancellation, later completed result and cleanup passed. Evidence suffix `Gmi7U2`.
4. **Visible / factory replacement — recoverable at the experimental seam.** Real `new_session`, unchanged verified PTY tree, fenced steering, `recovered-steered-result` from real task mode, graceful close, replay and cleanup passed. Evidence suffix `P0t1kN`.
5. **Visible / host-Pi reload — unsupported (gate failure).** Cross-process control/result recovery succeeded, then `afterEach` failed closed with `unsafe cleanup`. Evidence suffix `102vBE`.
6. **Visible / parent crash-restart — recoverable at the experimental seam.** Verified controller SIGKILL/restart, unchanged PTY identity, exclusive steering/close, recovered result and cleanup passed. Evidence suffix `i05tdE`.

The two cleanup failures do **not** include enough per-tree diagnostics to prove why `terminateProcessTree` refused. A graceful-exit race between the emptiness check and signal verification is a hypothesis, not a diagnosis. Do not weaken identity checks or treat refusal as success. Failed cleanup also leaves the fixture's shared tracking arrays for the following cell; this must be fixed/isolated before trusting a subsequent all-green matrix.

### Exact local evidence and verification

Evidence root: `/tmp/sumocode-plan112-lane-nsUbtM/`. Per-cell directories are `sumocode-plan112-proof-<suffix>/`; each contains `parents.jsonl`, `identities.jsonl`, `requests.jsonl`, `ownership.jsonl`, `controls.jsonl`, `events.jsonl`, `recovered.jsonl`, and task artifacts where applicable. Successful cleanup writes `audit.jsonl`. **Historical `verdict.jsonl` files were written before cleanup and are not authoritative verdicts.** The checked-in fixture now calls this output `observation.jsonl` and explicitly says cleanup is pending; this reporting-only correction has static verification but no third heavy run.

- `preflight.log`: initial shared-TMP preflight was blocked by stale state and a cross-worktree `node_modules` symlink. Preserved the symlink in the private lane root and installed locked dependencies locally. Fresh-private-TMP preflight passed; no shared evidence was purged.
- `feasibility-1.log`: command below executed all six, 3 passed / 3 visible failed because the fixture omitted task-mode's response trailing newline. Harness: **zero survivors across 22 groups**.
- `feasibility-2.log`: after the newline correction and added headless cancellation proof, 4 passed / 2 cleanup failures as above. Harness: **zero survivors across 25 groups**.
- `final-tree-audit.json`: read-only recheck of **all 47 recorded process trees from both runs: zero nonempty trees**. No PID-only signal was used by that audit. Both failed roots remain retained.
- `lightweight.log`: **139 passed**, one real-bash case deliberately unselected, covering both backends and task mode.
- `build-final.log`: `pnpm exec tsc --noEmit && pnpm build` passed. The private `tsconfig-proof.json` additionally typechecks both integration files (the repo tsconfig normally includes only `src`); passed.
- `lint-full.log`: `pnpm lint` passed. Focused fixture lint and `git diff --check` passed.
- Full unit/integration/bundle/native/visual gates: **not run** after the Step 1 STOP. No UI change or golden promotion. Plan remains **not DONE**.

Heavy command (both invocations, logs numbered above):

```sh
env -u NODE_PATH -u NODE_COMPILE_CACHE TMPDIR=/tmp/sumocode-plan112-lane-nsUbtM \
  pnpm vitest run test/integration/subagent-recovery.test.ts --fileParallelism=false -t 'feasibility:'
```

### STOP and next authorized scope

The same feasibility command failed twice following a reasonable fixture correction. Per this plan's STOP rule, do not proceed to registry/adoption and do not schedule another heavy retry without the coordinating owner's decision. This is **not** the private-Pi-protocol STOP and does not justify a visible-plus-queued v1 narrowing.

Next bounded slice: give cleanup failures exact tree/status evidence, isolate per-cell tracking even on failure while preserving roots, distinguish a proven concurrent graceful exit from unsafe identity, and keep the final matrix verdict after cleanup. Then obtain a fresh heavy lane and rerun all six. Promote the independent supervisor from a test-process role to a tracked SumoCode-owned fixture with its own durable identity/control journal and failure boundary before treating this as the complete Step 1 gate.

Interfaces for follow-up (no Plan106/111 file edits):

- **Lifecycle:** existing public Pi shutdown reason/start reason and new-session RPC suffice for this experiment. `/resume`, `/fork`, actual host `/reload`, and host death still need their later acceptance cases; request a Plan111 boundary only if existing events prove insufficient.
- **Processes:** consume `ProcessTreeIdentity`, `captureTreeVerification`, `identityMatches`, `signalVerifiedProcessTree`, `terminateProcessTree`, and `isTreeEmpty` as-is. No terminal manager/store/API changes.
- **Supervisor/protocol:** persist supervisor + child identity before release; retain the existing backend handle/parser; generation-fence control at effect time; recover bounded append-only events/results. Prove what happens when the supervisor, not just the Pi controller, dies.
- **Registry/delivery:** only after the gate passes, implement versioned private records, revision CAS/writer lease, adoption and completion-ID insertion acknowledgement. The fixture's generation broker is not a replacement for those interfaces.

Review-ready gate: loaded the bundled `review-ready/contract.md`; changed seam is test-only Pi-controller replacement against retained production backends. Trace: session event → fenced broker → backend control → real Pi/task-mode result → private journal replay → verified cleanup. Caller-knowledge/deletion/ownership/test-surface checks found the explicit prototype limitations above; kept the two-file fixture rather than introducing production abstractions. Simplification/static checks completed. **Blocked, not review-ready:** full feasibility and cleanup isolation remain red; no publication requested.

## Maintenance notes

Recovery capability must be stated per backend and replacement type. Do not generalize visible-pane evidence into a claim that pipe-based headless runs are recoverable.
