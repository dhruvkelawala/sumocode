import { describe, expect, it } from "vitest";
import {
	appendOrFoldTranscriptMessageIndexed,
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
	it("folds canonical identity transitions and unmatched live blocks", () => {
		const owner: ChatMessageViewModel = {
			id: "owner",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{
				type: "activity",
				activity: { id: "spawn-1", kind: "tool", title: "subagent_spawn", status: "running" },
			}],
		};
		const messages = [owner];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: {
				id: "subagent:sa-1",
				sourceId: "spawn-1",
				kind: "subagent",
				title: "worker",
				status: "succeeded",
			},
		}, cursor, { requireMatch: true });
		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: { id: "read-unmatched", kind: "tool", title: "read", status: "running" },
		}, cursor, { requireMatch: false });

		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "subagent:sa-1", sourceId: "spawn-1" }) }),
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "read-unmatched" }) }),
		]);
		expect(owner.blocks).toHaveLength(1);
	});

	it("folds no-ID delegations with sibling images", () => {
		const owner: ChatMessageViewModel = {
			id: "delegation-owner",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "delegation", delegation: { title: "worker", status: "running" } }],
		};
		const messages = [owner];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		appendOrFoldTranscriptMessageIndexed(messages, {
			id: "delegation-result",
			role: "system",
			displayName: "SYSTEM",
			blocks: [
				{ type: "delegation", delegation: { title: "worker", status: "success", summary: "done" } },
				{ type: "image", mime: "image/png", data: "image-data" },
			],
		}, cursor);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "delegation", delegation: expect.objectContaining({ status: "success", summary: "done" }) }),
			{ type: "image", mime: "image/png", data: "image-data" },
		]);
	});

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
