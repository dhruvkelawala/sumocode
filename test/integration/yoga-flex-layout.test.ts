import { Text } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { SumoNode } from "../../src/sumo-tui/layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type YogaNode } from "../../src/sumo-tui/layout/yoga.js";
import { CellBuffer, type Rect } from "../../src/sumo-tui/render/buffer.js";
import { bufferToAnsiLines } from "../../src/sumo-tui/render/ansi-writer.js";
import { createAttrs } from "../../src/sumo-tui/render/cell.js";
import { composite } from "../../src/sumo-tui/render/compositor.js";
import { PiComponentLeaf } from "../../src/sumo-tui/widgets/pi-component-leaf.js";
import { PI_BOOT_SEQUENCE, spawnPiPty } from "./spawn-pi-pty.js";

class BodyNode extends SumoNode {
	public constructor(yogaNode: YogaNode, parent?: SumoNode) {
		super(yogaNode, parent);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		buffer.paint(rect, { char: "B", attrs: createAttrs() });
		buffer.paintRow(rect.top, "BODY", rect.left, rect.width);
	}
}

describe("sumo-tui Yoga flex layout integration", () => {
	it("pins footer at bottom and lets body flex without manual padding", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const top = PiComponentLeaf.create(yoga, new Text("TopChrome", 0, 0), root);
		const body = new BodyNode(yoga.Node.create(), root);
		const footer = PiComponentLeaf.create(yoga, new Text("Footer", 0, 0), root);
		root.width = 80;
		root.height = 24;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		top.height = 1;
		body.flexGrow = 1;
		body.flexShrink = 1;
		footer.height = 1;

		root.yogaNode.calculateLayout(80, 24, DIRECTION_LTR);
		const buffer = new CellBuffer(24, 80);
		composite(root, buffer);
		const ansi = bufferToAnsiLines(buffer).join("\r\n");

		expect(buffer.toPlainRow(0).startsWith("TopChrome")).toBe(true);
		expect(buffer.toPlainRow(1).startsWith("BODY")).toBe(true);
		expect(buffer.toPlainRow(22).startsWith("BBBB")).toBe(true);
		expect(buffer.toPlainRow(23).startsWith("Footer")).toBe(true);
		expect(body.getComputedHeight()).toBe(22);
		expect(ansi).toContain("BODY");
		root.dispose();
	});

	it("boots Pi in altscreen so Phase 2 ANSI can be captured by the PTY harness", async () => {
		const pty = spawnPiPty({ cols: 80, rows: 24 });
		try {
			await pty.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
			expect(pty.getCurrentTerminalState().altscreenActive).toBe(true);
			expect(pty.getOutput()).toContain(PI_BOOT_SEQUENCE);
		} finally {
			pty.cleanup();
		}
	});
});
