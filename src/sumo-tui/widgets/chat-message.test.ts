import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
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
		for (let col = 0; col < 42; col += 1) {
			expect(buffer.getCell(1, col).bg).toBe(CATHEDRAL_TOKENS.colors.background);
			expect(buffer.getCell(1, col).bg).not.toBe(CATHEDRAL_TOKENS.colors.surfaceRecess);
		}
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
		expect(buffer.toPlainRow(1)).toBe("│ hello from a   │");
		expect(buffer.toPlainRow(2)).toBe("│ very long      │");
		expect(buffer.toPlainRow(3)).toBe("│ assistant      │");
		root.dispose();
	});

	it("hard-wraps long unbreakable tokens inside the body width", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 14;
		root.height = 6;
		ChatMessage.create(yoga, "user", "abcdefghijklmnop", root, FIXED_TIME);

		root.yogaNode.calculateLayout(14, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 14);
		composite(root, buffer);

		expect(buffer.toPlainRow(1)).toBe("│ abcdefghij │");
		expect(buffer.toPlainRow(2)).toBe("│ klmnop     │");
		root.dispose();
	});

	it("wraps CJK text by whole glyphs when no whitespace is available", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 12;
		root.height = 6;
		ChatMessage.create(yoga, "user", "界界界界界", root, FIXED_TIME);

		root.yogaNode.calculateLayout(12, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 12);
		composite(root, buffer);

		expect(buffer.toPlainRow(1)).toBe("│ 界界界界 │");
		expect(buffer.toPlainRow(2)).toBe("│ 界       │");
		root.dispose();
	});

	it("uses 126 body cells in a 130-column landscape chat frame", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 130;
		root.height = 6;
		ChatMessage.create(yoga, "user", `${"a".repeat(125)} tail`, root, FIXED_TIME);

		root.yogaNode.calculateLayout(130, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 130);
		composite(root, buffer);

		expect(buffer.toPlainRow(1)).toBe(`│ ${"a".repeat(125)}  │`);
		expect(buffer.toPlainRow(2)).toBe(`│ tail${" ".repeat(122)} │`);
		root.dispose();
	});

	it("uses term width minus 4 body cells in a portrait chat frame", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 60;
		root.height = 6;
		ChatMessage.create(yoga, "user", `${"b".repeat(56)} rest`, root, FIXED_TIME);

		root.yogaNode.calculateLayout(60, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 60);
		composite(root, buffer);

		expect(buffer.toPlainRow(1)).toBe(`│ ${"b".repeat(56)} │`);
		expect(buffer.toPlainRow(2)).toBe(`│ rest${" ".repeat(52)} │`);
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

	it("renders skill blocks as styled inline pills", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 60;
		root.height = 6;
		ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{ type: "skill", name: "frontend-design", expanded: false },
		]);

		root.yogaNode.calculateLayout(60, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 60);
		composite(root, buffer);

		const row = buffer.toPlainRow(1);
		expect(row).toContain("[skill] frontend-design (⌘O to expand)");
		root.dispose();
	});
});
