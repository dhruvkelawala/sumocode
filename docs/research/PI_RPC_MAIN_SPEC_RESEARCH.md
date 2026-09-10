# Pi RPC current-main specification research

**Status:** primary-source protocol inventory for the SumoCode RPC audit
**Researched:** 2026-08-27
**Upstream target:** Pi `main` at [`4e494929998d6bc4fccf75e0a233f727db4b70ee`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee)
**SumoCode baseline:** `@earendil-works/pi-coding-agent` `0.84.1` ([manifest](../../package.json#L27-L39), [lockfile](../../pnpm-lock.yaml#L195-L202)); upstream tag commit [`53fa77ccd8a279eb87e92294ef3687b03ff80112`](https://github.com/earendil-works/pi/tree/53fa77ccd8a279eb87e92294ef3687b03ff80112)
**Scope:** upstream RPC wire contract and version/capability delta only. This note does not audit SumoCode's implementation.

## Bottom line

Current upstream main documents **33 RPC commands**. SumoCode's pinned `0.84.1` has the same protocol except for one post-release command, but it is missing two important stream enrichments added in `0.84.2` and `0.84.3`:

1. `0.84.2` adds cumulative `usage` to every `message_update` wire event.
2. `0.84.3` adds `id` and `toolName` to `message_update.assistantMessageEvent` when its type is `toolcall_start`.
3. Current main after `0.84.3` adds `clear_queue`, returning and removing the pending steering and follow-up text.

The full command union, response union, and runtime dispatch confirm that there are no other RPC command additions between `0.84.1` and the researched main commit. The relevant upstream diffs are [`0.84.1...0.84.2`](https://github.com/earendil-works/pi/compare/53fa77ccd8a279eb87e92294ef3687b03ff80112...914cf1472e715297caa30db4b9535d534a9eb718), [`0.84.2...0.84.3`](https://github.com/earendil-works/pi/compare/914cf1472e715297caa30db4b9535d534a9eb718...4e58f324fae8ebfa98a3d45181fb248072a2afac), and [`0.84.3...researched main`](https://github.com/earendil-works/pi/compare/4e58f324fae8ebfa98a3d45181fb248072a2afac...4e494929998d6bc4fccf75e0a233f727db4b70ee). The release record independently names the streaming-usage fix in `0.84.2`, the tool-call identity fix in `0.84.3`, and `clear_queue` under Unreleased ([changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L3-L10), [0.84.3 entry](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L64-L70), [0.84.2 entry](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L107-L152)).

The more consequential finding is that current `rpc.md` is not a complete wire schema. The source emits three session events that the document does not list; its `get_commands`, `get_state`, compaction-failure, and message examples also disagree with current types or JSON serialization in specific ways. Those discrepancies are catalogued below.

## Authority and protocol framing

For this note, the source of truth is ordered as follows:

1. The current main [`RpcCommand` and `RpcResponse` unions](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L18-L230).
2. The current main [`runRpcMode()` dispatcher](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L385-L716).
3. The current main [`rpc.md`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md).
4. The upstream changelog and package metadata for release attribution.

RPC mode is started as `pi --mode rpc [options]`. Common startup options include provider/model selection, an initial session name, no-session operation, and a custom session directory. Pi recommends direct `AgentSession` use for an in-process Node application and provides `RpcClient` for a subprocess TypeScript client ([rpc.md startup and overview](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1-L27)).

The transport is strict JSONL:

- One JSON object per record.
- LF (`\n`) is the only record delimiter.
- Input may be CRLF because Pi strips one trailing `\r` after splitting on LF.
- `U+2028` and `U+2029` are legal inside JSON strings and must not split records; Node's generic `readline` is therefore non-compliant.
- Commands go to stdin. Responses, agent/session events, extension UI requests, and extension errors come from stdout.

These behaviors are stated in the spec and implemented by a dedicated `StringDecoder`-based reader and serializer ([rpc.md framing](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L20-L38), [`jsonl.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/jsonl.ts#L1-L57)).

Every RPC command may carry `id?: string`. A command response echoes that `id`; ordinary events generally do not. The exception is `bash_execution_update.id`, which carries the originating direct `bash` command id. A success has `{type:"response", command, success:true, data?}`; a failure has `{type:"response", command, success:false, error}`. Invalid JSON produces a failure whose `command` is `"parse"` and has no correlated id ([protocol overview](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L20-L27), [error handling](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1376-L1399), [runtime input handling](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L742-L806)).

## Complete command inventory

Notation: `?` means optional; `none` means the success response has no `data` property. Unless a row says **main only**, the command is present in pinned `0.84.1` as well as current main. Request and response fields below come from the current command/response unions and are cross-checked against the runtime dispatcher ([types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L18-L230), [dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L385-L716)).

| Area | Command and request payload beyond `id?` | Success `data` | Operational semantics |
|---|---|---|---|
| Prompting | `prompt`: `message: string`, `images?: ImageContent[]`, `streamingBehavior?: "steer" \| "followUp"` | none | The response acknowledges preflight acceptance/queueing/handling, not LLM completion. While streaming, behavior is required unless the message is an extension command. Skills and prompt templates expand before delivery. |
| Prompting | `steer`: `message: string`, `images?: ImageContent[]` | none | Queues for delivery after the current assistant turn's tool calls and before the next model call. Skills/templates expand; extension commands are rejected. |
| Prompting | `follow_up`: `message: string`, `images?: ImageContent[]` | none | Queues until the agent has no remaining tool calls or steering messages. Skills/templates expand; extension commands are rejected. |
| Prompting | `abort` | none | Aborts the active agent operation. Queued messages remain able to continue the session. |
| Prompting | `clear_queue` (**main only**) | `{steering: string[], followUp: string[]}` | Atomically retrieves and removes the two pending queues. For interactive Escape behavior, upstream says to clear first, then abort, then restore returned text client-side. |
| Prompting | `new_session`: `parentSession?: string` | `{cancelled: boolean}` | Starts a new session, optionally recording parent lineage. An extension may cancel; the RPC runtime rebinds only when not cancelled. |
| State | `get_state` | `RpcSessionState` | Snapshot: `model?`, thinking level, streaming/compacting flags, steering/follow-up modes, `sessionFile?`, session id, `sessionName?`, auto-compaction flag, message count, and pending-message count. |
| State | `get_messages` | `{messages: AgentMessage[]}` | Returns the current conversation/message state, rather than the append-only complete session tree. |
| Model | `set_model`: `provider: string`, `modelId: string` | full `Model` | Selects an exact configured provider/model pair; missing models fail. |
| Model | `cycle_model` | `{model, thinkingLevel, isScoped} \| null` | Advances through available/scoped models; `null` means there is no next choice (for example only one model). |
| Model | `get_available_models` | `{models: Model[]}` | Returns the current configured model snapshot. |
| Thinking | `set_thinking_level`: `level: ThinkingLevel` | none | Sets one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; actual availability is model-dependent. |
| Thinking | `cycle_thinking_level` | `{level} \| null` | Advances supported levels; `null` means the model has no cycling choice. |
| Thinking | `get_available_thinking_levels` | `{levels: ThinkingLevel[]}` | Returns current-model levels; non-reasoning models return `['off']`. |
| Queue policy | `set_steering_mode`: `mode: "all" \| "one-at-a-time"` | none | `all` drains all steers at the next turn boundary; default `one-at-a-time` supplies one per completed assistant turn. |
| Queue policy | `set_follow_up_mode`: `mode: "all" \| "one-at-a-time"` | none | `all` drains all follow-ups at settlement; default `one-at-a-time` supplies one per agent completion. |
| Compaction | `compact`: `customInstructions?: string` | `CompactionResult` | Manual compaction. Result has summary, first kept entry id, pre-compaction tokens, optional estimated post-compaction tokens, optional summarizer usage, and optional extension details. |
| Compaction | `set_auto_compaction`: `enabled: boolean` | none | Enables/disables automatic threshold/overflow compaction. |
| Retry | `set_auto_retry`: `enabled: boolean` | none | Enables/disables retry of transient overload, rate-limit, and server failures. |
| Retry | `abort_retry` | none | Cancels the current retry delay and stops further attempts. |
| Shell | `bash`: `command: string`, `excludeFromContext?: boolean` | `BashResult` | Executes immediately; streams all output in `bash_execution_update`; final result has output, optional exit code, cancelled/truncated flags, and optional full-output path. Unless excluded, its `BashExecutionMessage` is converted to user context on the **next** prompt. |
| Shell | `abort_bash` | none | Aborts the currently running direct RPC bash command. |
| Session | `get_session_stats` | `SessionStats` | Returns session/message/tool counts, aggregate tokens and cost, plus optional current `contextUsage`. Context usage can be absent or temporarily contain null token/percent values after compaction. |
| Session | `export_html`: `outputPath?: string` | `{path: string}` | Exports the current session and reports the chosen path. |
| Session | `switch_session`: `sessionPath: string` | `{cancelled: boolean}` | Extension-cancellable switch; runtime rebinds to the replacement session only on success. |
| Session | `fork`: `entryId: string` | `{text: string, cancelled: boolean}` | Creates a new session fork from a prior user-message entry on the active branch and returns that message text; extension-cancellable. |
| Session | `clone` | `{cancelled: boolean}` | Clones the active branch into a new session at the current leaf; fails when the session has no current entry; extension-cancellable. |
| Session | `get_fork_messages` | `{messages: {entryId, text}[]}` | Lists user messages eligible as fork points. |
| Session | `get_entries`: `since?: string` | `{entries: SessionEntry[], leafId: string \| null}` | Returns append-order entries including pre-compaction history and abandoned branches. `since` is a durable exclusive cursor; an unknown id fails. |
| Session | `get_tree` | `{tree: SessionTreeNode[], leafId: string \| null}` | Returns the append-only session as roots of `{entry, children, label?, labelTimestamp?}`; orphans are roots. |
| Session | `get_last_assistant_text` | `{text: string \| null}` | Last assistant text, or null when none exists. |
| Session | `set_session_name`: `name: string` | none | Trims and sets the display name; an empty trimmed name fails. Startup `--name`/`-n` is the process-level equivalent. |
| Discovery | `get_commands` | `{commands: RpcSlashCommand[]}` | Lists extension commands, prompt templates, and skills. Built-in TUI-only commands are deliberately absent and do not execute through `prompt`. |

The prompt/queue details are specified in [`rpc.md` lines 41–182](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L41-L182). State, models, thinking, and queue policies are in [lines 183–394](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L183-L394). Compaction, retry, and direct bash behavior are in [lines 395–551](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L395-L551). Session and command discovery are in [lines 552–854](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L552-L854).

### Prompt response timing is intentionally asymmetric

`prompt` is the only dispatch case that starts work without awaiting completion. It emits its one authoritative response when prompt preflight succeeds; if preflight fails, it emits one error response instead. Errors after acceptance appear through normal messages/events and never produce a second response for the same id. Every other command returns its response from the command handler itself ([prompt dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L416), [documented acceptance semantics](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L43-L79)).

### Direct `bash` is not an LLM tool call

The `bash` RPC command creates a `BashExecutionMessage`; it does not emit the agent tool lifecycle for an LLM-requested tool call. It has its own `bash_execution_update` stream and final `BashResult`. Unless `excludeFromContext` is true, Pi transforms the persisted bash execution into a user-text block when preparing the next prompt ([RPC bash semantics](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L477-L539), [`BashExecutionMessage` conversion](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/messages.ts#L26-L100)).

## Complete documented event inventory

The document lists 21 top-level event names. The session source event union plus `extension_error` confirms their fields; the RPC subscription sends session events through a JSON-specific `message_update` transform ([documented event list](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L855-L884), [`AgentSessionEvent`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L142-L185), [RPC forwarding](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L317-L360)).

| Event | Shape after `type` | Meaning/correlation |
|---|---|---|
| `agent_start` | none | Prompt processing begins. |
| `agent_end` | `messages: AgentMessage[]`, `willRetry: boolean` | One low-level agent run ended; retry, compaction, or queued continuation may still follow. |
| `agent_settled` | none | Session-level run has no automatic retry, compaction retry, or queued continuation remaining. |
| `turn_start` | none | Starts one assistant-response-plus-tools turn. |
| `turn_end` | `message: AgentMessage`, `toolResults: ToolResultMessage[]` | Ends that turn. |
| `message_start` | `message: AgentMessage` | Starts a user, assistant, or tool-result/custom message lifecycle. |
| `message_update` | `usage: Usage`, `assistantMessageEvent: delta` | Assistant-only streaming event. Main omits the cumulative `message` and nested `partial`; clients assemble blocks by `contentIndex`. |
| `message_end` | `message: AgentMessage` | Final authoritative message snapshot. |
| `bash_execution_update` | `id?: string`, `delta: string` | One output chunk from direct RPC `bash`; only event with command-id correlation. Streams even if final result is truncated. |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | LLM tool starts. |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | Accumulated tool result so far, not a delta; display may replace the prior partial. |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` | LLM tool completes. |
| `queue_update` | `steering: string[]`, `followUp: string[]` | Either pending queue changed. |
| `compaction_start` | `reason: "manual" \| "threshold" \| "overflow"` | Compaction begins. |
| `compaction_end` | `reason`, `result?`, `aborted`, `willRetry`, `errorMessage?` | Compaction completed, aborted, or failed. Successful overflow compaction may cause an automatic prompt retry. |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | Transient assistant-turn retry delay begins. |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | Retry loop succeeds or exhausts attempts. |
| `summarization_retry_scheduled` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | Compaction/branch-summary transient retry is scheduled. |
| `summarization_retry_attempt_start` | `{source:"branchSummary"}` or `{source:"compaction", reason}` | Retried summarization request starts. |
| `summarization_retry_finished` | none | Summarization retry loop is finished. |
| `extension_error` | `extensionPath`, `event`, `error` | Extension factory/handler error forwarded separately from the session event union. |

Lifecycle, streaming, bash, tool, queue, compaction, retry, summarization, and extension-error examples are in [`rpc.md` lines 885–1183](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L885-L1183).

### `message_update` delta shapes on current main

Current main's JSON transform deliberately removes every internal `partial: AssistantMessage`. It adds the latest cumulative provider `usage` at the top level and enriches only `toolcall_start` with stable identity. The final message remains `message_end.message` ([JSON transform](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/json-event.ts#L1-L60), [stream documentation](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L938-L997)).

| `assistantMessageEvent.type` | Fields beyond `type` |
|---|---|
| `text_start` | `contentIndex` |
| `text_delta` | `contentIndex`, `delta: string` |
| `text_end` | `contentIndex`, `content: string` |
| `thinking_start` | `contentIndex` |
| `thinking_delta` | `contentIndex`, `delta: string` |
| `thinking_end` | `contentIndex`, `content: string` |
| `toolcall_start` | `contentIndex`, `id: string`, `toolName: string` |
| `toolcall_delta` | `contentIndex`, `delta: string` (incremental serialized arguments) |
| `toolcall_end` | `contentIndex`, complete `toolCall` object |

Provider usage may remain all-zero until completion when the provider does not report usage while streaming. `toolcall_delta.delta` must be buffered to reconstruct live arguments; `toolcall_end.toolCall` is authoritative for the completed call.

## Extension UI sub-protocol

RPC mode sets extension `ctx.mode` to `"rpc"` and `ctx.hasUI` to true. UI support is a fixed request/response bridge rather than direct TUI access ([extension UI overview](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1184-L1206), [RPC UI implementation](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L72-L310)).

All server-to-client requests are `{type:"extension_ui_request", id:string, method, ...}`. There are four blocking dialogs:

| Method | Request fields | Valid response |
|---|---|---|
| `select` | `title`, `options: string[]`, `timeout?: number` | `{type:"extension_ui_response", id, value:string}` or `{..., cancelled:true}` |
| `confirm` | `title`, `message`, `timeout?: number` | `{..., confirmed:boolean}` or `{..., cancelled:true}` |
| `input` | `title`, `placeholder?: string`, `timeout?: number` | `{..., value:string}` or `{..., cancelled:true}` |
| `editor` | `title`, `prefill?: string` | `{..., value:string}` or `{..., cancelled:true}` |

Select/input/editor cancellation resolves to `undefined`; confirm cancellation resolves to false. For supported timed dialogs, Pi owns the timer and resolves the default locally; the client need not schedule it.

There are five fire-and-forget methods. They still carry unique request ids but require no response:

| Method | Request fields | Semantics |
|---|---|---|
| `notify` | `message`, `notifyType?: "info" \| "warning" \| "error"` | Notification; omitted type means info. |
| `setStatus` | `statusKey`, `statusText?: string` | Set or clear a keyed status entry. |
| `setWidget` | `widgetKey`, `widgetLines?: string[]`, `widgetPlacement?: "aboveEditor" \| "belowEditor"` | Set/clear string-line widget; factories are unsupported; default placement is above. |
| `setTitle` | `title` | Set host window/tab title. |
| `set_editor_text` | `text` | Replace host editor text; also used as the degraded `pasteToEditor` path. |

The discriminated request and response unions are authoritative ([RPC UI types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L232-L286)); the spec includes all request/response examples ([rpc.md UI requests](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1207-L1375)).

Direct-TUI methods are degraded or unavailable. `custom()` resolves undefined; custom header/footer/editor components, tool-expansion controls, working-message/indicator controls, theme changes, raw terminal input, and autocomplete composition do not cross the protocol. Synchronous editor reads return an empty string; `pasteToEditor` degrades to `set_editor_text`; theme enumeration/lookup is empty/undefined. Current source also shows newer `setWorkingVisible`, `setHiddenThinkingLabel`, `addAutocompleteProvider`, and `getEditorComponent` methods as no-op/undefined even though the current RPC document's unsupported-method list does not name all of them ([documented degradation list](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1195-L1206), [implemented RPC UI context](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L120-L310)).

## Documented message and nested data shapes

### Model

RPC model-bearing responses use the full Pi `Model` object. The document's representative required fields are `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, accepted `input` kinds, `contextWindow`, `maxTokens`, and per-million-token `cost` components (`input`, `output`, `cacheRead`, `cacheWrite`) ([documented Model](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1400-L1430)). Clients should preserve unknown optional model/provider compatibility fields rather than treating this example as a closed schema.

### `AgentMessage`

The base source union is `UserMessage | AssistantMessage | ToolResultMessage`, extended by coding-agent-specific message roles. These objects appear in `get_messages`, `message_start`, `message_end`, `agent_end`, and `turn_end` ([base message types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L421-L467), [extensible `AgentMessage`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts#L300-L325), [coding-agent roles](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/messages.ts#L26-L76)).

| Role | Current source shape |
|---|---|
| `user` | `{role:"user", content: string \| (TextContent \| ImageContent)[], timestamp:number}` |
| `assistant` | `{role:"assistant", content:(TextContent \| ThinkingContent \| ToolCall)[], api, provider, model, responseModel?, responseId?, diagnostics?, usage, stopReason, deferred?, errorMessage?, rawStopReason?, endTurn?, timestamp}` |
| `toolResult` | `{role:"toolResult", toolCallId, toolName, content:(TextContent \| ImageContent)[], details?, usage?, addedToolNames?, isError, timestamp}` |
| `bashExecution` | `{role:"bashExecution", command, output, exitCode?, cancelled, truncated, fullOutputPath?, timestamp, excludeFromContext?}` |
| `custom` | `{role:"custom", customType, content, display, details?, timestamp}` |
| `branchSummary` | `{role:"branchSummary", summary, fromId, timestamp}` |
| `compactionSummary` | `{role:"compactionSummary", summary, tokensBefore, timestamp}` |

Content blocks used by documented message examples are:

- `TextContent`: `{type:"text", text, textSignature?}`.
- `ImageContent`: `{type:"image", data:<base64>, mimeType}`.
- `ThinkingContent`: `{type:"thinking", thinking, thinkingSignature?, redacted?}`.
- `ToolCall`: `{type:"toolCall", id, name, arguments, thoughtSignature?, namespace?}`.
- `Usage`: input/output/cache counters, optional cache-retention/reasoning counters, `totalTokens`, and nested monetary cost totals.

These exact current types are in [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L350-L467). The current RPC document provides examples for user, assistant, tool-result, bash-execution, and attachment-shaped data in [lines 1431–1525](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1431-L1525), but those examples are not a complete or entirely current schema; see the discrepancies below.

## Exact capability delta from pinned `0.84.1`

### 1. `0.84.2`: cumulative usage on every streaming update

Pinned `0.84.1` emits:

```text
{type:"message_update", assistantMessageEvent:<delta without partial>}
```

From `0.84.2`, the wire emits:

```text
{type:"message_update", usage:<latest cumulative Usage>, assistantMessageEvent:<delta without partial>}
```

The `0.84.2` source change reads usage from the current assistant message snapshot while still dropping the O(n)-growing partial message. This enables live cost/token/context displays without reconstructing provider accounting from deltas ([0.84.2 changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L135-L147), [current transform](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/json-event.ts#L10-L18)).

### 2. `0.84.3`: tool-call identity is available at start

Pinned `0.84.1` (and `0.84.2`) `toolcall_start` has only `contentIndex`; a client must wait for `toolcall_end.toolCall` to learn stable identity from the RPC stream. From `0.84.3`, `toolcall_start` is `{type:"toolcall_start", contentIndex, id, toolName}`. Upstream derives the two fields from the internal partial once, then removes that partial before serialization ([0.84.3 changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L64-L70), [transform](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/json-event.ts#L20-L37)).

This permits immediate correlation/rendering of a live tool activity card before argument streaming finishes.

### 3. Current post-`0.84.3` main: `clear_queue`

`clear_queue` is absent from `0.84.1`, `0.84.2`, and `0.84.3`. It exists on researched main in the command/response unions, runtime dispatch, official client helper, documentation, and Unreleased changelog ([types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L18-L30), [dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L428-L443), [`RpcClient.clearQueue()`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-client.ts#L211-L231), [docs](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L124-L159)).

It closes a behavioral gap for a host-owned editor: the host can retrieve queued user text before aborting, because `abort` by itself leaves queued continuations eligible to run.

### 4. `0.84.2` nested message-shape additions

Because RPC forwards full `AssistantMessage` and `ToolCall` objects, two inherited AI-layer additions are also observable on the wire after the pin:

- `AssistantMessage.endTurn?: boolean`, a provider diagnostic preserving OpenAI Codex's terminal `end_turn` signal.
- `ToolCall.namespace?: string`, used for OpenAI Responses dynamically loaded/namespaced tools.

Both are optional and should be handled as additive fields ([0.84.2 changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L115-L125), [current AssistantMessage/ToolCall source](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L372-L445)).

### 5. `0.84.3` entrypoint packaging change, not a wire change

The pinned package maps the `pi` bin to `dist/cli.js` and `./rpc-entry` to `dist/rpc-entry.js`; current main package metadata maps them to `dist/bundle/cli.js` and `dist/bundle/rpc-entry.js`. The public export name is stable, but code that resolves a private physical dist path instead of the package export is version-sensitive ([pinned package metadata](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/package.json#L9-L24), [current package metadata](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/package.json#L9-L24), [0.84.3 changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L51-L62)).

Current main's manifest still says version `0.84.3` while the changelog places `clear_queue` under Unreleased. Planning must therefore target the researched main SHA/capability, not assume that installing released `0.84.3` provides `clear_queue` ([current manifest](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/package.json#L1-L4), [Unreleased entry](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/CHANGELOG.md#L3-L10)).

## Current `rpc.md` versus current source: compatibility hazards

These are upstream documentation/source gaps, not findings about SumoCode.

### DOC-SOURCE-01: `get_commands` provenance example is stale

`rpc.md` shows flat `path` and `location` fields and describes `location` values including `"path"`. Current `RpcSlashCommand` instead requires:

```text
{name, description?, source:"extension"|"prompt"|"skill", sourceInfo}
```

`sourceInfo` is `{path, source, scope:"user"|"project"|"temporary", origin:"package"|"top-level", baseDir?}`. Runtime construction also emits `sourceInfo`, not flat provenance ([stale doc example](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L816-L853), [current RPC type](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L76-L90), [`SourceInfo`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/source-info.ts#L1-L21), [runtime construction](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L682-L713)).

### DOC-SOURCE-02: three session events are emitted but undocumented

The source `AgentSessionEvent` union includes and emits:

- `entry_appended`: `{type:"entry_appended", entry: SessionEntry}`.
- `session_info_changed`: `{type:"session_info_changed", name?: string}` (undefined is omitted on JSON serialization).
- `thinking_level_changed`: `{type:"thinking_level_changed", level: ThinkingLevel}`.

RPC forwards all session subscription events, but none appears in the document's event table or individual event sections ([session event union](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L142-L185), [RPC forwarding](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L353-L360), [documented list](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L859-L884)). These events already exist in pinned `0.84.1`; they are not a new main-only capability.

### DOC-SOURCE-03: absent values are sometimes documented as `null`

The document says `get_state.model` is a `Model` or null, but `RpcSessionState.model` is optional and runtime passes `undefined`; JSON serialization omits the key. `sessionFile` and `sessionName` are likewise optional. The same issue exists for failed/aborted `compaction_end`: docs say `result` is null, while the source type and emit sites use `undefined`, so the property is omitted on stdout ([get-state docs](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L185-L217), [state type](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L93-L109), [compaction event type](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L156-L167), [documented compaction cases](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1069-L1108)). A robust client should accept both missing and null for compatibility.

### DOC-SOURCE-04: the `UserMessage`/Attachment examples are obsolete

`rpc.md` shows `UserMessage.attachments` and separately defines an `Attachment` object with file metadata, extracted text, and preview. Current `UserMessage` has no `attachments` property, and the current source files named by the document define no such RPC `Attachment` type. Prompt images are `ImageContent` blocks placed in `UserMessage.content` alongside a text block ([documented examples](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1431-L1443), [documented Attachment](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1511-L1525), [current UserMessage/ImageContent](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L366-L370), [current prompt image assembly](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1237-L1246)).

### DOC-SOURCE-05: message examples are narrower than the wire

The documented assistant usage example omits required `totalTokens`; its stop-reason list omits source values `"pending"` and `"deferred"`; and it does not describe optional assistant/tool-call fields such as response ids, deferred handles, diagnostics, `endTurn`, or tool `namespace`. The document also says `get_messages` returns `AgentMessage[]` but documents only user, assistant, tool result, and bash-execution roles; current coding-agent `AgentMessage` can also contain custom, branch-summary, and compaction-summary roles ([documented assistant](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1444-L1470), [current source](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L382-L467), [coding-agent custom roles](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/messages.ts#L42-L76)). Treat message/content objects as forward-extensible discriminated unions.

### DOC-SOURCE-06: RPC UI degradation list lags the interface

The document correctly states that custom TUI access does not cross RPC, but the source has accumulated additional no-op/undefined methods beyond the named list, including raw terminal input, working visibility, hidden-thinking labels, autocomplete providers, and current editor-component lookup. These are protocol non-capabilities, not missing request methods a client can invoke ([documented list](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L1195-L1206), [current implementation](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L120-L310)).

## Classic interactive steering versus RPC parity

### Verdict

**Ordinary agent steering is the same core implementation, but the complete classic interactive behavior is not exactly reproducible through the current RPC protocol alone.** A host can match idle Enter, streaming Enter, streaming follow-up, queue modes, queue display, dequeue, normal streaming Escape, retry Escape, direct bash cancellation, skill/template expansion, extension-command dispatch, and queued images by choosing the correct existing RPC commands and retaining local editor state. Strict parity still has three hard differences:

1. Classic Escape can cancel manual/automatic compaction and branch summarization through dedicated session methods; RPC exposes neither cancellation command, and its generic `abort` cancels neither operation.
2. Extension input/command code can observe `ctx.mode`/input source as `"tui"`/`"interactive"` in classic mode versus `"rpc"` in RPC mode, so extension-visible behavior can legitimately diverge even when the same text is submitted.
3. Pi's built-in slash commands are TUI-owned, deliberately absent from `get_commands`, and do not execute through RPC `prompt`; a host must reimplement/map them, and some have no RPC equivalent.

The first item is a protocol capability gap. The latter two are intentional mode boundaries. The evidence and exact mapping follow.

### Classic default key and submission state machine

Default bindings are Enter for submit, Alt+Enter for follow-up (Ctrl+Q on Windows), Alt+Up for dequeue (Alt+Q on Windows), Escape for interrupt, and Ctrl+C for editor clear ([coding-agent bindings](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/keybindings.ts#L92-L139), [base editor bindings](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/keybindings.ts#L135-L146)). Enter expands collapsed paste markers, trims the value, clears editor/paste/history/undo state synchronously, and only then invokes `onSubmit` ([editor submit](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/components/editor.ts#L1261-L1286)).

| Classic state/action | Exact current-main behavior | RPC reproduction |
|---|---|---|
| Idle + Enter | After TUI-local built-in/bash checks, the text enters the main input loop, which calls `session.prompt(text)` with default source `interactive`. | Send `prompt` without `streamingBehavior`; same `AgentSession.prompt` preflight and agent loop, but source is `rpc`. Clear/history behavior remains client-local. |
| Streaming + Enter | TUI calls `session.prompt(text, {streamingBehavior:"steer"})`; the editor is cleared first and pending UI refreshes. | Send RPC `prompt` with `streamingBehavior:"steer"`. Do **not** substitute direct RPC `steer` when exact extension-command/input-hook behavior matters. |
| Streaming + Alt+Enter | TUI calls `session.prompt(text, {streamingBehavior:"followUp"})`; the editor is cleared first. | Send RPC `prompt` with `streamingBehavior:"followUp"`. Do **not** substitute direct `follow_up` for exact hook/command semantics. |
| Idle + Alt+Enter | Acts like ordinary Enter by clearing the editor and invoking its submit handler. | Same mapping as idle Enter. |
| Compaction + Enter/Alt+Enter | Extension commands execute immediately; every other message is stored in a **TUI-local** compaction queue with mode `steer`/`followUp`, history is updated, editor clears, and status says it was queued. | The host must apply the same broad `isCompacting` policy, maintain a local queue, and flush after compaction. `AgentSession.prompt` explicitly rejects manual compaction, but the TUI's policy also covers automatic compaction and branch summarization; there is no server-side equivalent of that complete policy. |
| Streaming + Escape | Clears both queues, restores text to the editor, then calls `agent.abort()`. If queues are empty it still aborts. | On post-`0.84.3` main: `clear_queue`, prepend returned steering then follow-up text to current editor text with blank-line separators, then `abort`. Pinned `0.84.1` cannot atomically retrieve and clear server queues. |
| Alt+Up dequeue | Same queue clearing/restoration as Escape but does not abort; status reports restored count. | `clear_queue` plus local editor/status behavior; available only on current unreleased main. |
| Auto-retry delay + Escape | Temporarily replaces normal Escape with `session.abortRetry()`. | `abort_retry` is equivalent. |
| Direct bash running + Escape | `session.abortBash()`. | `abort_bash` is equivalent. |
| Compaction + Escape | Temporarily replaces normal Escape with `session.abortCompaction()`. | **Not reproducible:** no RPC command calls `abortCompaction`; generic `abort` only aborts retry and the active agent run. |
| Ctrl+C | First press clears only the editor; a second within 500 ms shuts Pi down. It is not the normal agent-abort gesture. | Entirely host-local; should not be mapped to RPC `abort` if matching classic behavior. |

The TUI submit branches are implemented together in [`interactive-mode.ts` lines 2974–3166](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2974-L3166); follow-up handling is in [lines 4108–4137](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4108-L4137). The idle loop ultimately calls `session.prompt(userInput)` ([lines 1182–1191](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1182-L1191)). RPC's `prompt` dispatch passes the same options into the same session method, changing only `source` to `"rpc"` ([RPC dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L416)).

### Why streaming TUI submissions map to RPC `prompt`, not `steer`/`follow_up`

`AgentSession.prompt()` performs this ordered preflight:

1. Recognize and execute a registered extension command immediately, even while streaming.
2. Reject ordinary prompts during manual compaction.
3. Emit the extension `input` event before expansion, allowing handled/transform results.
4. Expand `/skill:name` and prompt-template commands.
5. If streaming, enqueue using the requested steer/follow-up behavior; otherwise validate model/auth and start the prompt.

That ordering is shared by classic TUI and RPC `prompt` ([`AgentSession.prompt()`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1130-L1248)). In contrast, direct `session.steer()` and `session.followUp()` expand skills/templates, reject extension commands, and bypass the extension `input` event ([direct queue methods](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1359-L1398)). RPC exposes both layers. Therefore:

- Use RPC `prompt + streamingBehavior` to reproduce Enter/Alt+Enter.
- Use RPC `steer`/`follow_up` only when the caller intentionally wants the lower-level queue API and does not need classic input-hook or immediate extension-command behavior.

The remaining extension-visible difference is deliberate: RPC supplies input source `"rpc"`, while classic calls default to `"interactive"`; bound command/UI contexts likewise use RPC mode rather than TUI mode ([RPC prompt source](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L398-L408), [input event source selection](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1162-L1179), [classic extension binding](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1906-L1916), [RPC extension binding](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L317-L351)).

### Queue timing, modes, display, and restoration

Both queue modes default to `one-at-a-time`, are loaded from/persisted to settings, and can be changed through RPC `set_steering_mode`/`set_follow_up_mode` because those commands call the same session setters as the settings UI ([settings defaults](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/settings-manager.ts#L745-L763), [session setters](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1846-L1871), [RPC dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L517-L529)).

The low-level timing is exact and shared:

- Steering is polled **after** the current assistant response and all of its tool calls/results finish; current tool calls are not skipped. Returned steers are inserted before the next provider request.
- Follow-ups are polled only when there are no more tool calls and no steering messages, then start another turn.
- `all` drains the entire selected queue at one boundary; `one-at-a-time` drains one item and waits for the resulting assistant turn before the next item.

This is explicit in the agent-loop contract and implementation ([queue callback contract](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts#L233-L257), [loop boundaries](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L155-L274), [queue drain modes](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent.ts#L125-L159)).

The session emits full text-only `queue_update` arrays on every enqueue, clear, and delivery. When a queued user `message_start` arrives, it removes the first matching text from steering first, otherwise follow-up, and emits `queue_update` **before** forwarding the message event ([queue emission/removal](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L569-L582), [delivery removal ordering](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L622-L650)). Classic TUI consumes that same event and renders one-line `Steering:`/`Follow-up:` rows plus a dequeue hint ([event consumption](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3208-L3211), [queue UI](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4350-L4367)). RPC receives the same event, so that display is reproducible without polling.

Classic restoration clears session queues plus its extra local compaction queue, orders all steering text before all follow-up text, joins messages with two newlines, then prepends that block to any current editor text. It restores **text only**; queued image objects are discarded because `clearQueue()` and RPC `clear_queue` return only strings ([classic clear/restore](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4314-L4388), [session clear](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1562-L1574), [RPC clear](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L428-L435)).

### Compaction is the hard parity gap

Classic checks the broad `session.isCompacting` state, which includes automatic compaction, manual compaction, and branch summarization, before calling `AgentSession.prompt()`; the session method itself explicitly rejects only manual compaction ([state getter](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L967-L973), [prompt guard](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1144-L1160)). The classic mode therefore owns a second queue outside `AgentSession`. It stores raw text/mode while compacting and, on `compaction_end`, executes leading extension commands, starts the first ordinary prompt, queues the remainder at their original steer/follow-up modes, and restores the local queue if dispatch fails ([local queue and flush algorithm](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4390-L4484)). RPC provides enough primitives for a host to reproduce the ordinary compaction client-side queue/flush algorithm, but the host must impose the classic broad policy itself.

RPC does **not** provide the matching cancellation actions. On `compaction_start`, classic replaces Escape with `session.abortCompaction()` ([classic compaction Escape](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3396-L3417)). `abortCompaction()` cancels both manual and automatic compaction controllers ([session method](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L2069-L2075)). Tree branch summarization has a separate Escape path through `abortBranchSummary()` ([tree Escape handling](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5247-L5277), [session method](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L2077-L2082)). RPC generic `abort` calls only `session.abort()`, whose implementation aborts retry and the agent run, neither compaction nor branch summarization ([RPC abort](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L428-L430), [`session.abort()`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1595-L1603)). No current RPC command union member exposes either cancellation ([command union](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L18-L74)). Exact classic Escape parity therefore requires upstream RPC additions.

### Images, slash commands, extension commands, and bash special cases

- RPC `prompt`, `steer`, and `follow_up` all accept `ImageContent[]`; the shared session queue stores text for UI plus a user message whose content contains the images. Delivery semantics are otherwise identical ([RPC command types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L18-L27), [session queue assembly](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1400-L1431)). Classic default TUI only supplies actual image blocks for CLI-startup `@file` processing; clipboard-image paste writes a temporary file and inserts its path as editor text ([startup image prompt](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1125-L1169), [file processing](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/cli/file-processor.ts#L24-L87), [clipboard behavior](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2923-L2966)).
- Classic built-in slash commands are intercepted in the TUI submit handler before streaming/compaction queue selection. `get_commands` intentionally omits them, and sending one through RPC `prompt` does not invoke its TUI action. The host must map first-class RPC equivalents (`new_session`, `compact`, model/thinking/session calls, etc.) and own the rest of the UI flows ([TUI built-in dispatch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2979-L3113), [RPC built-in warning](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md#L840-L853)).
- Registered extension commands are the opposite: `prompt` executes them immediately even during streaming and before the compaction rejection/input hook. They manage any LLM activity themselves. Direct `steer`/`follow_up` reject them ([shared prompt preflight](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1130-L1160), [direct-queue rejection](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1434-L1446)).
- Skill commands and prompt templates pass through the extension input hook unexpanded, then expand before either idle send or queue insertion. Queue UI consequently receives expanded session-queue text. The TUI-only compaction queue holds raw text until it flushes ([expansion order](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts#L1162-L1202), [compaction queue](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4390-L4396)).
- `!command` and `!!command` are TUI-local syntax handled before compaction/streaming queue selection; `!!` sets exclude-from-context. RPC can reproduce this with `bash.command` and `bash.excludeFromContext`. While streaming, Alt+Enter does not pass through the normal submit handler, so a `!` string is queued as a follow-up rather than executed; idle Alt+Enter delegates to normal submit and does execute it ([TUI bash ordering](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3115-L3147), [follow-up branch](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4124-L4137), [RPC bash type](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts#L52-L55)).

## Version-aware planning contract

At the protocol level, a client planned for future Pi main should:

1. Keep strict LF-only JSONL framing and correlate command responses by optional `id`.
2. Feature-detect `message_update.usage` so the same parser works on pinned `0.84.1` and `0.84.2+`.
3. Feature-detect `toolcall_start.id`/`toolName`; use them immediately on `0.84.3+`, while retaining a fallback that learns identity from `toolcall_end.toolCall` on older workers.
4. Gate `clear_queue` by worker capability/version until the future release containing the current Unreleased change is pinned.
5. Preserve unknown top-level events, message roles, model fields, content-block fields, and session-entry variants; current source is already broader than current docs.
6. Accept missing and null for nullable-looking state/event fields, because upstream documentation and actual JSON serialization do not consistently agree.
7. Consume `get_commands[].sourceInfo` as the current schema while optionally accepting legacy/stale flat provenance fields.
8. Resolve the public `@earendil-works/pi-coding-agent/rpc-entry` export or public CLI rather than a physical `dist/...` file path, because `0.84.3` moved entrypoints into `dist/bundle/`.
9. Distinguish `agent_end` from `agent_settled`: the former is a low-level run boundary and the latter is the safe “Pi will not continue automatically” boundary.
10. Treat `message_end.message` and `toolcall_end.toolCall` as authoritative final objects; streaming state is reconstructed from indexed deltas and accumulated tool execution updates.

These are compatibility requirements derived from upstream's published protocol, source types, runtime implementation, changelog, and package metadata. They intentionally make no claim about which parts SumoCode currently implements.
