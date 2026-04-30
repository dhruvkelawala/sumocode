import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { createSplashTree, defaultSplashSnapshot, getSplashContentHeight } from "./splash-tree.js";

describe("createSplashTree", () => {
	for (const height of [30, 60, 100]) {
		it(`bottom-aligns splash content at ${height} rows so it stays close to Pi's editor`, async () => {
			const yoga = await loadYoga();
			const root = new SumoNode(yoga.Node.create());
			root.flexDirection = FLEX_DIRECTION_COLUMN;
			root.width = 120;
			root.height = height;

			const snapshot = defaultSplashSnapshot(false);
			const tree = createSplashTree(yoga, root, () => snapshot);
			root.yogaNode.calculateLayout(120, height, DIRECTION_LTR);

			const contentHeight = getSplashContentHeight(snapshot, 120);
			const freeRows = Math.max(0, height - contentHeight);
			expect(tree.bottomSpacer.getComputedHeight()).toBe(0);
			expect(tree.topSpacer.getComputedHeight()).toBe(freeRows);
			expect(tree.content.getComputedTop()).toBe(freeRows);
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
