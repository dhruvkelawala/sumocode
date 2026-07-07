import { describe, expect, it } from "vitest";
import { RpcHostStateStore } from "./state.js";

describe("RpcHostStateStore", () => {
	it("hydrates minimal chrome state from get_state", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		}, "codex/rpc-host-shell-002-exec");

		expect(state).toMatchObject({
			sessionId: "session-1",
			sessionName: "Migration",
			modelLabel: "openai/gpt-5.5",
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			messageCount: 2,
			pendingMessageCount: 1,
			hasMessages: true,
			gitBranch: "codex/rpc-host-shell-002-exec",
		});
	});

	it("surfaces sessionFile from a get_state payload", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionFile: "/Users/sumo-deus/.pi/agent/sessions/--test--/2026-07-02T20-24-17-673Z_019f2480.jsonl",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		});

		expect(state.sessionFile).toBe(
			"/Users/sumo-deus/.pi/agent/sessions/--test--/2026-07-02T20-24-17-673Z_019f2480.jsonl",
		);
	});

	it("keeps sessionFile undefined when the payload omits it", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState({
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		});

		expect(state.sessionFile).toBeUndefined();
	});

	it("tracks working and compaction lifecycle events", () => {
		const store = new RpcHostStateStore();

		expect(store.handleAgentEvent({ type: "agent_start" })).toMatchObject({ isStreaming: true });
		expect(store.handleAgentEvent({ type: "compaction_start", reason: "manual" })).toMatchObject({ isCompacting: true });
		expect(store.handleAgentEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: undefined })).toMatchObject({ isCompacting: false });
		expect(store.handleAgentEvent({ type: "agent_end", messages: [{ role: "user", content: "done" }], willRetry: false })).toMatchObject({
			isStreaming: false,
			messageCount: 1,
			hasMessages: true,
		});
	});

	it("tracks session/thinking updates and task partial counts", () => {
		const store = new RpcHostStateStore();

		store.handleAgentEvent({ type: "session_info_changed", name: "Renamed" });
		store.handleAgentEvent({ type: "thinking_level_changed", level: "minimal" });
		const state = store.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "task-1",
			toolName: "task",
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});

		expect(state).toMatchObject({
			sessionName: "Renamed",
			thinkingLevel: "minimal",
			taskPartialCount: 1,
			lastEventType: "tool_execution_update",
		});
	});

	it("applyModelChange patches modelLabel (and thinkingLevel, if given) directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		});

		const afterModelOnly = store.applyModelChange({ provider: "anthropic", id: "claude-opus-4-8" });
		expect(afterModelOnly).toMatchObject({
			modelLabel: "anthropic/claude-opus-4-8",
			thinkingLevel: "medium",
			sessionId: "session-1",
		});

		const afterBoth = store.applyModelChange({ provider: "google", id: "gemini-3" }, "high");
		expect(afterBoth).toMatchObject({ modelLabel: "google/gemini-3", thinkingLevel: "high" });
	});

	it("applyModelChange leaves modelLabel untouched when given an unresolvable model", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		});

		expect(store.applyModelChange(undefined)).toMatchObject({ modelLabel: "openai/gpt-5.5" });
	});

	it("applySessionName patches sessionName directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		});

		expect(store.applySessionName("Plan 041")).toMatchObject({
			sessionId: "session-1",
			sessionName: "Plan 041",
			modelLabel: "openai/gpt-5.5",
			thinkingLevel: "medium",
		});
	});

	it("applyThinkingLevel patches thinkingLevel directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState({
			model: { provider: "openai", id: "gpt-5.5" } as never,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		});

		expect(store.applyThinkingLevel("xhigh")).toMatchObject({ thinkingLevel: "xhigh", sessionId: "session-1" });
	});
});
