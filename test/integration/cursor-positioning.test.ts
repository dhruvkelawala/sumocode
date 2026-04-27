import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, type Component } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { SumoNode } from "../../src/sumo-tui/layout/node.js";
import { DIRECTION_LTR, loadYoga } from "../../src/sumo-tui/layout/yoga.js";
import { CellBuffer } from "../../src/sumo-tui/render/buffer.js";
import { composite } from "../../src/sumo-tui/render/compositor.js";
import { PiEditorLeaf } from "../../src/sumo-tui/widgets/pi-editor-leaf.js";

class TypingEditor implements Component {
	public text = "";
	public invalidate(): void {}
	public render(_width: number): string[] {
		return [`${this.text}${CURSOR_MARKER}`];
	}
}

function asEditor(component: Component): CustomEditor {
	return component as unknown as CustomEditor;
}

describe("sumo-tui cursor positioning integration", () => {
	it("keeps PiEditorLeaf hardware cursor exact across 50 typed frames", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const editor = new TypingEditor();
		const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(editor), root);
		root.width = 80;
		root.height = 4;
		root.paddingTop = 1;
		root.paddingLeft = 7;
		leaf.height = 1;

		for (let index = 0; index < 50; index += 1) {
			editor.text += "x";
			leaf.markDirty();
			root.yogaNode.calculateLayout(80, 4, DIRECTION_LTR);
			const buffer = new CellBuffer(4, 80);
			const result = composite(root, buffer);
			expect(result.hardwareCursor).toEqual({ row: 1, col: 7 + editor.text.length });
		}

		root.dispose();
	});

	it("validates Q1:A remap stability over 100 headless runs", async () => {
		const yoga = await loadYoga();
		let correctRuns = 0;
		for (let run = 0; run < 100; run += 1) {
			const root = new SumoNode(yoga.Node.create());
			const editor = new TypingEditor();
			const leaf = new PiEditorLeaf(yoga.Node.create(), asEditor(editor), root);
			root.width = 80;
			root.height = 3;
			root.paddingTop = 1;
			root.paddingLeft = 2;
			leaf.height = 1;
			let runCorrect = true;
			for (let index = 0; index < 50; index += 1) {
				editor.text += "a";
				leaf.markDirty();
				root.yogaNode.calculateLayout(80, 3, DIRECTION_LTR);
				const result = composite(root, new CellBuffer(3, 80));
				if (result.hardwareCursor?.row !== 1 || result.hardwareCursor.col !== 2 + editor.text.length) runCorrect = false;
			}
			if (runCorrect) correctRuns += 1;
			root.dispose();
		}

		expect(correctRuns).toBeGreaterThanOrEqual(96);
	});
});
