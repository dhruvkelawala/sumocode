# Research: herdr (herdr.dev) capabilities vs a custom SumoCode orchestration layer

**Date:** 2026-07-18
**Requested scope:** herdr v0.7.0 (locally installed, protocol 14), primary sources only.

> **Sourcing caveat (important):** the web research tooling in this run was non-functional
> (`web_search` failed with "No API key for Firecrawl" on every attempt), so herdr.dev docs,
> the changelog, and any GitHub repository were **unreachable**. All findings below come from
> **local primary artifacts installed by herdr itself** on this machine:
>
> - `~/.config/herdr/config.toml` — the user's live herdr config (schema is primary evidence of features)
> - `~/.claude/hooks/herdr-agent-state.sh` — herdr-installed Claude integration (`HERDR_INTEGRATION_ID=claude`, `HERDR_INTEGRATION_VERSION=7`)
> - `~/.pi/agent/extensions/herdr-agent-state.ts` — herdr-installed Pi integration (`HERDR_INTEGRATION_ID=pi`, `HERDR_INTEGRATION_VERSION=5`)
> - `~/.codex/hooks.json` — references a herdr-installed Codex hook (`~/.codex/herdr-agent-state.sh`)
> - `~/.local/bin/herdr` — the installed binary (Mach-O; string extraction was not feasible with available tools)
>
> Every claim below is tagged **[documented]** (directly observed in these artifacts) or
> **[inference]** / **[unverified]**. Questions that depend on herdr.dev docs pages
> (`herdr agent` subcommand list, `herdr wait`, skills system naming, changelog/cadence,
> stability guarantees) could **not** be verified and are flagged as gaps.

## Summary

herdr ships first-class agent-native primitives: per-pane agent state reporting
(`working | blocked | idle`) over a newline-delimited JSON Unix-socket API, versioned
auto-installed integrations for Pi, Claude, and Codex, an env contract
(`HERDR_ENV` / `HERDR_SOCKET_PATH` / `HERDR_PANE_ID`), agent session tracking with
resume-on-restore, a centralized worktree store with dedicated worktree
create/open/remove UI actions, and system-delivered notifications with an attention
queue. This confirms substantial overlap with a custom cmux-style orchestration layer
for state reporting, notifications, and worktree sessions. The CLI orchestration surface
(`herdr agent …`, `herdr wait`, skills) could not be verified from reachable primary
sources in this run.

## Findings

### 1. Agent-native primitives (integration system, env contract, socket protocol, state reporting)

1. **Env contract is exactly `HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID`** —
   **[documented]** Both the Claude and Pi integrations gate on all three:
   `[ "${HERDR_ENV:-}" = "1" ]`, non-empty `HERDR_SOCKET_PATH`, non-empty `HERDR_PANE_ID`,
   and silently no-op otherwise (TTY-defensive by design).
   Sources: `~/.claude/hooks/herdr-agent-state.sh`, `~/.pi/agent/extensions/herdr-agent-state.ts`.

2. **Socket API shape: Unix domain socket, newline-delimited JSON-RPC-like requests** —
   **[documented]** Requests are `{"id": "<source>:<ts>:<rand>", "method": "<ns.method>", "params": {…}}`
   written as a single line (`JSON.stringify(request) + "\n"`); the client reads one response
   chunk and closes. Timeouts are short (500 ms first attempt, 1500 ms retry in the Pi
   integration; 0.5 s in the Claude hook). Source: both integration files.

3. **Observed socket methods (protocol 14 as running locally):** — **[documented]**
   - `pane.report_agent` — params `{pane_id, source, agent, state, message?, seq, agent_session_path?|agent_session_id?}`;
     `state` is typed `"working" | "blocked" | "idle"` in the Pi integration. This is the
     agent-status primitive the task calls `agent_status idle|working|blocked`.
   - `pane.report_agent_session` — params `{pane_id, source, agent, seq, agent_session_id, agent_session_path?, session_start_source?}`;
     binds a pane to an agent session file/id (used by both Pi and Claude integrations on
     session start). This is what powers session resume (see finding 6).
   - `pane.release_agent` — params `{pane_id, source, agent, seq}`; releases the
     integration's "full-lifecycle authority" over the pane's agent state. The Pi
     integration only releases on a real quit (`reason === "quit"`), explicitly not on
     `/reload`, `/new`, `/resume`, `/fork`.
   - `seq` is a client-monotonic sequence (nanosecond-based) — herdr uses it to discard
     stale/out-of-order reports. **[inference from the code]**
   - `pane.report-metadata` / `report-metadata` — **[unverified]**; not present in any
     local integration. Likely part of the CLI/docs surface I could not reach.

4. **Integrations are herdr-installed, versioned, and overwrite-managed** — **[documented]**
   Each installed file carries the header `installed by herdr / managed by herdr;
   reinstalling or updating the integration overwrites this file. add custom hooks/plugins
   beside this file instead of editing it.` plus `HERDR_INTEGRATION_ID=<pi|claude>` and
   `HERDR_INTEGRATION_VERSION=<n>` (pi=5, claude=7). Codex has an equivalent hook wired
   in `~/.codex/hooks.json` (`bash '~/.codex/herdr-agent-state.sh' session` on
   SessionStart). The existence of a `herdr integration` install/update CLI command is
   **[inference]** from these headers — consistent with the requester's belief, but the
   command itself was not observable locally.

5. **The Pi integration exposes an extension-facing hook: `pi.events.on("herdr:blocked", …)`** —
   **[documented]** Any other Pi extension (i.e. SumoCode) can emit
   `herdr:blocked` with `{active: boolean, label?: string}` to push the pane into/out of
   the `blocked` state with a custom label. Blocked signals are ref-counted
   (`blockedCount`), so nested approvals compose. This is a direct, already-installed
   integration point for SumoCode's approval/DEFERRING state.
   Source: `~/.pi/agent/extensions/herdr-agent-state.ts`.

6. **State semantics are debounced and retry-aware** — **[documented]** Idle is debounced
   (`HERDR_PI_IDLE_DEBOUNCE_MS`, default 250 ms); retryable provider errors (rate limits,
   5xx, network) hold the pane in `working` for a grace window
   (`HERDR_PI_RETRY_GRACE_MS`, default 2500 ms) before flipping to `blocked` with the
   error message. Only the root UI session reports; subagent sessions are ignored.
   Source: `~/.pi/agent/extensions/herdr-agent-state.ts`.

7. **Agents are first-class UI objects with an attention queue** — **[documented in config schema]**
   `~/.config/herdr/config.toml` binds `previous_agent` / `next_agent` /
   `focus_agent = "prefix+alt+1..9"` under a section commented "Global movement and
   attention queue", plus `open_notification_target`, `agent_panel_sort = "priority"`,
   and `show_agent_labels_on_pane_borders = true`. So herdr maintains a cross-workspace
   agent list/panel, priority-sorts it, labels panes with agent state, and can jump focus
   to the pane that raised the latest notification.

8. **`herdr agent list/get/read/send/rename/focus/wait/attach/start/explain` and `herdr wait`** —
   **[unverified]** These CLI subcommands are asserted in the task but appear in no local
   artifact I could read, and herdr.dev was unreachable. The agent-panel/focus/session
   machinery above makes them plausible (focus, attach, and session read/send have visible
   backing state), but I cannot document flags or output formats. Treat as a gap.

### 2. Skills system (or similar)

9. **No local evidence of a "skills" system** — **[unverified]** Nothing in the config
   schema, integration files, or hook wiring references skills, workspace templates, or
   automation hooks by any name. The only extension points observable locally are:
   (a) the "add custom hooks/plugins beside this file" convention in managed integration
   files, and (b) the `herdr:blocked` event bus hook in the Pi integration. If herdr docs
   describe a skills-like feature, it could not be confirmed or named from primary sources
   in this run. **Do not design against it until verified against herdr.dev docs.**

### 3. Native git worktree model

10. **Centralized worktree store, decoupled from the repo** — **[documented in config]**
    `[worktrees] directory = "~/.herdr/worktrees"` — herdr creates worktrees under a
    single user-level directory rather than as siblings of the repo. This differs from a
    plain `git worktree add ../branch`: paths are herdr-managed and uniform across repos.
    (The directory did not yet exist on disk at read time — no worktrees created yet.)

11. **Worktrees are first-class workspace actions** — **[documented in config schema]**
    Dedicated keybindings exist: `new_worktree = "prefix+shift+g"`,
    `open_worktree = "prefix+shift+o"`, `remove_worktree = "prefix+alt+d"`, grouped in the
    config under the "Workspaces and tabs" section alongside `new_workspace` /
    `close_workspace`. **[inference]** This grouping plus the "open" verb (open an
    existing worktree *as a workspace*) strongly implies the workspace-per-worktree model
    the task describes: create → new branch + worktree + workspace; open → workspace onto
    an existing worktree; remove → tear down worktree (and presumably its workspace).

12. **`herdr worktree create/open/list/remove` flags (branch/base/path/label), label
    derivation, and auto-removal policy** — **[unverified]** CLI semantics require
    herdr.dev docs or `herdr worktree --help`; neither was reachable. `remove_worktree`
    being an explicit user action suggests worktrees are **not** auto-removed on
    workspace close, but that is **[inference]** only.

### 4. Notifications, waits, orchestration hooks

13. **System-delivered toasts with delay and positioning** — **[documented in config]**
    `[ui.toast] delivery = "system"` (macOS desktop notifications rather than in-terminal
    toasts), `delay_seconds = 2` (suppresses notifications when you're already looking),
    `[ui.toast.herdr] position`, `[ui.toast.clipboard] enabled/position`, `[ui.sound] enabled`.
    Combined with `open_notification_target` (jump to the pane that notified), herdr
    covers cmux-style "desktop notification + click-through to pane" natively.

14. **Session restore re-attaches agents** — **[documented in config]**
    `[session] resume_agents_on_restore = true` — herdr persists the pane↔agent-session
    binding (via `pane.report_agent_session`, which carries the transcript/session file
    path) and can resume agents when a workspace/session is restored. This is result/state
    continuity a custom layer would otherwise have to build.

15. **`herdr wait` / `notification show` CLI, task or fleet dashboards** —
    **[unverified]** No local artifact documents a `wait` primitive or a `notification
    show` command. The agent panel (`agent_panel_sort = "priority"`) is the closest
    observable thing to a fleet dashboard: a live, priority-sorted list of all agent
    panes with states. No evidence of task queues or result collection.

### 5. Stability / versioning

16. **Stable channel + update/manifest checks exist** — **[documented in config]**
    `[update] channel = "stable"`, `version_check = true`, `manifest_check = true`.
    A configurable `channel` key confirms at least one non-default channel exists
    (**[inference]**: a preview/nightly channel), but names and cadence are unverified.

17. **Integrations and protocol are independently versioned** — **[documented]**
    `HERDR_INTEGRATION_VERSION` (pi=5, claude=7) shows per-integration versioning with
    in-file changelog-ish comments (e.g. the Claude hook documents a behavior change:
    "Older Herdr integrations mapped SubagentStop to durable working…"). The requester
    reports the running daemon speaks **protocol 14**; nothing local states the protocol
    version or compatibility policy. **[unverified]**: release cadence, changelog
    contents, and any documented stability guarantee for the socket API or CLI JSON output.

### 6. What herdr makes redundant in a custom orchestration layer

18. **Already redundant (herdr does it natively, evidenced locally):**
    - **Agent state signalling** — per-pane `working/blocked/idle` with debounce,
      retry-hold, and label support, already installed for Pi/Claude/Codex. SumoCode
      should emit `herdr:blocked` for approvals instead of building its own channel. **[documented]**
    - **Desktop notifications + focus-to-pane** — system toast delivery, delay logic,
      notification-target jump key. Replaces custom cmux notification plumbing. **[documented]**
    - **Attention queue / fleet visibility** — priority-sorted agent panel, per-pane
      state labels, prev/next-agent navigation across workspaces. **[documented in config]**
    - **Worktree sessions** — centralized worktree store + create/open/remove workspace
      actions. Replaces custom "git worktree session" management. **[documented schema / inference on semantics]**
    - **Agent session persistence/resume** — pane↔session binding with
      resume-on-restore. **[documented]**
19. **Not evidenced (keep in the custom layer until docs prove otherwise):** task queues,
    result collection/aggregation, programmatic fleet control (`herdr agent send/wait/start`),
    skills/templates, cross-machine orchestration (though `[remote] manage_ssh_config = true`
    shows SSH-managed remote workspaces exist). **[unverified]**

## Sources

- Kept: `~/.config/herdr/config.toml` — live config; its schema is direct evidence of worktree store, agent panel, toast delivery, update channels, session resume, remote SSH management.
- Kept: `~/.pi/agent/extensions/herdr-agent-state.ts` — herdr-installed Pi integration v5; full socket protocol shape, state machine, `herdr:blocked` hook, env contract.
- Kept: `~/.claude/hooks/herdr-agent-state.sh` — herdr-installed Claude integration v7; env contract, `pane.report_agent_session`, subagent filtering.
- Kept: `~/.codex/hooks.json` — proves the Codex integration is installed (`~/.codex/herdr-agent-state.sh` on SessionStart).
- Dropped: `~/.local/bin/herdr` binary — Mach-O string extraction infeasible with read-only line-based tooling; sampled regions were unwind tables, not help text.
- Unreachable: https://herdr.dev (docs, changelog, integration pages) and any GitHub repo — `web_search` tool failed with a missing Firecrawl API key on every attempt. **No herdr.dev URL below is cited because none could be fetched.**

## Gaps

Could not verify (all require herdr.dev docs, the changelog, or `herdr … --help` output):

1. Exact `herdr agent` subcommand set and flags (list/get/read/send/rename/focus/wait/attach/start/explain) and `herdr wait` semantics/output.
2. Whether herdr has a "skills" system and what the docs actually call it.
3. `herdr worktree create/open/list/remove` flag semantics (branch/base/path/label), label derivation, auto-removal policy.
4. `herdr notification show` options; any task/fleet dashboard beyond the agent panel.
5. Release cadence, protocol-14 changelog, channel names, and documented API-stability guarantees for the socket API / CLI JSON.
6. `pane.report-metadata` / `report_metadata` method shape.

**Suggested next steps:** rerun this research once web access is restored (fetch
herdr.dev/docs, /changelog, GitHub); or, cheaper and fully local, run
`herdr --help`, `herdr agent --help`, `herdr worktree --help`, `herdr wait --help`,
`herdr integration --help`, and `herdr notification --help` in a shell (this subagent had
no bash tool) — that would close gaps 1–4 and 6 against the actual v0.7.0 binary.

---

## Addendum (2026-07-18): gaps closed via live CLI + herdr.dev

Verified by the parent session against the local v0.7.0 binary (`herdr … --help`,
read-only JSON calls with a running server, protocol 14) and https://herdr.dev
(docs index dated Jul 17, 2026; https://herdr.dev/agent-guide.md). Closes gaps 1–4
and 6; revises finding 9.

1. **CLI surface confirmed [documented].** `herdr agent
list/get/read/send/rename/focus/wait/attach/start/explain` all exist;
`agent start <name> [--cwd] [--workspace] [--tab] [--split right|down] [--env] -- <argv…>`
spawns argv directly in a new pane; `agent wait <target> --status idle|working|blocked|unknown
[--timeout MS]` blocks on agent state. `herdr wait output <pane> --match <text> [--regex]`
and `herdr wait agent-status <pane> --status …` exist. `herdr pane
split/run/close/focus/read/report-agent/report-metadata/move/zoom/rename` confirmed;
`pane report-metadata` takes `--title/--display-agent/--custom-status/--state-label/--ttl-ms`.
CLI responses are JSON envelopes: `{"id":"cli:pane:list","result":{…,"type":"pane_list"}}`
with stable ids (`w1:p2`, `w1:t2`, `term_…`).
2. **Skills: verified, two distinct things [documented].** (a) Herdr ships an
agent-facing skill — `SKILL.md`
(https://raw.githubusercontent.com/ogulcancelik/herdr/master/SKILL.md) — teaching an
agent inside a pane to drive herdr (split, run without stealing focus, read output,
“wait on other agents”); installable via `npx skills add ogulcancelik/herdr --skill herdr -g`
(per https://herdr.dev/agent-guide.md). (b) A **plugin system**: “Author local executable
workflow plugins with manifest actions and event hooks” plus a marketplace
(https://herdr.dev/docs/ index; “plugin panes” shipped in v0.7.4 release notes). Herdr's
repo is public: https://github.com/ogulcancelik/herdr.
3. **Worktree CLI confirmed [documented].**
`herdr worktree create [--workspace|--cwd] [--branch NAME] [--base REF] [--path PATH]
[--label TEXT] [--focus] [--json]`, `worktree open (--path|--branch) [--label]`,
`worktree list [--json]` (git-aware: reports `branch`, `is_detached`,
`is_linked_worktree`, `is_prunable`, `open_workspace_id` per entry, including worktrees
created by other tools), `worktree remove --workspace ID [--force]`. `--path`/`--branch`
override the default `~/.herdr/worktrees` store, so external conventions (e.g.
`sumo/<slug>` + sibling dirs) can be preserved while still getting a first-class herdr
workspace. Removal is an explicit action (confirmation-gated keybinding) — no observed
auto-removal.
4. **Notifications [documented].** `herdr notification show <title> [--body TEXT]
[--position …] [--sound none|done|request]`.
5. **Docs surface [documented].** CLI reference (https://herdr.dev/docs/cli-reference/),
socket API (https://herdr.dev/docs/socket-api/), agents/integrations, session-state, and
plugins pages exist; stable + preview channels confirmed on the docs site header.
Agent states in current docs: `working | blocked | done | idle | unknown` (adds `done`
over the v5 Pi integration's three states).
6. **Orchestration overlap (revised conclusion).** Herdr natively provides: pane-fleet
visibility (agent panel + attention queue), agent-state waits (`agent wait`,
`wait agent-status`), direct agent spawn (`agent start -- argv`), text steering into
panes (`agent send`), pane transcript reads (`agent read`/`pane read`), session
resume, native worktree workspaces, and desktop notifications. It does NOT provide:
typed result envelopes/manifests, task queues/dependencies, consumed-tracked result
delivery into a parent conversation, or headless (non-pane) child management — those
remain SumoCode's layer.
