import { describe, expect, it } from "vitest";
import { RpcHostStateStore } from "./state.js";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";

// SAFETY: fixtures populate only the RpcSessionState fields each test reads;
// unread fields (roles, content, etc.) are irrelevant to these behaviors.
function asRpcSessionState<T extends object>(value: T): RpcSessionState {
	// SAFETY: fixtures supply every RpcSessionState field the store consumes.
	return value as RpcSessionState;
}

// SAFETY: only the model identity fields are read by the store.
const modelFixture = { provider: "openai", id: "gpt-5.5" } as never;

describe("RpcHostStateStore", () => {
	it("preserves a live git branch through hydration when no branch is supplied", () => {
		const store = new RpcHostStateStore();
		// The detached branch lookup writes the real branch to the store during
		// hydration; a hydration commit that omits the branch must keep it.
		store.setGitBranch("feature/live");
		const hydrated = store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
			costUsd: 0,
		}));


		expect(hydrated.gitBranch).toBe("feature/live");
	});

	it("hydrates minimal chrome state from get_state", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}), "codex/rpc-host-shell-002-exec");

		expect(state).toMatchObject({
			sessionId: "session-1",
			sessionName: "Migration",
			modelLabel: "openai/gpt-5.5",
			hydrated: true,
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			messageCount: 2,
			pendingMessageCount: 1,
			hasMessages: true,
			gitBranch: "codex/rpc-host-shell-002-exec",
		});
	});

	it("preserves seeded startup chrome across a store-backed git branch update", () => {
		const store = new RpcHostStateStore();
		store.seedChrome({ modelLabel: "openai/gpt-5.5", thinkingLevel: "high" });

		// A pre-hydration branch lookup produces its snapshot from the store; the
		// advisory chrome hint must survive instead of blanking the model rail.
		expect(store.setGitBranch("feature/x")).toMatchObject({
			gitBranch: "feature/x",
			modelLabel: "openai/gpt-5.5",
			thinkingLevel: "high",
		});
	});

	it("seeds startup chrome without marking the state hydrated", () => {
		const store = new RpcHostStateStore();

		expect(store.seedChrome({ modelLabel: "openai/gpt-5.5", thinkingLevel: "high" })).toMatchObject({
			modelLabel: "openai/gpt-5.5",
			thinkingLevel: "high",
		});
		expect(store.getSnapshot().hydrated).toBeUndefined();
		expect(store.applyModelChange({ provider: "anthropic", id: "claude-opus-4-8" }).hydrated).toBeUndefined();

		expect(store.hydrateFromRpcState(asRpcSessionState({
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		})).hydrated).toBe(true);
	});

	it("surfaces sessionFile from a get_state payload", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}));

		expect(state.sessionFile).toBe(
			"/Users/sumo-deus/.pi/agent/sessions/--test--/2026-07-02T20-24-17-673Z_019f2480.jsonl",
		);
	});

	it("keeps sessionFile undefined when the payload omits it", () => {
		const store = new RpcHostStateStore();
		const state = store.hydrateFromRpcState(asRpcSessionState({
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		}));

		expect(state.sessionFile).toBeUndefined();
	});

	it("tracks working and compaction lifecycle events", () => {
		const store = new RpcHostStateStore();

		expect(store.handleAgentEvent({ type: "agent_start" })).toMatchObject({ isStreaming: true });
		expect(store.handleAgentEvent({ type: "compaction_start", reason: "manual" })).toMatchObject({ isCompacting: true, compactionReason: "manual" });
		expect(store.handleAgentEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: undefined })).toMatchObject({ isCompacting: false });
		expect(store.getSnapshot().compactionReason).toBeUndefined();
		expect(store.handleAgentEvent({ type: "agent_end", messages: [{ role: "user", content: "done" }], willRetry: false })).toMatchObject({
			isStreaming: false,
			messageCount: 1,
			hasMessages: true,
		});
	});

	it("carries manual and threshold compaction reasons from compaction_start events", () => {
		const store = new RpcHostStateStore();

		expect(store.handleAgentEvent({ type: "compaction_start", reason: "manual" })).toMatchObject({
			isCompacting: true,
			compactionReason: "manual",
		});
		expect(store.handleAgentEvent({ type: "compaction_start", reason: "threshold" })).toMatchObject({
			isCompacting: true,
			compactionReason: "threshold",
		});
	});

	it("leaves compactionReason undefined for unknown compaction_start reasons", () => {
		const store = new RpcHostStateStore();

		const state = store.handleAgentEvent({ type: "compaction_start", reason: "unexpected" });

		expect(state.isCompacting).toBe(true);
		expect(state.compactionReason).toBeUndefined();
	});

	it("clears stale compactionReason on compaction_end", () => {
		const store = new RpcHostStateStore();

		store.handleAgentEvent({ type: "compaction_start", reason: "threshold" });
		const state = store.handleAgentEvent({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });

		expect(state.isCompacting).toBe(false);
		expect(state.compactionReason).toBeUndefined();
	});

	it("clears stale compactionReason when hydrating a non-compacting get_state snapshot", () => {
		const store = new RpcHostStateStore();

		store.handleAgentEvent({ type: "compaction_start", reason: "manual" });
		const state = store.hydrateFromRpcState(asRpcSessionState({
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		}));

		expect(state.isCompacting).toBe(false);
		expect(state.compactionReason).toBeUndefined();
	});

	it("mirrors queue_update steer/follow-up snapshots into queuedMessages", () => {
		const store = new RpcHostStateStore();

		const queued = store.handleAgentEvent({
			type: "queue_update",
			steering: ["steer me"],
			followUp: ["then this", "and this"],
		});
		expect(queued.queuedMessages).toEqual(["steer me", "then this", "and this"]);
		expect(queued.pendingMessageCount).toBe(3);

		// Unrelated events must not clear the queue…
		expect(store.handleAgentEvent({ type: "agent_start" }).queuedMessages).toEqual(["steer me", "then this", "and this"]);

		// …and Pi's next snapshot (after a dequeue) is mirrored verbatim.
		const drained = store.handleAgentEvent({ type: "queue_update", steering: [], followUp: ["and this"] });
		expect(drained.queuedMessages).toEqual(["and this"]);
		expect(drained.pendingMessageCount).toBe(1);

		const empty = store.handleAgentEvent({ type: "queue_update", steering: [], followUp: [] });
		expect(empty.queuedMessages).toEqual([]);
		expect(empty.pendingMessageCount).toBe(0);
	});

	it("ignores malformed queue_update payloads without crashing", () => {
		const store = new RpcHostStateStore();
		const state = store.handleAgentEvent({ type: "queue_update", steering: "nope", followUp: [42, "ok"] });
		expect(state.queuedMessages).toEqual(["ok"]);
	});

	it("composes host-owned and Pi-owned queue snapshots without hydration erasing host messages", () => {
		const store = new RpcHostStateStore();

		expect(store.setHostQueuedMessages(["host b"]).queuedMessages).toEqual(["host b"]);
		expect(store.hydrateFromRpcState(asRpcSessionState({
			thinkingLevel: "medium",
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			autoCompactionEnabled: true,
			messageCount: 1,
			pendingMessageCount: 0,
		})).queuedMessages).toEqual(["host b"]);
		expect(store.getSnapshot().pendingMessageCount).toBe(1);

		expect(store.handleAgentEvent({ type: "queue_update", steering: ["pi steer"], followUp: [] }).queuedMessages).toEqual(["pi steer", "host b"]);
		expect(store.setHostQueuedMessages([]).queuedMessages).toEqual(["pi steer"]);
		expect(store.handleAgentEvent({ type: "queue_update", steering: [], followUp: [] }).queuedMessages).toEqual([]);
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

	it("resets transient event chrome when hydrating fresh RPC state", () => {
		const store = new RpcHostStateStore();

		const beforeHydrate = store.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "task-1",
			toolName: "task",
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		expect(beforeHydrate).toMatchObject({
			taskPartialCount: 1,
			lastEventType: "tool_execution_update",
		});

		const hydrated = store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
			thinkingLevel: "medium",
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "session-1",
			sessionName: "Migration",
			autoCompactionEnabled: true,
			messageCount: 2,
			pendingMessageCount: 1,
		}));

		expect(hydrated).toMatchObject({
			isStreaming: true,
			taskPartialCount: 0,
		});
		expect(hydrated.lastEventType).toBeUndefined();
	});

	it("applyModelChange patches modelLabel (and thinkingLevel, if given) directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}));

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
		store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}));

		expect(store.applyModelChange(undefined)).toMatchObject({ modelLabel: "openai/gpt-5.5" });
	});

	it("applySessionName patches sessionName directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}));

		expect(store.applySessionName("Plan 041")).toMatchObject({
			sessionId: "session-1",
			sessionName: "Plan 041",
			modelLabel: "openai/gpt-5.5",
			thinkingLevel: "medium",
		});
	});

	it("applyThinkingLevel patches thinkingLevel directly, without touching other state", () => {
		const store = new RpcHostStateStore();
		store.hydrateFromRpcState(asRpcSessionState({
			model: modelFixture,
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
		}));

		expect(store.applyThinkingLevel("xhigh")).toMatchObject({ thinkingLevel: "xhigh", sessionId: "session-1" });
	});
});
