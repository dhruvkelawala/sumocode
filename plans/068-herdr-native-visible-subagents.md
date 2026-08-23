# Plan 068 (reshaped): Herdr-native visible subagents

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9aa35e8..HEAD -- src/subagents/ src/terminal-host/ src/background-tasks/visible-spawn.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Supersedes**: the previous plan 068 (in-app `/subagents` dashboard +
> takeover + `/ps`). That plan is retired, not deferred: the operator's
> primary host is herdr, whose agent sidebar/attention queue IS the fleet
> dashboard. Do not build in-app fleet UI.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/065 (manager/backends), plans/066 (typed delivery),
  plans/069 (worktree isolation + manifest), plans/072 (TerminalHost facade),
  plans/074 (herdr worktree workspaces). All landed on main at `9aa35e8`.
  **Does NOT depend on plan 067** — safe to run in parallel with it; the only
  expected overlap is doc text in tool descriptions (trivial merge).
- **Category**: direction
- **Planned at**: commit `9aa35e8`, 2026-07-19
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/306 (scope
  reshaped — operator updates the issue; executor ignores it)
- **Research**: `docs/research/HERDR_VISIBLE_SUBAGENTS_2026.md` (read it
  first — primitive syntax, verified against herdr 0.7.4, lives there)

## Why this matters

Today subagents are headless-only: great for silent fan-out, invisible to the
human. The operator wants to *watch subagents bloom into herdr panes, click
in, and type* — while the orchestrator still gets typed completion cards.
Herdr 0.7.4 provides everything except layout policy: `agent start` targets
existing tabs/workspaces, Pi lifecycle hooks give authoritative
idle/working/blocked sidebar state for free, `pane run` steers without focus
theft, and `worktree open` attaches an existing checkout as a labeled
workspace. This plan adds `visible: true` to `subagent_spawn` so a child runs
as a real interactive sumocode pane — herdr-native — with settle/manifest/
delivery identical to headless children.

## Current state

- `src/subagents/manager.ts` — `spawn(task: SpawnSubagentTask)` (line ~137):
  cap gate (`MAX_RUNNING = 4`, `pendingSpawns` registered before first await),
  worktree creation via `src/git/worktree.ts` when `task.worktree` (069),
  computes `childCwd` (preserves caller subdir), then
  `child = this.backendFactory({ ...task, cwd: childCwd, id, signal })`.
  `BackendFactory` (line ~45) returns `SpawnedChild`.
- `src/subagents/backend-pi.ts:96` — `SpawnedChild`:
  `{ events: AsyncIterable<SubagentEvent> | callback-form; sessionFilePath?; interrupt(): void }`.
- `src/subagents/domain.ts` — `SubagentEvent`, `RunOutcome`,
  `SubagentSnapshot`, `SubagentWorktreeRef` (069).
- `src/subagents/index.ts` — settle → `buildCompletionManifest` (069) →
  delivery buffer defer → flush on idle/agent_end as `customType:
  "subagent-result"` (066). Backend factory is constructed here.
- `src/subagents/tools.ts:76-…` — the five verb tools; `subagent_spawn`
  schema currently: prompt, name, model, thinking, working_dir, worktree,
  branch.
- `src/terminal-host/types.ts` — `TerminalHost` interface (facade, 072);
  `herdr.ts` implements `openCommandInSplit` (via `agent start
  <uniqueHerdrAgentName()> --cwd … --split … --no-focus -- bash -lc …`),
  `createWorktreeWorkspace` (`worktree create --json`, returns workspaceId),
  `openExistingWorktreeWorkspace` (`worktree open --path … --json`) (074).
- `src/background-tasks/visible-spawn.ts` — reusable primitives:
  `buildVisibleTaskPaths` (log/response.md/exit-marker paths),
  `buildVisibleAgentCommand` (sumocode task-mode kickoff invocation),
  `parseExitMarkerLine` / `readExitCodeFromFile`. The bg task-manager's
  watcher/harvest loop shows how completion is detected — mirror the
  mechanism, do not import the bg registry.
- Conventions: tabs, strict TS, colocated vitest tests, execFile-style exec
  (never shell-interpolate ids/labels), `AGENTS.md` rules apply.

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                     | exit 0              |
| All tests | `pnpm test`                                          | all pass            |
| One file  | `pnpm vitest run src/subagents/layout.test.ts`       | all pass            |

## Scope

**In scope**:
- `src/subagents/domain.ts` (extend: visibility + pane ref on snapshot)
- `src/subagents/layout.ts` + test (create: placement policy, pure)
- `src/subagents/backend-pane.ts` + test (create: visible pane backend)
- `src/subagents/manager.ts` + test (route visible spawns; minimal diff)
- `src/subagents/tools.ts` + test (spawn schema: `visible`; new
  `subagent_send` tool)
- `src/subagents/index.ts` + test (factory routing, send wiring)
- `src/subagents/prompt.ts` + test (guidance for visible mode + send)
- `src/terminal-host/types.ts`, `herdr.ts`, `index.ts` + tests
  (new `startAgentPane` + `sendPaneText` capabilities)

**Out of scope**:
- In-app dashboard/takeover/`/ps` (retired — herdr sidebar owns fleet UI).
- Auto-balancing beyond the layout policy; `pane resize`/`move` calls.
- Plugin panes / fleet-board plugin; herdr notifications (`notification
  show`) — delivery cards + sidebar suffice for v1.
- Any change to `bg_task` behavior (plan 070 owns migration).
- Headless backend changes; `report-agent` lifecycle reporting (Pi hooks are
  already the authority — do NOT add a competing status source).

## Git workflow

- Branch: `advisor/068-herdr-native-visible-subagents`
- Conventional commits per step, e.g. `feat(subagents): pane backend for visible children`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Domain + terminal-host capabilities

1. `domain.ts`: add `visible?: boolean` to the spawn task surface and a
   `SubagentPaneRef` (`{ agentName: string; workspaceId?: string; tabId?:
   string; paneId?: string }`) as optional `pane` on `SubagentSnapshot`.
2. `terminal-host/types.ts`: add to `TerminalHost`:
   - `startAgentPane(pi, options: { name: string; cwd: string; shellCommand:
     string; placement: { kind: "workspace"; workspaceId: string } |
     { kind: "tab"; tabId: string; direction: SplitDirection } |
     { kind: "new-tab"; label: string } }): Promise<HostResult<{ pane: PaneRef;
     agentName: string; workspaceId?: string; tabId?: string; paneId?: string }>>`
   - `sendPaneText(pi, pane: PaneRef, text: string): Promise<HostResult<{}>>`
3. `herdr.ts`: implement both. `startAgentPane` maps placement →
   `herdr agent start <name> [--workspace ID | --tab ID --split D] --cwd …
   --no-focus -- bash -lc <cmd>`; for `new-tab`, first `herdr tab create
   --label <label> --no-focus` (parse tab id from JSON), then start into it.
   Parse `AgentInfo` (`workspace_id`, `tab_id`, `pane_id`) from the response.
   After start, best-effort `herdr pane rename <pane_id> <name>` (ignore
   failure). `sendPaneText` → `herdr pane run <pane_id> <text>` (text +
   Enter — NOT `agent send`, which is literal-no-Enter).
   Reuse `uniqueHerdrAgentName()`-style uniqueness but accept the caller's
   name prefix: `<slug>-<entropy>`.

**Verify**: `pnpm vitest run src/terminal-host/herdr.test.ts` → pass (Herdr
arg-shape tests for all three placement kinds and rename best-effort).

### Step 2: Layout policy (`src/subagents/layout.ts`, pure)

`planPlacement(input: { hostKind: TerminalHostKind; isolated: boolean;
visiblePanes: SubagentPaneRef[]; sessionTabId?: string }): Placement`

Policy v1 (keep it boring, data-driven):
- `isolated` → `{ kind: "workspace" }` (workspace id supplied by the caller
  after `openExistingWorktreeWorkspace`; the policy just classifies).
- non-isolated, no subagents tab yet → `{ kind: "new-tab", label: "subagents" }`.
- non-isolated, tab exists with `< 4` visible panes → `{ kind: "tab", tabId,
  direction }` where direction alternates `right`, `down`, `right`… by count.
- tab full (≥ 4) → `{ kind: "new-tab", label: "subagents 2" }` (increment).
- `hostKind !== "herdr"` → `{ kind: "fallback-split", direction: "right" }`.

Pure function, exhaustive tests. The manager stores the returned
`tabId` from the first spawn and feeds it back on subsequent calls.

**Verify**: `pnpm vitest run src/subagents/layout.test.ts` → pass.

### Step 3: Pane backend (`src/subagents/backend-pane.ts`)

A `BackendFactory`-compatible `SpawnedChild` that:
1. Builds paths + command via `buildVisibleTaskPaths` /
   `buildVisibleAgentCommand` from `visible-spawn.ts` (kickoff = task
   prompt; model/thinking passthrough; same env contract as bg agent
   spawns).
2. Starts the pane via `host.startAgentPane` (placement injected by the
   manager/index seam — the backend receives it resolved).
3. Emits `SubagentEvent`s from file evidence: `started` immediately; then a
   bounded poll watcher (mirror the bg harvest cadence) on the exit-marker
   file. On exit marker: read `response.md` → final text; exit 0 →
   `{ kind: "completed", finalText }`, non-zero → `{ kind: "failed" }` with
   the log tail as errorText. No mid-run transcript streaming in v1 (the
   child is interactive; there is no JSON event stream) — document this on
   the type.
4. `interrupt()`: close/stop the pane via the same host path `bg_task stop`
   uses for agent panes; always also cancel the watcher (no orphan timers —
   test with fake timers).
5. Spawn failure (host returns `ok: false`) → emit `failed` outcome with the
   host error; never leave the child unsettled.

**Verify**: `pnpm vitest run src/subagents/backend-pane.test.ts` → pass
(fake host + fake fs: completed, failed, interrupt-cancels-watcher,
spawn-failure settles).

### Step 4: Manager + index routing (minimal diff)

1. `manager.ts`: `spawn` passes `visible` through; for `visible && worktree`,
   after the existing git worktree creation, resolve the workspace via
   `host.openExistingWorktreeWorkspace({ path, label: branchSlug })` and
   inject `{ kind: "workspace", workspaceId }` placement; on host failure,
   **fail the spawn** (fail-closed, mirroring 069's worktree failure
   handling). Non-isolated visible: consult `planPlacement` with the stored
   subagents-tab id; store the tab id returned by the first successful spawn.
   Cap/settle/manifest/delivery paths are untouched — visible children count
   against `MAX_RUNNING` like everyone else.
2. `index.ts`: backend factory routes `task.visible` →
   `backend-pane`, else existing pi backend. Settled visible children flow
   through the SAME fold → manifest → defer → flush pipeline (066/069); the
   delivery card gains a `pane` line (herdr ref, e.g. `herdr w7:pB ·
   agent <name>`) when present.
3. Snapshot carries `pane` so `subagent_list`/`check` show where each child
   lives.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts
src/subagents/index.test.ts` → pass (routing; workspace-injection failure
fails spawn; tab id persistence; delivery card includes pane ref; headless
path byte-identical behavior).

### Step 5: Tool surface

1. `tools.ts`: `subagent_spawn` gains `visible?: boolean` ("open the child
   as an interactive pane in the terminal host — watchable and steerable;
   requires a running terminal host"). Reject `visible: true` when host kind
   is `none` with a clear error.
2. New tool `subagent_send` `{ id, text }`: for a RUNNING visible child,
   `host.sendPaneText` the text (prompt + Enter). Errors: unknown id,
   settled child, headless child ("headless children cannot receive input —
   respawn with visible: true"), unsupported terminal host. This is the orchestrator-steering
   verb; humans just type in the pane.
3. `prompt.ts`: extend the system-prompt guidance: when to use visible
   (work the human may want to watch/steer, long interactive tasks) vs
   headless (silent bounded fan-out); `subagent_send` semantics; note that
   isolated visible children appear as herdr workspaces, non-isolated tile
   into a "subagents" tab.

**Verify**: `pnpm vitest run src/subagents/tools.test.ts
src/subagents/prompt.test.ts` → pass.

### Step 6: Full gates + ledger

`pnpm typecheck && pnpm test` → exit 0, all pass. Update the plan 068 row in
`plans/README.md` to IN PROGRESS with this branch (title: "herdr-native
visible subagents").

## Test plan

- layout.test.ts — exhaustive placement matrix (isolated/host/tab-count).
- herdr.test.ts — exact argv assertions for `agent start` (all placements),
  `tab create`, `pane run`, `pane rename` best-effort.
- backend-pane.test.ts — settle from exit marker; failure paths; watcher
  disposal (fake timers); spawn-failure settles.
- manager/index tests — routing, workspace fail-closed, delivery card pane
  line, headless regression (existing tests untouched and green).
- tools tests — schema, `subagent_send` error taxonomy.

## Done criteria

- [ ] `pnpm typecheck` + `pnpm test` green
- [ ] `subagent_spawn {visible: true}` on herdr: non-isolated children tile
      into a "subagents" tab (alternating splits, ≤4/tab, `--no-focus`);
      isolated children open as labeled worktree workspaces
- [ ] Every spawn/tab/workspace call passes `--no-focus` (grep-proven)
- [ ] Visible children settle through the SAME manifest+typed-delivery path;
      card shows the pane ref; exactly-once preserved
- [ ] `subagent_send` steers a running visible child via `pane run`; full
      error taxonomy tested
- [ ] Headless behavior unchanged (no existing test modified except for new
      optional fields)
- [ ] No raw shell interpolation of names/labels/ids (execFile-style argv)
- [ ] `plans/README.md` row updated

## STOP conditions

Stop and report back if:

- `herdr agent start` JSON output does not include `pane_id`/`tab_id`/
  `workspace_id` in practice (schema says it does) — report the actual
  shape; do not parse with regexes from human-readable output.
- The visible-spawn primitives (`buildVisibleAgentCommand` etc.) turn out to
  be bg-registry-coupled (need a task registered to work) — report; do not
  register visible subagents in the bg registry.
- Reusing the bg "stop agent pane" path for `interrupt()` requires importing
  the bg task-manager wholesale — report the seam that's missing instead.
- The manager diff exceeds ~80 lines — the routing is in the wrong place;
  stop and propose where the seam should live.
- Any existing headless subagent test needs a behavioral (not additive)
  change.

## Maintenance notes

- **Follow-up (record, don't build)**: a tiny read-only `/subagents` text
  listing for HEADLESS children (one line each) may still be worth having —
  herdr can't see headless children. Cheap, additive, not in this plan.
- **Herdr feature requests to file upstream** (from the research doc):
  auto-balance/tile, `agent start --target-pane/--ratio`, `agent wait
  --status done`, `$summary` in default sidebar rows. If these land, the
  layout policy shrinks.
- Plan 070 (one grammar) folds `bg_task runner=sumocode` into
  `subagent_spawn {visible: true}` — this plan is the load-bearing half of
  that migration.
- The `--token summary=` enrichment (live "current step" in the sidebar) is
  deliberately deferred: it needs a child→host reporting channel; design it
  with the steering v2 work.
- Operator config tip (docs, not code): `agent_panel_sort = "priority"`
  turns the herdr sidebar into an attention queue for the whole fleet.
