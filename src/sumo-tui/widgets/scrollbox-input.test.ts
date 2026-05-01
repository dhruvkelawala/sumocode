import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type YogaNode } from "../layout/yoga.js";
import type { MouseEvent } from "../input/mouse.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
import { createAttrs } from "../render/cell.js";
import { composite, dispatchMouseEvent } from "../render/compositor.js";
import { ScrollBox } from "./scrollbox.js";

class RowNode extends SumoNode {
	public constructor(yogaNode: YogaNode, parent?: SumoNode) {
		super(yogaNode, parent);
		this.height = 1;
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		buffer.paint(rect, { char: ".", attrs: createAttrs() });
	}
}

function wheel(row: number, col: number, scrollDir: "up" | "down"): MouseEvent {
	return { type: "scroll", row, col, scrollDir, button: scrollDir === "up" ? 64 : 65, modifiers: { shift: false, alt: false, ctrl: false } };
}

describe("ScrollBox input", () => {
	it("mouse wheel defaults to two rows per tick for responsive chat scrolling", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const scrollBox = new ScrollBox(yoga.Node.create(), root);
		for (let index = 0; index < 8; index += 1) new RowNode(yoga.Node.create(), scrollBox);
		root.width = 4;
		root.height = 3;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.yogaNode.calculateLayout(4, 3, DIRECTION_LTR);
		composite(root, new CellBuffer(3, 4));

		expect(dispatchMouseEvent(root, wheel(1, 1, "down"))).toBe(true);
		expect(scrollBox.scrollOffset).toBe(2);
		root.dispose();
	});

	it("mouse wheel inside scrollbox scrolls by the configured acceleration amount", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const scrollBox = new ScrollBox(yoga.Node.create(), root, { scrollAcceleration: 3 });
		for (let index = 0; index < 8; index += 1) new RowNode(yoga.Node.create(), scrollBox);
		root.width = 4;
		root.height = 3;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.yogaNode.calculateLayout(4, 3, DIRECTION_LTR);
		composite(root, new CellBuffer(3, 4));

		expect(dispatchMouseEvent(root, wheel(1, 1, "down"))).toBe(true);
		expect(scrollBox.scrollOffset).toBe(3);
		root.dispose();
	});

	it("mouse wheel outside scrollbox is not handled by it", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const scrollBox = new ScrollBox(yoga.Node.create(), root);
		for (let index = 0; index < 8; index += 1) new RowNode(yoga.Node.create(), scrollBox);
		root.width = 4;
		root.height = 3;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.yogaNode.calculateLayout(4, 3, DIRECTION_LTR);
		composite(root, new CellBuffer(3, 4));

		expect(dispatchMouseEvent(root, wheel(4, 1, "down"))).toBe(false);
		expect(scrollBox.scrollOffset).toBe(0);
		root.dispose();
	});

	it("PgUp/PgDn move by half a page, Home/End/Shift+Down jump to edges", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const scrollBox = new ScrollBox(yoga.Node.create(), root);
		for (let index = 0; index < 10; index += 1) new RowNode(yoga.Node.create(), scrollBox);
		root.width = 4;
		root.height = 4;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.yogaNode.calculateLayout(4, 4, DIRECTION_LTR);
		scrollBox.syncLayoutMetrics();

		scrollBox.handleKey({ key: "End" });
		expect(scrollBox.scrollOffset).toBe(6);
		scrollBox.handleKey({ key: "PageUp" });
		expect(scrollBox.scrollOffset).toBe(4);
		scrollBox.handleKey({ key: "PageDown" });
		expect(scrollBox.scrollOffset).toBe(6);
		scrollBox.handleKey({ key: "Home" });
		expect(scrollBox.scrollOffset).toBe(0);
		scrollBox.handleKey({ key: "Shift+Down" });
		expect(scrollBox.scrollOffset).toBe(6);
		scrollBox.handleKey({ key: "Home" });
		expect(scrollBox.scrollOffset).toBe(0);
		root.dispose();
	});

	it("click on a padding row does not invoke a child handler (EC-13.1)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		let clicked = false;
		const child = new SumoNode(yoga.Node.create(), root, {
			onMouseDown: () => {
				clicked = true;
				return true;
			},
		});
		root.width = 4;
		root.height = 3;
		root.paddingTop = 1;
		child.width = 4;
		child.height = 1;
		root.yogaNode.calculateLayout(4, 3, DIRECTION_LTR);

		const click: MouseEvent = { type: "down", row: 0, col: 0, button: 0, modifiers: { shift: false, alt: false, ctrl: false } };
		expect(dispatchMouseEvent(root, click)).toBe(false);
		expect(clicked).toBe(false);
		root.dispose();
	});
});
