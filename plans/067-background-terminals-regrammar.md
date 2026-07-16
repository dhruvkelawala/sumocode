# Plan 067: Reshape shell background tasks into the bg_start/bg_status/bg_kill/bg_list verb grammar

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/background-tasks/ src/subagents/delivery.ts src/extension.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/066-typed-deferred-result-delivery.md
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15

## Why this matters

`bg_task` is one mega-tool with an `action` enum (`spawn|list|log|stop|clear`)
and conditionally-required fields (`command` only for spawn, `id` only for
log/stop, `pruneWorktree` only for clear). Conditionally-required fields keyed
on an enum are the top LLM tool-failure mode. The decided grammar
(`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`, P0 §2) is
verb-per-tool: `bg_start / bg_status / bg_kill / bg_list`, mirroring the
subagent verbs, with completion delivered as a **typed message** instead of
`sendUserMessage` prose. The battle-tested `BackgroundTaskManager` internals
(durable meta.json recovery, PID identity, log caps, SIGTERM→SIGKILL) are
KEPT — only the tool surface and the completion-notification path change.

## Current state

- `src/background-tasks/background-task-tool.ts` — registers the single
  `bg_task` tool (line 77: `name: "bg_task"`) with the action enum
  (lines 118–121) and conditionally-required params; also registers `/bg` and
  `/bg-run` commands (bottom of file). `installBackgroundTasks(pi)` returns
  the manager and hooks `session_shutdown` (lines 58–76: only kills on real
  quit, recovers from disk otherwise — PRESERVE this).
- `src/background-tasks/task-manager.ts` — the manager. Key surfaces this
  plan reuses unchanged: `spawnTask` (~line 520), `findTask`, `stopTask`
  (~line 1026), `listTasks`, `formatTaskListText` (~line 590),
  `getTaskHarvest` (~line 1244), `clearFinishedTasks` (~line 1224),
  recovery (`recoverTasks`, ~line 425). The prose wake to REPLACE:

  ```ts
  // src/background-tasks/task-manager.ts:1002-1012 (approx, inside finalizeTask)
  if (task.notifyOnExit && !this.recovering) {
      const message = `background task ${task.id} ${summarizeStatus(task)}: ...`;
      this.pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
  ```

- `src/background-tasks/task-types.ts` — `SpawnBackgroundTaskOptions`,
  `BackgroundTaskRunner = "shell" | "sumocode"`. The `sumocode` runner and
  `worktree` options stay reachable ONLY through the legacy `bg_task` tool
  until plan 070 migrates them; the new verb tools expose the SHELL runner
  only.
- `src/subagents/delivery.ts` (plan 066) — `createDeferredResultDelivery`,
  generic payload buffer to reuse for terminal exits.
- `src/extension.ts` — `installBackgroundTasks(pi)` called at ~line 217 (RPC
  child profile) and ~line 317 (main profile).
- Conventions: tabs, strict TS, typebox `Type.Object` params, model-facing
  strings in a prompt module, colocated vitest tests.

## Commands you will need

| Purpose   | Command                                                       | Expected on success |
|-----------|---------------------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                              | exit 0              |
| All tests | `pnpm test`                                                   | all pass            |
| One file  | `pnpm vitest run src/background-tasks/terminal-tools.test.ts` | all pass            |

## Scope

**In scope**:
- `src/background-tasks/terminal-tools.ts` (create — the four new tools)
- `src/background-tasks/terminal-prompt.ts` (create — model-facing strings)
- `src/background-tasks/terminal-tools.test.ts` (create)
- `src/background-tasks/task-manager.ts` (ONLY: add a typed-completion hook,
  Step 3 — do not restructure anything else)
- `src/background-tasks/index.ts` (export the new installer)
- `src/extension.ts` (wire installer in both profiles)

**Out of scope**:
- Deleting or renaming the `bg_task` tool — it stays registered and working
  until plan 070 (both surfaces coexist; the new tools' descriptions say they
  are preferred for shell commands).
- The `sumocode` agent runner, worktrees, cmux visible panes — untouched.
- `src/task-mode.ts`, `src/git/worktree.ts`.
- The `/ps` viewer UI (plan 068).

## Git workflow

- Branch: `advisor/067-background-terminals-regrammar`
- Conventional commits, e.g. `feat(bg): add bg_start/bg_status/bg_kill/bg_list`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Model-facing strings (`src/background-tasks/terminal-prompt.ts`)

Descriptions (adapt, do not copy verbatim, from the decided design):

- `bg_start`: "Start a long-running shell command as a background terminal.
  Fire-and-forget: returns immediately with an id; you receive a message with
  the final output when it exits. The process receives NO stdin — interactive
  commands will not work. Output is tail-truncated here; full logs are on
  disk." Params: `command` (req), `title` (req), `working_dir?`.
- `bg_status`: "Peek at a background terminal's status and current output
  tail without blocking." Param: `id`.
- `bg_kill`: "Stop one or more running background terminals (SIGTERM to the
  process group, escalating to SIGKILL)." Param: `ids` (array).
- `bg_list`: "List all background terminals with pid, elapsed, exit status."
  No params.
- Guidelines: use `bg_start` for servers/watchers/long builds, plain `bash`
  for quick commands; after starting, keep working — the exit result arrives
  automatically; never start interactive commands.

Include `buildStartResult(task)`, `describeTerminal(task)`,
`buildStatusResult(task)`, `buildTerminalResultMessage(task)` — pure
formatters over `BackgroundTaskSnapshot` (id, status, pid, elapsed, exitCode,
cwd, log tail via `manager.getTaskOutput`). Tail budgets: status 16KB stdout;
completion message 8KB with a `Full log: <path>` pointer.

**Verify**: `pnpm typecheck` → exit 0

### Step 2: The four tools (`src/background-tasks/terminal-tools.ts`)

`export function installTerminalTools(pi, manager: BackgroundTaskManager, delivery: DeferredResultDelivery)`
registering exactly four tools. Implementation maps thinly onto the existing
manager:

- `bg_start` → `manager.spawnTask({ command, cwd, title, runner: "shell", visible: false, notifyOnExit: false })`
  → `buildStartResult`. (The typed delivery in Step 3 replaces `notifyOnExit`.)
- `bg_status` → `manager.findTask(id)` (error listing known ids when missing)
  → `buildStatusResult`.
- `bg_kill` → for each id: `manager.stopTask(task)`; aggregate a per-id report
  (`Killed bt … / was already completed …`). Kill continues even if the tool
  call is aborted (the manager already owns escalation).
- `bg_list` → `manager.listTasks()` filtered to `runner === "shell"` →
  `describeTerminal` lines (or "No background terminals tracked.").

**Verify**: `pnpm vitest run src/background-tasks/terminal-tools.test.ts` →
pass (fake pi harness as in `background-task-tool.test.ts`; assert exactly 4
`registerTool` calls with the right names; spawn/kill/status happy paths and
unknown-id error).

### Step 3: Typed completion delivery hook (`src/background-tasks/task-manager.ts`)

Add an optional constructor callback:
`onTaskFinalized?: (task: BackgroundTaskSnapshot) => void`, invoked inside
`finalizeTask` for `reason === "self-exit"` when NOT `this.recovering`
(exactly where the `notifyOnExit` prose branch sits today — leave that branch
in place for legacy `bg_task` callers; plan 070 removes it). In the installer,
wire the callback for shell tasks to
`delivery.defer(task.id, () => payload)` with
`customType: "terminal-result"`, flushed by the same idle/agent_end flusher
plan 066 built (extend `installSubagents`'s flush loop or export the flusher
from `src/subagents/index.ts` — choose the smaller diff and document it).

The passive `fireCmuxNotify` toast stays untouched.

**Verify**: `pnpm vitest run src/background-tasks/task-manager.test.ts` →
existing tests still pass; new test proves the callback fires on self-exit
finalize and NOT during recovery.

### Step 4: Wire and render

- `src/background-tasks/index.ts`: export `installTerminalTools`.
- `src/extension.ts`: after `installBackgroundTasks(pi)` in both profiles,
  call `installTerminalTools(pi, backgroundTaskManager, delivery)`.
- Reuse plan 066's view-model mapping for `customType: "terminal-result"`
  (same block builder, label `[terminal] bt-… · <title> · exited (0)`). Add
  one view-model test case.

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `terminal-tools.test.ts`: 4 registrations; `bg_start` returns id + no-stdin
  wording; `bg_status` unknown id lists known ids; `bg_kill` reports
  already-settled ids distinctly; `bg_list` excludes `runner === "sumocode"`
  tasks.
- `task-manager.test.ts` (extend): finalize hook fires once per task, not on
  recovery, not on `stopped` reason.
- View-model: `terminal-result` custom message maps to one collapsed block.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `rg -n "name: \"bg_" src/background-tasks/terminal-tools.ts` → 4 tools
- [ ] Legacy `bg_task` tool still registered and its tests untouched/passing
- [ ] Shell completion arrives as `customType: "terminal-result"` (test-proven)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Plan 066's `delivery`/flush seam is absent or shaped differently.
- Adding the finalize callback requires restructuring `finalizeTask`'s
  ordering (it must remain: timers cleared → log cap → status → meta write →
  notify) — report instead of reordering.
- Tool-name collision: something else already registers `bg_start` etc.
- The four tools cannot share the manager instance with legacy `bg_task`
  without double-notification (both prose and typed firing for one task).

## Maintenance notes

- Plan 070 deletes the legacy `bg_task` enum tool, the `notifyOnExit` prose
  branch, and `/bg-run`; reviewers of THIS plan should confirm both surfaces
  coexist without double delivery (legacy spawns use prose only if
  `notifyOnExit: true`; new spawns always use typed delivery — assert both in
  review).
- The id scheme stays the manager's (`bg-…`). If ids are later renamed
  (`bt-…`), recovery must accept both prefixes.
- `/ps` (plan 068) reads `manager.listTasks()` + `getTaskOutput` — no new
  manager surface should be needed; if 068 asks for one, add it there.
