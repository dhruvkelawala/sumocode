import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { createSplashTree, defaultSplashSnapshot, getSplashContentHeight } from "./splash-tree.js";

describe("createSplashTree", () => {
	for (const height of [30, 60, 100]) {
		it(`centers splash content at ${height} rows`, async () => {
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
			const expectedContentTop = Math.floor(freeRows / 2);
			const expectedBottom = Math.floor(freeRows / 2);
			// Yoga may assign the odd rounding row to the top spacer's computed
			// height, but the content's actual top remains the visual center point.
			expect(tree.bottomSpacer.getComputedHeight()).toBe(expectedBottom);
			expect(tree.content.getComputedTop()).toBe(expectedContentTop);
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
