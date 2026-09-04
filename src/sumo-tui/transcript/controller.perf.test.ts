import { describe, expect, it, vi } from "vitest";
import {
	getActivityFoldOperationCountsForTests,
	resetActivityFoldOperationCountsForTests,
} from "./activity-fold.js";
import {
	getMessageContentKeyCacheMissesForTests,
	getTranscriptSnapshotEnvelopeCopiesForTests,
	resetMessageContentKeyCacheForTests,
	resetTranscriptSnapshotEnvelopeCopiesForTests,
	TranscriptController,
	type TranscriptControllerChatSink,
} from "./controller.js";
import { createTranscriptViewModelMapper } from "./view-model.js";

function longHistory(messageCount: number): unknown[] {
	return [
		{
			id: "tool-owner",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "read-live", name: "read", arguments: { path: "src/live.ts" } },
				{ type: "toolCall", id: "read-two", name: "read", arguments: { path: "src/two.ts" } },
				{ type: "toolCall", id: "read-three", name: "read", arguments: { path: "src/three.ts" } },
			],
		},
		...Array.from({ length: messageCount - 1 }, (_, index) => ({
			id: `history-${index}`,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `history ${index}`,
		})),
	];
}

function chatSink(): TranscriptControllerChatSink {
	return {
		replaceViewModels: vi.fn(() => ({ sourceMessages: 0, acceptedMessages: 0, renderedMessages: 0, archivedMessages: 0 })),
		addViewModel: vi.fn(() => true),
		replaceLastWithViewModel: vi.fn(() => true),
		replaceViewModelAt: vi.fn(() => true),
		beginStreaming: vi.fn(),
		endStreaming: vi.fn(),
	};
}

describe("TranscriptController streaming operation bounds", () => {
	it.each([100, 1_000, 10_000])("characterizes live update operations: %i committed messages", (messageCount) => {
		const delegate = createTranscriptViewModelMapper();
		const mapper = {
			reset: vi.fn(() => delegate.reset()),
			messageFromPiMessage: vi.fn(delegate.messageFromPiMessage.bind(delegate)),
			transcriptFromSessionContext: delegate.transcriptFromSessionContext.bind(delegate),
		};
		const chat = chatSink();
		const controller = new TranscriptController({ chat, mapper });
		controller.replaceFromMessages(longHistory(messageCount));
		controller.handleAgentEvent({ type: "message_start", message: { id: "draft", role: "assistant", content: "draft" } });
		for (const [toolCallId, path] of [["read-live", "src/live.ts"], ["read-two", "src/two.ts"], ["read-three", "src/three.ts"]]) {
			controller.handleAgentEvent({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path } });
		}
		const before = controller.viewModel();
		mapper.reset.mockClear();
		mapper.messageFromPiMessage.mockClear();
		vi.mocked(chat.replaceViewModelAt).mockClear();
		resetActivityFoldOperationCountsForTests();
		resetMessageContentKeyCacheForTests();
		resetTranscriptSnapshotEnvelopeCopiesForTests();

		const after = controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "read-live",
			toolName: "read",
			args: { path: "src/live.ts" },
			partialResult: { content: [{ type: "text", text: "updated" }] },
		});

		expect(getActivityFoldOperationCountsForTests()).toEqual({
			historyMessageVisits: 0,
			messageEnvelopeCopies: 0,
			indexedIdentityLookups: 1,
			indexedCandidateVisits: 1,
			targetBlockVisits: 6,
			changedMessagePaths: 1,
		});
		expect(getTranscriptSnapshotEnvelopeCopiesForTests()).toBe(1);
		expect(getMessageContentKeyCacheMissesForTests()).toBeLessThanOrEqual(2);
		expect(mapper.reset).not.toHaveBeenCalled();
		expect(mapper.messageFromPiMessage).not.toHaveBeenCalled();
		expect(chat.replaceViewModelAt).toHaveBeenCalledTimes(1);
		expect(after.messages).not.toBe(before.messages);
		expect(after.messages[0]).not.toBe(before.messages[0]);
		expect(after.messages[1]).toBe(before.messages[1]);
		expect(after.messages.at(-1)).toBe(before.messages.at(-1));
		expect(after.messages[0]?.blocks[1]).toBe(before.messages[0]?.blocks[1]);
		expect(before.messages[0]?.blocks[0]).toMatchObject({
			type: "activity",
			activity: { id: "read-live", status: "running" },
		});
		expect(after.messages[0]?.blocks[0]).toMatchObject({
			type: "activity",
			activity: { id: "read-live", status: "running", outputTail: "updated" },
		});
	});
});
