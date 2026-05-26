# SumoCode visible-agent orchestration — architecture research

Status: research note, 2026-05-26. Inputs are linked inline.

This is a from-scratch synthesis of how Pi + cmux can host visible background
agents, what packages already exist in the ecosystem, and what SumoCode should
actually build vs. delegate.

## 1. Decompose the problem

It looks like one feature ("visible background tasks"), but it is really four
independent layers stacked on top of each other:

| Layer | Question | Owner |
|---|---|---|
| **L1 Process** | How do we spawn a long-running task without blocking the orchestrator turn? | Pi extension code (`child_process.spawn` / detached). |
| **L2 Visibility** | Where does the user *see* the task? | cmux (panes, surfaces, sidebar, notifications). |
| **L3 Session** | Is the spawned process a plain shell, a Pi session, or something else? Where does its state live? | Pi (`--session`, `--mode json`, session events, `pi-tasks`-style stores). |
| **L4 Coordination** | How does the orchestrator learn the result, steer mid-run, or message the child? | Either Pi events (intra-process) or file/IPC/RPC (inter-process). |

The mistake every "subagent" extension makes is conflating these. The
ecosystem is large precisely because each project draws the dividing line
differently. SumoCode needs to pick its line consciously.

## 2. Pi's actual native primitives (from `extensions.md` and `rpc.md`)

These are what's *actually in `@earendil-works/pi-coding-agent`*. No package
needed.

### Session lifecycle hooks

- `session_start { reason: "startup" | "reload" | "new" | "resume" | "fork", previousSessionFile? }`
- `session_before_switch / session_before_fork / session_before_compact / session_before_tree`
- `session_shutdown { reason }`
- `before_agent_start / agent_start / agent_end`
- `turn_start / turn_end`
- `message_start / message_update / message_end`
- `tool_execution_start / tool_execution_update / tool_execution_end`
- `tool_call` (can block by returning `{ block: true }`)
- `tool_result` (can rewrite the result)
- `context` (can rewrite messages right before the LLM call)
- `model_select / thinking_level_select`
- `input` (intercept user input before skill/template expansion)
- `user_bash` (intercept `!`/`!!` commands; can replace operations)
- `before_provider_request / after_provider_response`

### Real session-control APIs (command context only)

- `ctx.newSession({ parentSession?, setup?, withSession? })`
- `ctx.fork(entryId, { position?, withSession? })`
- `ctx.switchSession(path, { withSession? })`
- `ctx.navigateTree(targetId, { summarize?, ... })`
- `ctx.reload()`
- `ctx.compact({ customInstructions?, onComplete?, onError? })`

### Cross-extension comms

- `pi.events.on/emit(name, data)` — shared in-process EventBus. This is the
  pivot used by `pi-tasks`, `tintinweb/pi-subagents`, and others to expose
  RPC across extensions in the same Pi process.
- `pi.sendUserMessage(text, { deliverAs })` — inject text as if user typed it
  (`steer` / `followUp` / `nextTurn`).
- `pi.sendMessage({ customType, content, display, details }, { deliverAs, triggerTurn })`
  — inject a custom message into the session for renderers.
- `pi.appendEntry(customType, data)` — persistent extension state in session.

### Sub-process modes worth knowing

- `pi -p` / `--print` — one-shot, no TTY.
- `pi --mode json` — line-delimited JSON events on stdout (the protocol
  HazAT/`collaborating-agents` parse to detect message_end / session id /
  exit). Stable enough that multiple extensions rely on it.
- `pi --mode rpc` — full bidirectional JSON-RPC over stdio with extension UI
  sub-protocol. Host owns UI; extensions still load. This is the "headless
  worker pool" substrate.
- `pi --session <path>` + `--session-control` — pinned session file, child
  controls own session lifecycle. Used by every subagent extension that
  wants to harvest the final assistant message reliably.
- `pi --no-extensions`, `--no-tools`, `--no-skills`, `--no-prompt-templates`,
  `--system-prompt`, `--append-system-prompt`, `--extension <path>` — full
  config control without editing settings.

**Key point:** Pi has no `session.created parentID` event bus à la OpenCode.
Cross-process coordination is *not* native — every package re-invents it
(intercom, fleet IPC files, EventBus + RPC, JSONL polling).

## 3. cmux primitives that matter for L2

From `cmux --help` and `joelhooks/pi-cmux`:

| Primitive | Use |
|---|---|
| `cmux identify --json` | Discover caller workspace/pane/surface refs. |
| `cmux new-split <dir> --workspace <w> --surface <s>` | Open new pane and print `OK surface:<n> workspace:<n>`. |
| `cmux respawn-pane --surface <s> --command <cmd>` | Replace the shell in a freshly-created pane. Survives weird shell-init paths. |
| `cmux send` / `send-key` | Type into a pane (used by opencode-cmux to inject `opencode attach ...`). |
| `cmux read-screen --surface <s> --scrollback --lines <n>` | Scrape pane output. Fallback when stdout pipelines aren't available. |
| `cmux close-surface --surface <s>` | Close a managed pane after completion. |
| `cmux set-status / set-progress / log / notify` | Sidebar entries, progress bars, log feed, native notifications. |
| `cmux top --json --processes` | Snapshot CPU/RSS/process trees per surface — usable as a liveness signal. |
| `cmux move-surface / reorder-surface / list-pane-surfaces / list-panes` | Two-phase grid balancing (the technique `collaborating-agents` uses for >2 panes). |
| `CMUX_WORKSPACE_ID / CMUX_SURFACE_ID / CMUX_TAB_ID` env | Auto-set in cmux terminals. Cheap "are we in cmux?" probe. |

cmux's surface refs are stable enough to track tasks across the lifetime of a
pane. There is no notion of a "Pi session ID" inside cmux — bridging is on us.

## 4. Package landscape, mapped to L1–L4

I went through the active Pi packages and lined up what each one actually
does. Sorted from "thinnest" to "fattest", with the layers they own.

### `pi-cmux` — joelhooks fork (the canonical L2 worker visibility layer)

- Auto no-ops outside cmux. Wires sidebar Running/Idle/NeedsInput, live
  tool-activity, mark-unread on agent_end, peon-ping, pane stack, session
  metadata, and three tools (`cmux`, `cmux_status`, `cmux_notify`).
- Has a real **worker mode**: `PI_CMUX_ROLE=worker`. Keeps visibility,
  disables subprocess-spawning features. `PI_CMUX_CHILD=1` fork-bomb guard.
- File-based fleet IPC via `~/tmp/pi-fleet/<agentId>.json`.
- Does **not** spawn subagents itself. It's deliberately the visibility
  half. The fleet/spawn half lives in `pi-cmux-subagents` (separate).
- Layer ownership: L2 + a sliver of L4 (file IPC).

### `pi-cmux` — javiermolinar (the one SumoCode already mirrors)

- Slash-command oriented, no long-running subagent path. Provides
  `cmux-core`, `cmux-open`, `cmux-split`, `cmux-notify` extensions. Same
  identify → list-panes → new-split → respawn-pane pattern SumoCode lifted.
- Layer ownership: L2 only.

### `pi-subagents` (nicobailon canonical, plus tintinweb/yzlin forks)

- Spawns isolated child Pi processes with their own tools, system prompts,
  models, thinking levels. Defaults to forked context.
- `tintinweb/pi-subagents` adds **cross-extension RPC over `pi.events`**:
  `subagents:rpc:ping/spawn/stop`, `subagents:ready`. This is the cleanest
  in-process API for "other extensions, please spawn an agent for me".
- All variants are *invisible* by default: the child is a background
  process, parent collects results via stdout JSON or session file.
- Layer ownership: L1 + L3 + L4 (in-process).

### `pi-intercom`

- 1:1 session messaging bridge. Pairs with `pi-subagents` so a child can
  send `need_decision` / `progress_update` back to the parent.
- Worth knowing because it solves the "inter-process steering" problem
  cleanly with a structured message protocol, not screen scraping.
- Layer ownership: L4 only.

### `baochunli/pi-collaborating-agents`

- Goes the furthest: registry / inbox / `messages.jsonl` + file reservations
  + `/agents` overlay. Supports both `process` (invisible) and `cmux-pane`
  (visible) launch modes for the **same** abstraction.
- For visible mode, it writes a `.sh` per subagent that:
  1. `cd <cwd>`
  2. `env PI_AGENT_NAME=... pi --session <jsonl> --session-control --extension <colab-ext> --append-system-prompt <type> "<prompt>"`
  3. Captures exit code into `<session>.exit`.
- Then it `cmux new-split` → `cmux send '<bash scriptpath>\n'`. Output
  collection is done by tailing the session JSONL plus the exit marker.
- Pane layout: two-phase `chooseCmuxSplitLeaf` plus a reconciliation pass
  using `list-panes`, `list-pane-surfaces`, `move-surface`, `reorder-surface`
  to reach a balanced grid.
- Auto-closes the pane after final message + idle grace, but leaves it open
  on non-zero exit. Best-in-class shutdown logic in the ecosystem.
- Layer ownership: L1 + L2 + L3 + L4 (file-based registry / inbox).

### `HazAT/pi-interactive-subagents`

- Same idea but a different backend abstraction: backs `cmux`, `tmux`,
  `zellij`, `wezterm` behind a single mux API (`sendCommand`,
  `sendLongCommand`, `readScreen`, `closeSurface`).
- `sendLongCommand` writes the command to a temp `.sh` and only sends
  `bash <path>` to the mux, sidestepping line-wrap truncation. This is
  the documented "long prompts survive send" pattern.
- The launch command is essentially the same as collaborating-agents:
  `pi --session <jsonl> -e <subagent-done.ts> [--model] [--tools] <prompt>`
  with env propagation.
- Layer ownership: L1 + L2 + L3 + L4, with the L2 layer abstracted across
  multiple multiplexers.

### `pi-tasks` (tintinweb)

- Task DAG with dependency edges, file-locked shared task stores, subagent
  spawning via `pi.events` RPC, auto-cascade after completion.
- Not visible by default — it's the *orchestration backbone*, not the
  visibility surface. Worth using *under* a visible layer.
- Layer ownership: L4, plus a thin L1 (it spawns subagents via the RPC bus
  rather than directly).

### `pi-agentteam`, `pi-teams`, `pi-cmux-subagents`, `cmux × pi rig` (gist)

- Variations on "leader + named teammates in tmux panes" with shared
  task board / messaging. Same architectural building blocks: child
  Pi sessions, file-backed message bus, mux panes for visibility.
- `cmux × pi rig` is a spec, not a package, but it's the cleanest
  articulation of the design principles (visible, steerable, composable,
  safe, with a `PI_CMUX_ROLE=worker` fork-bomb guard).

### `@vanillagreen/pi-background-tasks`

- Closer to what SumoCode's `bg_task` is today: track shell tasks, list /
  log / stop, dashboard summary, **not** agent-aware. No cmux integration.
- Layer ownership: L1 + a tiny L4 (status board).

### `@ogulcancelik/pi-tmux`

- Minimal: just wraps tmux pane create/send/list/kill. No session
  abstraction.
- Layer ownership: L2 only (tmux backend).

### Summary matrix

| Package | L1 process | L2 cmux/tmux | L3 session | L4 coordination | Visible by default? |
|---|---|---|---|---|---|
| pi-cmux (joelhooks) | ❌ | ✅ | ❌ | partial (file IPC) | n/a (visibility only) |
| pi-cmux (javiermolinar) | ❌ | ✅ | ❌ | ❌ | n/a |
| pi-subagents | ✅ | ❌ | ✅ | ✅ in-proc | ❌ |
| pi-intercom | ❌ | ❌ | ❌ | ✅ inter-proc | ❌ |
| collaborating-agents | ✅ | ✅ | ✅ | ✅ files+overlay | ✅ (opt-in mode) |
| pi-interactive-subagents | ✅ | ✅ (multi-mux) | ✅ | ✅ files | ✅ |
| pi-tasks | partial | ❌ | ❌ | ✅ EventBus + files | ❌ |
| pi-background-tasks | ✅ | ❌ | ❌ | partial | ❌ |
| pi-tmux | ❌ | ✅ (tmux only) | ❌ | ❌ | ✅ |

## 5. What this means for SumoCode

SumoCode is a Pi *extension* (Cathedral UI, retained TUI, slash commands).
It is **not** a multi-agent orchestrator and shouldn't try to become one. The
goal of `bg_task` is narrow:

> Let the orchestrator hand off a unit of work (shell or agent prompt) to a
> visible cmux surface, then keep going. The orchestrator may inspect logs
> or kill the task later. No fan-out, no DAG, no inboxes.

Mapped to the layer model:

- **L1 (process):** keep ours. `child_process.spawn` for shell tasks; no
  process at all for visible agent panes (cmux owns the lifecycle there).
- **L2 (cmux):** keep the `pi-cmux` (javiermolinar)-style new-split +
  respawn-pane pattern. We already ported it correctly. No move/reorder
  rebalancing needed because we never spawn >1 sibling at a time.
- **L3 (session):** **don't own this.** The visible agent pane runs
  `sumocode "<prompt>"` or `pi "<prompt>"`. That child gets its own Pi
  session file via Pi's normal logic. We don't pin `--session`.
- **L4 (coordination):** **don't own this either.** No final-message
  harvest, no inbox, no file reservations, no exit-code polling for agent
  panes. The user reads the pane.

For shell tasks (L1+L2 only):

- Keep `run.sh` wrapper, `exit.code`, log tee, exit-marker polling, and
  `notifyOnExit` followUp message. This is what `pi-background-tasks` does
  and it works.

For agent panes (L2 only):

- `cd '<cwd>' && exec sumocode '<prompt>'` (already shipped on PR #258).
- No wrapper, no tee, no exit polling. If the user wants to know when
  the child is done, they look at the pane. If they want programmatic
  result harvest, they should be using `pi-subagents`, not `bg_task`.

This is the design tension Dhruv kept catching: every time we tried to
treat visible agent panes like shell tasks, the UX got ugly. They are not
the same animal. Shell tasks are *managed*; agent panes are *handed off*.

## 6. Open architectural choices for SumoCode, scored

| Question | Option A | Option B | Recommendation |
|---|---|---|---|
| Should `bg_task runner=sumocode` collect a final response? | Yes, via `--session <path>` + JSONL tail like collaborating-agents | No, hand off; user reads the pane | **B.** Result harvest is a different feature ("subagent"). Don't conflate. |
| Should `bg_task` rebalance pane layout for ≥2 visible tasks? | Yes, port the two-phase chooser | No, single split at a time, user manages layout | **B for v1.** Re-evaluate only if users actually fan-out. |
| Should the orchestrator be able to message a running agent pane? | Yes, file-based IPC à la pi-intercom | No, kill + spawn fresh | **B.** Steering across cmux panes is `pi-intercom` territory. |
| Should we adopt `pi-cmux` (joelhooks) for sidebar + status? | Yes, full dependency | No, keep ours minimal | **defer.** It's the right package, but sidebar polish is a separate PR. |
| Should we add a "subagent" tool in addition to `bg_task`? | Yes, separate tool with session harvest | No, only `bg_task` | **Yes, eventually**, but as a wrapper around `pi-subagents` / `tintinweb/pi-subagents` via its `subagents:rpc:spawn` event bus. Don't reimplement. |

## 7. Concrete next steps for `bg_task` (PR #258 follow-ups)

Ordered by ROI, smallest first.

1. **Document the boundary.** In `bg_task` description and skill docs,
   state explicitly: shell tasks are tracked, agent panes are handed off.
   This prevents users (and the LLM) from expecting agent result harvest.
2. **Detect `PI_CMUX_CHILD=1`** in the SumoCode entry point and skip
   re-installing `bg_task`. Symmetric with `pi-cmux`. Cheap fork-bomb guard
   if a child sumocode session ever spawns another.
3. **Use `cmux notify`** on shell task exit when `notifyOnExit=true`. The
   current path uses `pi.sendUserMessage`, which only works while the
   orchestrator session is live. cmux notifications survive session
   reload and show across workspaces.
4. **For shell tasks, write `<dir>/meta.json`** with `taskId`, `command`,
   `cwd`, `startedAt`, `runner`, `cmux refs`. Lets future tools (a
   `/bg-tail`, a sidebar widget, etc.) discover live tasks without a
   running SumoCode session.
5. **Add a thin `subagent` tool later**, wrapping `pi-subagents`' EventBus
   RPC (`pi.events.emit("subagents:rpc:spawn", { task, ... })`). Keep
   `bg_task` focused on the hand-off case.

## 8. What we explicitly do not build

- Multi-pane grid layout rebalancing (`move-surface` / `reorder-surface`).
- File reservation / inbox / `messages.jsonl`.
- Session JSONL polling for visible agent result harvest.
- Custom mux abstraction across tmux/zellij/wezterm. cmux only.
- Auto-naming child sessions (that's `pi-cmux`'s `PI_CMUX_SESSION_NAMING`).
- DAG / fan-in / fan-out — defer to `pi-tasks` if we ever need it.

## 9. Reference URLs (verified during research)

- Pi extensions API: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi RPC mode: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md>
- pi-cmux (joelhooks): <https://github.com/joelhooks/pi-cmux>
- pi-cmux (javiermolinar): <https://github.com/javiermolinar/pi-cmux>
- pi-subagents (nicobailon): <https://github.com/nicobailon/pi-subagents>
- pi-subagents (tintinweb, RPC bus): <https://www.npmjs.com/package/@tintinweb/pi-subagents>
- pi-intercom: <https://github.com/nicobailon/pi-intercom>
- collaborating-agents: <https://github.com/baochunli/pi-collaborating-agents>
- pi-interactive-subagents (HazAT): <https://github.com/hazat/pi-interactive-subagents>
- cmux × pi rig (gist): <https://gist.github.com/joelhooks/11aea283acfd5a7f50e596bc63bbdd28>
- pi-tasks: <https://github.com/tintinweb/pi-tasks>
- @vanillagreen/pi-background-tasks: npm registry
- cmux help: `cmux --help` (130+ commands, including `new-split`, `respawn-pane`, `send`, `read-screen`, `top --json`, `notify`).
