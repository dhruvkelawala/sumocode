# Agent Observability, Evals, and Model-Comparison Analytics — Primary-Source Survey

**Date:** 2026-09-10
**Scope:** How coding agents and the wider LLM-agent ecosystem do (A) session tracing/observability, (B) per-product telemetry surfaces, (C) session sharing/replay, (D) evals and agent benchmarks, (E) what is worth adopting vs. vendor lock-in.
**Method:** All sources were fetched directly from official docs, specs, or source repos during research. Every non-obvious claim carries a URL. Items that could not be verified against a primary source are marked `[unverified]`. Live docs change; re-check URLs before depending on a detail.
**Not checked:** Cursor/Windsurf/Copilot telemetry internals, hosted vendor internals (LangSmith/Phoenix/Braintrust servers), OTel SDK language-by-language compliance, paid-plan behavior for any product.

---

## A. OpenTelemetry GenAI semantic conventions

### A.1 Where the spec lives now, and its stability

- The GenAI conventions lived in `open-telemetry/semantic-conventions` but **moved** to a dedicated repo, [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai), created 2026-05-05. The old pages now just say "moved" ([old repo marker](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/README.md)).
- Every GenAI signal is marked **Development** (blue "development" badge), not Stable: model spans, agent spans, metrics, and events all carry `**Status**: [Development]` ([gen-ai README](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md)).
- OTel's own document-status page defines Development as: "SHOULD NOT be used in production… MAY be removed without prior notice" ([document-status](https://opentelemetry.io/docs/specs/otel/document-status/)). Treat `gen_ai.*` as a naming convention to follow, not a stable contract.
- There is **no span named `gen_ai.chat`** in the current spec. The span type is `gen_ai.inference.client`; `gen_ai.operation.name` carries the value (`chat`, `generate_content`, `text_completion`, …) and the span name is `{gen_ai.operation.name} {gen_ai.request.model}` ([gen-ai-spans, Inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)).

### A.2 Spans and operation names

Model/client spans ([gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)):

| Span type | Kind | Span name convention | Operation name |
|---|---|---|---|
| `gen_ai.inference.client` | CLIENT (MAY be INTERNAL) | `{gen_ai.operation.name} {gen_ai.request.model}` | `chat`, `generate_content`, `text_completion` |
| `gen_ai.embeddings.client` | CLIENT | — | `embeddings` |
| `gen_ai.retrieval.client` | CLIENT | — | `retrieval` |
| `gen_ai.fetch_response.client` | — | — | `fetch_response` |
| `gen_ai.memory.client` | — | — | `create_memory`, `search_memory`, `update_memory`, `delete_memory`, … |
| `gen_ai.execute_tool.internal` | INTERNAL | `execute_tool {gen_ai.tool.name}` | `execute_tool` |

Agent spans ([gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)):

| Span type | Kind | Span name | Notes |
|---|---|---|---|
| `gen_ai.create_agent.client` | CLIENT | — | creates a hosted agent (e.g. Assistants API, Bedrock Agents) |
| `gen_ai.invoke_agent.client` | CLIENT | `invoke_agent {gen_ai.agent.name}` (fallback `invoke_agent`) | remote agent invocation |
| `gen_ai.invoke_agent.internal` | INTERNAL | — | in-process agent invocation |
| `gen_ai.invoke_workflow.internal` | INTERNAL | — | workflow orchestration |
| `gen_ai.plan.internal` | INTERNAL | — | agent planning/decomposition phase |

The full set of well-known `gen_ai.operation.name` values: `chat`, `create_agent`, `create_memory`, `create_memory_store`, `delete_memory`, `delete_memory_store`, `embeddings`, `execute_tool`, `fetch_response`, `generate_content`, `invoke_agent`, `invoke_workflow`, `plan`, `retrieval`, `search_memory`, `text_completion`, `update_memory` ([well-known values table](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)).

### A.3 Attribute names: tokens, cost, model, tools, agents, conversation

Registry: [docs/registry/attributes/gen-ai.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md).

**Tokens** (all Development; cached tokens are included in input totals, reasoning tokens in output):

- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`
- `gen_ai.usage.reasoning.output_tokens`
- Modality splits: `gen_ai.usage.text.input_tokens`, `gen_ai.usage.text.output_tokens`, `gen_ai.usage.text.cache_read.input_tokens`, `gen_ai.usage.image.*`, `gen_ai.usage.audio.*`
- `gen_ai.token.type` (metric dimension; well-known values `input`/`output`)

**Model / request / response:**

- `gen_ai.provider.name` (Required on spans; discriminated provider flavor, e.g. `openai`, `aws.bedrock`)
- `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`
- `gen_ai.response.finish_reasons` (string array)
- Request params: `gen_ai.request.temperature`, `top_p`, `top_k`, `max_tokens`, `frequency_penalty`, `presence_penalty`, `stop_sequences`, `seed`, `choice.count`, `stream`, `reasoning.level`
- `gen_ai.output.type` (`text`/`json`/`image`)

**Tools:**

- `gen_ai.tool.name` (Required on the execute-tool span), `gen_ai.tool.type` (`function`/`extension`/`datastore`), `gen_ai.tool.description`
- `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments` (**Opt-In**), `gen_ai.tool.call.result` (**Opt-In**)
- `gen_ai.tool.definitions` (**Opt-In**, full tool schemas)

**Agents / conversation / workflow:**

- `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, `gen_ai.agent.description`
- `gen_ai.conversation.id` (explicitly tied to a real session/thread id; the spec says **do not** substitute a fresh UUID or trace id), `gen_ai.conversation.compacted` (boolean)
- `gen_ai.workflow.name`
- Retrieval/memory: `gen_ai.retrieval.query.text`, `gen_ai.retrieval.documents`, `gen_ai.retrieval.top_k`, `gen_ai.memory.*`

**Cost: there is no standard cost attribute.** The registry contains no `gen_ai.cost`/`gen_ai.usage.cost` key as of this revision (verified by enumerating `gen_ai.*` in the [registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md)). Cost is vendor-reported: Claude Code emits `cost_usd`/`cost_usd_micros` ([Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)); Codex emits the `codex.turn.cost_microusd` metric ([turn_cost_otel.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/turn_cost_otel.rs)).

**Tool-call outcomes.** There is no `tool.success` boolean. Outcomes are expressed through span status / `error.type` ("SHOULD match the error code returned by the Generative AI provider or client library") and through the aggregate metrics below. `gen_ai.invoke_agent.tool_calls` explicitly includes failed calls ([metric definition](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)).

### A.4 Metrics

Client metrics ([gen-ai-metrics.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)):

- `gen_ai.client.token.usage` — Histogram, unit `{token}`, explicit bucket boundaries `[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]`, required attribute `gen_ai.token.type` (`input`/`output`).
- `gen_ai.client.operation.duration`, `gen_ai.client.operation.time_to_first_chunk`, `gen_ai.client.operation.time_per_output_chunk`.
- Server-side: `gen_ai.server.request.duration`, `gen_ai.server.time_to_first_token`, `gen_ai.server.time_per_output_token`.

Agent/tool/workflow metrics:

- `gen_ai.invoke_agent.duration`, `gen_ai.invoke_agent.inference_calls`, `gen_ai.invoke_agent.tool_calls`
- `gen_ai.execute_tool.duration`
- `gen_ai.invoke_workflow.duration`

`gen_ai.invoke_agent.tool_calls` is scoped to one agent invocation, counts client-side tool calls "including failed ones", excludes server-side provider tools, and explicitly avoids double counting sub-agent calls ([notes](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)).

### A.5 Events

Two events ([gen-ai-events.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md)):

- `gen_ai.client.inference.operation.details` — **Opt-In**; "could be used to store input and output details independently from traces." Carries the full request/response payload: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, plus request params and usage.
- `gen_ai.evaluation.result` — Recommended; **this is the spec-level hook for eval scores**. Attributes: `gen_ai.evaluation.name` (Required), `gen_ai.evaluation.score.value` (double), `gen_ai.evaluation.score.label` (low-cardinality label such as `pass`/`fail`), `gen_ai.evaluation.explanation`, `gen_ai.response.id`. It should be parented to the evaluated span or carry `gen_ai.response.id`.

### A.6 Content-capture policy

From [§ Capturing instructions, inputs, and outputs](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md):

- "OpenTelemetry instrumentations **SHOULD NOT capture them by default**, but SHOULD provide an option for users to opt in."
- Three approved patterns: (1) default — don't record; (2) record `gen_ai.system_instructions` / `gen_ai.input.messages` / `gen_ai.output.messages` on spans — "best suited" for pre-production; (3) store content externally and record references, with an upload hook.
- Input/output attribute shapes are formally defined and versioned as JSON Schemas: [`gen-ai-input-messages.json`](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-input-messages.json) / [`gen-ai-output-messages.json`](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-output-messages.json). Messages are `{role, parts:[{type: text|tool_call|tool_call_response, ...}]}`.
- Structured attributes "may not yet be supported on spans" in a given language; the fallback is JSON-string on spans, structured on events (references OTEP-4485).
- Instrumentation MAY offer truncation of individual content properties "while preserving JSON structure".
- Streaming chunk capture is a TODO in the spec.

### A.7 Provider-specific pages

The repo carries provider docs for [OpenAI](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/openai.md), [Anthropic](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md), [AWS Bedrock](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/aws-bedrock.md), [Azure AI Inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/azure-ai-inference.md), and [MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md). The OpenAI page adds `openai.*` attributes (`openai.api.type`, `openai.request.service_tier`, `openai.response.service_tier`, `openai.response.system_fingerprint`).

---

## B. Coding-agent products, traced from primary sources

### B.1 Claude Code

**OpenTelemetry export** ([Monitoring](https://code.claude.com/docs/en/monitoring-usage)):

- Metrics (time series, standard metrics protocol):
  `claude_code.session.count`, `claude_code.lines_of_code.count`, `claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.cost.usage` (USD), `claude_code.token.usage` (tokens), `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`.
  `claude_code.token.usage` breaks down by `type` (input/output), user, team, model, `skill.name`, `plugin.name`, `agent.name`.
- Logs/events (logs protocol), each with `event.name`, `event.timestamp` ISO-8601, and a monotonic `event.sequence`:
  `claude_code.user_prompt`, `assistant_response`, `tool_result`, `api_request`, `api_error`, `api_refusal`, `api_request_body`, `api_response_body`, `tool_decision`, `permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`, `plugin_installed`, `plugin_loaded`, `skill_activated`, `at_mention`, `api_retries_exhausted`, `hook_registered`, `hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`, `compaction`, `subagent_completed`, `feedback_survey`, `retention_sweep`.
- Event payload examples: `api_request` carries `model`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `client_request_id`, `speed`, `query_source`; `tool_result` carries `tool_name`, `tool_use_id`, `success` ("true"/"false"), `duration_ms`, `error_type`, `decision_type`, `decision_source`, `tool_input_size_bytes`, `tool_result_size_bytes`, plus opt-in `tool_parameters`/`tool_input`; `tool_decision` covers accepts/rejects including `user_abort`/`user_reject` sources.
- Content redaction defaults: prompt text is `<REDACTED>` unless `OTEL_LOG_USER_PROMPTS=1`; assistant text is `<REDACTED>` unless `OTEL_LOG_ASSISTANT_RESPONSES=1`; tool details/params require `OTEL_LOG_TOOL_DETAILS=1`; tool input/output bodies on spans require `OTEL_LOG_TOOL_CONTENT=1`; content is truncated at a 60 KB default limit. `message.uuid` links events to persisted transcript entries (v2.1.214+).
- **Traces (beta)** — span tree documented explicitly:
  ```
  claude_code.interaction
  ├── claude_code.llm_request
  ├── claude_code.hook                    (detailed beta tracing)
  └── claude_code.tool
      ├── claude_code.tool.blocked_on_user
      ├── claude_code.tool.execution
      └── (Agent tool) subagent claude_code.llm_request / claude_code.tool spans
  ```
  Spans carry OTel GenAI attributes alongside Claude-specific ones: `gen_ai.system` = `anthropic`, `gen_ai.request.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.tool.call.id` (= `tool_use_id`). Each retry emits `gen_ai.request.attempt` span events. When talking to the Anthropic API directly, `traceparent` is propagated and the API's `traceresponse` header is recorded as a span link.
- Configuration is via `CLAUDE_CODE_ENABLE_TELEMETRY`/OTLP env vars and settings; managed settings can lock the OTLP destination (not detailed here).

**Hooks system** ([Hooks](https://code.claude.com/docs/en/hooks)):

- Lifecycle events: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`.
- Hooks receive JSON on stdin (e.g. `tool_name`, `tool_input`, `tool_use_id`, `agent_id`, `agent_type`); the docs explicitly say `tool_use_id` in hook payloads matches the OTel `tool_result`/`tool_decision` events and the `tool_use_id` span attribute, so hooks and OTel records are joinable.

**Transcripts / export** ([Sessions](https://code.claude.com/docs/en/sessions)):

- Transcripts are JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`; one JSON object per message/tool use/metadata entry.
- The docs warn the entry format is **internal and changes between versions**; scripts parsing it directly can break. `/export` renders a readable plain-text transcript (clipboard or file); `claude --resume <transcript-path>` resumes from a `.jsonl`.
- The Agent SDK exposes a `SessionStore` adapter (`append`/`load` + optional methods) to mirror JSONL transcripts to S3/Redis/Postgres; reference adapters exist in the SDK repo ([Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)).

### B.2 OpenAI Codex CLI

**OTel crate** ([codex-otel README](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md)):

- `codex_otel::OtelProvider` wires log/trace/metric exporters; `SessionTelemetry` emits session-scoped tracing events with conversation/model/account metadata; configured `otel.span_attributes` and W3C `tracestate` members are applied to exported spans; trace context is propagated.
- Config keys ([Codex config reference](https://developers.openai.com/codex/config-reference.md)): `otel.environment` (default `dev`), `otel.exporter` (`none | otlp-http | otlp-grpc`), `otel.trace_exporter`, `otel.metrics_exporter` (`none | statsig | otlp-http | otlp-grpc`; **default is `statsig`**), `otel.log_user_prompt` (opt-in for raw prompts), `otel.exporter.<id>.endpoint`/`.protocol`.
- Metrics names ([metrics/names.rs](https://github.com/openai/codex/blob/main/codex-rs/otel/src/metrics/names.rs)) include: `codex.turn.cost_microusd`, `codex.turn.token_usage`, `codex.turn.e2e_duration_ms`, `codex.turn.ttft.duration_ms`, `codex.turn.ttfm.duration_ms`, `codex.api_request` (+`.duration_ms`), `codex.tool.call` (+`.duration_ms`), `codex.tool.unified_exec`, `codex.sse_event`, `codex.websocket.request/event`, `codex.goal.*` (created/completed/blocked/resumed/duration_s/token_count), `codex.guardian.review*`, `codex.hooks.run*`, `codex.plugins.*`, `codex.startup.*`, `codex.responses_api_engine_*`, `codex.thread.skills.*`.
- Event names emitted through `SessionTelemetry` ([session_telemetry.rs](https://github.com/openai/codex/blob/main/codex-rs/otel/src/events/session_telemetry.rs)): `codex.conversation_starts`, `codex.user_prompt`, `codex.api_request`, `codex.tool_decision`, `codex.turn_cost`, `codex.turn_ttft`, `codex.sandbox_outcome`, `codex.auth_recovery`, `codex.plugin_install_elicitation_sent`, `codex.plugin_install_suggestion`, `codex.sse_event`, `codex.websocket_connect`, `codex.websocket_request`, plus span attrs `codex.usage.reasoning_output_tokens` and `codex.usage.total_tokens`.

**Sessions / rollouts:**

- Sessions are recorded by the `codex-rs/rollout` crate (`RolloutRecorder`, `SESSIONS_SUBDIR`, `SessionMeta`; see [rollout re-exports](https://github.com/openai/codex/blob/main/codex-rs/core/src/rollout.rs)); the exact on-disk path layout is not documented in a public doc page `[unverified]`.
- `codex exec --json` produces a **JSON Lines event stream** documented in the CLI docs: event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error` ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)).
- The **rollout-trace** crate defines an opt-in diagnostic trace format ([rollout-trace README](https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/README.md)): bundle = `manifest.json` (trace id, rollout id, root thread), `trace.jsonl` (append-only raw events ordered by writer `seq`), `payloads/*.json` (raw requests/responses/tool IO/terminal output), and reduced `state.json`. Design is "observe first, interpret later": hot-path code writes raw events; an offline reducer builds `ConversationItem` (model-visible), `ToolCall`, `CodeCell`, `TerminalOperation`, `InferenceCall`, `Compaction`, `InteractionEdge`, and `RawPayloadRef` objects. Enabled only when `CODEX_ROLLOUT_TRACE_ROOT` is set; README states "Codex does not upload or report these traces".
- The app-server protocol publishes JSON Schema + TypeScript types for session events; `ServerNotification.json` enumerates methods like `turn/started`, `turn/completed`, `thread/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress` ([schema dir](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json), [ServerNotification.json](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/ServerNotification.json)).

### B.3 Gemini CLI

Telemetry doc: [docs/cli/telemetry.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md).

- Config via `settings.json` or env: `GEMINI_TELEMETRY_ENABLED`, `GEMINI_TELEMETRY_TARGET` (`gcp`/`local`), `GEMINI_TELEMETRY_OTLP_ENDPOINT`, `GEMINI_TELEMETRY_OTLP_PROTOCOL`, `GEMINI_TELEMETRY_OUTFILE`, `GEMINI_TELEMETRY_LOG_PROMPTS`, `GEMINI_TELEMETRY_TRACES_ENABLED`.
- **Prompt logging defaults to `true`** (`logPrompts` default `true`) — a different privacy default from the OTel GenAI spec and from Claude Code's redaction-by-default.
- Logs (event names): `gemini_cli.api_request`, `gemini_cli.api_response`, `gemini_cli.api_error`, `gemini_cli.tool_call`, `gemini_cli.file_operation`, `gemini_cli.slash_command`, `gemini_cli.model_routing`, `gemini_cli.chat_compression`, `gemini_cli.chat.content_retry`, `gemini_cli.extension_enable/disable/install/uninstall`, `gemini_cli.ide_connection`, `gemini_cli.agent.start/finish`, `gemini_cli.hook_call`, `gemini_cli.rewind`, `gemini_cli.edit_strategy`, `gemini_cli.edit_correction`, `gemini_cli.conseca.verdict`, etc.
- Metrics: `gemini_cli.token.usage`, `gemini_cli.api.request.count`, `gemini_cli.api.request.latency`, `gemini_cli.tool.call.count`, `gemini_cli.tool.call.latency`, `gemini_cli.session.count`, `gemini_cli.lines.changed`, `gemini_cli.file.operation.count`, `gemini_cli.agent.run.count`, `gemini_cli.agent.turns`, and more.
- The doc also emits GenAI semconv metrics/traces: `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, and `gen_ai.client.inference.operation.details`-style fields (`gen_ai.request.model`, `gen_ai.input.messages`, `gen_ai.usage.input_tokens`, …); trace spans tie their operation name to e.g. `tool_call`, `gen_ai.*`.
- Sessions: complete history (prompts, responses, tool executions with inputs/outputs, token usage, reasoning summaries) is stored under `~/.gemini/tmp/<project_hash>/chats/` ([session-management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)). Checkpointing snapshots project state in a shadow git repo at `~/.gemini/history/<project_hash>` plus a JSON conversation/tool-call file under `~/.gemini/tmp/<project_hash>/checkpoints` ([checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md)).

### B.4 OSS coding agents with documented trace formats

- **SWE-agent** writes `<instance_id>.traj`, a JSON file of `(thought, action, observation)` turns. Each step includes `response`, `thought`, `action`, `observation`, `state`, and `query` (the exact model input for that step). A trajectory viewer ("inspector") ships with it ([trajectories doc](https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md)).
- **OpenHands** models execution as an immutable, append-only typed event log: `MessageEvent`, `ActionEvent`, `ObservationEvent`, `AgentErrorEvent`, `SystemPromptEvent`, `CondensationSummaryEvent`, `ConversationStateUpdateEvent`, `PauseEvent`, `UserRejectObservation`, etc., each an immutable Pydantic model with id/timestamp/source ([events architecture](https://docs.openhands.dev/sdk/arch/events.md)). It also has built-in OTel tracing over standard `OTEL_EXPORTER_OTLP_TRACES_*` env vars ([observability guide](https://docs.openhands.dev/sdk/guides/observability.md)).
- **pi** (the agent this repo extends) exports sessions to GitHub Gists containing a `session.html` with base64-encoded session data; the decoded payload is `{header, entries, leafId, systemPrompt?, tools?}` with entry types `message`, `model_change`, `thinking_level_change`, `compaction` and content blocks `text`, `toolCall`, `thinking`, `image` ([local pi-share skill](/Users/dhruvkelawala/.pi/agent/npm/node_modules/mitsupi/skills/pi-share/SKILL.md); viewer at [shittycodingagent.ai/session](https://shittycodingagent.ai/session/)).

---

## C. Session sharing / replay

### C.1 Claude Code

- **Artifacts**: Claude can publish the work as a live page on claude.ai from the session; the page is private by default and gets a Share menu (organization or public link) ([artifacts](https://code.claude.com/docs/en/artifacts)). This shares *output*, not a transcript.
- **Cloud sessions**: at claude.ai/code, sessions can be toggled Private/Team (Enterprise/Team) or shared by link (Max/Pro), with optional repo-access requirement and name hiding ([Claude Code on the web § Share sessions](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **Structured transcript**: JSONL on disk, `/export` for humans, `SessionStore` mirroring for machines. A public "transcript share URL" format is not documented `[unverified]`; historical `/share` behavior was not found in current docs.

### C.2 Codex CLI

- The internal session record is the rollout; `codex exec --json` gives a scriptable JSONL event stream; the app-server protocol gives typed notifications for UIs; the rollout-trace bundle is the explicit, schema'd local diagnostic format (raw `trace.jsonl` + payloads + reduced `state.json`). No public share-link mechanism is documented `[unverified]`.

### C.3 pi (gist-based share URLs)

- Share URLs look like `https://shittycodingagent.ai/session/?<gist_id>` (also `buildwithpi.ai`/`pi.dev` variants); the gist holds `session.html` with base64 session data. The format is documented in the local pi-share skill (session header + JSONL-style entries + branch leaf id), and has a client-side viewer.

### C.4 Protocol-level interchange candidates

- **AG-UI "Agent User Interaction Protocol"** defines a streaming event schema for agent runs: base event props `type`, `timestamp`, `rawEvent`, `metadata`, plus optional `subagentRunId`; lifecycle events `RunStarted`/`RunFinished`/`RunError`/`StepStarted`/`StepFinished`; event families for text messages, tool calls, state snapshots/deltas, activity, subagents. `metadata` is an open map explicitly intended for things like token usage and trace ids ([events](https://docs.ag-ui.com/concepts/events)). This is the closest thing found to a vendor-neutral *live session* event vocabulary.
- **Agent Trace** (v0.1.0, RFC, Jan 2026) is a JSON-Schema spec for AI-code attribution, not transcripts: a trace record has `version/id/timestamp/vcs/tool/files[]`; each file lists conversations with line `ranges`, a `contributor` (`human|ai|mixed|unknown`, `model_id`), and a `conversation.url` back-reference ([spec](https://agent-trace.dev/)). Useful as a link layer between commits and sessions.
- **OTel GenAI message schemas** (`gen-ai-input-messages.json`, `gen-ai-output-messages.json`) are the only schema'd, cross-vendor message/content format found; they are content envelopes, not session containers.
- **No single cross-vendor "session transcript interchange format" exists** as of this survey — evidence is the absence of one in all primary docs reviewed; each product documents its own JSONL/bundle format, and the OTel spec deliberately defines events/attributes rather than a transcript document.

---

## D. Eval frameworks and benchmarks for agents

### D.1 The shared data model

Frameworks converge on the same four-stage flow, with different names:

**dataset item → run/trace → scorer/evaluator/grader → report/comparison**

| Framework | Dataset item | Run | Scorer | Result object | Compare/report |
|---|---|---|---|---|---|
| OpenAI Evals (API) | JSONL row validated against an input schema | `evals.runs.create` run; per-item output | `testing_criteria` graders: `string_check`, `text_similarity`, `score_model`, `label_model` | per-item pass/fail from graders | Runs retrievable per eval; platform being deprecated (below) |
| OpenAI Datasets (replacement) | CSV/uploaded dataset with input + ground-truth columns | grading pass per grader column | Score model / Label model / string-based graders | pass/fail column per grader | dashboard tabs across prompt variants |
| Anthropic guidance | hand-built test cases (1k-scale examples) | run model on each case | code-based, human, LLM-based grading; rubrics | boolean/`correct`-`incorrect` | not framework-specified; statistical guidance only |
| LangSmith | `Dataset` of `Example` (input + optional reference output) | `Experiment` = app run over dataset; `Run` = production trace | `Evaluator` (human, code, LLM-judge, pairwise) | `Feedback` dict: `key`, `score`/`value`, `comment` | experiments over datasets + online eval on traces |
| Braintrust | `Dataset` (inputs, expected outputs, metadata) | `Experiment` — "immutable, comparable record of your eval runs" | `Scorer` (numeric) / `Classifier` (categorical); autoevals, LLM-judge, custom code | scores per test case | experiments over time, CI, online scoring |
| Arize Phoenix | `Dataset` collected from traces/code/CSV | `Experiment` rerunning app versions on same inputs | `Evaluator`s: LLM-based, code-based, human annotations; dataset evaluators | scores + annotations on spans | experiment comparison |
| W&B Weave | `Dataset` of examples | `.evaluate()` run of a `Model`/function | scoring functions (`Scorer`), can be LLM-based | per-example scores in Weave UI | evaluation views |
| Inspect (UK AISI) | `Sample` (`input`, `target`, optional `files`, `setup`, `metadata`) | `Task` = dataset + `Solver` + `Scorer` | `Scorer` returns `Score(value, answer, explanation)` | `.eval` (binary) or `.json` log with per-sample scores | Log File API, dataframes, `inspect view` |
| promptfoo | test cases (`vars`) in YAML | prompt/provider matrix | `assert` list: deterministic, model-assisted (`llm-rubric`), `javascript`/`python`/`ruby`; assert-sets; weights + thresholds | per-assertion pass/fail + weighted score | CLI table + JSON output, CI exit codes |

Sources: [OpenAI Evals guide](https://platform.openai.com/docs/guides/evals), [OpenAI Datasets guide](https://platform.openai.com/docs/guides/evaluation-getting-started), [Anthropic develop-tests](https://docs.claude.com/en/docs/test-and-evaluate/develop-tests), [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts), [Braintrust evaluate](https://www.braintrust.dev/docs/evaluate), [Phoenix docs](https://arize.com/docs/phoenix), [Phoenix datasets/experiments](https://arize.com/docs/phoenix/datasets-and-experiments/overview-datasets), [Weave evaluations](https://weave-docs.wandb.ai/guides/core-types/evaluations), [Inspect datasets](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/datasets.qmd), [Inspect custom scorers](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/custom-scorers.qmd), [Inspect eval logs](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/eval-logs.qmd), [promptfoo assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/).

Notes worth stealing from specific frameworks:

- **Inspect** has the cleanest typed contract: `Sample` → `Task` (dataset/solver/scorer) → `Score(value, answer, explanation)`; logs are `.eval` binary or `.json` with a documented Log File API and dataframe extraction; it also has refusal logging and per-sample preservation controls ([eval-logs](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/eval-logs.qmd)).
- **promptfoo** has the most explicit scoring algebra: `assert-set` with `threshold`, `weight` per assertion, weighted average → metric score, test-level `threshold` for pass/fail ([assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/)).
- **LangSmith** names the score record explicitly: `Feedback { key, score|value, comment }` ([concepts](https://docs.langchain.com/langsmith/evaluation-concepts)).
- **OpenAI's Evals platform is being retired**: docs state existing content is read-only on 2026-10-31 and the platform shuts down 2026-11-30, pointing users to Datasets ([evals guide](https://platform.openai.com/docs/guides/evals)). Do not build on the Evals API.
- **Anthropic's guidance** is a process, not a framework: be task-specific, automate grading, favor volume; grade with code first, humans if needed, LLM-judge last; use detailed rubrics and demand reasoning-before-score ([develop-tests](https://docs.claude.com/en/docs/test-and-evaluate/develop-tests)).

### D.2 Coding-agent benchmarks and what they measure

| Benchmark | Measured artifact | Scoring | Notes |
|---|---|---|---|
| SWE-bench | patch (`instance_id`, `model_patch`) applied in Docker | repository test suite; resolved = "The patch made the required tests pass" per instance `report.json` | splits: Lite 300, Verified 500, dev 225, test 2294 ([evaluation doc](https://github.com/SWE-bench/SWE-bench/blob/main/docs/assets/evaluation.md)); harness writes per-instance `report.json`, `test_output.txt`, `eval.sh` ([guides/evaluation](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/evaluation.md)) |
| SWE-bench Verified | subset of 500 human-validated instances | same harness | [OpenAI–SWE-bench collaboration](https://github.com/SWE-bench/SWE-bench#news); dataset [princeton-nlp/SWE-bench_Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) |
| Terminal-Bench | agent operating in a sandboxed terminal | per-task test script in Docker; oracle solution verifies task validity | ~100 tasks in beta; dataset + harness; leaderboard `terminal-bench-core` v0.1.1; paper [OpenReview a7Qa4CcHak](https://openreview.net/forum?id=a7Qa4CcHak) ([repo](https://github.com/laude-institute/terminal-bench), [docs](https://www.tbench.ai/docs)) |
| Aider polyglot | code edits across 6 languages | per-exercise pass + whether the edit format was correct; reported as "percent completed correctly" / "percent using correct edit format" | 225 hardest of 697 Exercism exercises (C++/Go/Java/JS/Python/Rust) ([writeup](https://aider.chat/2024/12/21/polyglot.html), [leaderboard](https://aider.chat/docs/leaderboards/)) |
| SWE-bench-Live | patch on auto-updated, multi-language, multi-OS tasks | Docker harness like SWE-bench; lite/full/verified splits frozen | automated curation pipeline; since Aug 2026 leaderboard submissions must include **agent rollout trajectories** to prove no leakage; Windows/multi-lang datasets ([site](https://swe-bench-live.github.io/), [paper arXiv:2505.23419](https://arxiv.org/abs/2505.23419)) |
| Gemini CLI behavioral evals (EDK) | tool-call behavior in a real CLI session | vitest assertions on tool calls (`rig.waitForToolCall`) rather than prose; per-model JSON reports | `.eval.ts` files; policies `ALWAYS_PASSES`/`USUALLY_PASSES`/`USUALLY_FAILS`; CI validation + nightly per-model aggregation ([behavioral-evals](https://github.com/google-gemini/gemini-cli/blob/main/docs/behavioral-evals.md)) |

Summary of *what* each measures: SWE-bench(+Verified/-Live) measure patch correctness against repo tests; Terminal-Bench measures end-to-end terminal task completion; Aider polyglot measures code-edit correctness and edit-format compliance across languages; Gemini's EDK measures behavioral trajectories (which tools, in what order, avoiding destructive actions).

### D.3 Trajectory quality and detecting agent struggle from traces

There is active published work on exactly this. Concrete signals used across it include repeated steps/tool calls, unbounded loops, error/correction streaks, and recovery behavior:

- **MAST — "Why Do Multi-Agent LLM Systems Fail?"** (arXiv:2503.13657): 1600+ annotated traces, 14 failure modes in 3 clusters (specification, inter-agent misalignment, task verification). Mode names include **Step repetition**, Conversation reset, Information withholding, Task derailment (verified in the paper HTML). This is the closest thing to a failure taxonomy for trace-level struggle [α](https://arxiv.org/abs/2503.13657).
- **IAL-Scan — "When Agents Do Not Stop: Uncovering Infinite Agentic Loops in LLM Agents"** (arXiv:2607.01641): defines Infinite Agentic Loops (repeated model calls, tools, workflow transitions, handoffs) and statically analyzes real agent projects to detect them; notes cost exhaustion, context growth, repeated side effects.
- **AgentRx** (arXiv:2602.02475): 170 manually annotated failed trajectories; annotates a critical failure step and a grounded-theory taxonomy; automated constraint-synthesis + LLM-judge diagnosis with an auditable violation log.
- **AgenTracer** (arXiv:2509.03312): failure attribution in multi-agent traces via counterfactual replay + programmed fault injection (dataset TracerTraj); reports SOTA reasoning LLMs generally below 10% attribution accuracy.
- **Agent trajectories as programs** (arXiv:2606.16988): fingerprints agent behavior procedurally from SWE-bench trajectories; identifies which agent produced a trajectory at 85.7% accuracy, i.e. trace shape is a stable behavioral signature.
- **Agentic Harness Engineering** (arXiv:2604.25850): explicitly builds observability pillars to evolve coding-agent harnesses — component observability, "experience observability" (distilling millions of trajectory tokens into a drill-down evidence corpus), decision observability (prediction paired with edit, later verified).
- **Trajectory-aware evaluation**: PTA-IRT (arXiv:2609.01603) uses process signals (explored context, attempted edits, solving paths) instead of pass/fail only; **AgentLens** (arXiv:2607.06624) scores whole trajectories with formal checks + LLM-written reviews + side-by-side comparisons to catch regressions; **AgentRewardBench** (arXiv:2504.08942) evaluates automatic judges of web-agent trajectories.

What this implies for a "struggle metric": there is **no canonical published scalar** for struggle; the repeatable primitives are *counts of repeated (tool, args) pairs*, *loop/cycle detection over the event sequence*, *consecutive error streaks*, *revert/re-edit patterns*, and *verification/recovery behavior*. The taxonomy work (MAST) and the loop analysis (IAL-Scan) are the best citable foundations.

---

## E. Synthesis: which conventions to adopt, which are vendor lock-in

### E.1 Standard conventions worth following

1. **OTel `gen_ai.*` naming** for spans/attributes/metrics — with the explicit caveat that the whole namespace is Development (not production-stable). Adopt names: `gen_ai.conversation.id` (real session id), `gen_ai.request.model`/`gen_ai.response.model`, `gen_ai.usage.input_tokens`/`output_tokens` (+ cache/reasoning), `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments/result` behind an opt-in, `error.type` for outcomes. Span types: `gen_ai.inference.client`, `gen_ai.execute_tool.internal`, `gen_ai.invoke_agent.client/internal`, `gen_ai.plan.internal`. Metric shapes: `gen_ai.client.token.usage` (histogram, `{token}`, input/output split), `gen_ai.invoke_agent.tool_calls`.
2. **Content capture default-off, opt-in, with a defined redaction switch.** OTel says SHOULD NOT capture by default; Claude Code mirrors this (redacted unless `OTEL_LOG_USER_PROMPTS` etc.). Gemini CLI is the outlier (prompts on by default). A design that stores content externally and references it from spans is spec-endorsed.
3. **`gen_ai.evaluation.result`** as the event shape for eval scores (`name`, `score.value`, `score.label`, `explanation`, parent/response id). It is the only schema'd cross-vendor eval-result event found.
4. **The generic eval pipeline vocabulary**: dataset item → run → scorer → score record → experiment comparison. Concretely: Inspect's `Sample`/`Task`/`Score(value, answer, explanation)` and LangSmith's `Feedback(key, score|value, comment)` are the cleanest typed contracts to imitate; promptfoo's weighted assertion algebra and threshold semantics are the best pass/fail aggregation model reviewed.
5. **Trajectory-level diagnostics over verdict-only evals.** MAST/IAL-Scan/AgentRx show the failure modes worth detecting; SWE-bench-Live now requires rollout trajectories for submission verification, which makes trajectory capture a benchmark requirement, not a nice-to-have.
6. **Event vocabularies with typed lifecycle**: AG-UI's `RunStarted`/`StepStarted`/`ToolCall*`/`RunFinished|RunError` and Codex's `thread.*`/`turn.*`/`item.*` are good proof that lifecycle + item stream + deltas is a workable session event shape. Pick one and emit OTel-compatible attributes inside it rather than inventing a third vocabulary.
7. **Join keys that already exist in practice**: `tool_use_id` == `gen_ai.tool.call.id` (Claude Code documents the equivalence), `gen_ai.conversation.id` for sessions, `gen_ai.response.id` for model responses, `message.uuid` for transcript entries.

### E.2 Vendor-specific things not to standardize on

- **Metric/event name prefixes**: `claude_code.*`, `codex.*`, `gemini_cli.*` are product namespaces; fine as add-ons, wrong as the core schema. Their *shapes* (counters vs histograms, token breakdowns) are worth copying.
- **Cost**: no standard attribute exists; each vendor invents one (`cost_usd`, `codex.turn.cost_microusd`). If SumoCode computes cost, it must derive it from model + tokens itself and not expect a portable field.
- **Codex defaults**: `otel.metrics_exporter` defaulting to `statsig` is a vendor backend default; self-hosted observability must override it explicitly.
- **OpenAI Evals API**: deprecated with a hard 2026-11-30 shutdown; the grader type names (`string_check`, `text_similarity`, `score_model`, `label_model`) are useful vocabulary but the API is not a foundation.
- **Claude Code specifics**: the span hierarchy (`claude_code.interaction` → `tool.blocked_on_user`/`tool.execution`), the hook event names, and the redaction env-var names are Claude-only. The JSONL transcript format is explicitly documented as internal and version-unstable — do not parse it as an integration surface; use `/export` or the SDK's `SessionStore`.
- **Share/replay surfaces**: Claude artifacts and cloud session links are hosted features; pi share URLs depend on GitHub Gists; none is a portable transcript standard. If SumoCode shares sessions, expect to define its own viewer + storage and only adopt Agent Trace / OTel message schemas for interop.
- **Framework-internal concepts** (Braintrust "experiment", LangSmith "feedback", Phoenix "dataset evaluators", Weave "op") are helpful vocabulary but private data models; adopting their SDK types creates lock-in. Adopt the pipeline and record shapes instead.

### E.3 Open questions / unverified

- Exact on-disk path layout for Codex rollouts is not in the public docs reviewed `[unverified]`; only the crate names and the `trace.jsonl`/`state.json` bundle layout are documented.
- Whether Claude Code exposes a per-transcript shareable URL (beyond artifacts and cloud sessions) is not documented `[unverified]`.
- Braintrust/Phoenix/LangSmith *server-side* schemas for runs/scores are not published; only the client-side concepts were verified.
- OTel GenAI span/name stability: everything is Development and the spec moved repos in 2026, so pin any implementation to a specific spec commit/tag and expect renames.
- No published data found on Cursor/Windsurf/Copilot CLI telemetry `[not checked]`.

---

## Appendix: primary sources consulted

OpenTelemetry: [genai repo](https://github.com/open-telemetry/semantic-conventions-genai) · [gen-ai-spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) · [gen-ai-agent-spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) · [gen-ai-metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md) · [gen-ai-events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md) · [attributes registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md) · [document status](https://opentelemetry.io/docs/specs/otel/document-status/) · [OpenAI provider page](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/openai.md)

Claude Code: [monitoring](https://code.claude.com/docs/en/monitoring-usage) · [hooks](https://code.claude.com/docs/en/hooks) · [sessions](https://code.claude.com/docs/en/sessions) · [artifacts](https://code.claude.com/docs/en/artifacts) · [web sessions](https://code.claude.com/docs/en/claude-code-on-the-web) · [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)

Codex: [otel README](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md) · [metric names](https://github.com/openai/codex/blob/main/codex-rs/otel/src/metrics/names.rs) · [session telemetry](https://github.com/openai/codex/blob/main/codex-rs/otel/src/events/session_telemetry.rs) · [rollout-trace README](https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/README.md) · [config reference](https://developers.openai.com/codex/config-reference.md) · [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md) · [app-server schema](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json)

Gemini CLI: [telemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md) · [session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) · [checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md) · [behavioral evals](https://github.com/google-gemini/gemini-cli/blob/main/docs/behavioral-evals.md)

Other agents/protocols: [SWE-agent trajectories](https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md) · [OpenHands events](https://docs.openhands.dev/sdk/arch/events.md) · [OpenHands observability](https://docs.openhands.dev/sdk/guides/observability.md) · [AG-UI events](https://docs.ag-ui.com/concepts/events) · [Agent Trace](https://agent-trace.dev/) · [pi share viewer](https://shittycodingagent.ai/session/)

Evals/benchmarks: [OpenAI Evals](https://platform.openai.com/docs/guides/evals) · [OpenAI Datasets](https://platform.openai.com/docs/guides/evaluation-getting-started) · [Anthropic evals guidance](https://docs.claude.com/en/docs/test-and-evaluate/develop-tests) · [LangSmith](https://docs.langchain.com/langsmith/evaluation-concepts) · [Braintrust](https://www.braintrust.dev/docs/evaluate) · [Phoenix](https://arize.com/docs/phoenix) · [Weave](https://weave-docs.wandb.ai/guides/core-types/evaluations) · [Inspect](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/docs/datasets.qmd) · [promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/) · [SWE-bench](https://github.com/SWE-bench/SWE-bench) · [SWE-bench evaluation](https://github.com/SWE-bench/SWE-bench/blob/main/docs/assets/evaluation.md) · [Terminal-Bench](https://github.com/laude-institute/terminal-bench) · [Aider polyglot writeup](https://aider.chat/2024/12/21/polyglot.html) · [SWE-bench-Live](https://swe-bench-live.github.io/) · [arXiv:2505.23419](https://arxiv.org/abs/2505.23419)

Trajectory/struggle research: [MAST arXiv:2503.13657](https://arxiv.org/abs/2503.13657) · [IAL-Scan arXiv:2607.01641](https://arxiv.org/abs/2607.01641) · [AgentRx arXiv:2602.02475](https://arxiv.org/abs/2602.02475) · [AgenTracer arXiv:2509.03312](https://arxiv.org/abs/2509.03312) · [Agent trajectories as programs arXiv:2606.16988](https://arxiv.org/abs/2606.16988) · [Agentic Harness Engineering arXiv:2604.25850](https://arxiv.org/abs/2604.25850) · [PTA-IRT arXiv:2609.01603](https://arxiv.org/abs/2609.01603) · [AgentLens arXiv:2607.06624](https://arxiv.org/abs/2607.06624) · [AgentRewardBench arXiv:2504.08942](https://arxiv.org/abs/2504.08942)
