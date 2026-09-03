import { describe, expect, it } from "vitest";
import {
	getActivityFoldOperationCountsForTests,
	resetActivityFoldOperationCountsForTests,
} from "./activity-fold.js";
import {
	getTranscriptSnapshotEnvelopeCopiesForTests,
	resetTranscriptSnapshotEnvelopeCopiesForTests,
	TranscriptController,
} from "./controller.js";

function longHistory(messageCount: number): unknown[] {
	return [
		{
			id: "tool-owner",
			role: "assistant",
			content: [{ type: "toolCall", id: "read-live", name: "read", arguments: { path: "src/live.ts" } }],
		},
		...Array.from({ length: messageCount - 1 }, (_, index) => ({
			id: `history-${index}`,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `history ${index}`,
		})),
	];
}

describe("TranscriptController streaming operation bounds", () => {
	it.fails.each([100, 1_000, 10_000])("characterizes live update operations: %i committed messages", (messageCount) => {
		const controller = new TranscriptController();
		const before = controller.replaceFromMessages(longHistory(messageCount));
		resetActivityFoldOperationCountsForTests();
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
		});
		expect(getTranscriptSnapshotEnvelopeCopiesForTests()).toBe(1);
		expect(after.messages).not.toBe(before.messages);
		expect(after.messages[0]).not.toBe(before.messages[0]);
		expect(after.messages[1]).toBe(before.messages[1]);
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
