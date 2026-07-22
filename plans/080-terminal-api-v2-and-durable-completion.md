# Plan 080: Terminal API v2 and durable passive completion

> **Executor instructions**: Execute in an isolated worktree based on the approved Plan 079 integration commit. Follow each step and verification. Stop on a STOP condition. No backward compatibility is required for callable `bg_*` tools, but do not delete files or clean legacy artifacts/processes without explicit approval. Do not touch `.pi-subagents/`, push, merge, or promote visual goldens.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat acf6ae2..origin/main -- \
>   src/background-tasks \
>   src/subagents/delivery.ts \
>   src/subagents/index.ts \
>   src/extension.ts \
>   src/interaction-registry.ts \
>   docs/PI_TOOL_ARCHITECTURE.md
> git status --short
> ```
>
> Also verify the Plan 079 Activity contract exists at the branch base. Preserve newer changes; never use `git reset --hard` or `git clean`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Category**: orchestration correctness / agent UX
- **Depends on**: Plan 079
- **Planned at**: `acf6ae2`, 2026-07-22
- **Execution status**: TODO
- **Unblocks**: Plan 081

## Decision

Replace the callable `bg_start/bg_status/bg_kill/bg_list` surface with exactly five verbs:

- `terminal_start`
- `terminal_check`
- `terminal_wait`
- `terminal_stop`
- `terminal_list`

Completion is durable task state. Default completion is passive and must not trigger an agent turn. Explicit waiting or observation consumes pending wake interest so a later idle flush cannot duplicate the result. Terminal delivery is separated from the subagent `DeferredResultDelivery` buffer.

Historical session transcript rendering and legacy metadata reading may remain where harmless; no callable aliases or prompt guidance for `bg_*` remain.

## Tool contract

### `terminal_start`

```ts
{
	command: string;
	title: string;
	working_dir?: string;
	completion?: "passive" | "wake"; // default passive
}
```

Returns immediately with a stable terminal ID. No stdin, TUI, prompt, visibility, worktree, or agent-runner options.

### `terminal_check`

```ts
{ id: string }
```

Returns one immutable snapshot and bounded current/final output without blocking. If settled, atomically sets `observedAt` and suppresses an unclaimed wake. It does not make a later wait unavailable.

### `terminal_wait`

```ts
{
	ids: string[]; // min 1, max 64
	timeout_ms?: number; // default 30_000, max 300_000
}
```

Waits for all requested IDs. Timeout is a normal result containing `settled` and `pendingIds`. Aborting the tool aborts only the wait. Returned settled tasks atomically set `observedAt` and `consumedAt`. Multiple waits return the same durable snapshots safely; consumption means notification disposition, not data deletion.

### `terminal_stop`

```ts
{ ids: string[] } // min 1, max 64
```

Marks all valid running targets stopping, signals every target first, then awaits all concurrently. Successful stops become `cancelled`, observed, and consumed. Already-settled tasks are reported and observed. Unknown or foreign-session IDs are not controlled.

### `terminal_list`

```ts
{}
```

Lists current-session tasks newest first, including completion disposition. It is side-effect free: no observation, consumption, or wake suppression.

## Durable terminal state

Refactor `src/background-tasks/task-types.ts` around a versioned terminal record. Use `term-` IDs for new tasks. Required fields:

```ts
interface TerminalTaskSnapshot {
	readonly schemaVersion: number;
	readonly revision: number;
	readonly id: string;
	readonly ownerSessionId: string;
	readonly command: string;
	readonly cwd: string;
	readonly title: string;
	readonly status: "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "lost";
	readonly completionPolicy: "passive" | "wake";
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly settledAt?: number;
	readonly exitCode?: number | null;
	readonly observedAt?: number;
	readonly consumedAt?: number;
	readonly deliveryState: "none" | "pending" | "claimed" | "delivered" | "suppressed";
	readonly completionId?: string;
	readonly pid?: number;
	readonly processGroupId?: number;
	readonly processStartTime?: string;
	readonly logFile: string;
}
```

The manager may retain existing storage location and read schema v2/v3 for diagnostics, but must not guess ownership or inject legacy results into the active session. New records use atomic temp-file + flush/close + same-directory rename. Failure to persist spawn identity is fatal: terminate the new process group and fail the call.

## Completion state machine

1. Natural settlement writes final status/output evidence and creates one `completionId`.
2. `passive` completion may add/update a visible typed `terminal-result` message with `triggerTurn: false` only for the active owning session.
3. `wake` completion remains pending while busy. When the owning session is active and idle, claim it and send one typed message with `triggerTurn: true`.
4. `terminal_check`, `terminal_wait`, and `terminal_stop` suppress any unclaimed delivery before returning settlement data.
5. Session A completion never enters session B. Resuming A may surface its still-pending completion.
6. A delivery is acknowledged only after the matching completion ID is observable in the session message stream; a crash before acknowledgment leaves it retryable.
7. A claimed delivery uses a bounded lease so process death cannot wedge it forever.

Keep `customType: "terminal-result"`, but include `completionId`, `ownerSessionId`, and a Plan 079 `ActivitySnapshot` in details. Never send fake user prose.

## Implementation steps

### 1. Separate terminal delivery from subagents

Modify:

- `src/subagents/delivery.ts` and tests only as needed to make it subagent-only
- `src/subagents/index.ts` and tests
- `src/background-tasks/terminal-tools.ts`
- `src/extension.ts`

Remove terminal calls to `flushDeferredResultDelivery`, terminal payload preservation on subagent shutdown, and shared terminal/subagent buffer ownership. Do not change subagent delivery semantics in this plan.

### 2. Add durable repository and manager transitions

Create or refactor:

- `src/background-tasks/task-store.ts`
- `src/background-tasks/task-store.test.ts`
- `src/background-tasks/task-manager.ts`
- `src/background-tasks/task-manager.test.ts`
- `src/background-tasks/task-types.ts`

The store owns atomic record transitions and owner filtering. The manager owns process lifecycle, bounded tail reads, wait subscriptions, recovery, and delivery claims. A transition accepts an expected revision and must reject stale writes.

Retain current log cap and process identity safety. Corrupt records are quarantined logically (ignored with diagnostics), never silently overwritten.

### 3. Make stop descendant-proof

Extract testable process-group operations to `src/background-tasks/process-tree.ts` with tests.

POSIX requirements:

- spawn detached into a dedicated process group
- signal only `-pgid`
- after SIGTERM grace, SIGKILL the still-live group
- confirm the group is empty before recording `cancelled`
- do not treat only the leader's exit as success
- do not fall back from an `EPERM` group signal to positive PID

Windows requirements:

- use a process-tree operation such as `taskkill /T`, with forced escalation
- never claim full cancellation from `child.kill()` alone

Batch stop signals every target before waiting for the first target.

### 4. Register the five tools and update guidance

Refactor without deleting:

- `src/background-tasks/terminal-tools.ts`
- `src/background-tasks/terminal-tools.test.ts`
- `src/background-tasks/terminal-prompt.ts`
- add `terminal-prompt.test.ts`
- `src/background-tasks/background-task-tool.ts`
- `src/background-tasks/index.ts`
- `src/extension.ts`
- `src/extension.test.ts`
- `src/interaction-registry.ts`

Register exactly the five `terminal_*` names. Remove `/bg` and all active `bg_*` prompt patches/guidelines. Update generated tool descriptions in developer guidance through the existing extension path.

`visible-spawn.ts` is shared historical/subagent-adjacent infrastructure; do not delete it.

### 5. Session and delivery event wiring

Use `ctx.sessionManager.getSessionId()` at start/check/wait/stop/list boundaries. Bind active session on `session_start`, clear only the binding on replacement, and preserve running tasks. A quit may stop owned children according to the existing shutdown contract.

Add tests for:

- passive completion never sets `triggerTurn: true`
- explicit wake only wakes current owning idle session
- check before idle flush suppresses wake
- wait and completion race produces one observable result
- list has no side effects
- A→B switch prevents stale injection; resume A restores visibility
- recovery after process restart
- exactly-once completion ID acknowledgment

### 6. Documentation and migration note

Update:

- `docs/PI_TOOL_ARCHITECTURE.md`
- the orchestration section of `plans/README.md` if needed by the executor
- public prompt/help references found by `rg -n '\bbg_(start|status|kill|list)\b|/bg\b' src docs README.md bin test`

Do not edit private `sumocode-config`. Report remaining private-config migration risk.

## Verification

```bash
pnpm vitest run \
  src/background-tasks \
  src/subagents/delivery.test.ts \
  src/subagents/index.test.ts \
  src/extension.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm visual:ci
rg -n '\bbg_(start|status|kill|list)\b|/bg\b' src docs README.md bin test
```

The final search may match historical migration notes and historical fixture transcript strings only; no registration, prompt guidance, or callable alias may remain. Add a POSIX integration regression where a descendant ignores SIGTERM; `terminal_stop` must escalate and prove it is gone.

## STOP conditions

Stop and report if:

1. Pi does not preserve `completionId`/details across classic send, RPC replay, and session hydration.
2. A real process-group regression leaves a descendant alive after reported cancellation.
3. Atomic transition/claim correctness requires a new native dependency or unsafe lock stealing.
4. A post-spawn persistence failure cannot guarantee process-group termination.
5. Session ownership cannot be obtained consistently from extension contexts.
6. Legacy task cleanup/process termination or file deletion becomes necessary; obtain explicit approval.
7. Any Activity details must bypass Plan 079's bounded/sanitized contract.

## Out of scope

- Live host-side Activity feed and in-place terminal card subscription (Plan 081)
- Subagent/native-task visual adapters (Plan 082)
- Interactive terminals, stdin, terminal panes, fleet dashboard, or compatibility aliases
- Automatic cleanup of `$TMPDIR/sumocode-bg` or other legacy artifacts
