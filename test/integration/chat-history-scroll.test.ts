import { describe, expect, it } from "vitest";
import { SumoNode } from "../../src/sumo-tui/layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../../src/sumo-tui/layout/yoga.js";
import { CellBuffer } from "../../src/sumo-tui/render/buffer.js";
import { composite, dispatchMouseEvent } from "../../src/sumo-tui/render/compositor.js";
import { ChatPager } from "../../src/sumo-tui/widgets/chat-pager.js";

describe("Phase 3 chat history scroll integration", () => {
	it("PgUp reveals older visible messages at the top", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		root.width = 48;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		for (let index = 0; index < 200; index += 1) chat.addMessage("sumo", `message ${index.toString().padStart(3, "0")}`);
		root.yogaNode.calculateLayout(48, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 48));
		chat.scrollBox.scrollToBottom();

		const bottomFrame = new CellBuffer(8, 48);
		composite(root, bottomFrame);
		chat.handleKey({ key: "PageUp" });
		const pageUpFrame = new CellBuffer(8, 48);
		composite(root, pageUpFrame);

		expect(bottomFrame.toPlainRow(0)).toContain("message 192");
		expect(pageUpFrame.toPlainRow(0)).toContain("message 188");
		root.dispose();
	});

	it("mouse wheel scroll is handled by ChatPager's in-app ScrollBox", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		root.width = 48;
		root.height = 6;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		for (let index = 0; index < 40; index += 1) chat.addMessage("sumo", `message ${index.toString().padStart(3, "0")}`);
		root.yogaNode.calculateLayout(48, 6, DIRECTION_LTR);
		composite(root, new CellBuffer(6, 48));
		chat.scrollBox.scrollToBottom();
		const before = chat.scrollBox.scrollOffset;

		const handled = dispatchMouseEvent(root, { type: "scroll", scrollDir: "up", button: 64, row: 2, col: 2, modifiers: { shift: false, alt: false, ctrl: false } });

		expect(handled).toBe(true);
		expect(chat.scrollBox.scrollOffset).toBe(before - 3);
		expect(chat.scrollBox.manualScroll).toBe(true);
		root.dispose();
	});
});
