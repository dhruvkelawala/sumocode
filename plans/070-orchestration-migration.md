# Plan 070: Migrate to the single orchestration grammar and retire the overlapping surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/background-tasks/ src/extension.ts src/native-task-tool.ts docs/PI_TOOL_ARCHITECTURE.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: plans/065-subagents-core.md, plans/066-typed-deferred-result-delivery.md, plans/067-background-terminals-regrammar.md, plans/068-fleet-dashboard-and-takeover.md, plans/069-worktree-isolation-and-manifest.md
- **Category**: migration
- **Planned at**: commit `d4ce41d`, 2026-07-15

> **Gate**: Do NOT start this plan until the operator (Dhruv) confirms he has
> used the new `subagent_*`/`bg_*` tools for real work and considers them at
> parity. This plan removes working functionality; the confirmation is the
> go/no-go, not test results alone.

## Why this matters

After plans 065–069 land, SumoCode temporarily exposes FOUR delegation
surfaces: `subagent_*` (new), `bg_*` (new), `bg_task` (legacy mega-tool with
shell + visible-agent runners), and native `task`. The whole point of the
redesign (`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`,
"Recommended SumoCode sequence") is that the model sees **one grammar** — the
prompt-surface cost and mis-routing risk of four overlapping systems is worse
than before the redesign. This plan retires the legacy surfaces and fixes the
model-facing guidance.

## Current state

- `src/background-tasks/background-task-tool.ts` — registers the `bg_task`
  mega-tool (line 77), the `/bg` and `/bg-run` commands (bottom of file), and
  wires `session_shutdown` handling (lines 58–76 — this shutdown/recovery
  wiring MUST survive the tool's removal).
- `src/background-tasks/task-manager.ts` — `notifyOnExit` prose branch inside
  `finalizeTask` (`sendUserMessage`, ~lines 1002–1012) kept alive by plan 067
  for legacy callers; the `sumocode` visible-agent runner spawn path
  (`spawnVisibleTask`, `buildVisibleTaskCommand` usage) and its capacity gate
  (`assertAgentCapacityAvailable`).
- `src/background-tasks/visible-spawn.ts` + `src/task-mode.ts` — the
  cmux-pane agent-runner machinery (`sumocode task` handoff, marker files,
  auto-exit). Used ONLY by `bg_task runner=sumocode`.
- `src/native-task-tool.ts` — the `task` tool, installed in
  `src/extension.ts` (~lines 196 and 296) with a system-prompt patch:

  ```ts
  // src/extension.ts:303-307 (approx, both profiles)
  systemPromptPatches: [{
      match: /…custom tools depending on the project\./i,
      replace: "\n- task: never run this tool unless it's a skill run or I explictly ask you to",
  }],
  ```

  The `task` tool STAYS (it is the skill-run substrate and the Cathedral
  scroll/scribe renderer's data source) but its guidance must route normal
  delegation to `subagent_spawn`.
- `docs/PI_TOOL_ARCHITECTURE.md` — lists `bg_task` as a SumoCode-only tool
  (line ~48); must be updated.
- `bin/sumocode.sh` — the `task` subcommand (`sumocode task --prompt-file …`)
  is the visible-agent entrypoint; it becomes dead once `runner=sumocode` is
  gone, but the wrapper change is OUT of scope (see Scope) — only the spawn
  path that invokes it is removed.
- Conventions: tabs, strict TS, colocated vitest tests.

## Commands you will need

| Purpose   | Command                                | Expected on success |
|-----------|----------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                       | exit 0              |
| All tests | `pnpm test`                            | all pass            |
| Dead code | `pnpm dead-code`                       | report reviewed (no exit gate) |

## Scope

**In scope**:
- `src/background-tasks/background-task-tool.ts` (remove the `bg_task` tool +
  `/bg-run`; keep `installBackgroundTasks`'s manager construction, recovery,
  shutdown wiring, and `/bg` → repoint to the `/ps` viewer or keep as list)
- `src/background-tasks/task-manager.ts` (remove the `notifyOnExit` prose
  branch and the `sumocode`-runner spawn/capacity/response-watcher paths)
- `src/background-tasks/task-types.ts` (narrow `BackgroundTaskRunner`; keep
  snapshot fields needed to RECOVER old on-disk `sumocode` task metadata as
  terminal/readable — see Step 3)
- `src/background-tasks/visible-spawn.ts` (delete agent-runner branches; keep
  shell-script branches used by visible shell tasks if any remain, else delete
  file), associated tests
- `src/task-mode.ts` + `src/extension.ts` (remove task-mode auto-exit install
  ONLY if nothing else launches `sumocode task`; otherwise leave — verify
  first)
- `src/extension.ts` (update the `task` system-prompt patch; remove dead wiring)
- `docs/PI_TOOL_ARCHITECTURE.md` (reflect the new tool inventory)
- `AGENTS.md` (if it references `bg_task` usage — check with `rg -n "bg_task" AGENTS.md`)

**Out of scope**:
- `bin/sumocode.sh` — leave the `task` subcommand in the wrapper (harmless,
  and external orchestrators may still call it); removing it is follow-up.
- Removing the native `task` TOOL — it stays for skill runs and the
  transcript delegation renderer; only its guidance text changes.
- The externally installed `pi-subagents` package (`~/.pi/agent/...`) — user
  config, not repo code. Recommend disabling in the final report; do not
  edit files outside the repo.
- Any new features.

## Git workflow

- Branch: `advisor/070-orchestration-migration`
- Conventional commits, one per step, e.g.
  `refactor(bg_task)!: remove legacy mega-tool surface` (note the `!` —
  breaking change markers appear in repo history for behavior removals)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Inventory the blast radius (read-only)

Run and record in the commit message of Step 2:

```
rg -n "bg_task|runner=sumocode|notifyOnExit|SUMOCODE_TASK_MODE" src test docs AGENTS.md README.md --stats
```

Every hit must be classified: remove here / keep (recovery|wrapper|history) /
out of scope. If a hit belongs to a live feature not covered by this plan's
steps (e.g. `src/commands/review.ts` `taskSpawner` usage —
`src/interaction-registry.ts:146` passes the background manager into the
review command), STOP and report it.

**Verify**: classification list complete (attach to the commit body).

### Step 2: Remove the `bg_task` tool surface

In `background-task-tool.ts`: delete the `pi.registerTool({ name: "bg_task" … })`
block and `/bg-run`; keep manager construction + `session_shutdown` wiring +
`/bg` (repoint its text to mention `/ps`). Delete tool-surface tests that
exercised the enum dispatch; keep manager tests.

**Verify**: `pnpm typecheck && pnpm test` → pass;
`rg -n "\"bg_task\"" src/` → no matches.

### Step 3: Remove the `sumocode` agent runner, keep recovery readable

In `task-manager.ts`: remove `assertAgentCapacityAvailable`,
`getAgentCapacityDetails`, `armAgentStartupDeadline`, `armResponseWatcher`,
the `runner === "sumocode"` branches of `spawnTask`/`spawnVisibleTask`/
`getTaskHarvest`, and the `notifyOnExit` prose branch in `finalizeTask`
(plan 067's typed callback is now the only completion channel).

Recovery constraint: `parseRecoveredTask` must still ACCEPT persisted
snapshots with `runner: "sumocode"` from disk (old sessions), reconciling
them to terminal states and listing them read-only — narrow the SPAWN type,
not the recovery type. Add a test: a v2 meta.json with `runner: "sumocode"`
recovers as a terminal, listable task and never re-arms watchers.

In `task-mode.ts`/`extension.ts`: `installTaskModeAutoExit` guards on
`SUMOCODE_TASK_MODE=1` which only the removed spawn path sets from this repo —
but the wrapper still exposes `sumocode task` for external callers, so KEEP
the task-mode module and its install (it is inert otherwise). Record this
decision in the commit body.

**Verify**: `pnpm typecheck && pnpm test` → pass; new recovery test passes;
`rg -n "sumocode" src/background-tasks/task-manager.ts` → only
recovery/legacy-comment hits.

### Step 4: Fix the model-facing guidance

- `src/extension.ts` (BOTH profiles): update the `task` tool's
  `systemPromptPatches` replacement text to:
  `"\n- task: only for skill runs. For delegation use subagent_spawn; for background commands use bg_start."`
- `src/subagents/prompt.ts` / `terminal-prompt.ts`: confirm guidelines do not
  reference `bg_task` (fix if they do).
- `docs/PI_TOOL_ARCHITECTURE.md`: replace the `bg_task` row with the
  `subagent_*` and `bg_*` families; note `task` = skill-run substrate.

**Verify**: `rg -n "bg_task" src/ docs/PI_TOOL_ARCHITECTURE.md` → only
historical/research-doc hits outside `src/`.

### Step 5: Dead-code sweep and full check

Run `pnpm dead-code`; remove now-unreferenced exports flagged in
`src/background-tasks/` and `src/spike/cmux-background/` is OUT of scope
(spike dir, documented as non-production). Do not chase unrelated knip
findings.

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- Extend `task-manager.test.ts`: legacy `sumocode` meta recovery (Step 3);
  finalize fires only the typed callback (no `sendUserMessage` spy calls).
- Tool inventory test (new, in `src/extension.test.ts` style): the fake-pi
  harness registers `subagent_*` (5), `bg_*` (4), `task`, and NOT `bg_task`.
- All plan 065–069 suites must still pass unmodified — they are the parity
  regression net.

## Done criteria

- [ ] Operator go/no-go recorded (see Gate) before any removal commit
- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `rg -n "\"bg_task\"|sendUserMessage" src/background-tasks/` → no matches
- [ ] Old `sumocode`-runner meta.json recovers read-only (test-proven)
- [ ] `docs/PI_TOOL_ARCHITECTURE.md` matches the registered tool inventory
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The operator gate has not been explicitly confirmed.
- Step 1 finds a live consumer of `bg_task`/`runner=sumocode` outside this
  plan's scope (e.g. the review command's `taskSpawner`, user skills in
  `~/.pi`, or docs/marketing flows that demo it).
- Removing the response-watcher paths breaks recovery of RUNNING legacy agent
  tasks from a live session (someone mid-flight during the upgrade) — report
  the reconciliation gap instead of force-finalizing.
- `pnpm dead-code` flags removals that would touch out-of-scope files.

## Maintenance notes

- This plan is the point of no return for the mega-tool; rollback = revert
  the branch. Keep it as ONE branch with stepwise commits for bisectability.
- The user should also disable the external `pi-subagents` extension and any
  `SUMOCODE_BG_AGENT_*` env config after this lands (report reminder — outside
  repo scope).
- Follow-ups deliberately deferred: `bin/sumocode.sh task` subcommand removal,
  cmux visible PANES as an optional task VIEW (spawn stays headless), durable
  subagent recovery across reloads, steerable backends, the result loop
  (diff → apply/discard) consuming plan 069's manifest.
