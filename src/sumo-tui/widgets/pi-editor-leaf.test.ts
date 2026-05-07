import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, type Component } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { PiEditorLeaf } from "./pi-editor-leaf.js";

class FakeEditor implements Component {
	public constructor(private readonly rows: string[]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return this.rows;
	}
}

function asEditor(component: Component): CustomEditor {
	return component as unknown as CustomEditor;
}

describe("PiEditorLeaf", () => {
	it("remaps CURSOR_MARKER from leaf-local to frame coordinates (EC-1.1)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor([`ab${CURSOR_MARKER}cd`])), root);
		root.width = 10;
		root.height = 4;
		root.paddingTop = 2;
		root.paddingLeft = 3;
		leaf.height = 1;
		root.yogaNode.calculateLayout(10, 4, DIRECTION_LTR);

		const buffer = new CellBuffer(4, 10);
		const result = composite(root, buffer);

		expect(leaf.getHardwareCursor()).toEqual({ row: 2, col: 5 });
		expect(result.hardwareCursor).toEqual({ row: 2, col: 5 });
		expect(buffer.toPlainRow(2)).toBe("   abcd   ");
		root.dispose();
	});

	it("tracks variable editor row counts (EC-1.2)", async () => {
		const yoga = await loadYoga();
		for (const rowCount of [1, 3, 6]) {
			const root = new SumoNode(yoga.Node.create());
			const rows = Array.from({ length: rowCount }, (_, index) => `row${index}`);
			const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
			root.width = 8;
			root.yogaNode.calculateLayout(8, undefined, DIRECTION_LTR);
			expect(leaf.getComputedHeight()).toBe(rowCount);
			root.dispose();
		}
	});

	it("falls back to Pi's fake inverse cursor when autocomplete omits the marker", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor([" > \x1b[7m \x1b[0m"])), root);
		root.width = 8;
		root.paddingTop = 1;
		root.paddingLeft = 2;
		root.yogaNode.calculateLayout(10, undefined, DIRECTION_LTR);

		const buffer = new CellBuffer(2, 10);
		const result = composite(root, buffer);

		expect(leaf.getHardwareCursor()).toEqual({ row: 1, col: 5 });
		expect(result.hardwareCursor).toEqual({ row: 1, col: 5 });
		root.dispose();
	});

	it("returns null when the cursor marker is scrolled out of the rendered rows (EC-1.3)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(["visible only"])), root);
		root.width = 12;
		root.yogaNode.calculateLayout(12, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(1, 12);
		composite(root, buffer);
		expect(leaf.getHardwareCursor()).toBeNull();
		root.dispose();
	});

	it("uses visibleWidth for CJK cursor columns (EC-1.4)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor([`a界${CURSOR_MARKER}b`])), root);
		root.width = 8;
		root.yogaNode.calculateLayout(8, undefined, DIRECTION_LTR);

		const buffer = new CellBuffer(1, 8);
		composite(root, buffer);

		expect(leaf.getHardwareCursor()).toEqual({ row: 0, col: 3 });
		expect(buffer.getCell(0, 1).char).toBe("界");
		expect(buffer.getCell(0, 2).char).toBe("");
		root.dispose();
	});

	it("marks inner editor cells as selectable so drag-to-copy works (#207-style follow-up)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = [
			"\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
			"\u2502 hello \u2502",
			"\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
		];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 9;
		root.yogaNode.calculateLayout(9, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(3, 9);
		composite(root, buffer);

		// border rows must remain non-selectable
		for (let col = 0; col < 9; col += 1) {
			expect(buffer.getSelectionMeta(0, col)).toBeUndefined();
			expect(buffer.getSelectionMeta(2, col)).toBeUndefined();
		}
		// content row marks inner cells but not the side border columns
		expect(buffer.getSelectionMeta(1, 0)).toBeUndefined();
		expect(buffer.getSelectionMeta(1, 8)).toBeUndefined();
		for (let col = 1; col <= 7; col += 1) {
			expect(buffer.getSelectionMeta(1, col)).toEqual({ selectable: true });
		}
		root.dispose();
	});

	it("marks every cell selectable when the editor renders without a frame (e.g. Pi resume selector)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = ["SELECT SESSION"];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 14;
		root.yogaNode.calculateLayout(14, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(1, 14);
		composite(root, buffer);

		for (let col = 0; col < 14; col += 1) {
			expect(buffer.getSelectionMeta(0, col)).toEqual({ selectable: true });
		}
		root.dispose();
	});

	it("keeps a user-typed box-drawing row in the middle of a multiline prompt selectable", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = [
			"\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
			"\u2502 hello \u2502",
			"\u2502\u250C\u2500\u2500\u2500\u2500\u2500\u2510\u2502",
			"\u2502 world \u2502",
			"\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
		];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 9;
		root.yogaNode.calculateLayout(9, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 9);
		composite(root, buffer);

		// the middle row is box-drawing-only but sits inside the frame, so its
		// inner cells stay selectable
		for (let col = 1; col <= 7; col += 1) {
			expect(buffer.getSelectionMeta(2, col)).toEqual({ selectable: true });
		}
		root.dispose();
	});

	it("keeps a bare horizontal-bar row selectable when no corners frame it", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = ["\u2500\u2500\u2500\u2500\u2500"];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 5;
		root.yogaNode.calculateLayout(5, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(1, 5);
		composite(root, buffer);

		for (let col = 0; col < 5; col += 1) {
			expect(buffer.getSelectionMeta(0, col)).toEqual({ selectable: true });
		}
		root.dispose();
	});

	it("treats embedded separators inside content rows as selectable", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = [
			"\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
			"\u2502 \u2500\u2500\u2500\u2500\u2500 \u2502",
			"\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
		];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 9;
		root.yogaNode.calculateLayout(9, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(3, 9);
		composite(root, buffer);

		// the separator row still has side `│` borders, so its inner cells stay selectable
		for (let col = 1; col <= 7; col += 1) {
			expect(buffer.getSelectionMeta(1, col)).toEqual({ selectable: true });
		}
		root.dispose();
	});

	it("keeps blank rows inside multiline prompts selectable so paragraph breaks survive copy", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const rows = [
			"\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
			"\u2502 line1 \u2502",
			"\u2502       \u2502",
			"\u2502 line3 \u2502",
			"\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
		];
		new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor(rows)), root);
		root.width = 9;
		root.yogaNode.calculateLayout(9, undefined, DIRECTION_LTR);
		const buffer = new CellBuffer(5, 9);
		composite(root, buffer);

		for (const row of [1, 2, 3]) {
			for (let col = 1; col <= 7; col += 1) {
				expect(buffer.getSelectionMeta(row, col)).toEqual({ selectable: true });
			}
		}
		root.dispose();
	});

	it("preserves ANSI underline around IME pre-edit while stripping only the marker (EC-1.5)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor([`\x1b[4mpre${CURSOR_MARKER}edit\x1b[0m`])), root);
		root.width = 10;
		root.yogaNode.calculateLayout(10, undefined, DIRECTION_LTR);

		const buffer = new CellBuffer(1, 10);
		composite(root, buffer);

		expect(leaf.getHardwareCursor()).toEqual({ row: 0, col: 3 });
		expect(buffer.toPlainRow(0).slice(0, 7)).toBe("preedit");
		expect(buffer.getCell(0, 0).attrs.underline).toBe(true);
		expect(buffer.getCell(0, 6).attrs.underline).toBe(true);
		root.dispose();
	});
});
