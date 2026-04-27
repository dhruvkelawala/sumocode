import { describe, expect, it } from "vitest";
import { SumoNode } from "./node.js";
import { FLEX_DIRECTION_COLUMN, DIRECTION_LTR, freeRecursive, loadYoga, type YogaNode } from "./yoga.js";

interface MockYogaNode {
	children: MockYogaNode[];
	freed: boolean;
	getChildCount(): number;
	getChild(index: number): MockYogaNode;
	removeChild(child: MockYogaNode): void;
	free(): void;
}

function mockYogaNode(children: MockYogaNode[] = []): MockYogaNode {
	return {
		children,
		freed: false,
		getChildCount() {
			return this.children.length;
		},
		getChild(index: number) {
			return this.children[index]!;
		},
		removeChild(child: MockYogaNode) {
			this.children = this.children.filter((candidate) => candidate !== child);
		},
		free() {
			this.freed = true;
		},
	};
}

describe("SumoNode", () => {
	it("sets Yoga props, adds children, calculates layout, and exposes computed boxes", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const header = new SumoNode(yoga.Node.create());
		const body = new SumoNode(yoga.Node.create());

		root.width = 80;
		root.height = 24;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		header.height = 3;
		body.flexGrow = 1;
		body.flexShrink = 1;
		root.addChild(header);
		root.addChild(body);

		root.yogaNode.calculateLayout(80, 24, DIRECTION_LTR);

		expect(header.getComputedTop()).toBe(0);
		expect(header.getComputedHeight()).toBe(3);
		expect(body.getComputedTop()).toBe(3);
		expect(body.getComputedHeight()).toBe(21);

		root.dispose();
	});

	it("freeRecursive walks children and frees Yoga FFI resources", () => {
		const grandchild = mockYogaNode();
		const child = mockYogaNode([grandchild]);
		const root = mockYogaNode([child]);

		freeRecursive(root as unknown as YogaNode);

		expect(root.freed).toBe(true);
		expect(child.freed).toBe(true);
		expect(grandchild.freed).toBe(true);
		expect(root.children).toEqual([]);
		expect(child.children).toEqual([]);
	});

	it("disposes wrapper trees idempotently", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const child = new SumoNode(yoga.Node.create(), root);

		expect(root.children).toHaveLength(1);
		root.dispose();
		root.dispose();
		expect(child.children).toHaveLength(0);
	});

	it("allocates and frees 1k Yoga nodes without leaking wrappers (EC-9.2)", async () => {
		const yoga = await loadYoga();
		for (let index = 0; index < 1_000; index += 1) {
			const root = new SumoNode(yoga.Node.create());
			const child = new SumoNode(yoga.Node.create(), root);
			root.width = 10;
			child.height = 1;
			root.yogaNode.calculateLayout(10, 1, DIRECTION_LTR);
			root.dispose();
			expect(root.children).toHaveLength(0);
		}
	});
});
