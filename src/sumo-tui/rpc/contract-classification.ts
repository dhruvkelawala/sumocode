import type { AgentSessionEvent, RpcCommand, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

/**
 * Compile-exhaustive disposition matrix for the pinned Pi RPC release
 * (`@earendil-works/pi-coding-agent` 0.85.1, Plan 088).
 *
 * This module is a classification gate, not an executor: nothing here sends a
 * command, mutates state, or answers a request. Each map is checked with
 * `satisfies Record<...>` against the shipped unions, so an additive Pi union
 * member is a typecheck failure until it is classified here. Unknown runtime
 * events stay forward-tolerant at the client boundary (see `client.ts`); only
 * the known members need a disposition.
 *
 * Re-run the classification whenever the Pi pins in `package.json` change.
 */

export type RpcCommandDisposition =
	| { readonly kind: "implemented"; readonly owner: string }
	| { readonly kind: "intentionally-bypassed"; readonly owner: string; readonly reason: string }
	| { readonly kind: "downstream-plan-owned"; readonly owner: string; readonly reason: string }
	| { readonly kind: "unsupported"; readonly owner: string; readonly reason: string };

export type AgentEventDisposition =
	| { readonly kind: "projected"; readonly owner: string; readonly note?: string }
	| { readonly kind: "scheduler-only"; readonly owner: string; readonly note?: string }
	| { readonly kind: "transcript-only"; readonly owner: string; readonly note?: string }
	| { readonly kind: "intentionally-ignored"; readonly owner: string; readonly reason: string }
	| { readonly kind: "downstream-plan-owned"; readonly owner: string; readonly reason: string };

export type ExtensionUiDisposition = { readonly kind: "mapped"; readonly owner: string; readonly response: string };

export const RPC_COMMAND_DISPOSITIONS = {
	abort: { kind: "implemented", owner: "controls.ts RpcHostControls.abort" },
	abort_bash: { kind: "downstream-plan-owned", owner: "Plan 091 (#378)", reason: "direct bash owns the abort path" },
	abort_retry: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "auto-retry lifecycle authority" },
	bash: { kind: "downstream-plan-owned", owner: "Plan 091 (#378)", reason: "Pi-native direct user bash" },
	clear_queue: { kind: "downstream-plan-owned", owner: "Plan 090 (#377)", reason: "native queue ownership and clear/restore UX; 088 only locks the response envelope" },
	clone: { kind: "implemented", owner: "controls.ts RpcHostControls.clone" },
	compact: { kind: "implemented", owner: "controls.ts RpcHostControls.compact" },
	cycle_model: { kind: "implemented", owner: "controls.ts RpcHostControls.cycleModel" },
	cycle_thinking_level: { kind: "implemented", owner: "controls.ts RpcHostControls.cycleThinkingLevel" },
	export_html: { kind: "implemented", owner: "controls.ts RpcHostControls.exportHtml" },
	follow_up: { kind: "downstream-plan-owned", owner: "Plan 090 (#377)", reason: "native follow-up queue delivery" },
	fork: { kind: "implemented", owner: "controls.ts RpcHostControls.fork" },
	get_available_models: { kind: "implemented", owner: "controls.ts RpcHostControls.getAvailableModels" },
	get_available_thinking_levels: { kind: "implemented", owner: "controls.ts RpcHostControls.getAvailableThinkingLevels" },
	get_commands: { kind: "implemented", owner: "controls.ts RpcHostControls.getCommands" },
	get_entries: { kind: "implemented", owner: "controls.ts RpcHostControls.getEntries" },
	get_fork_messages: { kind: "implemented", owner: "controls.ts RpcHostControls.getForkMessages" },
	get_last_assistant_text: { kind: "implemented", owner: "controls.ts RpcHostControls.getLastAssistantText" },
	get_messages: { kind: "implemented", owner: "host.ts readRpcMessages" },
	get_session_stats: { kind: "implemented", owner: "controls.ts RpcHostControls.getSessionStats" },
	get_state: { kind: "implemented", owner: "controls.ts RpcHostControls.refreshState" },
	get_tree: { kind: "intentionally-bypassed", owner: "session-reader.ts", reason: "Plan 086 locked flat get_entries plus streamed local entries; nested tree payloads are never requested" },
	new_session: { kind: "implemented", owner: "controls.ts RpcHostControls.newSession" },
	prompt: { kind: "implemented", owner: "host.ts sendUserMessage / controls.ts executeExtensionCommand" },
	set_auto_compaction: { kind: "implemented", owner: "controls.ts RpcHostControls.setAutoCompaction" },
	set_auto_retry: { kind: "implemented", owner: "controls.ts RpcHostControls.setAutoRetry" },
	set_follow_up_mode: { kind: "downstream-plan-owned", owner: "Plan 090 (#377)", reason: "steer-default delivery toggle" },
	set_model: { kind: "implemented", owner: "controls.ts RpcHostControls.setModel" },
	set_session_name: { kind: "implemented", owner: "controls.ts RpcHostControls.setSessionName" },
	set_steering_mode: { kind: "downstream-plan-owned", owner: "Plan 090 (#377)", reason: "steer-default delivery toggle" },
	set_thinking_level: { kind: "implemented", owner: "controls.ts RpcHostControls.setThinkingLevel" },
	steer: { kind: "downstream-plan-owned", owner: "Plan 090 (#377)", reason: "native steering queue delivery" },
	switch_session: { kind: "implemented", owner: "controls.ts RpcHostControls.switchSession" },
} as const satisfies Record<RpcCommand["type"], RpcCommandDisposition>;

export const AGENT_EVENT_DISPOSITIONS = {
	agent_end: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent", note: "run boundary only; agent_settled is the idle boundary" },
	agent_settled: { kind: "scheduler-only", owner: "prompt-scheduler.ts RpcPromptScheduler.handleAgentEvent", note: "ordinary idle boundary" },
	agent_start: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent", note: "also opens the transcript run and scheduler busy window" },
	auto_retry_end: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "retry lifecycle projection" },
	auto_retry_start: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "retry lifecycle projection" },
	bash_execution_update: { kind: "downstream-plan-owned", owner: "Plan 091 (#378)", reason: "native direct bash streaming" },
	compaction_end: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent", note: "transcript commits the summary; scheduler drains on it" },
	compaction_start: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent", note: "transcript also tracks the reason" },
	entry_appended: { kind: "intentionally-ignored", owner: "session-reader.ts", reason: "authoritative entries are read with get_entries/get_messages; no live consumer" },
	message_end: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController" },
	message_start: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController", note: "prompt-scheduler observes it only for the Plan 087 force-steer lifecycle" },
	message_update: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController" },
	queue_update: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent", note: "prompt-scheduler also consumes it for force-steer ownership" },
	session_info_changed: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent" },
	summarization_retry_attempt_start: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "summarization retry lifecycle projection" },
	summarization_retry_finished: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "summarization retry lifecycle projection" },
	summarization_retry_scheduled: { kind: "downstream-plan-owned", owner: "Plan 089 (#376)", reason: "summarization retry lifecycle projection" },
	thinking_level_changed: { kind: "projected", owner: "state.ts RpcHostStateStore.handleAgentEvent" },
	tool_execution_end: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController" },
	tool_execution_start: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController" },
	tool_execution_update: { kind: "transcript-only", owner: "transcript/controller.ts TranscriptController", note: "state store also counts task partials" },
	turn_end: { kind: "scheduler-only", owner: "prompt-scheduler.ts RpcPromptScheduler.handleAgentEvent", note: "force-steer lifecycle boundary" },
	turn_start: { kind: "intentionally-ignored", owner: "prompt-scheduler.ts", reason: "no consumer; turn_end and agent_settled own the scheduling boundaries" },
} as const satisfies Record<AgentSessionEvent["type"], AgentEventDisposition>;

export const EXTENSION_UI_METHOD_DISPOSITIONS = {
	confirm: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.modals.confirm", response: "awaits confirmed/cancelled" },
	editor: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.modals.editor", response: "awaits text/cancelled" },
	input: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.modals.input", response: "awaits text/cancelled" },
	notify: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.notifications.notify", response: "fire-and-forget toast" },
	select: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.modals.select", response: "awaits value/cancelled; auth titles are decoded" },
	set_editor_text: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.editorText.setText", response: "fire-and-forget editor buffer" },
	setStatus: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.statusPublication.setStatus", response: "fire-and-forget status region" },
	setTitle: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.terminal.setTitle", response: "fire-and-forget terminal title" },
	setWidget: { kind: "mapped", owner: "extension-ui-responder.ts RpcExtensionUiResponder.regionRegistry.mountWidget", response: "fire-and-forget widget region" },
} as const satisfies Record<RpcExtensionUIRequest["method"], ExtensionUiDisposition>;
