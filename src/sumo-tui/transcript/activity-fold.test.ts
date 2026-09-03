import { describe, expect, it } from "vitest";
import {
	createFoldableBlockCursor,
	foldBlockIntoIndexedMessages,
	indexFoldableBlocks,
} from "./activity-fold.js";
import type { ChatMessageViewModel } from "./view-model.js";

function subagentMessage(id: string, sourceId: string): ChatMessageViewModel {
	return {
		id: `message-${sourceId}`,
		role: "sumo",
		displayName: "SUMO",
		blocks: [{
			type: "activity",
			activity: { id, sourceId, kind: "subagent", title: sourceId, status: "running" },
		}],
	};
}

describe("indexed Activity folding", () => {
	it("updates the exact source identity when canonical IDs repeat", () => {
		const first = subagentMessage("subagent:worker", "spawn-first");
		const second = subagentMessage("subagent:worker", "spawn-second");
		const messages = [first, second];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: {
				id: "subagent:worker",
				sourceId: "spawn-first",
				kind: "subagent",
				title: "first complete",
				status: "succeeded",
			},
		}, cursor, { requireMatch: true });

		expect(messages[0]).not.toBe(first);
		expect(messages[1]).toBe(second);
		expect(first.blocks[0]).toMatchObject({ type: "activity", activity: { status: "running" } });
		expect(messages[0]?.blocks[0]).toMatchObject({ type: "activity", activity: { sourceId: "spawn-first", status: "succeeded" } });
	});
});
