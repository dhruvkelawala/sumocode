import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { createSidebarTree, resolveSidebarLayoutMode } from "./sidebar-tree.js";

function plainRowHasPaint(buffer: CellBuffer, row: number): boolean {
	return buffer.toPlainRow(row).trim().length > 0;
}

describe("sidebar-tree", () => {
	it("docks at width >= 120 with a fixed 49-column sidebar", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 130;
		root.height = 20;
		const tree = createSidebarTree(yoga, root, { terminalWidth: 130, terminalHeight: 20, sessionHasMessages: true });
		root.yogaNode.calculateLayout(130, 20, DIRECTION_LTR);

		expect(tree.mode).toBe("dock");
		expect(tree.sidebar.getComputedWidth()).toBe(49);
		expect(tree.chat.getComputedWidth()).toBe(81);
		expect(tree.sidebar.getComputedLeft()).toBe(81);
		root.dispose();
	});

	it("overlays with a backdrop below 120 columns", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 80;
		root.height = 20;
		const tree = createSidebarTree(yoga, root, { terminalWidth: 80, terminalHeight: 20, sessionHasMessages: true });
		root.yogaNode.calculateLayout(80, 20, DIRECTION_LTR);
		const frame = new CellBuffer(20, 80);
		composite(root, frame);

		expect(tree.mode).toBe("overlay");
		expect(tree.chat.getComputedWidth()).toBe(80);
		expect(tree.sidebar.getComputedWidth()).toBe(49);
		expect(tree.sidebar.getComputedLeft()).toBe(31);
		expect(plainRowHasPaint(frame, 0)).toBe(false);
		expect(frame.getCell(0, 0).bg).toBe("#120D0A");
		root.dispose();
	});

	it("hides while the splash has no messages", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.width = 130;
		root.height = 20;
		const tree = createSidebarTree(yoga, root, { terminalWidth: 130, terminalHeight: 20, sessionHasMessages: false });
		root.yogaNode.calculateLayout(130, 20, DIRECTION_LTR);

		expect(resolveSidebarLayoutMode({ terminalWidth: 130, terminalHeight: 20, sessionHasMessages: false })).toBe("hidden");
		expect(tree.mode).toBe("hidden");
		expect(tree.sidebar.getComputedWidth()).toBe(0);
		root.dispose();
	});

	it("renders REGISTRY chrome with version, session markers, and active sub-tabs", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = 140;
		root.height = 24;
		const tree = createSidebarTree(yoga, root, {
			terminalWidth: 140,
			terminalHeight: 24,
			sessionHasMessages: true,
			activeSubTab: "MEMORY",
			sessions: [
				{ name: "sumocode", branch: "main", active: true },
				{ name: "sumocode", branch: "other-branch", active: false },
			],
		});
		root.yogaNode.calculateLayout(140, 24, DIRECTION_LTR);
		const frame = new CellBuffer(24, 140);
		composite(root, frame);
		const sidebarLeft = tree.sidebar.getComputedLeft();
		const sidebarText = Array.from({ length: 12 }, (_, row) => frame.toPlainRow(row).slice(sidebarLeft)).join("\n");

		expect(sidebarText).toContain("REGISTRY");
		expect(sidebarText).toContain("v 1.0.0");
		expect(sidebarText).toContain("◆ sumocode (main)");
		expect(sidebarText).toContain("▢ sumocode (other-branch)");
		expect(sidebarText).toContain("▢ CONTEXT");
		expect(sidebarText).toContain("◆ MEMORY");
		root.dispose();
	});
});
