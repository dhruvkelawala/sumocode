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
	it.fails("characterizes live-card retention: 100 live Activities remain viewport bounded", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 5 });

		chat.reconcileFeedActivities(liveActivities(100));

		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(5);
		expect(chat.getArchivedMessageCount()).toBe(95);
		expect(chat.scrollBox.children.length).toBeLessThanOrEqual(6);
		root.dispose();
	});
});
