import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { createSplashTree, defaultSplashSnapshot, getSplashContentHeight } from "./splash-tree.js";

function firstNonBlankRow(buffer: CellBuffer, height: number): number {
	for (let row = 0; row < height; row += 1) {
		if (buffer.toPlainRow(row).trim().length > 0) return row;
	}
	return -1;
}

describe("createSplashTree", () => {
	for (const height of [30, 60, 100]) {
		it(`centers splash content vertically at ${height} rows with flex spacers`, async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			root.flexDirection = FLEX_DIRECTION_COLUMN;
			root.width = 120;
			root.height = height;

			const snapshot = defaultSplashSnapshot(false);
			const tree = createSplashTree(yoga, root, () => snapshot);
			root.yogaNode.calculateLayout(120, height, DIRECTION_LTR);
			const frame = new CellBuffer(height, 120);
			composite(root, frame);

			const contentHeight = getSplashContentHeight(snapshot, 120);
			const expectedTop = Math.floor((height - contentHeight) / 2);
			expect(tree.topSpacer.getComputedHeight()).toBe(expectedTop);
			expect(tree.bottomSpacer.getComputedHeight()).toBe(height - expectedTop - contentHeight);
			expect(tree.content.getComputedTop()).toBe(expectedTop);
			expect(firstNonBlankRow(frame, height)).toBeGreaterThanOrEqual(expectedTop);
			expect(firstNonBlankRow(frame, height)).toBeLessThan(expectedTop + contentHeight);
			root.dispose();
		});
	}

	it("collapses once the session has messages so splash and sidebar never share the empty state", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 100;
		root.height = 40;
		const tree = createSplashTree(yoga, root, () => defaultSplashSnapshot(true));
		tree.syncVisibility();
		root.yogaNode.calculateLayout(100, 40, DIRECTION_LTR);

		expect(tree.root.getComputedHeight()).toBe(0);
		root.dispose();
	});
});
