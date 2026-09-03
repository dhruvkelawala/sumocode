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
		expect(chat.getArchivedMessageCount()).toBe(95);
		expect(chat.scrollBox.children.length).toBeLessThanOrEqual(6);
		expect(chat.getKnownActivityIds()).toHaveLength(100);

		for (const activity of liveActivities(100)) {
			expect(chat.revealActivity(activity.id)).toBe(true);
			const visible = chat.getRenderedMessages().find((message) => message.text.includes(activity.title));
			expect(visible?.text).toContain(activity.outputTail);
			expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		}
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
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 95 hidden messages ──" });
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
		expect(new Set(chat.getKnownActivityIds())).toEqual(new Set(knownOrder));
		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		root.dispose();
	});
});
