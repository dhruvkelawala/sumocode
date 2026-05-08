import { Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { PiComponentLeaf } from "./pi-component-leaf.js";

class RowsComponent implements Component {
	public constructor(private readonly rows: string[]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return this.rows;
	}
}

describe("PiComponentLeaf", () => {
	it("wraps pi-tui Spacer and measures blank rows", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = PiComponentLeaf.create(yoga, new Spacer(3), root);
		root.width = 5;
		root.height = 3;
		root.yogaNode.calculateLayout(5, 3, DIRECTION_LTR);

		expect(leaf.getComputedHeight()).toBe(3);
		const buffer = new CellBuffer(3, 5);
		composite(root, buffer);
		expect(buffer.toPlainRow(0)).toBe("     ");
		expect(buffer.toPlainRow(2)).toBe("     ");
		root.dispose();
	});

	it("wraps pi-tui Text at a Yoga-computed origin", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = PiComponentLeaf.create(yoga, new Text("hello", 0, 0), root);
		root.width = 10;
		root.height = 3;
		root.paddingTop = 1;
		root.paddingLeft = 2;
		root.yogaNode.calculateLayout(10, 3, DIRECTION_LTR);

		const buffer = new CellBuffer(3, 10);
		composite(root, buffer);
		expect(buffer.toPlainRow(1)).toBe("  hello   ");
		expect(leaf.getComputedLeft()).toBe(2);
		root.dispose();
	});

	it("returns expected measured height for varying render output (EC-1.2, EC-15.1)", async () => {
		const yoga = await loadYoga();
		for (const rowCount of [1, 3, 6]) {
			const root = new SumoNode(yoga.Node.create());
			const leaf = PiComponentLeaf.create(yoga, new RowsComponent(Array.from({ length: rowCount }, (_, index) => `row${index}`)), root);
			root.width = 8;
			root.yogaNode.calculateLayout(8, undefined, DIRECTION_LTR);
			expect(leaf.getComputedHeight()).toBe(rowCount);
			root.dispose();
		}
	});

	it("clips render rows to the Yoga rect height (EC-15.2)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const leaf = PiComponentLeaf.create(yoga, new RowsComponent(["one", "two", "tre"]), root);
		root.width = 3;
		root.height = 1;
		leaf.height = 1;
		root.yogaNode.calculateLayout(3, 1, DIRECTION_LTR);

		const buffer = new CellBuffer(3, 3);
		composite(root, buffer);
		expect(buffer.toPlainRow(0)).toBe("one");
		expect(buffer.toPlainRow(1)).toBe("   ");
		root.dispose();
	});

	it("does not crash when Yoga measures with width=0 (EC-15.3)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		PiComponentLeaf.create(yoga, new Text("hello", 0, 0), root);
		root.width = 0;
		expect(() => root.yogaNode.calculateLayout(0, undefined, DIRECTION_LTR)).not.toThrow();
		root.dispose();
	});
});
