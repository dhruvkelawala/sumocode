# Plan 093: Index terminal state and perform one startup reconciliation

> **Executor instructions**: This is a persistence/lifecycle change. Follow the characterization-first order exactly. Run each verification gate. Never delete durable terminal records. Stop rather than weakening ownership, revision, lease, or process-identity checks.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- src/background-tasks/task-store.ts src/background-tasks/task-manager.ts src/background-tasks/terminal-tools.ts src/activity/manager-bridge.ts src/activity/feed-publisher.ts src/background-tasks/*.test.ts src/activity/manager-bridge.test.ts src/activity/feed-publisher.test.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/extension src/background-tasks/task-store.ts src/background-tasks/task-manager.ts src/background-tasks/terminal-tools.ts src/activity/manager-bridge.ts src/activity/feed-publisher.ts src/background-tasks/*.test.ts src/activity/manager-bridge.test.ts src/activity/feed-publisher.test.ts`. If this reports pre-existing work, STOP and preserve it.
> If the drift check reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/091-isolate-extension-install-tests.md`, `plans/issues/092.md` (sanitized public dependency; full security executor plan is local-only)
- **Category**: perf
- **Milestone**: M1 — Command-ready foundation
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/387

## Why this matters

Command readiness currently scales with all historical terminal records. Against 1,444 records/55 MiB, six owner queries took 4.433s and the first-frame-to-command-ready gap was 7.913s. The fix is an indexed manager projection and one explicit freshness boundary—not fibers, record deletion, or weaker persistence validation.

## Current state

- `TerminalTaskStore.loadAll()` synchronously validates and parses every task directory and rebuilds `metaPathById`.
- `TerminalTaskStore.listOwned()` calls `loadAll()` every time:

```ts
public listOwned(ownerSessionId: string): TerminalTaskSnapshot[] {
	return this.loadAll().filter((task) => task.ownerSessionId === ownerSessionId)
		.sort((left, right) => right.createdAt - left.createdAt);
}
```

- `TerminalTaskManager` already owns an ID-keyed `this.tasks` map, exposes bounded immutable `getSnapshots()`, and has an explicit `refreshSnapshotsFromStore()` disk-refresh boundary. The missing piece is an owner index and rerouting owner-query call sites; do not create a competing second cache.
- Constructor adoption calls `store.loadAll()` once, yet `list` (`task-manager.ts:528`), `claimPending`/`acknowledge` (`:739`, `:764`), `getClaimRetryDelay` (`:780`), and `stopOwned` (`:848`) call `store.listOwned()` again. `TerminalDeliveryCoordinator.bind()` drives `safeReconcile` plus queued `flush`, producing the six owner scans before Activity takeover can add another refresh.
- `TerminalDeliveryCoordinator.bind()` reconciles immediately and queues another flush; the combined path performs at least six full scans.
- `ActivityManagerBridge.syncOwnedSessions()` calls `refreshSnapshotsFromStore()` on ownership acquisition, adding another scan.
- Existing safety contracts in `task-store.ts` include canonical paths, `O_NOFOLLOW`, owner/mode checks, atomic JSON replacement, revision CAS, cross-process task locks, claim tokens, and claim leases. Preserve all of them.

## Target design

1. `TerminalTaskStore` exposes `refreshIndex()` as the only full validated scan boundary. One pass returns the validated snapshots used to seed the manager and builds compact ID→metadata-path plus owner→indexed-selection entries. Each selection entry caches immutable owner/order/status/completion/delivery/lease fields needed to choose list/claim/acknowledgement/retry candidates without reopening metadata files; callers must invoke `refreshIndex()` explicitly at a proven freshness boundary.
2. `TerminalTaskManager` retains its existing immutable-by-replacement snapshots from that same validated pass and indexes them by owner rather than reparsing records. Store indexes remain compact derived/cache state, never a second durable authority. Plan 106 may later bound manager-retained snapshots while preserving direct store-index paths and selection fields.
3. Disk refresh is explicit: construction and proven writer takeover/rebind are freshness boundaries.
4. Owner/list queries join owner-index IDs to manager-retained snapshots; claim, acknowledgement, and retry-delay selection use the compact indexed fields. Only a record selected for mutation or an explicitly requested ID absent from the manager snapshot map is reread directly through its indexed path. Mutations reread under the task lock, evaluate the eligibility/update decision against that authoritative locked snapshot (not the retained projection), and enforce revision/lease checks before writing; pure candidate selection performs no metadata rereads.
5. One coordinator startup method refreshes/reconciles/acknowledges/claims from one projection generation.
6. Activity publication consumes the manager projection. Only proven cross-process takeover may request a fresh disk scan.

Do not silently cache forever across process boundaries. If an external writer may have advanced records, call the explicit refresh boundary before making ownership decisions.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Store/manager | `pnpm vitest run src/background-tasks/task-store.test.ts src/background-tasks/task-manager.test.ts` | all pass |
| Delivery | `pnpm vitest run src/background-tasks/terminal-tools.test.ts src/activity/manager-bridge.test.ts` | all pass |
| Full unit | `pnpm test` (informational) / `VITEST_MAX_WORKERS=1 pnpm test` (authoritative locally) | exit 0 |
| Integration | `pnpm test:integration` | exit 0 |
| Required | `pnpm exec tsc --noEmit && pnpm build && pnpm lint` | exit 0 |

The default-parallel `pnpm test` is locally load-sensitive (pre-existing timing flakes in untouched files make it non-deterministic on this machine), so the authoritative local full-unit gate runs under `VITEST_MAX_WORKERS=1`; default-parallel runs are informational only and CI remains the authoritative full-unit gate. This reconciles the gate with execution evidence rather than loosening it.

## Committed bundle freshness

After final source edits, run `pnpm build:extension` before `pnpm test`; keep the generated `dist/extension/**` changes in this plan. Integration tests may rebuild the bundle, so rerun `pnpm build:extension` afterward and verify no additional unexpected generated drift.

## Scope

**In scope**:
- `dist/extension/**` generated by `pnpm build:extension`.
- `src/background-tasks/task-store.ts`
- `src/background-tasks/task-manager.ts`
- `src/background-tasks/terminal-tools.ts`
- `src/activity/manager-bridge.ts`
- `src/activity/feed-publisher.ts`
- Their colocated tests.
- A test-only scan counter or injected projection loader.

**Authorized review-fix addition (run `run-20260829T150412Z-08a6aa41` attempt 2)**: `src/activity/feed-publisher.ts` plus its colocated test are in scope for the writer-death seam only — expose a read-only `writerDeathProven` getter over the exact claim-time proof already computed and stored, and retire the `canReconcileAbandonedActivities` authorization bit. No other publisher API broadens; schema, layout, lease, and retention behavior are unchanged.

**Authorized review-fix addition (run `run-20260829T162741Z-50088751` attempt 1)**: final blockers and should-fixes only.

- `src/background-tasks/task-store.ts`: reject any `create()` whose id is already present in `indexedById` before the durable write/index replacement regardless of owner/timestamp/path (owner-bucket integrity regression), and preserve the last good index generation when `refreshIndex()` hits a transient `readdir` failure (an initial failure naturally leaves the empty index).
- `src/background-tasks/task-store.ts` + `src/background-tasks/task-manager.ts`: narrow mutation-truth rework so `store.transition`'s update callback runs inside the task lock against the authoritative just-read snapshot (returning `undefined` records a no-op under the lock) and `TerminalTaskManager.mutate` evaluates claim/ack predicates in that callback; revision CAS/retry is retained.
- `src/background-tasks/task-manager.ts` + `src/background-tasks/terminal-tools.ts`: add the narrow authoritative `readIndexed(id)` manager read and use it for one pre-send claim-token verification so a cross-process reclaim between claim and send suppresses the duplicate follow-up; selected-only reads and exact read counters are preserved.
- `src/activity/manager-bridge.ts`: coalesce all newly claimed owners with `writerDeathProven` in one `syncOwnedSessions` pass into ONE global `refreshSnapshotsFromStore`, and consume the proof via `completeAbandonedReconciliation()` after every successful publication even when `abandonedRunningIds` is empty (empty-feed takeover). `src/activity/feed-publisher.ts` changes are limited to the `writerDeathProven` getter doc.
- `test/fixtures/terminal-store-racer.ts` is added to scope as a mechanical API migration only (it compiles against the `store.transition` update-callback signature).
- No retention, schema, layout, or deletion changes; no public store/manager API beyond `readIndexed`.

**Out of scope**:
- Record deletion, archival, retention, schema migration, or changing task-directory layout.
- Polling cadence/process verification (Plan 106).
- Effect adoption.
- Visual rendering or terminal tool schemas.

## Git workflow

- Branch: `advisor/093-index-terminal-store-startup`
- Commit by logical slice: characterization, projection, coordinator consolidation.
- Message example: `perf(terminals): index startup reconciliation`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Characterize scan count and cross-process freshness

Add deterministic tests using an injected/counting store—not wall-clock budgets. Count both full directory scans and individual metadata-file reads. Pin:
- manager construction performs one full validated load, retains that generation's snapshots, and builds compact selection indexes;
- binding/listing/flushing an owner performs no repeated full loads and zero metadata rereads for pure candidate queries;
- owner A queries never return owner B;
- an explicitly invoked refresh adopts a higher external revision;
- stale revisions and lease-token mismatches still fail safely.

The target startup count is one full load for manager construction, plus at most one explicit refresh if the test models proven takeover. A normal same-process bind must not scan six times.

**Verify**: new tests fail against current code for the expected scan-count reason.

### Step 2: Add the ID/owner projection

Implement the named API from Target design: `refreshIndex()` rebuilds `metaPathById`, owner→ID state, and compact immutable indexed-selection entries with every field needed to choose list/claim/acknowledgement/retry candidates. Return the validated snapshots from that same pass so the manager seeds its existing projection without reparsing. `listOwnedIndexed(ownerSessionId)` returns compact candidates without opening metadata files; `getIndexed(id)` uses the indexed path for one direct validated read when the manager no longer retains that snapshot. Update selection entries by immutable replacement after each successful local create/transition; external writers become visible only at an explicit refresh boundary. Keep the projection derived from canonical validated metadata; do not persist a second index file. Owner buckets exclude malformed/skipped records and identity fields remain immutable.

Keep transition/read-current operations authoritative at mutation time: after selecting a candidate from compact fields, reread only that record under its task lock, evaluate the eligibility/update decision inside the transition callback against that locked authoritative snapshot, and enforce revision/lease checks before writing. Indexed candidate selection does not bypass locks or revision checks. Remove any implicit `loadAll()` or all-owned-record metadata-read fallback from indexed APIs. Name regressions `selects 1500 owned candidates with zero metadata reads`, `serves an old indexed ID with one metadata read and zero full scans`, and `rereads only the selected record before mutation`.

**Verify**: store/manager tests pass, including duplicate ID, corrupt record, external-revision, lock, lease, and process-identity cases.

### Step 3: Consolidate delivery startup

Replace the bind → reconcile → queued duplicate reconcile sequence with one manager/coordinator operation over one projection generation. It must:
- acknowledge only receipts observable in the current Pi branch;
- reclaim only expired claims;
- claim at most one wake completion;
- retain passive-before-wake ordering;
- schedule a lease retry only when a claimed record remains.

Subsequent listener-driven flushes may query the projection but must not rescan disk or reopen every owned metadata file.

**Verify**: `terminal-tools.test.ts` passes and the scan-count regression reports the target count.

### Step 4: Make Activity bridge consume projection snapshots

On normal same-process ownership, use `getSnapshots()`/subscription output. On proven previous-writer death, call the explicit refresh once before takeover publication. Preserve session ownership leases and abandoned-producer semantics.

**Verify**: manager-bridge takeover, redaction, retention, and multi-owner tests pass.

### Step 5: Run full gates and record evidence

Add a test fixture with at least 1,500 tiny metadata records and assert full-scan count remains constant and post-refresh candidate selection performs zero metadata reads regardless of owned-record count. Joining retained manager snapshots for list also performs zero reads; a selected mutation or explicitly requested manager-evicted ID may reread exactly one current record. A duration may be recorded as non-gating evidence; do not encode machine-specific milliseconds in unit tests.

**Verify**: all commands in the table pass.

## Test plan

Required cases: empty store, 1,500 records across owners, duplicate/corrupt records, external higher revision, stale transition, unexpired/expired claim, coordinator crash/reclaim, activity writer takeover, start/list/check/wait/stop behavior, and manager detach.

## Done criteria

- [ ] Normal startup performs one full terminal-store load, not six owner scans.
- [ ] Owner/delivery candidate selection after refresh uses compact cached fields with zero metadata rereads; list uses retained manager snapshots; mutation or an explicitly requested manager-evicted ID rereads only its selected record and never scans the store.
- [ ] Cross-process refresh is explicit and tested.
- [ ] Locks, revision CAS, lease tokens, file validation, and PID identity checks are unchanged or stronger.
- [ ] No durable record is deleted or rewritten solely for indexing.
- [ ] Unit, integration, typecheck/build, and lint gates pass.

## STOP conditions

- Correctness appears to require removing revision checks, leases, canonical-path validation, or process identity verification.
- The index would become a second durable source of truth requiring migration.
- The implementation needs automatic retention or deletion.
- A normal same-process startup performs more than one full scan after Step 3, or a proven takeover performs more than one additional explicit refresh scan.

## Maintenance notes

The compact path/selection projection is an accelerator, not the persistence authority. Local writes replace its cached entry only after the durable transition succeeds. Manager snapshots come from the same validated refresh pass and may be bounded later without dropping indexed paths/selection fields. Any future multi-process terminal writer must either publish projection updates through an explicit protocol or trigger the existing refresh boundary.
