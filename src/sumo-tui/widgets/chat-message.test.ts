import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeThemeColors, resetThemeRegistryForTests, setActiveTheme } from "../../themes/index.js";
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

function setTimestamp(message: ChatMessage, timestamp: Date): void {
	const candidate: unknown = message;
	if (candidate && typeof candidate === "object" && "setTimestamp" in candidate && typeof candidate.setTimestamp === "function") {
		candidate.setTimestamp(timestamp);
		return;
	}
	throw new TypeError("ChatMessage.setTimestamp is not available");
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

	it("semantic code selection excludes nested frames and line-number gutters", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 42;
		root.height = 6;
		ChatMessage.create(
			yoga,
			"sumo",
			"",
			root,
			FIXED_TIME,
			[{ type: "code", lang: "sh", source: "  alpha\nbeta" }],
		);

		root.yogaNode.calculateLayout(42, 6, DIRECTION_LTR);
		const buffer = new CellBuffer(6, 42);
		composite(root, buffer);

		// Outer chat frame: rows 0/5. Nested code frame: rows 1/4.
		// The code gutter occupies columns 4..7; source begins at column 8.
		for (let col = 0; col < 42; col += 1) {
			expect(buffer.getSelectionMeta(1, col)).toBeUndefined();
			expect(buffer.getSelectionMeta(4, col)).toBeUndefined();
		}
		for (let col = 4; col <= 7; col += 1) {
			expect(buffer.getSelectionMeta(2, col)).toBeUndefined();
			expect(buffer.getSelectionMeta(3, col)).toBeUndefined();
		}
		expect(buffer.getSelectionMeta(2, 8)).toEqual({ selectable: true });
		expect(buffer.getSelectionMeta(3, 8)).toEqual({ selectable: true });

		const selection = new SelectionController();
		selection.handleMouseEvent({ type: "down", button: 0, row: 2, col: 8, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 3, col: 11, modifiers: { shift: false, alt: false, ctrl: false } }, buffer);

		expect(selection.extractSelectedText(buffer)).toBe("  alpha\nbeta");
		root.dispose();
	});

	it("semantic selection excludes blank gutters and collapse chrome from wrapped plaintext code", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 42;
		root.height = 25;
		ChatMessage.create(
			yoga,
			"sumo",
			"",
			root,
			FIXED_TIME,
			[{ type: "code", lang: "txt", source: "word ".repeat(180).trim() }],
		);

		root.yogaNode.calculateLayout(42, 25, DIRECTION_LTR);
		const buffer = new CellBuffer(25, 42);
		composite(root, buffer);

		// First continuation row: nested border and continuation gutter are chrome;
		// wrapped source starts at the same column as numbered source rows.
		for (let col = 2; col <= 7; col += 1) expect(buffer.getSelectionMeta(3, col)).toBeUndefined();
		expect(buffer.getSelectionMeta(3, 8)).toEqual({ selectable: true });
		// Wrapped-content collapse affordance is entirely non-selectable.
		for (let col = 0; col < 42; col += 1) expect(buffer.getSelectionMeta(22, col)).toBeUndefined();
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

	it("wraps question prompts and choices inside the message body", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
			{
				type: "question",
				question: {
					prompt: "Choose the deployment environment for this release",
					choices: ["Production with the full validation suite"],
				},
			},
		]);

		const plain = renderRows(message, 30).map(stripAnsi);

		expect(plain.some((row) => row.includes("for this release"))).toBe(true);
		expect(plain.some((row) => row.includes("validation suite"))).toBe(true);
		expect(plain.every((row) => row.length === 30)).toBe(true);
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

	describe("renderRows memoization", () => {
		afterEach(() => {
			resetThemeRegistryForTests();
		});

		function fixtureBlocks() {
			return [
				{ type: "markdown" as const, text: "# Title\n**bold** text" },
				{ type: "thinking" as const, text: "**hidden** thought", hidden: false },
				{ type: "code" as const, lang: "ts", source: "const x = 1;" },
				{ type: "tool" as const, tool: { name: "read", status: "success" as const, input: { path: "src/auth/session.ts" }, expanded: false } },
			];
		}

		it("produces byte-identical output before/after memoization for a fixture message across block kinds", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, fixtureBlocks());

			const first = renderRows(message, 60);
			const second = renderRows(message, 60);

			// Repeated calls at the same width with unchanged content must return
			// byte-identical rows (memoization must not alter output).
			expect(second).toEqual(first);
			const plain = stripAnsi(first.join("\n"));
			expect(plain).toContain("Title");
			expect(plain).toContain("bold text");
			expect(plain).toContain("hidden thought");
			expect(plain).toContain("const x = 1;");
			expect(plain).toContain("read");
			root.dispose();
		});

		it("invalidates the memo when a mutator changes content (appendText)", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "hello", root, FIXED_TIME);

			const before = renderRows(message, 40);
			message.appendText(" world");
			const after = renderRows(message, 40);

			expect(after).not.toEqual(before);
			expect(stripAnsi(after.join("\n"))).toContain("hello world");
		});

		it("invalidates the memo on setText, setBlocks, and setRole", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "user", "first", root, FIXED_TIME);

			const afterCreate = renderRows(message, 40);

			message.setText("second");
			const afterSetText = renderRows(message, 40);
			expect(afterSetText).not.toEqual(afterCreate);

			message.setBlocks([{ type: "markdown", text: "third" }], "third");
			const afterSetBlocks = renderRows(message, 40);
			expect(afterSetBlocks).not.toEqual(afterSetText);

			message.setRole("sumo");
			const afterSetRole = renderRows(message, 40);
			expect(afterSetRole).not.toEqual(afterSetBlocks);
		});

		it("setTimestamp invalidates the renderRows memo when the rendered minute changes", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "timestamped", root, new Date("2026-04-30T11:42:00.000"));

			const before = renderRows(message, 44);
			setTimestamp(message, new Date("2026-04-30T11:43:00.000"));
			const after = renderRows(message, 44);

			expect(after).not.toBe(before);
			expect(stripAnsi(after[0] ?? "")).toContain("11:43");
			expect(stripAnsi(after[0] ?? "")).not.toContain("11:42");
			root.dispose();
		});

		it("setTimestamp preserves the memoized rows reference when the rendered minute is unchanged", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const sameMinute = new Date("2026-04-30T11:42:59.000");
			const message = ChatMessage.create(yoga, "sumo", "timestamped", root, new Date("2026-04-30T11:42:00.000"));

			const before = renderRows(message, 44);
			setTimestamp(message, sameMinute);
			const after = renderRows(message, 44);

			expect(after).toBe(before);
			expect(message.toSnapshot().timestamp).toEqual(sameMinute);
			expect(stripAnsi(after[0] ?? "")).toContain("11:42");
			root.dispose();
		});

		it("invalidates the memo on theme switch", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
				{ type: "markdown", text: "- one\n- two" },
			]);

			const before = renderRows(message, 40);
			const cycled = setActiveTheme("obsidian");
			expect(cycled.success).toBe(true);
			const after = renderRows(message, 40);

			expect(after).not.toEqual(before);
			// same underlying text content survives the theme switch; only frame
			// chrome/styling differs (obsidian uses square corners, not rounded).
			expect(after.join("\n")).toContain("one");
			expect(after.join("\n")).toContain("two");
		});

		it("recomputes on width change and returns identical rows for a repeated prior width", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "hello from a very long assistant response", root, FIXED_TIME);

			const atWidth40 = renderRows(message, 40);
			const atWidth60 = renderRows(message, 60);
			expect(atWidth60).not.toEqual(atWidth40);

			// Cache holds current + previous width; re-requesting width 40 must
			// still return the correct (recomputed-or-cached) content for that width.
			const atWidth40Again = renderRows(message, 40);
			expect(atWidth40Again).toEqual(atWidth40);
		});

		it("setToolExpansion invalidates only the affected message", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const affected = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
				{ type: "tool", tool: { name: "read", status: "success", input: { path: "a.ts" }, expanded: false } },
			]);
			const untouched = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
				{ type: "tool", tool: { name: "read", status: "success", input: { path: "b.ts" }, expanded: false } },
			]);

			const affectedBefore = renderRows(affected, 40);
			const untouchedBefore = renderRows(untouched, 40);

			expect(affected.setToolExpansion(true)).toBe(true);

			const affectedAfter = renderRows(affected, 40);
			const untouchedAfter = renderRows(untouched, 40);

			expect(affectedAfter).not.toEqual(affectedBefore);
			expect(untouchedAfter).toEqual(untouchedBefore);
		});

		it("reuses the memoized rows array reference on a same-width, unchanged-content repeat call", async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
				{ type: "markdown", text: "# Title\n**bold** text" },
			]);

			const first = renderRows(message, 48);
			const second = renderRows(message, 48);

			// Reference equality is only possible if renderRows short-circuited on
			// a cache hit instead of recomputing (and thus re-invoking Markdown).
			expect(second).toBe(first);
		});

		it("invokes the Markdown constructor exactly once across repeated same-width renderRows calls", async () => {
			const renderSpy = vi.spyOn(Markdown.prototype, "render");
			try {
				const yoga = await loadYoga();
				const root = new SumoNode(yoga.Node.create());
				const message = ChatMessage.create(yoga, "sumo", "", root, FIXED_TIME, [
					{ type: "markdown", text: "# Title\n**bold** text" },
				]);

				renderSpy.mockClear();
				renderRows(message, 48);
				renderRows(message, 48);
				renderRows(message, 48);

				expect(renderSpy).toHaveBeenCalledTimes(1);
				root.dispose();
			} finally {
				renderSpy.mockRestore();
			}
		});
	});
});
