import { describe, expect, it } from "vitest";
import {
	appendOrFoldTranscriptMessageIndexed,
	createFoldableBlockCursor,
	foldBlockIntoIndexedMessages,
	getActivityFoldOperationCountsForTests,
	indexFoldableBlocks,
	resetActivityFoldOperationCountsForTests,
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

	it("matches a no-ID result to the first queued delegation even when it has an ID", () => {
		const messages: ChatMessageViewModel[] = [{
			id: "delegations",
			role: "sumo",
			displayName: "SUMO",
			blocks: [
				{ type: "delegation", delegation: { id: "first", title: "first", status: "running" } },
				{ type: "delegation", delegation: { id: "second", title: "second", status: "running" } },
			],
		}];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		foldBlockIntoIndexedMessages(messages, {
			type: "delegation",
			delegation: { title: "complete", status: "success" },
		}, cursor, { requireMatch: true });

		expect(messages[0]?.blocks[0]).toMatchObject({ type: "delegation", delegation: { id: "first", status: "success" } });
		expect(messages[0]?.blocks[1]).toMatchObject({ type: "delegation", delegation: { id: "second", status: "running" } });
		foldBlockIntoIndexedMessages(messages, {
			type: "delegation",
			delegation: { title: "second complete", status: "success" },
		}, cursor, { requireMatch: true });
		expect(messages[0]?.blocks[1]).toMatchObject({ type: "delegation", delegation: { id: "second", status: "success" } });
	});

	it("indexes each pending delegation when one appended message owns several", () => {
		const messages: ChatMessageViewModel[] = [];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		appendOrFoldTranscriptMessageIndexed(messages, {
			id: "delegation-owner",
			role: "sumo",
			displayName: "SUMO",
			blocks: [
				{ type: "delegation", delegation: { id: "first", title: "first", status: "running" } },
				{ type: "delegation", delegation: { id: "second", title: "second", status: "running" } },
			],
		}, cursor);

		for (const title of ["first complete", "second complete"]) {
			foldBlockIntoIndexedMessages(messages, {
				type: "delegation",
				delegation: { title, status: "success" },
			}, cursor, { requireMatch: true });
		}

		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "delegation", delegation: expect.objectContaining({ id: "first", status: "success" }) }),
			expect.objectContaining({ type: "delegation", delegation: expect.objectContaining({ id: "second", status: "success" }) }),
		]);
	});

	it("keeps newest anonymous delegation ownership after an older ID update", () => {
		const messages: ChatMessageViewModel[] = [
			{
				id: "older-message",
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "delegation", delegation: { id: "older", title: "older", status: "running" } }],
			},
			{
				id: "newer-message",
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "delegation", delegation: { id: "newer", title: "newer", status: "running" } }],
			},
		];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		foldBlockIntoIndexedMessages(messages, {
			type: "delegation",
			delegation: { id: "older", title: "older updated", status: "running" },
		}, cursor, { requireMatch: true });

		foldBlockIntoIndexedMessages(messages, {
			type: "delegation",
			delegation: { title: "anonymous result", status: "success" },
		}, cursor, { requireMatch: true });

		expect(messages[0]?.blocks[0]).toMatchObject({ type: "delegation", delegation: { id: "older", status: "running" } });
		expect(messages[1]?.blocks[0]).toMatchObject({ type: "delegation", delegation: { id: "newer", status: "success" } });
	});

	it("keeps no-ID delegation lookup constant across long history", () => {
		const messages: ChatMessageViewModel[] = Array.from({ length: 10_000 }, (_, index) => ({
			id: `delegation-message-${index}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "delegation", delegation: { id: `delegation-${index}`, title: `worker ${index}`, status: "running" } }],
		}));
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		resetActivityFoldOperationCountsForTests();

		foldBlockIntoIndexedMessages(messages, {
			type: "delegation",
			delegation: { title: "complete", status: "success" },
		}, cursor, { requireMatch: true });

		expect(getActivityFoldOperationCountsForTests().indexedCandidateVisits).toBe(1);
		expect(messages.at(-1)?.blocks[0]).toMatchObject({ type: "delegation", delegation: { id: "delegation-9999", status: "success" } });
	});

	it("falls back to equal Activity ID when a non-subagent update gains a source ID", () => {
		const messages: ChatMessageViewModel[] = [{
			id: "tool-owner",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "activity", activity: { id: "terminal-1", kind: "terminal", title: "build", status: "running" } }],
		}];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: { id: "terminal-1", sourceId: "start-1", kind: "terminal", title: "build", status: "succeeded" },
		}, cursor, { requireMatch: true });

		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "terminal-1", sourceId: "start-1", status: "succeeded" }) }),
		]);
	});

	it("uses the source alias directly when canonical IDs repeat", () => {
		const messages = Array.from({ length: 10_000 }, (_, index) => subagentMessage("subagent:worker", `spawn-${index}`));
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		resetActivityFoldOperationCountsForTests();

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: {
				id: "subagent:worker",
				sourceId: "spawn-0",
				kind: "subagent",
				title: "first complete",
				status: "succeeded",
			},
		}, cursor, { requireMatch: true });

		expect(getActivityFoldOperationCountsForTests().indexedCandidateVisits).toBe(1);
		expect(messages[0]?.blocks[0]).toMatchObject({ type: "activity", activity: { sourceId: "spawn-0", status: "succeeded" } });
	});

	it("folds a subagent update that first gains createdAt", () => {
		const messages: ChatMessageViewModel[] = [{
			id: "subagent-message",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "activity", activity: { id: "subagent:worker", kind: "subagent", title: "worker", status: "running" } }],
		}];
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: { id: "subagent:worker", kind: "subagent", title: "worker", status: "succeeded", createdAt: 10 },
		}, cursor, { requireMatch: true });

		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks[0]).toMatchObject({ type: "activity", activity: { status: "succeeded", createdAt: 10 } });
	});

	it("keeps bare repeated subagent completion lookup constant", () => {
		const messages: ChatMessageViewModel[] = Array.from({ length: 10_000 }, (_, index) => ({
			id: `subagent-message-${index}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "activity", activity: { id: "subagent:worker", kind: "subagent", title: `worker ${index}`, status: "running" } }],
		}));
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		resetActivityFoldOperationCountsForTests();

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: { id: "subagent:worker", kind: "subagent", title: "complete", status: "succeeded" },
		}, cursor, { requireMatch: true });

		expect(getActivityFoldOperationCountsForTests().indexedCandidateVisits).toBe(1);
		expect(messages.at(-1)?.blocks[0]).toMatchObject({ type: "activity", activity: { status: "succeeded" } });
	});

	it("uses createdAt directly when canonical subagent IDs repeat without source IDs", () => {
		const messages: ChatMessageViewModel[] = Array.from({ length: 10_000 }, (_, index) => ({
			id: `subagent-message-${index}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [{
				type: "activity",
				activity: { id: "subagent:worker", kind: "subagent", title: `worker ${index}`, status: "running", createdAt: index },
			}],
		}));
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		resetActivityFoldOperationCountsForTests();

		foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: { id: "subagent:worker", kind: "subagent", title: "first complete", status: "succeeded", createdAt: 0 },
		}, cursor, { requireMatch: true });

		expect(getActivityFoldOperationCountsForTests().indexedCandidateVisits).toBe(1);
		expect(messages[0]?.blocks[0]).toMatchObject({ type: "activity", activity: { createdAt: 0, status: "succeeded" } });
	});

	it("does not scan repeated canonical subagent IDs for an unseen source", () => {
		const messages = Array.from({ length: 10_000 }, (_, index) => subagentMessage("subagent:worker", `spawn-${index}`));
		const cursor = createFoldableBlockCursor(indexFoldableBlocks(messages));
		resetActivityFoldOperationCountsForTests();

		const result = foldBlockIntoIndexedMessages(messages, {
			type: "activity",
			activity: {
				id: "subagent:worker",
				sourceId: "spawn-new",
				kind: "subagent",
				title: "new generation",
				status: "succeeded",
			},
		}, cursor, { requireMatch: true });

		expect(result.folded).toBe(false);
		expect(getActivityFoldOperationCountsForTests().indexedCandidateVisits).toBe(0);
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
