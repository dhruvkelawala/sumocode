# Research: cmux-visible background tasks for SumoCode

Spike date: 2026-05-25  
Author: Zeus (SumoCode)  
Status: proposal — not production

## Problem statement

Dhruv wants the SumoCode orchestrator to start long-running work **without blocking the main session**, while still letting him **watch it live** in cmux (split/tab). `pi-subagents` solves multi-agent delegation but is heavier than needed for “run `pnpm test` in the background and let me peek”.

Requirements distilled from conversation:

1. Orchestrator-callable tool (not slash-command-only)
2. Visible execution surface in cmux when requested
3. Persistent logs + completion wakeups (existing bg_task semantics)
4. Cathedral/SumoTUI rendering in the parent session
5. No cmux/tmux orchestration bolted outside Pi’s tool loop

## Candidates evaluated

### 1. `pi-subagents` (npm:pi-subagents@0.25.0)

| Aspect | Assessment |
|---|---|
| Tool | `subagent` — no clash with SumoCode `task` |
| Strength | Role library (scout/reviewer/oracle), chains, parallel, async |
| Weakness | Full child Pi sessions; overkill for shell background jobs |
| cmux | No first-class visible split integration |
| SumoCode fit | Complementary for review/scout, not the background-process primitive |

**Verdict:** Keep installed optionally; do not use as the primary background-process layer.

### 2. `pi-cmux` (npm:pi-cmux@0.1.8)

| Aspect | Assessment |
|---|---|
| Surface | Slash commands only (`/cmv`, `/cmo`, `/cmrv`, …) |
| cmux API | `new-split` → poll panes → `respawn-pane --command` |
| Strength | Battle-tested split creation in cmux; already in Dhruv’s settings |
| Weakness | **Not orchestrator-callable** — no `registerTool` |
| SumoCode fit | Reuse `cmux-core.ts` patterns, not the package wholesale |

**Verdict:** Extract the cmux CLI sequence; wrap in a SumoCode/`bg_task` tool.

### 3. `opencode-cmux` ([0xCaso/opencode-cmux](https://github.com/0xCaso/opencode-cmux) v0.2.4)

| Aspect | Assessment |
|---|---|
| Model | OpenCode plugin listening to `session.created` with `parentID` |
| Visible subagents | `cmux new-split` + `cmux send` + `opencode attach <url> --session <id>` |
| Notifications | `cmux rpc notification.create`, `set-status`, `log`, `clear-status` |
| cmux hooks | Does **not** use `cmux set-hook` for splits — direct CLI |
| Server discovery | `lsof` on listening port; requires `opencode --port` |

**Key insight:** Attach-model works when the child is a **resumable agent session**. For shell commands, attach is wrong — use `respawn-pane` with a wrapped command (pi-cmux pattern).

**Verdict:** Best reference for event-driven cmux side effects + split grid layout; adapt spawn path for shell tasks.

### 4. `@vanillagreen/pi-background-tasks` (v1.5.0)

| Aspect | Assessment |
|---|---|
| Tool | `bg_task` + `bg_status` |
| Spawn | `child_process.spawn` detached, stdout/stderr piped to log |
| Wakeups | Exit + output match, budget caps, session-resumable sidecar |
| UI | Own widget/dashboard (vstack stack) |
| cmux | None today |

**Verdict:** **Best fork base.** Hard problems (PGID, PID reuse, wake budgets, auto-background bash) already solved.

### 5. SumoCode native `task` tool

| Aspect | Assessment |
|---|---|
| Model | Subprocess `pi` with scoped tools |
| Strength | SumoTUI delegation blocks already wired |
| Weakness | Invisible by default; not optimized for `pnpm test` style jobs |
| cmux | None |

**Verdict:** Keep for structured Pi delegation; pair with visible `bg_task` for shell monitors.

## cmux hook surface (what it is / isn’t)

`cmux hooks pi install` writes `~/.pi/agent/extensions/cmux-session.ts` for **session restore + lifecycle metadata** — not for opening splits on tool calls.

Relevant cmux CLI for this spike:

| Command | Use |
|---|---|
| `cmux --json identify` | Resolve caller workspace/surface |
| `cmux --json list-panes --workspace <ref>` | Diff panes before/after split |
| `cmux new-split right\|down --workspace --surface` | Create split |
| `cmux respawn-pane --workspace --surface --command <cmd>` | Start command in split |
| `cmux set-status / clear-status` | Sidebar working/idle |
| `cmux rpc notification.create` | Desktop notify on completion |
| `cmux log` | Workspace log feed |
| `cmux close-surface` | Cleanup finished visible tasks |
| `cmux read-screen` | Optional snapshot for orchestrator (expensive) |

`cmux set-hook` is tmux-compat and **not** how opencode-cmux or pi-cmux operate.

## Architectural fork: two spawn modes

```
┌─────────────────────┐     bg_task spawn (visible=false)
│  SumoCode parent    │ ──► child_process.spawn (current pi-background-tasks)
│  orchestrator       │     pipe stdout → log, wake on exit
└─────────────────────┘

┌─────────────────────┐     bg_task spawn (visible=true)
│  SumoCode parent    │ ──► cmux new-split + respawn-pane
│  orchestrator       │     wrapper: command 2>&1 | tee -a log; write exit file
└─────────────────────┘     tail log file for wakeups (no stdout pipe to Pi)
         │
         ▼
┌─────────────────────┐
│  cmux split surface │  human watches live terminal output
└─────────────────────┘
```

### Why log-tee wrapper for visible mode

When Pi spawns with piped stdio, output is invisible in the cmux pane. Visible mode must run **inside** the cmux surface. Pi tracks completion by:

1. Wrapper writes `[sumocode-bg] exit:<code>` and `<code>` to sidecar files
2. Parent polls log mtime + exit marker (same orphan-watcher patterns as today)
3. Optional: `cmux read-screen` for snapshots (not on hot path)

See `visible-spawn.ts` for the wrapper builder.

## opencode-cmux vs our fork (mapping)

| opencode-cmux | SumoCode fork |
|---|---|
| `session.created` + `parentID` | `bg_task` spawn with `visible: true` |
| `createSplit()` | `openVisibleTaskInSplit()` in cmux-adapter |
| `opencode attach …` | `respawn-pane` with `buildVisibleTaskCommand()` |
| `activeSplits` Map | `ManagedTask.cmuxSurfaceRef` on task snapshot |
| `removeAndClose()` on idle | Optional `closeSurfaceOnExit` setting |
| `setStatus("working")` | Map to SumoCode footer state or cmux status key `sumocode-bg` |

## Recommended package shape

```
@sumocode/pi-background-cmux   (fork of pi-background-tasks)
├── extensions/background-tasks.ts   (+ visible spawn branch)
├── extensions/cmux-adapter.ts         (from spike)
├── extensions/visible-spawn.ts
└── settings: { cmux: { enabled, direction, focus, closeOnExit } }
```

SumoCode changes (follow-on PR, not this spike):

- Render `bg_task` / `bg_status` in SumoTUI transcript pipeline
- Command palette: “background tasks dashboard”
- Disable vstack widget when SumoTUI retained renderer active

## Risks

| Risk | Mitigation |
|---|---|
| Not inside cmux → visible spawn fails | Graceful fallback to invisible spawn + notify |
| Log tail polling latency | Reuse existing output wake debounce |
| Duplicate packages (`pi-cmux` + fork) | Fork calls cmux CLI directly; deprecate overlapping `/cmo` usage in docs |
| Cursor SDK shell-exec warnings | Unrelated; visible tasks bypass Cursor shell bridge |
| Maintaining upstream fork | Start as thin adapter layer; contribute `visible` upstream to vstack |

## Decision

**Proceed with fork of `@vanillagreen/pi-background-tasks` + cmux adapter from this spike.** Do not build cmux orchestration in tmux. Do not use `pi-subagents` as the background shell primitive.

Next PR after spike: implement fork package + SumoTUI `bg_task` renderer + smoke test in cmux.
