import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { ChatMessage } from "./chat-message.js";

const FIXED_TIME = new Date("2026-04-30T11:42:00.000");

describe("ChatMessage", () => {
	it("renders V2 rounded transparent message frames", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 42;
		root.height = 5;
		ChatMessage.create(yoga, "user", "review src/auth/session.ts", root, FIXED_TIME);

		root.yogaNode.calculateLayout(42, 5, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 42);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toMatch(/^╭ USER ─+╮$/);
		expect(buffer.toPlainRow(1)).toBe("│ review src/auth/session.ts             │");
		expect(buffer.toPlainRow(2)).toMatch(/^╰─+╯$/);
		root.dispose();
	});

	it("wraps content inside the frame width", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 18;
		root.height = 8;
		ChatMessage.create(yoga, "sumo", "hello from a very long assistant response", root, FIXED_TIME);

		root.yogaNode.calculateLayout(18, 8, DIRECTION_LTR);
		const buffer = new CellBuffer(8, 18);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toMatch(/^╭ SUMO ─+ 11:42 ─╮$/);
		expect(buffer.toPlainRow(1)).toBe("│ hello from a v │");
		expect(buffer.toPlainRow(2)).toBe("│ ery long assis │");
		root.dispose();
	});

	it("uses the configured primary agent name for assistant headers", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 18;
		root.height = 5;
		ChatMessage.create(yoga, "sumo", "configured name", root, FIXED_TIME, undefined, { primaryAgentName: "Zeus" });

		root.yogaNode.calculateLayout(18, 5, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 18);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toMatch(/^╭ ZEUS ─+ 11:42 ─╮$/);
		root.dispose();
	});
});
