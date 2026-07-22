import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
	TranscriptController,
	getMessageContentKeyCacheMissesForTests,
	planChatDiff,
	resetMessageContentKeyCacheForTests,
	type TranscriptControllerChatSink,
} from "./controller.js";
import type { ChatMessageViewModel } from "./view-model.js";

function readJsonl(path: string): unknown[] {
	return readFileSync(resolve(process.cwd(), path), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

describe("TranscriptController agent_end reconciliation", () => {
	it("keeps a prior committed exchange visible after a second agent_end", () => {
		const controller = new TranscriptController();

		// First exchange.
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "first question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "first question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a1", role: "assistant", content: "first answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a1", role: "assistant", content: "first answer" } });
		controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u1", role: "user", content: "first question" },
				{ id: "a1", role: "assistant", content: "first answer" },
			],
		});

		expect(controller.viewModel().messages.map((m) => m.id)).toEqual(["u1", "a1"]);

		// Second exchange.
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u2", role: "user", content: "second question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u2", role: "user", content: "second question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a2", role: "assistant", content: "second answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a2", role: "assistant", content: "second answer" } });
		const transcript = controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u2", role: "user", content: "second question" },
				{ id: "a2", role: "assistant", content: "second answer" },
			],
		});

		// Both exchanges must remain visible — the first must not have been wiped.
		expect(transcript.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
	});

	it("keeps a mid-run follow-up because agent_end always carries it (pinned Pi 0.79.1 behavior)", () => {
		// Pinned against @earendil-works/pi-agent-core 0.79.1: `runLoop` is the
		// ONLY emitter of `message_end` for a mid-run queued (steer/followUp)
		// message, and the same block pushes that message into `newMessages`
		// (dist/agent-loop.js:95-103; follow-up drain at :157-161) — the exact
		// array every `agent_end` carries (dist/agent-loop.js:109,151,166). So an
		// agent_end arriving after a mid-run follow-up ALWAYS includes it, and
		// the run-suffix splice cannot drop it. If a Pi upgrade breaks this
		// invariant, this test's premise (and the splice in `handleAgentEvent`'s
		// agent_end branch) must be revisited.
		const controller = new TranscriptController();

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a1", role: "assistant", content: "working on it" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a1", role: "assistant", content: "working on it" } });
		// User submits mid-run with streamingBehavior "followUp"; the loop drains
		// the queue and injects it (message_start/message_end + newMessages push).
		controller.handleAgentEvent({ type: "message_start", message: { id: "fu1", role: "user", content: "also do X" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "fu1", role: "user", content: "also do X" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a2", role: "assistant", content: "done, including X" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a2", role: "assistant", content: "done, including X" } });

		const before = controller.viewModel().messages;

		// agent_end.messages === the loop's newMessages: the injected follow-up
		// is present, in interleaved order.
		const transcript = controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u1", role: "user", content: "question" },
				{ id: "a1", role: "assistant", content: "working on it" },
				{ id: "fu1", role: "user", content: "also do X" },
				{ id: "a2", role: "assistant", content: "done, including X" },
			],
		});

		// The reconcile must be an identity operation: same messages, same
		// order, the follow-up present exactly once.
		expect(transcript.messages.map((m) => m.id)).toEqual(["u1", "a1", "fu1", "a2"]);
		expect(transcript.messages).toEqual(before);
		expect(transcript.messages.filter((m) => m.id === "fu1")).toHaveLength(1);
	});

	it("replays a long-stream fixture preceded by a synthetic committed exchange and keeps the prior exchange", () => {
		const controller = new TranscriptController();

		controller.replaceFromMessages([
			{ id: "prior-user", role: "user", content: "earlier question" },
			{ id: "prior-assistant", role: "assistant", content: "earlier answer" },
		]);

		for (const event of readJsonl("scratch/rpc-spike/events-perf-long-stream.jsonl")) {
			controller.handleAgentEvent(event);
		}

		const ids = controller.viewModel().messages.map((m) => m.id);
		expect(ids[0]).toBe("prior-user");
		expect(ids[1]).toBe("prior-assistant");
		// The fixture's run messages (user prompt + long assistant reply) must be appended after prior history.
		expect(ids.length).toBe(4);
	});

	it("does not resurrect stale runStart tracking across a rehydrate", () => {
		const controller = new TranscriptController();
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "q" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "q" } });

		// A session switch/rehydrate happens mid-run (defensive edge case). The
		// rehydrated baseline becomes the new floor: without an intervening
		// agent_start, agent_end reconciliation falls back to appending after it
		// rather than reaching back before the rehydrate point.
		controller.replaceFromMessages([{ id: "fresh", role: "user", content: "fresh session" }]);

		const transcript = controller.handleAgentEvent({
			type: "agent_end",
			messages: [{ id: "reply", role: "assistant", content: "reply" }],
		});

		expect(transcript.messages.map((m) => m.id)).toEqual(["fresh", "reply"]);
	});

	it("reconciles even without a preceding agent_start by appending after existing committed history", () => {
		const controller = new TranscriptController();
		controller.replaceFromMessages([{ id: "old", role: "user", content: "old session" }]);

		const transcript = controller.handleAgentEvent({
			type: "agent_end",
			messages: [{ id: "new-u", role: "user", content: "new question" }, { id: "new-a", role: "assistant", content: "new answer" }],
		});

		expect(transcript.messages.map((m) => m.id)).toEqual(["old", "new-u", "new-a"]);
	});

	it("renders provider auth-resolution errors with a /login hint", () => {
		const controller = new TranscriptController();
		const userMessage = { id: "u1", role: "user", content: "hi" };
		const assistantError = {
			id: "a1",
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			stopReason: "error",
			errorMessage: "No API key for provider: anthropic",
		};
		const expectedHint = "anthropic auth failed — run pi directly and /login to re-authenticate";

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: userMessage });
		controller.handleAgentEvent({ type: "message_end", message: userMessage });

		controller.handleAgentEvent({ type: "message_start", message: assistantError });
		expect(controller.viewModel().messages.at(-1)?.blocks).toContainEqual({ type: "markdown", text: expectedHint });

		controller.handleAgentEvent({ type: "message_end", message: assistantError });
		const transcript = controller.handleAgentEvent({
			type: "agent_end",
			messages: [userMessage, assistantError],
		});

		expect(transcript.messages.at(-1)?.blocks).toContainEqual({ type: "markdown", text: expectedHint });
	});
});

describe("TranscriptController Activity folding", () => {
	it("keeps simultaneous same-name tools distinct and folds each result by stable ID", () => {
		const controller = new TranscriptController();
		const transcript = controller.replaceFromMessages([
			{
				id: "assistant-tools",
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-a", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "read-b", name: "read", arguments: { path: "b.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "read-a", toolName: "read", content: [{ type: "text", text: "alpha" }] },
			{ role: "toolResult", toolCallId: "read-b", toolName: "read", content: [{ type: "text", text: "beta" }] },
		]);

		const activities = transcript.messages.flatMap((message) => message.blocks).filter((block) => block.type === "activity");
		expect(transcript.messages).toHaveLength(1);
		expect(activities).toHaveLength(2);
		expect(activities.map((block) => block.activity.id)).toEqual(["read-a", "read-b"]);
		expect(activities.map((block) => block.activity.outputTail)).toEqual(["alpha", "beta"]);
	});

	it("folds an image-bearing tool result into one Activity and one deduplicated sibling image", () => {
		const controller = new TranscriptController();
		controller.replaceFromMessages([{
			id: "assistant-tools",
			role: "assistant",
			content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "shot.png" } }],
		}]);
		const result = {
			role: "toolResult",
			toolCallId: "read-image",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", filename: "shot.png" },
			],
		};

		controller.handleAgentEvent({ type: "message_start", message: result });
		const transcript = controller.handleAgentEvent({ type: "message_update", message: result });

		expect(transcript.messages).toHaveLength(1);
		expect(transcript.messages[0]?.blocks.filter((block) => block.type === "activity")).toHaveLength(1);
		expect(transcript.messages[0]?.blocks.filter((block) => block.type === "image")).toEqual([
			{ type: "image", data: "iVBORw0KGgo=", mime: "image/png", filename: "shot.png" },
		]);
	});

	it("does not regress a live Activity after a terminal event", () => {
		const controller = new TranscriptController();
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant", role: "assistant", content: [] } });
		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "final" }] },
			isError: false,
		});
		const regressed = controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "a.ts" },
			partialResult: { content: [] },
		});

		const block = regressed.messages.flatMap((message) => message.blocks).find((candidate) => candidate.type === "activity");
		expect(block).toMatchObject({ type: "activity", activity: { id: "read-1", status: "succeeded", outputTail: "final", body: { text: "final" } } });
	});
});

describe("TranscriptController live-state clearing", () => {
	it("clears finished live tools on agent_end since authoritative messages now carry them", () => {
		const controller = new TranscriptController();
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "src/auth.ts" },
		});
		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "src/auth.ts" },
			result: { content: [{ type: "text", text: "file contents" }] },
			isError: false,
		});

		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 1 });

		controller.handleAgentEvent({
			type: "agent_end",
			messages: [{ id: "final", role: "assistant", content: "done" }],
		});

		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 0, taskPartials: 0, draftMessage: false });
	});

	it("clears a tool still mid-execution when agent_end fires (e.g. an aborted run)", () => {
		const controller = new TranscriptController();
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tool-running",
			toolName: "bash",
			args: { command: "long-running-command" },
		});

		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 1 });

		controller.handleAgentEvent({
			type: "agent_end",
			messages: [{ id: "u1", role: "user", content: "q" }, { id: "a1", role: "assistant", content: "aborted", stopReason: "aborted" }],
		});

		// agent_end means the run truly ended -- the authoritative messages array
		// is now the source of truth, so no live tool state should remain even for
		// a tool that never reached tool_execution_end.
		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 0 });
	});

	it("clears live task partials on rehydrate", () => {
		const controller = new TranscriptController();
		controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "task-1",
			toolName: "task",
			args: { prompt: "do work" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});

		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 1, taskPartials: 1 });

		controller.replaceFromMessages([{ id: "rehydrated", role: "user", content: "hi" }]);

		expect(controller.getLiveStateSnapshot()).toMatchObject({ liveTools: 0, taskPartials: 0, draftMessage: false });
	});
});

type FakeChatSink = TranscriptControllerChatSink & {
	replaceViewModels: Mock;
	addViewModel: Mock;
	replaceViewModelAt: Mock;
	replaceLastWithViewModel: Mock;
};

function fakeChatSink(): FakeChatSink {
	return {
		replaceViewModels: vi.fn((messages: readonly ChatMessageViewModel[]) => ({
			sourceMessages: messages.length,
			acceptedMessages: messages.length,
			renderedMessages: messages.length,
			archivedMessages: 0,
		})),
		addViewModel: vi.fn((_message: ChatMessageViewModel) => undefined),
		replaceViewModelAt: vi.fn((_index: number, _message: ChatMessageViewModel) => undefined),
		replaceLastWithViewModel: vi.fn((_message: ChatMessageViewModel) => undefined),
	};
}

describe("TranscriptController incremental chat sink (B9)", () => {
	it("memoizes fallback content keys per reused view-model object", () => {
		resetMessageContentKeyCacheForTests();
		const prefix = Array.from({ length: 50 }, (_, index): ChatMessageViewModel => ({
			id: `prefix-${index}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "markdown", text: `prefix ${index}` }],
		}));
		const previousLast: ChatMessageViewModel = {
			id: "draft",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "markdown", text: "old" }],
		};
		const nextLast: ChatMessageViewModel = {
			id: "draft",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "markdown", text: "new" }],
		};
		const previous = [...prefix, previousLast];
		const next = [...prefix, nextLast];

		expect(planChatDiff(previous, next)).toEqual([{ kind: "replace-last", message: nextLast }]);
		const missesAfterColdDiff = getMessageContentKeyCacheMissesForTests();
		expect(missesAfterColdDiff).toBe(52);

		expect(planChatDiff(previous, next)).toEqual([{ kind: "replace-last", message: nextLast }]);
		expect(getMessageContentKeyCacheMissesForTests()).toBe(missesAfterColdDiff);
	});

	it("replaces the full pager on the very first publish (nothing to diff against yet)", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "hi" } });

		expect(chat.replaceViewModels).toHaveBeenCalledTimes(1);
		expect(chat.addViewModel).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).not.toHaveBeenCalled();
	});

	it("message_update draft deltas call replaceLastWithViewModel, never replaceViewModels", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "draft", role: "assistant", content: "he" } });
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();

		controller.handleAgentEvent({ type: "message_update", message: { id: "draft", role: "assistant", content: "hell" } });
		controller.handleAgentEvent({ type: "message_update", message: { id: "draft", role: "assistant", content: "hello" } });

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).toHaveBeenCalledTimes(2);
		const lastCallText = chat.replaceLastWithViewModel.mock.calls.at(-1)?.[0]?.blocks?.[0]?.text;
		expect(lastCallText).toBe("hello");
	});

	it("message_update uses the O(1) hinted boundary diff without prefix key misses", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });
		const history = Array.from({ length: 200 }, (_, index) => ({
			id: `history-${index}`,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message ${index}`,
		}));
		controller.replaceFromMessages(history);
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "draft", role: "assistant", content: "hello" } });
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();
		chat.replaceLastWithViewModel.mockClear();
		resetMessageContentKeyCacheForTests();

		controller.handleAgentEvent({ type: "message_update", message: { id: "draft", role: "assistant", content: "hello stream" } });

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).toHaveBeenCalledTimes(1);
		expect(chat.replaceLastWithViewModel.mock.calls[0]?.[0]?.blocks).toEqual([{ type: "markdown", text: "hello stream" }]);
		// Only the previous and next draft boundary messages were keyed; the 200-message prefix stayed untouched.
		expect(getMessageContentKeyCacheMissesForTests()).toBe(2);
	});

	it("message_update timestamp-only changes on the last message call replaceLastWithViewModel", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({
			type: "message_start",
			message: {
				id: "draft",
				role: "assistant",
				content: "hello",
				timestamp: "2026-04-30T11:42:00.000Z",
			},
		});
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();
		chat.replaceLastWithViewModel.mockClear();

		// Timestamps are deterministic view-model provenance (view-model.ts:692),
		// so a changed rendered minute is a visible last-message diff.
		controller.handleAgentEvent({
			type: "message_update",
			message: {
				id: "draft",
				role: "assistant",
				content: "hello",
				timestamp: "2026-04-30T11:43:00.000Z",
			},
		});

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).toHaveBeenCalledTimes(1);
		expect(chat.replaceLastWithViewModel.mock.calls[0]?.[0]).toMatchObject({
			id: "draft",
			timestamp: new Date("2026-04-30T11:43:00.000Z"),
			blocks: [{ type: "markdown", text: "hello" }],
		});
	});

	it("message_end committing the draft appends via addViewModel, not a full replace", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "question" } });
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();

		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "question" } });

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).not.toHaveBeenCalled(); // no new draft yet; message_end just commits the same last entry
		// message_end's committed message renders identically to the draft it replaces, so
		// the diff sees no reference/content change at the last slot and applies no-op.
	});

	it("a fresh message starting after a committed one appends via addViewModel", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "question" } });
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();

		controller.handleAgentEvent({ type: "message_start", message: { id: "a1", role: "assistant", content: "reply" } });

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).toHaveBeenCalledTimes(1);
		expect(chat.addViewModel.mock.calls[0]?.[0]?.id).toBe("a1");
	});

	it("target-updates a non-last Activity result instead of replacing the pager", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });
		controller.replaceFromMessages([
			{
				id: "assistant-tools",
				role: "assistant",
				content: [{ type: "toolCall", id: "read-a", name: "read", arguments: { path: "a.ts" } }],
			},
			{ id: "later-user", role: "user", content: "keep this later message" },
		]);
		chat.replaceViewModels.mockClear();
		chat.replaceViewModelAt.mockClear();
		chat.replaceLastWithViewModel.mockClear();

		controller.handleAgentEvent({
			type: "message_start",
			message: { role: "toolResult", toolCallId: "read-a", toolName: "read", content: [{ type: "text", text: "alpha" }] },
		});

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).not.toHaveBeenCalled();
		expect(chat.replaceViewModelAt).toHaveBeenCalledTimes(1);
		expect(chat.replaceViewModelAt).toHaveBeenCalledWith(0, expect.objectContaining({
			id: "assistant-tools",
			blocks: [expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "read-a", status: "succeeded", outputTail: "alpha" }) })],
		}));
	});

	it("replaceFromMessages (hydration) always calls replaceViewModels", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "question" } });
		chat.replaceViewModels.mockClear();

		controller.replaceFromMessages([{ id: "rehydrated", role: "user", content: "hi" }]);

		expect(chat.replaceViewModels).toHaveBeenCalledTimes(1);
	});

	it("falls back to a full replace when agent_end rewrites already-committed history (not just the run suffix)", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		// First exchange committed.
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "first question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "first question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a1", role: "assistant", content: "first answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a1", role: "assistant", content: "first answer" } });
		controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u1", role: "user", content: "first question" },
				{ id: "a1", role: "assistant", content: "first answer" },
			],
		});
		chat.replaceViewModels.mockClear();

		// Second exchange: agent_end's run-suffix splice only touches messages
		// from this run onward, so committed history before it is untouched by
		// reference -- the common case stays incremental.
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u2", role: "user", content: "second question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u2", role: "user", content: "second question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a2", role: "assistant", content: "second answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a2", role: "assistant", content: "second answer" } });
		chat.replaceViewModels.mockClear();

		controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u2", role: "user", content: "second question" },
				{ id: "a2", role: "assistant", content: "second answer" },
			],
		});

		expect(chat.replaceViewModels).not.toHaveBeenCalled();

		// Now force an actual history rewrite: a rehydrate/replay whose agent_end
		// messages diverge from an earlier point than the run start (defensive
		// edge case) must fall back to a full replace rather than silently
		// dropping/misplacing history.
		chat.replaceViewModels.mockClear();
		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u1", role: "user", content: "first question -- rewritten" },
				{ id: "a1", role: "assistant", content: "first answer" },
				{ id: "u2", role: "user", content: "second question" },
				{ id: "a2", role: "assistant", content: "second answer" },
			],
		});
		expect(chat.replaceViewModels).toHaveBeenCalledTimes(1);
	});
	it("target-updates a single non-last rewrite after streamed updates", () => {
		const chat = fakeChatSink();
		const controller = new TranscriptController({ chat });

		controller.handleAgentEvent({ type: "agent_start" });
		controller.handleAgentEvent({ type: "message_start", message: { id: "u1", role: "user", content: "question" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "u1", role: "user", content: "question" } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "a1", role: "assistant", content: "draft" } });
		controller.handleAgentEvent({ type: "message_update", message: { id: "a1", role: "assistant", content: "answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "a1", role: "assistant", content: "answer" } });
		chat.replaceViewModels.mockClear();
		chat.addViewModel.mockClear();
		chat.replaceViewModelAt.mockClear();
		chat.replaceLastWithViewModel.mockClear();

		controller.handleAgentEvent({
			type: "agent_end",
			messages: [
				{ id: "u1", role: "user", content: "question rewritten" },
				{ id: "a1", role: "assistant", content: "answer" },
			],
		});

		expect(chat.replaceViewModels).not.toHaveBeenCalled();
		expect(chat.addViewModel).not.toHaveBeenCalled();
		expect(chat.replaceLastWithViewModel).not.toHaveBeenCalled();
		expect(chat.replaceViewModelAt).toHaveBeenCalledWith(0, expect.objectContaining({ id: "u1" }));
	});

	it("does not schedule a render when an event produces no visible diff", () => {
		const chat = fakeChatSink();
		const scheduleRender = vi.fn();
		const controller = new TranscriptController({ chat, scheduleRender });

		controller.handleAgentEvent({ type: "agent_start" });
		scheduleRender.mockClear();

		// compaction_start with no reason handler side effect and no message
		// change should not force a render through the chat sink.
		controller.handleAgentEvent({ type: "compaction_start", reason: "manual" });

		expect(scheduleRender).not.toHaveBeenCalled();
	});
});
