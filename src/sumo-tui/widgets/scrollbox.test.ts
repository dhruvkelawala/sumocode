import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type YogaNode } from "../layout/yoga.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
import { createAttrs } from "../render/cell.js";
import { composite } from "../render/compositor.js";
import { ScrollBox } from "./scrollbox.js";

class LineNode extends SumoNode {
	public renderCount = 0;
	public constructor(yogaNode: YogaNode, private readonly label: string, parent?: SumoNode) {
		super(yogaNode, parent);
		this.height = 1;
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		this.renderCount += 1;
		buffer.paint(rect, { char: this.label, attrs: createAttrs() });
	}
}

async function makeScrollFixture(childCount = 5, viewportHeight = 3): Promise<{ root: SumoNode; scrollBox: ScrollBox; children: LineNode[] }> {
	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	const scrollBox = new ScrollBox(yoga.Node.create(), root);
	const children = Array.from({ length: childCount }, (_, index) => new LineNode(yoga.Node.create(), String(index), scrollBox));
	root.width = 4;
	root.height = viewportHeight;
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	root.yogaNode.calculateLayout(4, viewportHeight, DIRECTION_LTR);
	scrollBox.syncLayoutMetrics();
	return { root, scrollBox, children };
}

describe("ScrollBox", () => {
	it("scrollBy clamps correctly at both edges", async () => {
		const { root, scrollBox } = await makeScrollFixture();
		scrollBox.scrollBy(99);
		expect(scrollBox.scrollOffset).toBe(2);
		scrollBox.scrollBy(-99);
		expect(scrollBox.scrollOffset).toBe(0);
		root.dispose();
	});

	it("scrollTo respects [0, max]", async () => {
		const { root, scrollBox } = await makeScrollFixture();
		scrollBox.scrollTo(-10);
		expect(scrollBox.scrollOffset).toBe(0);
		scrollBox.scrollTo(10);
		expect(scrollBox.scrollOffset).toBe(2);
		root.dispose();
	});

	it("isAtBottom returns true at the bottom edge", async () => {
		const { root, scrollBox } = await makeScrollFixture();
		expect(scrollBox.isAtBottom()).toBe(false);
		scrollBox.scrollToBottom();
		expect(scrollBox.isAtBottom()).toBe(true);
		root.dispose();
	});

	it("skips children outside the viewport while painting visible rows", async () => {
		const { root, scrollBox, children } = await makeScrollFixture(6, 3);
		scrollBox.scrollTo(3);
		const buffer = new CellBuffer(3, 4);
		composite(root, buffer);

		expect(buffer.toPlainRow(0)).toBe("3333");
		expect(buffer.toPlainRow(2)).toBe("5555");
		expect(children[0]?.renderCount).toBe(0);
		expect(children[5]?.renderCount).toBe(1);
		root.dispose();
	});

	it("tracks Yoga-computed viewport height", async () => {
		const { root, scrollBox } = await makeScrollFixture(2, 4);
		const buffer = new CellBuffer(4, 4);
		composite(root, buffer);
		expect(scrollBox.viewportHeight).toBe(4);
		root.dispose();
	});

	it("snaps to bottom when stickyBottom content arrives without manual scroll", async () => {
		const { root, scrollBox } = await makeScrollFixture(4, 2);
		scrollBox.stickyBottom = true;
		scrollBox.notifyContentChanged(4, 0);
		expect(scrollBox.scrollOffset).toBe(2);
		root.dispose();
	});

	it("preserves manual viewport during appended streaming content (EC-2.5)", async () => {
		const { root, scrollBox } = await makeScrollFixture(8, 3);
		scrollBox.stickyBottom = true;
		scrollBox.scrollToBottom();
		scrollBox.scrollBy(-2);
		const beforeOffset = scrollBox.scrollOffset;
		const before = new CellBuffer(3, 4);
		composite(root, before);

		const yoga = await loadYoga();
		new LineNode(yoga.Node.create(), "8", scrollBox);
		root.yogaNode.calculateLayout(4, 3, DIRECTION_LTR);
		scrollBox.notifyContentChanged(1, 0);
		const after = new CellBuffer(3, 4);
		composite(root, after);

		expect(scrollBox.manualScroll).toBe(true);
		expect(scrollBox.scrollOffset).toBe(beforeOffset);
		expect(after.toPlainRow(0)).toBe(before.toPlainRow(0));
		root.dispose();
	});

	it("scrolling up trips manualScroll and returning bottom clears it", async () => {
		const { root, scrollBox } = await makeScrollFixture(6, 3);
		scrollBox.scrollToBottom();
		scrollBox.scrollBy(-1);
		expect(scrollBox.manualScroll).toBe(true);
		scrollBox.scrollToBottom();
		expect(scrollBox.manualScroll).toBe(false);
		root.dispose();
	});
});
