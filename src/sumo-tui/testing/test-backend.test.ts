import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";
import { SumoTuiTestBackend } from "./test-backend.js";

const backends: SumoTuiTestBackend[] = [];

afterEach(() => {
	for (const backend of backends.splice(0)) backend.dispose();
});

async function createBackend(options?: Parameters<typeof SumoTuiTestBackend.create>[0]): Promise<SumoTuiTestBackend> {
	const backend = await SumoTuiTestBackend.create(options);
	backends.push(backend);
	return backend;
}

class CursorEditor {
	public text = "";

	public render(width: number): string[] {
		const row = `> ${this.text}${CURSOR_MARKER}`;
		return [row.padEnd(Math.max(0, width), " ")];
	}
}

describe("SumoTuiTestBackend", () => {
	it("exposes current and previous buffers plus cursor state", async () => {
		const backend = await createBackend({ cols: 12, rows: 3 });
		const node = new SumoNode(backend.yoga.Node.create(), backend.root);
		node.width = "100%";
		node.height = 1;

		const first = backend.render();
		expect(first.current.getDimensions()).toEqual({ rows: 3, cols: 12 });
		expect(first.previous).toBeUndefined();
		expect(backend.current?.getDimensions()).toEqual({ rows: 3, cols: 12 });
		expect(backend.previous).toBeUndefined();

		const second = backend.pilot.resize(10, 4);
		expect(second.current.getDimensions()).toEqual({ rows: 4, cols: 10 });
		expect(second.previous?.getDimensions()).toEqual({ rows: 3, cols: 12 });
		expect(backend.previous?.getDimensions()).toEqual({ rows: 3, cols: 12 });
	});

	it("drives key, mouse, and resize events through the pilot API", async () => {
		const backend = await createBackend({ cols: 16, rows: 4 });
		let keyCount = 0;
		let scrollCount = 0;
		const target = new SumoNode(backend.yoga.Node.create(), backend.root, {
			onScroll: (_node, event) => {
				scrollCount += (event as { scrollDir?: string }).scrollDir === "down" ? 1 : 0;
				return true;
			},
		});
		target.width = "100%";
		target.height = "100%";
		backend.setFocus({
			handleKey: (event) => {
				if (event.key !== "x") return false;
				keyCount += 1;
				return true;
			},
		});
		backend.render();

		expect(backend.pilot.key("x")).toBe(true);
		expect(keyCount).toBe(1);
		expect(backend.pilot.mouse({ type: "scroll", scrollDir: "down", button: 65, row: 0, col: 0 })).toBe(true);
		expect(scrollCount).toBe(1);
		expect(backend.pilot.resize(20, 5).current.getDimensions()).toEqual({ rows: 5, cols: 20 });
	});

	it("covers cursor advance without a PTY by rendering PiEditorLeaf headlessly", async () => {
		const backend = await createBackend({ cols: 24, rows: 3 });
		const editor = new CursorEditor();
		const leaf = PiEditorLeaf.create(backend.yoga, editor as unknown as CustomEditor, backend.root);
		leaf.width = "100%";

		backend.setFocus({
			handleKey: (event) => {
				if (event.key.length !== 1) return false;
				editor.text += event.key;
				leaf.markDirty();
				return true;
			},
		});

		let frame = backend.render();
		expect(frame.cursor).toEqual({ row: 0, col: 2 });
		let previousColumn = frame.cursor?.col ?? -1;

		for (const char of "ZQXJW") {
			expect(backend.pilot.key(char)).toBe(true);
			frame = backend.pilot.render();
			expect(frame.cursor?.col).toBeGreaterThan(previousColumn);
			previousColumn = frame.cursor?.col ?? previousColumn;
		}

		expect(frame.current.toPlainRow(0).trimEnd()).toBe("> ZQXJW");
	});
});
