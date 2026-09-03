import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { loadYoga } from "../layout/yoga.js";
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
			chat.setActivityExpansion(activity.id, true);
			const visible = chat.getRenderedMessages().find((message) => message.text.includes(activity.title));
			expect(visible?.text).toContain(activity.outputTail);
			expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		}
		root.dispose();
	});

	it("settles virtualized card without dropping order or current output", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });
		const activities = liveActivities(100);
		chat.reconcileFeedActivities(activities);
		const knownOrder = chat.getKnownActivityIds();
		const readState = { unread: chat.getUnreadCount(), lastRead: chat.getLastReadIndex() };

		chat.reconcileFeedActivities(activities.map((activity, index) => index === 0
			? { ...activity, status: "succeeded" as const, outputTail: "complete" }
			: activity));
		chat.setActivityExpansion("terminal-0", true);

		const visible = chat.getRenderedMessages().find((message) => message.text.includes("terminal 0"));
		expect(visible?.toSnapshot().blocks?.[0]).toMatchObject({
			type: "activity",
			activity: { id: "terminal-0", status: "succeeded", outputTail: "complete" },
		});
		expect(new Set(chat.getKnownActivityIds())).toEqual(new Set(knownOrder));
		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		expect({ unread: chat.getUnreadCount(), lastRead: chat.getLastReadIndex() }).toEqual(readState);
		root.dispose();
	});
});
