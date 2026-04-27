import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../../src/sumo-tui/layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../../src/sumo-tui/layout/yoga.js";
import { CellBuffer } from "../../src/sumo-tui/render/buffer.js";
import { composite } from "../../src/sumo-tui/render/compositor.js";
import { FrameScheduler } from "../../src/sumo-tui/runtime/frame-scheduler.js";
import { ChatPager } from "../../src/sumo-tui/widgets/chat-pager.js";

describe("Phase 3 streaming integration", () => {
	it("coalesces 1000 chunks in one second to <=60 frames and renders the final message", async () => {
		vi.useFakeTimers();
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		let frameCount = 0;
		const scheduler = new FrameScheduler({
			frameIntervalMs: 17,
			render: () => {
				frameCount += 1;
				root.yogaNode.calculateLayout(60, 8, DIRECTION_LTR);
				composite(root, new CellBuffer(8, 60));
			},
		});
		const chat = ChatPager.create(yoga, root, {
			renderControls: {
				scheduleRender: () => scheduler.requestRender(),
				setStreamingMode: (enabled) => (enabled ? scheduler.enterStreamingMode() : scheduler.exitStreamingMode()),
			},
		});
		root.width = 60;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;

		chat.addMessage("sumo", "");
		for (let index = 0; index < 1000; index += 1) chat.appendToLast(String(index % 10));
		await vi.advanceTimersByTimeAsync(1000);
		chat.endStreaming();
		await vi.runOnlyPendingTimersAsync();

		expect(frameCount).toBeLessThanOrEqual(60);
		expect(chat.getLastMessage()?.text).toHaveLength(1000);
		expect(chat.getLastMessage()?.text.endsWith("9")).toBe(true);
		scheduler.dispose();
		root.dispose();
		vi.useRealTimers();
	});
});
