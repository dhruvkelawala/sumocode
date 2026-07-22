# Herdr-Native Visible Subagents — Research (2026-07)

Sources: herdr 0.7.4 CLI help + bundled API schema (subagent recon, read-only against the
live server), herdr.dev/docs/agents/ and /docs/plugins/ (read 2026-07-19). Complements
`HERDR_CAPABILITIES_2026.md` (0.7.0 baseline) — this doc is scoped to what plan 068 needs.

## The one-line conclusion

Everything needed to make subagents visible, watchable, steerable herdr citizens already
exists in herdr 0.7.4 — **except auto-layout, which SumoCode must own** — and SumoCode
already owns every non-herdr half of the pipeline (task-mode kickoff, response harvest,
settle → manifest → typed delivery).

## Primitives inventory (verified)

### Spawning agents into herdr

```
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down]
                  [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
```

- Targets an **existing tab** → multiple agents can tile into one tab.
- Targets an **existing workspace** → agent lands in a worktree workspace.
- Returns `agent_started` with `AgentInfo`: `terminal_id`, `workspace_id`, `tab_id`,
  `pane_id`, `agent_status`, `focused`, plus optional `name`, `agent`, `cwd`, `title`…
- **No `--target-pane` / `--ratio`** — precise geometry needs `pane split`/`pane move`.

### Layout (orchestrator-owned)

```
herdr pane split [<pane_id>] --direction right|down [--ratio FLOAT] [--cwd] [--env] [--no-focus]
herdr pane move <pane_id> --tab <tab_id> --split right|down [--target-pane ID] [--ratio FLOAT]
herdr pane move <pane_id> --new-tab [--workspace ID] [--label TEXT] [--focus|--no-focus]
herdr tab create [--workspace ID] [--cwd PATH] [--label TEXT] [--env] [--no-focus]
herdr workspace create [--cwd PATH] [--label TEXT] [--env] [--no-focus]
```

- `pane split` accepts an explicit pane id → can split non-focused panes in other tabs.
- **No balance/tile/grid command exists.** A layout policy (who splits whom, which
  direction, what ratio) must live in SumoCode.

### Status: Pi is a lifecycle authority

From herdr.dev/docs/agents/: Pi's integration role is **"state and session"** with
lifecycle hooks as the status authority when installed (it is, on this machine). A child
`sumocode` pane therefore gets **authoritative idle/working/blocked in the sidebar for
free** — no screen-manifest scraping, no reporting code needed for the basic states.

Display enrichment on top:

```
herdr pane rename <pane_id> <label>            # human task label on the pane border
herdr pane report-metadata <pane_id> --source ID [--title TEXT] [--display-agent TEXT]
     [--state-label STATUS=TEXT] [--token NAME=VALUE] [--seq N] [--ttl-ms N]
herdr pane report-agent <pane_id> --source ID --agent LABEL --state idle|working|blocked|unknown
```

- `--token summary=...` renders as `$summary` in a configurable sidebar row
  (`[ui.sidebar.agents] rows`). Not in the default template — user opt-in.
- `agent_panel_sort = "priority"` turns the sidebar into an attention queue.
- Identity layers observed live: canonical `agent` ("pi"), orchestrator `name`
  ("sumocode-mrrt0019-ae8bm"), pane `label`, workspace label — all independent.

### Steering

```
herdr pane run <pane_id> <command>     # text + Enter → the way to send a prompt
herdr agent send <target> <text>       # LITERAL text, no Enter — not for prompts
herdr agent read <target> --source recent-unwrapped --lines N   # transcript capture
herdr agent attach <target> [--takeover]                        # human-only surface
herdr agent wait <target> --status idle|working|blocked|unknown [--timeout MS]
```

- **`agent wait` has no `done` status** in 0.7.4 (schema defines it; CLI doesn't accept
  it). Completion must come from our own harvest (exit marker / response.md), which we
  already have — herdr wait is only useful for *blocked* detection.
- Targets resolve by terminal id, unique agent name, label, or pane id — store the
  returned opaque ids, don't rely on names.

### Worktree ↔ workspace (074 machinery)

```
herdr worktree create [--workspace ID|--cwd PATH] [--branch NAME] [--base REF]
                      [--path PATH] [--label TEXT] [--no-focus] [--json]
herdr worktree open   [--workspace ID|--cwd PATH] (--path PATH|--branch NAME) [--label] [--json]
herdr worktree list   [--json]    # per-entry: path, branch, label, open_workspace_id?
```

- `open_workspace_id` present ⇔ the worktree is currently open as a workspace.
- **Always pass explicit `--cwd`/`--workspace`** — default resolves against the *focused*
  workspace, which may be a different project.

### Notifications & future plugin surface

```
herdr notification show <title> [--body TEXT] [--position ...] [--sound none|done|request]
```

Plugins (v1, 0.7.x): manifest-declared `[[events]]` (e.g. `on = "worktree.created"`),
`[[actions]]`, `[[panes]]` with placement `overlay|popup|split|tab|zoomed` (popup takes
`width`/`height`, `"80%"` ok); full herdr CLI is the plugin API via `HERDR_BIN_PATH`.
A "sumocode fleet board" plugin pane is feasible later; **not needed for v1** — the
sidebar already is the fleet view.

## Gaps → herdr feature requests (file upstream, don't block on them)

1. Auto-balance/tile command for N panes in a tab.
2. `agent start --target-pane/--ratio` (precise placement at spawn).
3. `agent wait --status done` (CLI parity with schema).
4. Documented attention-queue ordering/tie-breaking.
5. `$summary` in a default sidebar row template.

## Design synthesis for plan 068

| Concern | Mechanism |
|---|---|
| Visible child process | reuse `bg_task runner=sumocode` machinery: task-mode kickoff, response.md, exit marker — but registered in the **subagent manager**, not the bg registry |
| Placement, non-isolated | one "subagents" tab per orchestrator session (`tab create --no-focus --label`), children tile in via `agent start --tab --split` with an orchestrator-owned direction/ratio policy; cap per tab, then next tab |
| Placement, isolated | `worktree create --json` → workspace per child (074 path), `agent start --workspace --cwd <wt> --no-focus` |
| Live status | free via Pi lifecycle hooks; enrich with `pane rename <task-slug>` + `report-metadata --title/--token summary --seq` |
| Human interaction | it's a real pane — click in and type; `attach --takeover` from outside |
| Orchestrator steering | `pane run` (prompt + Enter) exposed as a `subagent_send`-style verb, visible children only |
| Completion | existing harvest → settle → 069 manifest → 066 typed delivery card; optional `notification show --sound done` |
| Never steal focus | `--no-focus` on every spawn/split/tab/workspace call |
| cmux fallback | degrade to the existing single-split visible spawn; no new cmux features (compat-only promise) |
| In-app dashboard | **not built** — herdr sidebar is the fleet UI; footer keeps a running-count chip |
