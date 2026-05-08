import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SumoNode } from "../layout/node.js";
import type { YogaNode } from "../layout/yoga.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
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

class TextRowNode extends SumoNode {
	public constructor(yogaNode: YogaNode, parent: SumoNode, private readonly text: string) {
		super(yogaNode, parent);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		buffer.paintRow(rect.top, this.text, rect.left, rect.width);
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

	it("selects text through Pilot mouse events, highlights it, and emits OSC 52 on mouse-up", async () => {
		const backend = await createBackend({ cols: 12, rows: 2 });
		const node = new TextRowNode(backend.yoga.Node.create(), backend.root, "hello world");
		node.width = "100%";
		node.height = 1;
		backend.render();

		expect(backend.pilot.mouse({ type: "down", button: 0, row: 0, col: 0 })).toBe(true);
		expect(backend.pilot.mouse({ type: "drag", button: 0, row: 0, col: 4 })).toBe(true);
		let frame = backend.pilot.mouse({ type: "up", button: 0, row: 0, col: 4 });

		expect(frame).toBe(true);
		expect(backend.clipboardWrites.at(-1)).toEqual({
			text: "hello",
			sequence: "\x1b]52;c;aGVsbG8=\x1b\\",
		});
		expect(backend.current?.getCell(0, 0).attrs.inverse).toBe(true);
		expect(backend.current?.getCell(0, 4).attrs.inverse).toBe(true);
		expect(backend.current?.getCell(0, 5).attrs.inverse).toBe(false);

		backend.clipboardWrites.length = 0;
		expect(backend.pilot.key({ key: "c", meta: true })).toBe(true);
		expect(backend.clipboardWrites.at(-1)?.text).toBe("hello");

		expect(backend.pilot.key("Escape")).toBe(true);
		expect(backend.current?.getCell(0, 0).attrs.inverse).toBe(false);
	});

	it("clears selection on outside click and keeps wide glyphs intact", async () => {
		const backend = await createBackend({ cols: 8, rows: 2 });
		const node = new TextRowNode(backend.yoga.Node.create(), backend.root, "a界b");
		node.width = "100%";
		node.height = 1;
		backend.render();

		backend.pilot.mouse({ type: "down", button: 0, row: 0, col: 2 });
		backend.pilot.mouse({ type: "drag", button: 0, row: 0, col: 3 });
		backend.pilot.mouse({ type: "up", button: 0, row: 0, col: 3 });

		expect(backend.clipboardWrites.at(-1)?.text).toBe("界b");
		expect(backend.current?.getCell(0, 1).attrs.inverse).toBe(true);
		expect(backend.current?.getCell(0, 2).attrs.inverse).toBe(true);

		backend.clipboardWrites.length = 0;
		backend.pilot.mouse({ type: "down", button: 0, row: 1, col: 0 });
		backend.pilot.mouse({ type: "up", button: 0, row: 1, col: 0 });

		expect(backend.clipboardWrites).toEqual([]);
		expect(backend.current?.getCell(0, 1).attrs.inverse).toBe(false);
		expect(backend.current?.getCell(0, 2).attrs.inverse).toBe(false);
	});
});
