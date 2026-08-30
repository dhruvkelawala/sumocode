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
3. Disk refresh is explicit: construction and proven writer takeover/rebind are freshness boundaries. A refresh reports success/failure explicitly: `refreshIndex()` returns a success result and preserves the last good index generation when the store directory cannot be read, and `refreshSnapshotsFromStore()` propagates that result instead of letting callers confuse an unreadable store with a successfully refreshed empty one.
4. Owner/list queries join owner-index IDs to manager-retained snapshots; claim, acknowledgement, and retry-delay selection use the compact indexed fields. Only a record selected for mutation or an explicitly requested ID absent from the manager snapshot map is reread directly through its indexed path. Mutations reread under the task lock, evaluate the eligibility/update decision against that authoritative locked snapshot (not the retained projection), and enforce revision/lease checks before writing; a locked update that returns `undefined` (no-op under the lock) refreshes that record's compact indexed entry from the authoritative snapshot before returning. Pure candidate selection performs no metadata rereads; owner prechecks use the no-I/O `isIndexedOwner(id, ownerSessionId)` compact-index membership API.
5. One coordinator startup method refreshes/reconciles/acknowledges/claims from one projection generation.
6. Activity publication consumes the manager projection. Only proven cross-process takeover may request a fresh disk scan.

Do not silently cache forever across process boundaries. If an external writer may have advanced records, call the explicit refresh boundary before making ownership decisions.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Store/manager | `pnpm vitest run src/background-tasks/task-store.test.ts src/background-tasks/task-manager.test.ts` | all pass |
| Delivery | `pnpm vitest run src/background-tasks/terminal-tools.test.ts src/activity/manager-bridge.test.ts` | all pass |
| Full unit | `VITEST_MAX_WORKERS=1 pnpm test` (one-worker gate) and a serial `pnpm vitest run --fileParallelism=false` run (both authoritative locally); default-parallel `pnpm test` is informational | exit 0 |
| Integration | `pnpm test:integration` | exit 0 |
| Required | `pnpm exec tsc --noEmit && pnpm build && pnpm lint` | exit 0 |

The default-parallel `pnpm test` is locally load-sensitive: it can fail on pre-existing load-sensitive timing assertions whose test bodies and budgets this plan does not change. Some of those assertions live in files this plan touches (such as task-manager), but each failing test is byte-identical to its pre-plan version and passes in isolation; no timeout or budget was inflated. The authoritative local full-unit gates are the one-worker run (`VITEST_MAX_WORKERS=1 pnpm test`) and a serial run (`--fileParallelism=false`); default-parallel runs are informational only and CI remains the authoritative full-unit gate. This reconciles the gate with execution evidence rather than loosening it.

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

**Authorized review-fix addition (run `run-20260829T162741Z-50088751` attempt 2)**: `readIndexed` is owner-scoped — signature `readIndexed(id, ownerSessionId)`, returning `undefined` for another owner's record — and the coordinator passes the current session owner to the pre-send read while keeping its explicit receipt/claim-token check; still no broader public tool exposure. Gate wording in this plan and `plans/README.md` is corrected: default-parallel failures are pre-existing load-sensitive assertions whose test bodies and budgets are unchanged by this plan (some occur in touched files such as task-manager, but each failing test is byte-identical and passes in isolation); the one-worker and serial runs are the local full-unit gates and CI remains authoritative. No timeout/budget inflation.

**Authorized review-fix addition (run `run-20260829T180227Z-03c8c56f`) — final blocker and should-fixes only**:

- `src/background-tasks/task-store.ts` + `src/background-tasks/task-manager.ts` + `src/activity/manager-bridge.ts`: refresh success is explicit end to end. `refreshIndex()` returns `TerminalTaskIndexRefreshResult` (`ok` plus snapshots) and preserves the last good generation on a transient `readdir` failure; `refreshSnapshotsFromStore()` propagates it. In `syncOwnedSessions`, death-proven owners are claimed only after the one coalesced global refresh succeeds: if it fails, the bridge publishes nothing for them, adds nobody to `claimedOwners`, leaves `completeAbandonedReconciliation()` unconsumed, and retains publisher ownership plus proof (the session claim stays with the bridge token) so the next sync retries; on retry success it claims all pending death-proven owners, publishes each once, and consumes each proof, with no extra refresh on settled repeats. Normal non-takeover owners are unaffected.
- `src/background-tasks/task-store.ts`: `transition`'s locked no-op (`update` returning `undefined`) refreshes that record's compact indexed entry from the authoritative locked snapshot before returning, so retry-delay/candidate selection observes external advances (e.g. claimed→delivered by another process) without a reread/retry loop.
- `src/background-tasks/task-store.ts` + `src/background-tasks/task-manager.ts`: narrow no-I/O store API `isIndexedOwner(id, ownerSessionId)`; `readIndexed` prechecks it before opening metadata, so a foreign- or unknown-owner read costs zero metadata reads and a same-owner read exactly one. Owner immutability and security checks are unchanged.
- `plans/README.md`: the 093 evidence line cites the verifiable committed extension manifest input hash plus `outputsHash` freshness instead of the unverifiable "rebuilt three times byte-identical" claim. One-worker and serial full-unit gates are preserved as the local authoritative runs; CI remains authoritative.
- No retention, schema, layout, or deletion changes; no public store/manager API beyond `isIndexedOwner` and the explicit refresh result shape already required by this plan.

**Authorized review-fix addition (run `run-20260829T180227Z-03c8c56f` attempt 2) — release should-fixes only**:

- `src/background-tasks/task-manager.ts` (+ colocated test): `readIndexed` re-verifies `snapshot.ownerSessionId` from the freshly read record after the compact precheck and its one `getIndexed` read — defense-in-depth so a compact entry gone stale relative to disk can never return another session's record. The recheck costs no extra I/O (a mismatch still costs exactly one metadata read and zero scans) and the foreign/unknown-owner zero-read precheck behavior is unchanged.
- Root `README.md`: the one-line self-verifying extension bundle contract note (`dist/extension/.inputs.json` binds the input-graph hash to `outputsHash`, `pnpm build:extension` reproduces both, the runtime rejects stale inputs or a mismatched artifact) is an authorized part of this plan's bundle-freshness evidence repair and is kept; this authorization covers that file for the working-tree preflight/drift check.
- No other behavior, schema, layout, retention, or public API changes.

**Authorized review-fix addition (run `run-20260829T203858Z-77e98acd` attempt 1) — quarantine lifecycle gaps only**:

- `src/background-tasks/task-manager.ts` (+ colocated test): STOP consistency — the ordinary stop path re-verifies compact-index membership after the TERM/SIGKILL tree wait succeeds and returns the normal `{outcome:"unknown"}` result before `settleDisposedStop`, instead of `settleDisposedStop`'s failed "durable record unavailable" result, matching the other stop-window quarantine routes.
- `src/background-tasks/task-store.ts` (+ colocated test): `refreshIndex()` distinguishes transient per-file metadata-read errnos (`EACCES`/`EIO`/`EMFILE`/`ENFILE`/`EAGAIN`) from true corruption, ENOENT, parse, and schema invalidity. A transient read of a record the last good index already knows retains its prior metadata path and compact index entry, reports the id in the new optional `preservedIds` field of the successful `TerminalTaskIndexRefreshResult`, and diagnoses the failure as `io` instead of `corrupt`; a transient read of an unindexed record stays absent from the generation. Corrupt/malformed/legacy records still quarantine and prune. A deterministic `metaReadFault` test seam (`TerminalTaskStoreOptions`) is authorized because chmod-based faults surface as the store's 0600-mode validation error, not a read errno.
- `src/background-tasks/task-manager.ts` (+ colocated test): `refreshSnapshotsFromStore()` keeps the retained full snapshot for `preservedIds` in the successful generation (only genuinely quarantined ids are pruned) and calls `clearPoll(id)` for pruned ids so no further reconciles are scheduled while the separate runtime child/process bookkeeping remains.
- `src/activity/manager-bridge.ts` (+ colocated test): every successful process-global `sessionOwnership.claim` is tracked in a `claimedSessionOwners` set separate from published `claimedOwners`. A failed takeover refresh (explicit `{ok:false}` or unexpected throw) keeps the claim for retry; `dispose()` releases every held claim — published and pending — exactly once, so a replacement bridge in the same process can claim and publish; released publishers drop their claim tracking too.
- `src/activity/manager-bridge.ts` (+ colocated test): the expected takeover-refresh failure diagnostic (both the `{ok:false}` and unexpected-throw paths) is emitted once per failure episode; a successful refresh resets the dedupe so the next failure episode is diagnosed again.
- No retention, schema, layout, or deletion changes; the public store/manager surface grows only by the optional `preservedIds` refresh-result field and the test-only `metaReadFault` store option.

**Authorized review-fix addition (run `run-20260829T203858Z-77e98acd` attempt 2) — transient owner blockers only**:

- `src/background-tasks/task-store.ts`: known-ID reservation during refresh. One O(1) prior path→id map is built per scan (the id→path half is the live `metaPathById`), replacing the linear `priorIdForMetaPath` walk. A candidate whose parsed id matches a prior indexed id at a different metadata path is diagnosed and skipped as `duplicate` regardless of scan order — even if the prior path later fails transiently, is corrupt, or is missing in the same scan. The known path owns identity: a duplicate never takes over. Known transient reads keep preserving the prior compact entry, prior path, and `preservedIds` exactly as before.
- `src/background-tasks/task-store.ts`: `replaceIndexedEntry` migrates the id out of the stale owner bucket when a locked no-op observes a divergent compact owner (empty buckets are removed), so the id can never answer in two owners' lists.
- `src/background-tasks/task-manager.ts`: on a successful refresh every fresh valid snapshot is adopted even when its revision equals the retained entry — revision equality alone no longer skips adoption — so an external same-revision owner/content divergence updates the full projection, `getSnapshots()`, and both owner lists to the refreshed owner. `preservedIds` is converted to a `Set` once before the prune loop.
- `src/activity/manager-bridge.ts`: the takeover-refresh failure diagnostic dedupe also resets on a sync pass with zero pending takeover owners (no refresh ran, so it cannot end the episode), so future failure episodes log again.
- `src/activity/manager-bridge.test.ts`: fix the noted misindented continuation comment.
- Regressions: duplicate directory sorting before its transient-failing prior keeps the prior owner/path; a duplicate never takes over a corrupt or missing prior (id quarantined); same-revision owner A→B adoption (owner A lists empty, owner B lists the refreshed snapshot across list/get/getSnapshots); locked no-op owner-bucket migration without dual membership; an unindexed transient read stays absent and fail-safe. Security, CAS, lease, process-identity, and duplicate diagnostics are unchanged. The scan-order test uses a test-only passthrough `node:fs` wrapper (inline lint-suppressed) because readdir order is not otherwise controllable; no public store/manager API growth.
- No retention, schema, layout, or deletion changes.

**Authorized review-fix addition (run `run-20260829T220648Z-7ab611c9` attempt 1) — persistent identity reservation and refresh recovery gating only**:

- `src/background-tasks/task-store.ts`: the known-ID reservation becomes store-instance persistent. A separate reserved id→canonical metadata path map — compact paths only, never full snapshots, so it is bounded security state that survives quarantine and a Plan 106 bound on retained snapshots can never turn it into a second durable authority — is written by validated adoptions and by `create`. Active-index quarantine (corrupt/missing/transient) may remove query entries but never releases or migrates the reservation: any other path presenting the same id is diagnosed `duplicate` forever in this store instance across subsequent refreshes, and `create` rejects a reserved id even when its active entry was already quarantined. The prior path→id reverse map is now built lazily on the first transient read, so transient-free scans pay no per-scan O(index) build; duplicate identity resolution is one O(1) reservation lookup per parsed candidate.
- `src/background-tasks/task-manager.ts`: at the explicit refresh boundary every fresh valid snapshot is still adopted unconditionally, but recovery side effects (settled log cap, launch-gate release, arm, reconcile scheduling) run only when the projection has no previous snapshot for the id or its meaningful durable identity changed — a different revision or owner. Revision plus owner are sufficient, so a deep same-revision, same-owner content compare is deliberately avoided: such a rewrite is adopted with no recovery side effects, a same-revision owner divergence still recovers, and unchanged records are not log-capped or rescheduled again per refresh. Test-only `onRefreshAdopt`/`onRefreshRecover` manager option spies pin the adopt/recover counts; no other public API growth.
- `src/background-tasks/task-store.test.ts`: the scan-order quarantine test clears the seeded readdir override before the real-readdir re-index pass instead of letting the middle refresh and re-seed read the stale seeded array.
- Regressions: a reservation outlives quarantine (second/third refresh keep diagnosing the waiting duplicate and never adopt it), a hijack-shaped `create` after quarantine is rejected with zero scans and zero metadata reads (the O(1) reservation path), duplicate-sorts-first plus known-transient retention is retained, and the refresh spy counts cover unchanged, same-revision same-owner rewrite, revision-bump, and same-revision owner-divergence records.
- No retention, schema, layout, or deletion changes.

**Authorized review-fix addition (run `run-20260830T014152Z-d9a8db37` attempt 2) — refresh re-entrancy blocker and lifecycle-wake should-fixes only**:

- Supersedes the "Revision plus owner are sufficient" sentence in the `run-20260829T220648Z-7ab611c9` attempt 1 block above: the shipped recovery gate covers revision, owner, and the recovery-relevant lifecycle fields — status and process identity (pid/processGroupId/processStartTime) — so an external same-revision, same-owner rewrite that flips settled→running or swaps process identity recovers instead of leaving an active terminal unarmed behind a stale settled projection, while a pure same-revision, same-owner content rewrite is still adopted with no recovery side effects and no deep content compare.
- `src/background-tasks/task-manager.ts` (B1/S1): `refreshSnapshotsFromStore()` no longer notifies inside its loops. Waiter-relevant changes — each genuinely pruned (quarantined) id and each retained record whose recovery-relevant identity changed — are collected during the adopt and prune loops and fanned out ONCE after both complete, through a batched notify: per-task listeners receive each change (parked waiters re-evaluate completion against the final projection), and projection listeners receive exactly one publication of the final projection. No intermediate projection that still contains a not-yet-pruned quarantined id is ever adopted or published, and the K+1 store scans, recursion depth, and duplicate publishes a listener-triggered re-entrant refresh previously caused are gone.
- `src/activity/manager-bridge.ts` (B1): bridge-side in-flight guard — the takeover refresh marks the window around the `refreshSnapshotsFromStore()` call; a projection listener fanned out during that window adopts the final projection and keeps the output poll in step but does not publish or re-run `syncOwnedSessions`, so a listener-triggered nested sync cannot rescan the store, and the sync that started the refresh claims and publishes each owner exactly once after the refresh completes. No manager-side guard: a re-entrant `refreshSnapshotsFromStore` from an arbitrary listener still performs a real scan and never returns a fake `{ok:false}`.
- `src/background-tasks/task-manager.ts` (S2): the single fan-out includes refresh adoptions of retained records whose recovery-relevant identity changed, so an external rewrite flipping running→settled adopted at refresh wakes a parked `wait()` promptly without timer elapse.
- Regressions: a bridge test whose manager double invokes the stored `subscribeChanges` listener during refresh asserts `refreshCount===1` and exactly one publish per owner; the `FakeTerminalManager` refresh now performs that fan-out so the coalesced-refresh takeover tests are no longer vacuous; the real-manager takeover quarantine regression pins one scan delta and exactly one publication excluding every quarantined id; manager tests pin the single final-projection fan-out for multiple quarantined ids and a parked wait woken by a same-revision running→settled refresh adoption without timer elapse.
- No retention, schema, layout, or deletion changes; no public store/manager API growth; the test-only spy surface is unchanged.

**Authorized review-fix addition (run `run-20260830T014152Z-d9a8db37` attempt 2 residual P2s) — refresh notification batch suppression and new-record delivery wake only**:

- `src/background-tasks/task-manager.ts` (P2-A, two synchronous threads, one root): recovery work inside `refreshSnapshotsFromStore()`'s adoption loop can reach `notifyChanges` synchronously mid-refresh — `recover()`→`scheduleReconcile()` runs reconcile's async body to its first await on the refresh stack, reaching `mutate()`→`adopt(…, true)` either through reconcile's tree-verification mutation or its starting/lost settlement — publishing an intermediate projection before quarantined ids are pruned and re-opening listener re-entrancy. Fix: a manager-level notification batch. While the refresh's adopt/prune loops run, every `notifyChanges` call queues its per-task changes (deduped to the latest snapshot per id) and publishes no projection; the batch flag is cleared in `finally`, and one merged fan-out after both loops folds in everything queued mid-batch, resolves each id to the latest retained snapshot at fan-out time, emits final per-task payloads (a fresh-then-stale v2→v1 per-task sequence can never be observed), and publishes exactly one final projection. Still no manager-side re-entrancy guard: a re-entrant refresh from an arbitrary listener performs a real scan and never returns a fake `{ok:false}`.
- `src/background-tasks/task-manager.ts` (P2-B): records new to the projection (`previous === undefined`) that pass the recovery gate are now included in that batched fan-out (per-task + projection) instead of notifying nothing, so a takeover retry whose refresh discovers an already-settled pending completion wakes the `TerminalDeliveryCoordinator` — which listens for per-task notifications only — and claims/sends it.
- Regressions: a refresh whose adopted running record's recovery synchronously mutates through the verification reconcile while a second record is quarantined in the same scan pins exactly one full scan (a projection listener that rescans on an intermediate generation never sees one), exactly one publication that already excludes the quarantined id, and exactly one per-task payload per id at the latest revision (v2-then-v1 unobservable); a refresh discovering a brand-new settled pending record pins one per-task notification, one projection publication, and a real coordinator flush (`terminal-result` delivered through `pi.sendMessage`).
- No retention, schema, layout, or deletion changes; no public store/manager API growth; the test-only spy surface is unchanged; "exactly one refresh scan per proven takeover" is unchanged — the notification batch adds no scans.

**Authorized review-fix addition (run `run-20260830T035909Z-1de0a1f1` attempt 1) — transactional batch drain and adoption-only projection publication only**:

- `src/background-tasks/task-manager.ts` (P2-1): the refresh notification batch drain is transactional — the merged fan-out moves into the `finally` that also closes the batch, so a throw from the adopt/prune loops (any unexpected recovery error or injected test-seam failure) still drains `refreshBatchQueued` and fans out whatever per-task changes were collected before the throw, deduped to the latest retained snapshot as normal. A parked waiter wakes promptly instead of its notification leaking into a later refresh, queue state never carries across refresh calls, and any throw-path publication reflects the current retained projection; the throw keeps propagating to the caller, and the explicit `{ok:false}` non-throw path is unchanged.
- `src/background-tasks/task-manager.ts` (P2-2): a same-revision, same-owner content-only rewrite is adopted into the stored snapshot but fires no recovery gate and joins no per-task change, so `notifyChanges([])` early-returned and projection subscribers stayed stale. `runRefreshLoops` now reports whether any adoption actually replaced a stored snapshot with differing content, using a cheap shallow compare of compact snapshot fields — strict per-field equality in both directions with a missing key treated as an `undefined` value (in-memory snapshots can carry explicit-`undefined` keys a re-parse omits) and `processTreeVerification` compared by its small member-anchor list through the existing `sameTreeVerification`; no deep JSON of large payloads. On a successful refresh where that happened — or where a prune occurred, which already joins the per-task fan-out — exactly one final projection publication is emitted even when the per-task changed list is empty, with no per-task noise for content-only rewrites and no extra store scans; a refresh with zero changes and no prune publishes nothing.
- Regressions: a refresh whose recovery seam throws mid-loop after a same-revision running→settled rewrite was collected for an older-sorted record pins that a parked `wait()` wakes from the thrown refresh's drain without timer elapse, that no per-task payload or publication leaks into the following no-change refresh, and that a real durable change still fans out normally; a same-revision same-owner content-only rewrite pins exactly one publication carrying the updated content, zero per-task notifications, exactly one full scan per refresh, and silence for no-change refreshes.
- No retention, schema, layout, or deletion changes; no public store/manager API growth; the test-only spy surface is unchanged; one scan per takeover, mid-refresh batch suppression, dedupe-to-latest fan-out, and the new-adoption delivery wake all stand.

**Authorized review-fix addition (run `run-20260830T035909Z-1de0a1f1` attempt 2) — delivery-eligibility wake on adopted same-revision rewrites only**:

- `src/background-tasks/task-manager.ts` (P2): the refresh changed/recovery gate covers revision, owner, lifecycle status, and process identity, so a same-revision, same-owner external rewrite that flipped only delivery-eligibility/receipt fields — a settled record adopted as delivered/suppressed and rewritten back to `pending`-eligible, a changed `completionId` receipt, a changed `deliveryClaimToken` claim, or a flipped `completionPolicy` — recorded only a projection-level content change. The `TerminalDeliveryCoordinator` listens exclusively via `addChangeListener` (per-task), so it never scheduled a flush and a reopened pending completion could be stranded with no retry timer or later transition. The snapshot schema (`task-types.ts`) is classified against the coordinator's single eligibility/acknowledgement predicates (`isClaimable`/`isAcknowledgementMatch`, the `DeliveryEligibility` field set): `deliveryState`, `completionPolicy`, `completionId`, `deliveryClaimToken`. When any of those differs on an adopted rewrite whose recovery gate did not fire, the rewrite joins the batched per-task fan-out (waking the coordinator to schedule its flush) instead of staying projection-only. Recovery side effects (settled log cap, launch-gate release, arm, reconcile scheduling) remain gated on revision/owner/status/process identity and never run for a delivery-only change. `updatedAt` is deliberately not classified: it only shifts the claim-lease clock that `getClaimRetryDelay` retry timers already own, and the pinned cosmetic-rewrite behavior (title plus `updatedAt` rewrite stays projection-only) is preserved — a rewrite whose differing content touches none of the four classified fields still joins no per-task change and emits exactly one final projection publication.
- Regression: a settled suppressed record is seeded before manager construction and adopted as suppressed; an external same-revision, same-owner, same-status, same-process-identity rewrite flips `deliveryState` back to `pending` (observation timestamps cleared per store schema); the refresh fans out exactly one per-task change and one projection publication with the recovery spy staying empty, and the real `TerminalDeliveryCoordinator` wakes, claims, and delivers the `terminal-result` message through `pi.sendMessage`, with its acknowledge pass observing the receipt through a branch double mirroring `completionsFromContext` so the durable record settles as delivered; a following cosmetic rewrite (title only, every delivery field equal) stays projection-only with zero per-task noise. Verified red pre-fix (per-task changes empty, no send).
- No retention, schema, layout, or deletion changes; no public store/manager API growth; the test-only spy surface is unchanged; one scan per takeover, mid-refresh batch suppression, dedupe-to-latest fan-out, the transactional drain, and the adoption-only projection publication all stand.

**Authorized review-fix addition (run `run-20260830T054423Z-5b26979b` attempt 1) — claimed-record lease-clock wake only**:

- Supersedes the `updatedAt`-exclusion rationale in the `run-20260830T035909Z-1de0a1f1` attempt 2 block above ("`updatedAt` is deliberately not classified") with one claimed-record exception: `updatedAt` stays unclassified for non-claimed records, but for a claimed record (old or new `deliveryState === "claimed"`) `updatedAt` IS the claim-lease clock both `isClaimable` and `getClaimRetryDelay` read. An adopted same-revision, same-owner, same-status, same-process-identity rewrite whose four classified delivery fields (`deliveryState`/`completionPolicy`/`completionId`/`deliveryClaimToken`) are unchanged but whose `updatedAt` moved — a backward move advances lease expiry sooner than the coordinator's armed retry timer, which was computed from the newer timestamp — previously stayed projection-only, so an active coordinator kept the retry timer from the stale delay remainder and postponed an already-eligible completion for up to that remainder. `deliveryEligibilityChanged` now additionally classifies any `updatedAt` change on a claimed (old or new) record as a per-task delivery change: the rewrite joins the batched fan-out, the `TerminalDeliveryCoordinator` wakes, re-runs its claim pass against the advanced lease, and `syncLeaseRetry` recomputes from the fresher timestamp. Non-claimed `updatedAt` changes remain cosmetic/projection-only (the pinned cosmetic-rewrite tests stand). No recovery side effects run for this class — the recovery gate (revision/owner/status/process identity) is unchanged and `deliveryEligibilityChanged` is still consulted only when it did not fire.
- Regression: a claimed record (rival claim token, fresh `updatedAt`) is seeded before manager construction and adopted with the coordinator bound, arming exactly one lease-retry timer at the full claim-lease delay; an external same-revision rewrite moves `updatedAt` backward past lease expiry with all four classified fields identical; the refresh pins exactly one per-task change plus one publication with the recovery spy empty, the coordinator recalculates and claims/delivers the `terminal-result` through `pi.sendMessage` after advancing only 1s of the ~29s stale remainder (fake timers pin no reliance on the old timer), and the recalculated retry timer is torn down once the acknowledge settles the record delivered; a following non-claimed title+`updatedAt` cosmetic rewrite on the delivered record stays projection-only. Verified red pre-fix (per-task changes empty, no send within the sliver advance).
- No retention, schema, layout, or deletion changes; no public store/manager API growth; the test-only spy surface is unchanged; the transactional drain, adoption-only projection publication, batched fan-out, one scan per takeover, and the delivery-field wake all stand.

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

On normal same-process ownership, use `getSnapshots()`/subscription output. On proven previous-writer death, call the explicit refresh once before takeover publication, and treat its explicit success result as the freshness gate: a failed refresh leaves the death-proof publishers unclaimed, unpublished, and unreconciled so the next sync retries the one global refresh; a successful refresh claims, publishes, and consumes each proof exactly once. Preserve session ownership leases and abandoned-producer semantics.

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
