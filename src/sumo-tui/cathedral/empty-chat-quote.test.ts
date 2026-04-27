import { describe, expect, it } from "vitest";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { SumoNode } from "../layout/node.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { stripAnsi } from "./ansi.js";
import { EmptyChatQuoteNode, renderEmptyChatQuoteLines, shouldRenderEmptyChatQuote, type EmptyChatQuoteSnapshot } from "./empty-chat-quote.js";

describe("empty-chat quote", () => {
	it("mount predicate requires active state, visible sidebar, and zero user messages", () => {
		expect(shouldRenderEmptyChatQuote({ sidebarVisible: true, isSplash: false, userMessageCount: 0 })).toBe(true);
		expect(shouldRenderEmptyChatQuote({ sidebarVisible: false, isSplash: false, userMessageCount: 0 })).toBe(false);
		expect(shouldRenderEmptyChatQuote({ sidebarVisible: true, isSplash: true, userMessageCount: 0 })).toBe(false);
		expect(shouldRenderEmptyChatQuote({ sidebarVisible: true, isSplash: false, userMessageCount: 1 })).toBe(false);
	});

	it("centers the Saint-Exupéry quote in the chat pane", () => {
		const lines = renderEmptyChatQuoteLines(60).map(stripAnsi);
		expect(lines[0]).toContain("\"perfection is achieved when there is");
		expect(lines[1]).toContain("nothing left to take away.\"");
		expect(lines[2]).toContain("— saint-exupéry");
		expect(lines[0].indexOf("\"")).toBeGreaterThan(8);
	});

	it("renders nothing after the first user message arrives", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 80;
		root.height = 12;
		let snapshot: EmptyChatQuoteSnapshot = { sidebarVisible: true, isSplash: false, userMessageCount: 0 };
		new EmptyChatQuoteNode(yoga.Node.create(), () => snapshot, root);

		root.yogaNode.calculateLayout(80, 12, DIRECTION_LTR);
		let frame = new CellBuffer(12, 80);
		composite(root, frame);
		expect(Array.from({ length: 12 }, (_, row) => frame.toPlainRow(row)).join("\n")).toContain("saint-exupéry");

		snapshot = { sidebarVisible: true, isSplash: false, userMessageCount: 1 };
		root.yogaNode.calculateLayout(80, 12, DIRECTION_LTR);
		frame = new CellBuffer(12, 80);
		composite(root, frame);
		expect(Array.from({ length: 12 }, (_, row) => frame.toPlainRow(row)).join("\n")).not.toContain("saint-exupéry");
		root.dispose();
	});
});
