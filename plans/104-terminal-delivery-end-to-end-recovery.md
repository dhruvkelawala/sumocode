# Plan 104: Add real-process terminal completion and recovery coverage

> **Executor instructions**: Follow this plan step by step and run every verification command. Build tests before changing production behavior. Use isolated Pi/session/terminal roots and no credentials. Exercise the real `TerminalTaskManager` and `TerminalDeliveryCoordinator`; a fixture that calls `sendMessage` directly does not satisfy this plan. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- test/integration/terminal-completion-fidelity.test.ts src/background-tasks/terminal-tools.ts src/background-tasks/task-manager.ts src/activity/manager-bridge.ts test/integration/spawn-pi-pty.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/extension test/integration/terminal-completion-fidelity.test.ts test/integration/terminal-completion-recovery.test.ts test/integration/spawn-pi-pty.ts test/fixtures src/background-tasks/terminal-tools.ts src/background-tasks/task-manager.ts src/activity/manager-bridge.ts`. If this reports pre-existing work, STOP and preserve it.
> If the drift check reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior or signatures differ, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/issues/092.md`, `plans/093-index-terminal-store-startup.md`, `plans/issues/100.md` (security dependencies are sanitized publicly; full executor plans stay local)
- **Category**: tests
- **Milestone**: M3 — Lifecycle reliability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/398

## Why this matters

Unit tests cover delivery claims and retries with a fake manager, while the existing integration fidelity test injects a synthetic `terminal-result` directly through `pi.sendMessage`. No real-process test proves that an actual terminal settles, is claimed once, survives host replacement, appears in the right session, and is acknowledged only after observability. These are data-loss/duplication boundaries.

## Current state

- `test/integration/terminal-completion-fidelity.test.ts` launches Pi RPC with a fixture extension whose command directly calls `pi.sendMessage`; it never starts `TerminalTaskManager` or `TerminalDeliveryCoordinator`.
- `src/background-tasks/terminal-tools.test.ts` thoroughly models claim/retry/idempotency using a fake in-memory manager.
- Production delivery in `terminal-tools.ts` uses durable completion IDs, claim tokens, leases, active-session ownership, and post-send branch observability.
- `ActivityManagerBridge` adds a separate durable feed writer/takeover lease.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| New integration | `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false` | pass |
| Existing fidelity | `pnpm vitest run test/integration/terminal-completion-fidelity.test.ts --fileParallelism=false` | pass |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration` | exit 0 |

## Committed bundle freshness

If the plan adds any production test seam under `src/`, run `pnpm build:extension` before `pnpm test` and keep `dist/extension/**` in scope. If implementation remains integration-fixture-only, the bundle must stay byte-identical.

## Scope

**In scope**:
- `dist/extension/**` only when a production extension seam changes.
- `test/integration/terminal-completion-recovery.test.ts` (create).
- Test fixtures/extensions under `test/fixtures/`.
- Minimal test seams in terminal manager/coordinator only if needed for deterministic crash points.
- Existing fidelity test may be renamed/clarified but remains as Pi details serialization coverage.

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

### Step 2: Test exact-once normal delivery

Assert:
- correct owner session only;
- stable completion ID/details survive RPC replay and session hydration;
- acknowledgement occurs only after the message is observable;
- a later idle/agent-settled event does not insert a duplicate;
- session-facing output is redacted/bounded per Plan 100.

**Verify**: `pnpm vitest run test/integration/terminal-completion-recovery.test.ts --fileParallelism=false -t "delivers a passive terminal once through the real coordinator"` → pass; the test parses the session JSONL and asserts exactly one message with the captured completion ID before and after a later settled event.

### Step 3: Test crash/replacement recovery

Introduce a deterministic stop after durable claim but before branch observability, then start a replacement coordinator after lease expiry. Assert it reclaims and inserts once. Also test stop after insertion but before acknowledgement: replacement sees the stable completion ID and acknowledges without a second insertion.

Use explicit marker files/events, not sleeps.

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

Required scenarios: passive, wake, busy owner, wrong active session, check race, wait race, crash-before-send, crash-after-send, lease expiry, persisted replay, malformed/corrupt unrelated record, child cancellation, and cleanup.

## Done criteria

- [ ] Tests exercise real manager/store/coordinator code.
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
- Determinism requires editing or deleting the user's terminal store.
- Pi offers no observable boundary for one crash window and no safe test seam can expose it.
- The test discovers a production duplication/loss bug; stop and split a corrective plan before weakening assertions.

## Maintenance notes

Any delivery protocol change must update this integration test and the fake-manager unit suite together. Keep IDs in assertions; presentation text is not the idempotency contract.
