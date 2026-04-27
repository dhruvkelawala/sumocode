import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type YogaNode } from "../layout/yoga.js";
import { CellBuffer, type Rect } from "./buffer.js";
import { createAttrs } from "./cell.js";
import { composite } from "./compositor.js";

class PaintNode extends SumoNode {
	public constructor(yogaNode: YogaNode, private readonly char: string, parent?: SumoNode) {
		super(yogaNode, parent);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		buffer.paint(rect, { char: this.char, attrs: createAttrs() });
	}
}

describe("compositor", () => {
	it("walks Yoga-computed flex boxes and paints leaves", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const top = new PaintNode(yoga.Node.create(), "T", root);
		const body = new PaintNode(yoga.Node.create(), "B", root);
		root.width = 4;
		root.height = 4;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		top.height = 1;
		body.flexGrow = 1;
		root.yogaNode.calculateLayout(4, 4, DIRECTION_LTR);

		const buffer = new CellBuffer(4, 4);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toBe("TTTT");
		expect(buffer.toPlainRow(1)).toBe("BBBB");
		expect(buffer.toPlainRow(3)).toBe("BBBB");
		root.dispose();
	});

	it("sorts absolute children by z-index", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const base = new PaintNode(yoga.Node.create(), ".", root);
		const low = new PaintNode(yoga.Node.create(), "1", root);
		const high = new PaintNode(yoga.Node.create(), "2", root);
		root.width = 3;
		root.height = 1;
		base.width = 3;
		base.height = 1;
		low.position = "absolute";
		low.left = 1;
		low.top = 0;
		low.width = 1;
		low.height = 1;
		low.zIndex = 1;
		high.position = "absolute";
		high.left = 1;
		high.top = 0;
		high.width = 1;
		high.height = 1;
		high.zIndex = 2;
		root.yogaNode.calculateLayout(3, 1, DIRECTION_LTR);

		const buffer = new CellBuffer(1, 3);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toBe(".2.");
		root.dispose();
	});
});
