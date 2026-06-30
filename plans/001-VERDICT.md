# 001 Verdict: RPC fidelity spike

Plan written against commit: `ae03bc0`
Spike run against commit: `c744cd2d6b4bd75e15405f3cdf303e03dcc4f93f`

Overall verdict: **GO with caveats**

This spike did not touch production code. The harness lives under `scratch/rpc-spike/`, and the directory is ignored by `.gitignore`.

## Claim Results

| Claim | Result | Evidence |
| --- | --- | --- |
| RPC host and extension load | PASS | `node scratch/rpc-spike/host.mjs --selftest` printed a successful `get_state` response and SumoCode extension commands from `get_commands`, including `answer`, `sumo:approval`, and `sumo:theme`. |
| Transcript fidelity | PASS for final persisted transcript shape; caveat for live-only partials | `--tool-scenario`, `--image-scenario`, and `--abort-scenario` produced RPC event fixtures. `--compare-tool`, `--compare-image`, and `--compare-abort` each reported `equal:true` between finalized `message_end` events and `get_messages` after canonical JSON sorting. |
| Task partialResult over RPC | PASS for event stream presence | `node scratch/rpc-spike/host.mjs --task-scenario` reported `partialUpdates:1` for `toolName:"task"` and produced `events-task-partial.jsonl`. Partial task updates are live event data, not final persisted `get_messages` data. |
| Approval round-trip | PASS with security caveat | `node scratch/rpc-spike/approval-test.mjs` exited 0. `No` and timeout preserved the sentinel file and had no successful execution end; `Yes` deleted the sentinel and had successful execution end. Pi emits `tool_execution_start` before `tool_call` veto, so the safe assertion is no successful execution and no side effect, not absence of `tool_execution_start`. |
| answer-tool extraction outside `custom()` | PASS | `node scratch/rpc-spike/host.mjs --answer-rpc` exited 0 and produced structured result content: `{"questions":[{"prompt":"What is your name?"},{"prompt":"Which city should we use?"}]}`. This used a standalone extraction function with `complete()` in RPC mode. |
| Perf bench | PASS for deterministic RPC stream | `node scratch/rpc-spike/host.mjs --perf` exited 0. Metrics are below. No visible host-side JSON parse bottleneck was observed in the deterministic stream. |

## Perf Numbers

Deterministic fake-provider RPC long stream:

| Metric | Value |
| --- | ---: |
| Total elapsed | 3485.001 ms |
| First update | 3323.254 ms |
| Message updates | 102 |
| Average update delta | 1.291 ms |
| Stdout bytes | 12,827,841 |
| JSON.parse time | 5.607 ms |
| Bytes/sec | 3,680,871.101 |

Caveat: this bench used a deterministic scratch provider to avoid live model/provider variability. It proves host JSONL parsing and stdout throughput for a large `partial` stream, but it is not a real-provider latency comparison against interactive SumoTUI.

## Fixtures

Generated fixtures:

- `scratch/rpc-spike/events-tool.jsonl`
- `scratch/rpc-spike/events-task-partial.jsonl`
- `scratch/rpc-spike/events-image.jsonl`
- `scratch/rpc-spike/events-abort.jsonl`
- `scratch/rpc-spike/events-answer-rpc.jsonl`
- `scratch/rpc-spike/events-perf-long-stream.jsonl`

Message and comparison artifacts:

- `scratch/rpc-spike/messages-tool.json`
- `scratch/rpc-spike/messages-task-partial.json`
- `scratch/rpc-spike/messages-image.json`
- `scratch/rpc-spike/messages-abort.json`
- `scratch/rpc-spike/messages-answer-rpc.json`
- `scratch/rpc-spike/view-model-tool-events.json`
- `scratch/rpc-spike/view-model-tool-messages.json`
- `scratch/rpc-spike/view-model-image-events.json`
- `scratch/rpc-spike/view-model-image-messages.json`
- `scratch/rpc-spike/view-model-abort-events.json`
- `scratch/rpc-spike/view-model-abort-messages.json`
- `scratch/rpc-spike/perf-long-stream.json`
- `scratch/rpc-spike/ui-answer-rpc.json`

## Missing AgentEvent Fields

No missing fields were observed for final chat text, thinking blocks, tool call arguments, tool result text, image blocks, or aborted assistant final messages in the deterministic scenarios. `message_end` plus `get_messages` carried the same final transcript view-model inputs after canonicalization.

Known caveat: partial tool progress, including task partial output, is live event-only data. `get_messages` backfills final tool results, not every intermediate `tool_execution_update.partialResult`.

## Un-sourced Surface Inventory

These rendered surfaces are not backed directly by persisted `AgentMessage` records. They need host-owned state or RPC event re-sourcing in the migration.

| Surface | Current source | RPC re-source |
| --- | --- | --- |
| Top chrome/header | `ctx.ui.setHeader`, `session_start`, lifecycle state, session manager/cache | Host-owned chrome using `get_state`, `session_info_changed`, `model_select`, `thinking_level_changed`, `agent_start/end`, and local session list/cache. |
| Footer | `ctx.ui.setFooter`, lifecycle state, model/context usage, branch provider | Host-owned footer using `get_state`, `get_session_stats`, lifecycle events, local git branch watcher, and local cost/context cache. |
| Sidebar dock | `ctx.ui.setWidget("sumocode-sidebar-dock")`, session cache, memory client, metrics HUD | Host-owned sidebar using `get_messages`, `get_state`, local memory client, and local metrics timers. |
| Cathedral editor | `ctx.ui.setEditorComponent` and Pi editor internals | Host-owned editor. RPC only needs prompt/steer/follow_up plus local editor state. |
| Input hints | `ctx.ui.setWidget("sumocode-input-hints")`, model/thinking/context state | Host-owned hint row using `get_state`, `thinking_level_changed`, model events, and local editor/session state. |
| Splash | `ctx.ui.setWidget("sumocode-splash")`, `sessionHasMessages`, message events | Host-owned splash using `get_messages` and `message_start/end` events. |
| Working indicator | `setWorkingIndicator` or retained `setWidget`, driven by `agent_start/end` | Host-owned indicator using `agent_start`, `message_update`, `tool_execution_*`, and `agent_end`. |
| Compaction indicator | retained `setWidget`, `session_before_compact`, `session_compact`, compaction reason cache | Mostly re-sourced from RPC `compaction_start` and `compaction_end`; manual/custom labeling may need an explicit host-side command state. |
| Approval modal | `ctx.ui.custom()` in production approval gate | Re-source via RPC `extension_ui_request` `select`; spike proved denial/timeout safe by side-effect assertion. |
| Divine Query and command palette | `ctx.ui.custom()` overlays | Re-source via RPC `select` or host-native palette UI. No `custom()` dependency can remain because RPC `custom()` is a no-op. |
| Question tool and answer questionnaire | `ctx.ui.custom()` forms | Re-source via RPC `select/input/editor` or host-native form state. Spike proved answer extraction can move outside `custom()`, but questionnaire UI still needs a host replacement. |
| Memory editor and theme-check overlays | `ctx.ui.custom()` | Re-source as host-native modal/editor flows. |
| Notifications | `ctx.ui.notify` | RPC already emits `extension_ui_request` `notify`; host can mirror to notices and optional persisted custom messages where needed. |
| Theme/worktree command result renderers | `pi.sendMessage` plus `registerMessageRenderer` | Persisted custom messages appear in `get_messages`; host must carry SumoCode custom renderers or convert details into host view-model blocks. |
| Slate | `pi.appendEntry("slate", ...)` on shutdown plus transient notifications | Persisted custom entries can be read from session branch in-process today; RPC host will need either a session-entry API or a SumoCode-owned mirror command/event. |
| Background task list and notices | background task manager plus `ctx.ui.notify` | Host-owned background-task panel/state is needed; notify already travels over RPC. |

## Notes

- `ctx.ui.custom()` remains unusable in Pi RPC mode. Any production path depending on it must move to RPC dialog methods or host-native UI.
- The approval claim should be tracked as "veto prevents successful execution and side effects." It should not be tracked as "no `tool_execution_start` is emitted", because Pi emits that event before `beforeToolCall`/`tool_call` approval handlers run.
- The spike host is intentionally disposable. Plan 002 should not copy it wholesale; it should re-implement the host with production process lifecycle, event buffering, UI state ownership, and tests.
