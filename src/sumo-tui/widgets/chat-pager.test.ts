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
		expect(chat.getArchivedMessageCount()).toBe(4800);
		expect(chat.getRenderedMessages()).toHaveLength(200);
		expect(chat.scrollBox.children).toHaveLength(201);
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 4800 earlier messages ──" });
		root.dispose();
	});

	it("bulk hydrates resumed transcripts with one render and no archived Yoga nodes", async () => {
		const controls: ChatPagerRenderControls = { scheduleRender: vi.fn(), setStreamingMode: vi.fn() };
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 50, renderControls: controls });
		const messages = Array.from({ length: 5000 }, (_, index) => ({
			id: `message-${index}`,
			role: "sumo" as const,
			displayName: "SUMO",
			blocks: [{ type: "markdown" as const, text: `message ${index}` }],
		}));

		const stats = chat.replaceViewModels(messages);

		expect(stats).toEqual({ sourceMessages: 5000, acceptedMessages: 5000, renderedMessages: 50, archivedMessages: 4950 });
		expect(chat.archivedMessages).toHaveLength(0);
		expect(chat.getArchivedMessageCount()).toBe(4950);
		expect(chat.getRenderedMessages()).toHaveLength(50);
		expect(chat.getRenderedMessages()[0]?.text).toBe("message 4950");
		expect(chat.getRenderedMessages().at(-1)?.text).toBe("message 4999");
		expect(chat.scrollBox.children).toHaveLength(51);
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 4950 earlier messages ──" });
		expect(controls.scheduleRender).toHaveBeenCalledTimes(1);
		root.dispose();
	});

	it("can bulk replace resumed transcripts repeatedly after detaching old Yoga nodes", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 3 });
		const messages = (prefix: string) => Array.from({ length: 6 }, (_, index) => ({
			id: `${prefix}-${index}`,
			role: "sumo" as const,
			displayName: "SUMO",
			blocks: [{ type: "markdown" as const, text: `${prefix} message ${index}` }],
		}));

		chat.replaceViewModels(messages("first"));
		chat.replaceViewModels(messages("second"));

		expect(chat.getArchivedMessageCount()).toBe(3);
		expect(chat.getRenderedMessages().map((message) => message.text)).toEqual(["second message 3", "second message 4", "second message 5"]);
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 3 earlier messages ──" });
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

	it("renders structured tool blocks compact by default and expands them on demand", async () => {
		const { root, chat, buffer } = await makeChat(90, 8);
		chat.addViewModel({
			id: "s1",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "tool", tool: { name: "read", status: "success", input: { path: "src/auth/session.ts" } } }],
		});
		let frame = buffer();
		expect(frame.toPlainRow(1)).toContain("✓ [read]  src/auth/session.ts  · ⌘O expand");
		expect(frame.toPlainRow(2)).toMatch(/^╰─+╯/);

		chat.setToolExpansion(true);
		frame = buffer();
		expect(frame.toPlainRow(1)).toContain("╭─ [read]  src/auth/session.ts");
		expect(frame.toPlainRow(2)).toContain("preview collapsed");
		root.dispose();
	});

	it("accepts deterministic timestamps for fixture-backed visual states", async () => {
		const { root, chat } = await makeChat();
		const timestamp = new Date("2026-04-30T11:42:00Z");

		chat.addMessage("sumo", "done", timestamp);

		expect(chat.getRenderedMessages()[0]?.timestamp).toEqual(timestamp);
		root.dispose();
	});

	it("passes the configured primary agent name into assistant chat headers", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { primaryAgentName: "Zeus" });
		root.width = 24;
		root.height = 5;
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		chat.addMessage("sumo", "done", new Date("2026-04-30T11:42:00.000"));

		root.yogaNode.calculateLayout(24, 5, DIRECTION_LTR);
		const frame = new CellBuffer(5, 24);
		composite(root, frame);

		expect(frame.toPlainRow(0)).toMatch(/^╭ ZEUS ─+ 11:42 ─╮$/);
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
		expect(frame.toPlainRow(4)).toContain("↓ 1 new message — Press ⇧↓ to jump");
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
