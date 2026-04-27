import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, type Component } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { PiEditorLeaf } from "./pi-editor-leaf.js";
import { ChatPager, type ChatPagerRenderControls } from "./chat-pager.js";

class FakeEditor implements Component {
	public constructor(private readonly rows: string[]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return this.rows;
	}
}

function asEditor(component: Component): CustomEditor {
	return component as unknown as CustomEditor;
}

async function makeChat(width = 32, height = 6): Promise<{ root: SumoNode; chat: ChatPager; buffer: () => CellBuffer }> {
	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	const chat = ChatPager.create(yoga, root);
	root.width = width;
	root.height = height;
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	return {
		root,
		chat,
		buffer: () => {
			root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
			const frame = new CellBuffer(height, width);
			composite(root, frame);
			return frame;
		},
	};
}

describe("ChatPager", () => {
	it("renders an empty flex slot without chat rows for splash transition (EC-17.4)", async () => {
		const { root, chat, buffer } = await makeChat(20, 3);
		const frame = buffer();

		expect(chat.getRenderedMessages()).toHaveLength(0);
		expect(frame.toPlainRow(0)).toBe(" ".repeat(20));
		root.dispose();
	});

	it("addMessage adds a child and grows scrollHeight", async () => {
		const { root, chat, buffer } = await makeChat();
		chat.addMessage("user", "hello");
		buffer();

		expect(chat.getRenderedMessages()).toHaveLength(1);
		expect(chat.scrollBox.scrollHeight).toBeGreaterThan(0);
		expect(chat.scrollBox.children).toHaveLength(1);
		root.dispose();
	});

	it("appendToLast updates the last child only", async () => {
		const { root, chat } = await makeChat();
		const first = chat.addMessage("user", "first");
		const last = chat.addMessage("sumo", "hello");
		chat.appendToLast(" world");

		expect(first.text).toBe("first");
		expect(chat.getLastMessage()).toBe(last);
		expect(last.text).toBe("hello world");
		root.dispose();
	});

	it("virtualizes large histories to 200 rendered messages plus a placeholder (EC-9.1)", async () => {
		const { root, chat } = await makeChat();
		for (let index = 0; index < 5000; index += 1) chat.addMessage("sumo", `message ${index}`);

		expect(chat.archivedMessages).toHaveLength(4800);
		expect(chat.getRenderedMessages()).toHaveLength(200);
		expect(chat.scrollBox.children).toHaveLength(201);
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 4800 earlier messages ──" });
		root.dispose();
	});

	it("streaming while scrolled up preserves the visible position (EC-2.5)", async () => {
		const { root, chat, buffer } = await makeChat(36, 5);
		for (let index = 0; index < 12; index += 1) chat.addMessage("sumo", `message ${index}`);
		buffer();
		chat.scrollBox.scrollToBottom();
		chat.scrollBox.scrollBy(-3);
		const beforeOffset = chat.scrollBox.scrollOffset;
		const before = buffer().toPlainRow(0);

		chat.appendToLast("\nstreamed tool output\nmore streamed output");
		const after = buffer().toPlainRow(0);

		expect(chat.scrollBox.manualScroll).toBe(true);
		expect(chat.scrollBox.scrollOffset).toBe(beforeOffset);
		expect(after).toBe(before);
		root.dispose();
	});

	it("tool result during typing keeps the editor cursor leaf stable (EC-2.3)", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		const editor = new PiEditorLeaf(yoga.Node.create(), asEditor(new FakeEditor([`ask${CURSOR_MARKER}`])), root);
		root.width = 30;
		root.height = 8;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		editor.height = 1;
		for (let index = 0; index < 10; index += 1) chat.addMessage("sumo", `message ${index}`);

		root.yogaNode.calculateLayout(30, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 30));
		const before = editor.getHardwareCursor();
		chat.addMessage("tool", "tool result finished while typing");
		root.yogaNode.calculateLayout(30, 8, DIRECTION_LTR);
		composite(root, new CellBuffer(8, 30));

		expect(before).toEqual({ row: 7, col: 3 });
		expect(editor.getHardwareCursor()).toEqual(before);
		root.dispose();
	});

	it("scroll up plus a new message shows the unread jump banner", async () => {
		const { root, chat, buffer } = await makeChat(48, 5);
		for (let index = 0; index < 10; index += 1) chat.addMessage("sumo", `message ${index}`);
		buffer();
		chat.scrollBox.scrollToBottom();
		chat.handleKey({ key: "PageUp" });
		chat.addMessage("sumo", "new answer");
		const frame = buffer();

		expect(chat.getUnreadCount()).toBe(1);
		expect(frame.toPlainRow(4)).toContain("↓ 1 new message — Press End to jump");
		root.dispose();
	});

	it("schedules renders and enters streaming mode for appended chunks", async () => {
		const controls: ChatPagerRenderControls = { scheduleRender: vi.fn(), setStreamingMode: vi.fn() };
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { renderControls: controls });
		chat.addMessage("sumo", "");
		chat.appendToLast("chunk");

		expect(controls.scheduleRender).toHaveBeenCalledTimes(2);
		expect(controls.setStreamingMode).toHaveBeenCalledWith(true);
		root.dispose();
	});
});
