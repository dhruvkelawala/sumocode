import { describe, expect, it } from "vitest";
import { activeThemeColors } from "../../themes/index.js";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { fgHex, stripAnsi } from "../cathedral/ansi.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { SelectionController } from "../input/selection.js";
import { ChatMessage } from "./chat-message.js";

const FIXED_TIME = new Date("2026-04-30T11:42:00.000");

function renderRows(message: ChatMessage, width: number): string[] {
	return (message as unknown as { renderRows(width: number): string[] }).renderRows(width);
}

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

	it("marks only chat body text cells as semantically selectable", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 42;
		root.height = 5;
		ChatMessage.create(yoga, "user", "review src/auth/session.ts", root, FIXED_TIME);

		root.yogaNode.calculateLayout(42, 5, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 42);
		composite(root, buffer);

		expect(buffer.getSelectionMeta(0, 0)).toBeUndefined();
		expect(buffer.getSelectionMeta(1, 0)).toBeUndefined();
		expect(buffer.getSelectionMeta(1, 1)).toBeUndefined();
		expect(buffer.getSelectionMeta(1, 2)).toEqual({ selectable: true });
		expect(buffer.getSelectionMeta(1, 27)).toEqual({ selectable: true });
		expect(buffer.getSelectionMeta(1, 28)).toBeUndefined();
		expect(buffer.getSelectionMeta(2, 0)).toBeUndefined();
		root.dispose();
	});

	it("preserves blank body rows in semantic selection so paragraph breaks survive copy", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 32;
		root.height = 7;
		ChatMessage.create(yoga, "user", "first paragraph\n\nsecond paragraph", root, FIXED_TIME);

		root.yogaNode.calculateLayout(32, 7, DIRECTION_LTR);
		const buffer = new CellBuffer(7, 32);
		composite(root, buffer);

		// Frame row 0 (top), body rows 1-3, frame row 4 (bottom).
		expect(buffer.toPlainRow(1)).toBe("│ first paragraph              │");
		expect(buffer.toPlainRow(2)).toBe("│                              │");
		expect(buffer.toPlainRow(3)).toBe("│ second paragraph             │");

		// Blank body row must still carry selection metadata so the row
		// participates in semantic selection. Frame edges and trailing
		// padding stay untagged.
		expect(buffer.getSelectionMeta(2, 0)).toBeUndefined();
		expect(buffer.getSelectionMeta(2, 1)).toBeUndefined();
		expect(buffer.getSelectionMeta(2, 2)).toEqual({ selectable: true });
		expect(buffer.getSelectionMeta(2, 28)).toEqual({ selectable: true });
		expect(buffer.getSelectionMeta(2, 31)).toBeUndefined();

		const selection = new SelectionController();
		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 3, col: 18, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		expect(selection.extractSelectedText(buffer)).toBe("first paragraph\n\nsecond paragraph");
		root.dispose();
	});

	it("semantic chat selection cannot start from the frame and highlights only content", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 42;
		root.height = 5;
		ChatMessage.create(yoga, "user", "review src/auth/session.ts", root, FIXED_TIME);

		root.yogaNode.calculateLayout(42, 5, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 42);
		composite(root, buffer);
		const selection = new SelectionController();

		expect(selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 0, modifiers: { shift: false, alt: false, ctrl: false } }, buffer)).toBe(false);
		expect(selection.extractSelectedText(buffer)).toBe("");

		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 1, col: 41, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.applySelectionHighlight(buffer);

		expect(selection.extractSelectedText(buffer)).toBe("review src/auth/session.ts");
		expect(buffer.getCell(1, 0).attrs.inverse).toBe(false);
		expect(buffer.getCell(1, 1).attrs.inverse).toBe(false);
		expect(buffer.getCell(1, 2).attrs.inverse).toBe(true);
		expect(buffer.getCell(1, 27).attrs.inverse).toBe(true);
		expect(buffer.getCell(1, 28).attrs.inverse).toBe(false);
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

	it("renders bold and headings as styled, not literal markdown", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{ type: "markdown", text: "# Title\n**bold** text" },
		]);

		const rows = renderRows(message, 48);
		const raw = rows.join("\n");
		const plain = stripAnsi(raw);

		expect(plain).toContain("Title");
		expect(plain).toContain("bold text");
		expect(plain).not.toContain("# Title");
		expect(plain).not.toContain("**bold**");
		expect(raw).toContain("\x1b[1m");
		root.dispose();
	});

	it("renders a bullet list with a styled bullet", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{ type: "markdown", text: "- one\n- two" },
		]);

		const rows = renderRows(message, 40);
		const raw = rows.join("\n");
		const plain = stripAnsi(raw);

		expect(plain).toContain("- one");
		expect(plain).toContain("- two");
		expect(raw).toContain(`${fgHex(activeThemeColors().accent)}- `);
		root.dispose();
	});

	it("renders thinking markdown as styled thinking text", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{ type: "thinking", text: "**hidden** thought", hidden: false },
		]);

		const rows = renderRows(message, 48);
		const raw = rows.join("\n");
		const plain = stripAnsi(raw);

		expect(plain).toContain("✦ hidden thought");
		expect(plain).not.toContain("**hidden**");
		expect(raw).toContain("\x1b[3m");
		root.dispose();
	});

	it("renders collapsed skill blocks as a single styled inline pill", async () => {
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
		expect(row).toContain("[skill] frontend-design (ctrl+o to expand)");
		expect(buffer.toPlainRow(2)).toMatch(/^╰─+╯$/);
		root.dispose();
	});

	it("renders expanded skill blocks with wrapped body rows", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 48;
		root.height = 8;
		ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{
				type: "skill",
				name: "deep-research",
				expanded: true,
				content: "full body line 1\nfull body line 2",
			},
		]);

		root.yogaNode.calculateLayout(48, 8, DIRECTION_LTR);
		const buffer = new CellBuffer(8, 48);
		composite(root, buffer);

		expect(buffer.toPlainRow(1)).toContain("[skill] deep-research (ctrl+o to collapse)");
		expect(buffer.toPlainRow(2)).toBe(`│ full body line 1${" ".repeat(28)} │`);
		expect(buffer.toPlainRow(3)).toBe(`│ full body line 2${" ".repeat(28)} │`);
		root.dispose();
	});

	it("expands every collapsible block kind through the tool expansion bridge", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{ type: "tool", tool: { name: "read", status: "success", input: { path: "src/auth/session.ts" }, expanded: false } },
			{ type: "skill", name: "frontend-design", expanded: false, content: "design notes" },
			{ type: "summary", kind: "branch", label: "[branch]", content: "summary notes", expanded: false },
		]);

		expect(message.setToolExpansion(true)).toBe(true);
		expect(message.toSnapshot().blocks).toMatchObject([
			{ type: "tool", tool: { expanded: true } },
			{ type: "skill", expanded: true },
			{ type: "summary", expanded: true },
		]);
		root.dispose();
	});
});
