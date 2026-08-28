# Plan 114: Add visible subagent budgets and warning-only stall policy

> **Executor instructions**: Follow this plan step by step and run every verification command. Implement observability and explicit policy before enforcement. V1 must never auto-kill a child based on inferred stall or budget exhaustion. Cancellation remains an explicit human/agent action. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host dist/extension src/subagents/domain.ts src/subagents/budget-policy.ts src/subagents/budget-policy.test.ts src/subagents/registry.ts src/subagents/registry.test.ts src/subagents/manager.ts src/subagents/manager.test.ts src/subagents/tools.ts src/subagents/tools.test.ts src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts src/subagents/backend-pane.ts src/subagents/backend-pane.test.ts src/task-mode.ts src/task-mode.test.ts src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts src/sumo-tui/transcript/activity-renderer.ts src/sumo-tui/transcript/activity-renderer.test.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension src/subagents/domain.ts src/subagents/budget-policy.ts src/subagents/budget-policy.test.ts src/subagents/registry.ts src/subagents/registry.test.ts src/subagents/manager.ts src/subagents/manager.test.ts src/subagents/tools.ts src/subagents/tools.test.ts src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts src/subagents/backend-pane.ts src/subagents/backend-pane.test.ts src/task-mode.ts src/task-mode.test.ts src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts src/sumo-tui/transcript/activity-renderer.ts src/sumo-tui/transcript/activity-renderer.test.ts`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state behavior/signature, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/109-contain-subagent-lifecycle-failures.md`, `plans/112-durable-subagent-registry.md` (shared snapshot/schema surface)
- **Category**: direction
- **Milestone**: M5 — Product durability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/408

## Why this matters

SumoCode permits ten running and sixteen queued subagents but exposes no wall-time/token/cost/output budget or last-progress signal. A hung child can occupy a slot indefinitely, while long legitimate tool calls are indistinguishable from a stall. Operators need bounded, visible evidence and an explicit cancellation decision—not silent capacity loss or unsafe automatic killing.

## Current state

- `src/subagents/domain.ts` defines only global running/queued ceilings.
- `SubagentSnapshot.usage` records tokens/context/cost/turns but has no limits or last-event timestamp.
- `SubagentManager` updates snapshots on events and leaves live children running until settlement/cancel/close.
- Visible pane children emit start/pane/settle to the manager but stream normal activity in their pane; the task-mode control watcher can provide a heartbeat if designed carefully.
- `subagent_list` shows age/status; Activity cards already project snapshot state.

## V1 contract

- Optional per-child wall-time, token, and cost budgets; bounded defaults may come from role/session policy.
- Snapshot exposes elapsed, budget utilization, `lastProgressAt`, and `health: active | quiet | stalled-warning | over-budget-warning`.
- Stall means no verifiable progress/heartbeat for a configurable interval; process/pane still alive is reported separately.
- Crossing a budget/stall threshold emits one warning/state transition. It does **not** cancel, close, or dequeue the child.
- `subagent_cancel` remains the explicit enforcement path.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Domain/manager | `pnpm vitest run src/subagents/manager.test.ts src/subagents/tools.test.ts` | pass |
| Backends | `pnpm vitest run src/subagents/backend-pi.test.ts src/subagents/backend-pane.test.ts src/task-mode.test.ts` | pass |
| Activity/visual | `pnpm vitest run src/activity/subagent-adapter.test.ts src/sumo-tui/transcript/activity-renderer.test.ts && pnpm visual:ci` | exit 0; no golden promotion |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration` | exit 0 |

## Committed bundle freshness

After final source/UI edits, run `pnpm build:host && pnpm build:extension` before `pnpm test`; keep `dist/host/**` and `dist/extension/**` generated changes in scope. Rerun builders after integration and before visual verification.

## Scope

**In scope**:
- `dist/host/**` and `dist/extension/**` generated by the committed bundle builders.
- `src/subagents/budget-policy.ts` and `src/subagents/budget-policy.test.ts` (create), plus budget/health fields in `domain.ts`.
- Plan-112 registry schema/migration tests for the added budget/progress fields.
- Optional spawn/tool parameters or role defaults.
- Headless event timestamps and a visible-child heartbeat/liveness signal if feasible.
- List/check presentation in `src/subagents/tools.ts`, Activity projection in `src/activity/subagent-adapter.ts`, and retained rendering in `src/sumo-tui/transcript/activity-renderer.ts`, with colocated tests and warning dedup.

**Out of scope**:
- Automatic cancellation/kill.
- Provider-level hard token enforcement.
- Billing guarantees.
- Global agent recursion/depth policy.
- Changing Plan 112's lease/process-ownership protocol beyond serializing the new budget/progress fields.

## Git workflow

- Branch: `advisor/114-subagent-budget-visibility`
- Commits: pure policy, backend signals, presentation.
- Message: `feat(subagents): expose budgets and stall warnings`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define pure policy and terminology

Add validated budget inputs and a pure evaluator using current time, usage, last progress, process/pane liveness, and status. Distinguish `quiet` from `stalled-warning`; startup/setup and known long tool execution need separate grace. Invalid/zero/negative limits fail at spawn validation.

**Verify**: `pnpm vitest run src/subagents/budget-policy.test.ts` → table covers below/at/above wall-token-cost limits, missing usage, startup/tool grace, quiet/stalled/liveness combinations, invalid inputs, and proves the evaluator type/output has no cancel/close/interrupt action.

### Step 2: Capture truthful progress signals

Headless backend updates `lastProgressAt` on parsed child events. For visible children, add an owner-only heartbeat/status marker from task mode or use verifiable pane/process activity; do not equate absence of transcript events with death. If no trustworthy visible progress signal exists, expose only `quiet` + liveness and STOP before claiming stall detection for visible children.

**Verify**: `pnpm vitest run src/subagents/backend-pi.test.ts src/subagents/backend-pane.test.ts src/task-mode.test.ts -t "progress|heartbeat|liveness"` → headless events update progress; visible heartbeat/liveness cases match the supported policy; settled/aborted children leave zero heartbeat timers.

### Step 3: Add one manager health scheduler

Use one unrefed scheduler to recompute health for running children. Notify listeners only on health/budget state changes, not every tick. Clear it when no children run/dispose. Preserve capacity and queue logic.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts -t "health scheduler|budget warning|stall warning"` → one unrefed scheduler for all running children, one warning per crossing, recovery after progress, zero scheduler after settlement/dispose, and zero backend interrupt/cancel calls.

### Step 4: Surface budgets in tools and Activity

Add optional spawn parameters with bounded maxima and role/session defaults only where configuration has an established home. `list`/`check` show utilization and last progress. Cards use existing warning colors/state roles; do not create a new theme token without spec. Include exact next action: inspect or explicitly cancel.

**Verify**: `pnpm vitest run src/subagents/tools.test.ts src/subagents/registry.test.ts src/activity/subagent-adapter.test.ts src/sumo-tui/transcript/activity-renderer.test.ts && pnpm visual:ci` → exit 0; spawn validation bounds limits, registry round-trips them, list/check/cards use approved voice/tokens, and no golden file changes.

### Step 5: Run full gates

Add a manager test named `keeps one health scheduler with 10 running and 16 queued` using fake timers and ensure health work stays bounded.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts -t "keeps one health scheduler with 10 running and 16 queued" && pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration` → exit 0 with fake-timer health work bounded to one scheduler.

## Test plan

Cover wall/token/cost boundaries, missing usage, heartbeat, long tool grace, visible liveness-only fallback, warning dedup/recovery, queued/setup states, settlement, cancellation, manager dispose, and max concurrency.

## Done criteria

- [ ] Budgets and health are visible in snapshots/tools/cards.
- [ ] Progress/liveness semantics are truthful per backend.
- [ ] One scheduler evaluates health and cleans up.
- [ ] V1 never auto-cancels or closes a child.
- [ ] Full unit/integration/visual gates pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 114's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a Current state assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Visible progress cannot be observed reliably; report that backend as liveness-only.
- Provider usage cannot be mapped to the advertised budget unit.
- Implementation requires automatic kill to be useful.
- New visual tokens are required without design approval.

## Maintenance notes

If automatic enforcement is ever proposed, it needs a separate plan, user policy, and interruption-safety proof. Warning-only is intentional, not unfinished enforcement.
