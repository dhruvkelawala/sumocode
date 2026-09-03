import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { ChatPager } from "./chat-pager.js";

function liveActivities(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `terminal-${index}`,
		kind: "terminal" as const,
		title: `terminal ${index}`,
		status: "running" as const,
		createdAt: index,
		outputTail: `output ${index}`,
	}));
}

describe("ChatPager live-card retention bounds", () => {
	it("characterizes live-card retention: 100 live Activities remain bounded and rehydrates live card", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });

		chat.reconcileFeedActivities(liveActivities(100));

		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		expect(chat.getArchivedMessageCount()).toBe(0);
		expect(chat.scrollBox.children.length).toBeLessThanOrEqual(5);
		expect(chat.getKnownActivityIds()).toHaveLength(100);

		for (const activity of liveActivities(100)) {
			expect(chat.revealActivity(activity.id)).toBe(true);
			const visible = chat.getRenderedMessages().find((message) => message.text.includes(activity.title));
			expect(visible?.text).toContain(activity.outputTail);
			expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		}
		root.dispose();
	});

	it("programmatic page-up visits all 100 live Activity IDs", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });
		const activities = liveActivities(100);
		chat.reconcileFeedActivities(activities);
		chat.reconcileFeedActivities(activities.map((activity, index) => index === 0
			? { ...activity, outputTail: "latest output" }
			: activity));
		const observed = new Map<string, string | undefined>();

		for (let step = 0; step < 100; step += 1) {
			for (const message of chat.getRenderedMessages()) {
				for (const block of message.toSnapshot().blocks ?? []) {
					if (block.type === "activity") observed.set(block.activity.id, block.activity.outputTail);
				}
			}
			chat.handleKey({ key: "PageUp" });
		}

		expect(observed.size).toBe(100);
		expect(observed.get("terminal-0")).toBe("latest output");
		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(6);
		root.dispose();
	});

	it("keeps manual scroll at transcript top while page-up rehydrates Activity history", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.width = 80;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });
		chat.reconcileFeedActivities(liveActivities(10));
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 80));
		chat.scrollBox.scrollTo(0);
		expect(chat.scrollBox.manualScroll).toBe(true);

		chat.handleKey({ key: "PageUp" });
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 80));

		expect(chat.scrollBox.manualScroll).toBe(true);
		expect(chat.scrollBox.scrollOffset).toBe(0);
		root.dispose();
	});

	it("rehydrates a live card in logical order with its latest output", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });
		const activities = liveActivities(100);
		chat.reconcileFeedActivities(activities);
		chat.reconcileFeedActivities(activities.map((activity, index) => index === 0
			? { ...activity, outputTail: "latest output" }
			: activity));

		expect(chat.revealActivity("terminal-0")).toBe(true);

		const renderedIds = chat.getRenderedMessages().flatMap((message) =>
			(message.toSnapshot().blocks ?? []).flatMap((block) => block.type === "activity" ? [block.activity.id] : [])
		);
		expect(renderedIds).toEqual(["terminal-0", "terminal-96", "terminal-97", "terminal-98", "terminal-99"]);
		expect(chat.getRenderedMessages()[0]?.text).toContain("latest output");
		expect(chat.getArchivedMessageCount()).toBe(0);
		root.dispose();
	});

	it("disposes and reconstructs a virtualized live node once", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 1 });
		const activities = liveActivities(2);
		chat.reconcileFeedActivities([activities[0]!]);
		const original = chat.getRenderedMessages()[0]!;
		const dispose = original.dispose.bind(original);
		original.dispose = vi.fn(() => dispose());

		chat.reconcileFeedActivities(activities);
		expect(original.dispose).toHaveBeenCalledTimes(1);
		expect(chat.scrollBox.children).not.toContain(original);
		expect(chat.revealActivity("terminal-0")).toBe(true);
		expect(chat.getRenderedMessages()[0]).not.toBe(original);
		expect(original.dispose).toHaveBeenCalledTimes(1);
		root.dispose();
	});

	it("protects only the explicitly revealed Activity", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 2 });
		chat.reconcileFeedActivities(liveActivities(6));
		chat.setActivityExpansion("terminal-0", false);
		expect(chat.getRenderedMessages().some((message) => message.text.includes("terminal 0"))).toBe(false);

		expect(chat.revealActivity("terminal-0")).toBe(true);
		chat.reconcileFeedActivities(liveActivities(7));

		expect(chat.getRenderedMessages().some((message) => message.text.includes("terminal 0"))).toBe(true);
		expect(chat.getActivityExpansion("terminal-0")).toBe(false);
		expect(chat.getRenderedMessages()).toHaveLength(2);
		root.dispose();
	});

	it("preserves the visible scroll anchor during non-prefix eviction", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.width = 80;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 3 });
		chat.reconcileFeedActivities(liveActivities(6));
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 80));
		chat.scrollBox.scrollTo(5);
		expect(chat.revealActivity("terminal-3")).toBe(true);
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		const before = new CellBuffer(8, 80);
		composite(root, before);
		const beforeRows = Array.from({ length: 8 }, (_, row) => before.toPlainRow(row));
		const anchorRow = beforeRows.findIndex((row) => row.includes("terminal"));
		expect(anchorRow).toBeGreaterThanOrEqual(0);
		const anchor = beforeRows[anchorRow]!;

		chat.addMessage("sumo", "new reply");
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		const after = new CellBuffer(8, 80);
		composite(root, after);

		expect(after.toPlainRow(anchorRow)).toBe(anchor);
		expect(chat.getRenderedMessages().some((message) => message.text === "new reply")).toBe(true);
		root.dispose();
	});

	it("settles virtualized card without dropping order or current output", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.width = 80;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });
		const activities = liveActivities(100);
		chat.reconcileFeedActivities(activities);
		root.yogaNode.calculateLayout(80, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 80));
		chat.scrollBox.scrollTo(1);
		const knownOrder = chat.getKnownActivityIds();
		const readState = { offset: chat.scrollBox.scrollOffset, unread: chat.getUnreadCount(), lastRead: chat.getLastReadIndex() };

		chat.reconcileFeedActivities(activities.map((activity, index) => index === 0
			? { ...activity, status: "succeeded" as const, outputTail: "complete" }
			: activity));
		expect({ offset: chat.scrollBox.scrollOffset, unread: chat.getUnreadCount(), lastRead: chat.getLastReadIndex() }).toEqual(readState);
		expect(chat.revealActivity("terminal-0")).toBe(true);

		const visible = chat.getRenderedMessages().find((message) => message.text.includes("terminal 0"));
		expect(visible?.toSnapshot().blocks?.[0]).toMatchObject({
			type: "activity",
			activity: { id: "terminal-0", status: "succeeded", outputTail: "complete" },
		});
		expect(chat.getKnownActivityIds()).toEqual(knownOrder);
		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		root.dispose();
	});
});
