import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { SelectionController } from "../input/selection.js";
import { PiEditorLeaf } from "./pi-editor-leaf.js";
import { ChatPager, type ChatPagerRenderControls } from "./chat-pager.js";
import type { ChatMessageViewModel } from "../transcript/view-model.js";

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

function toolViewModel(id: string, path: string, expanded = true, timestamp = new Date("2026-04-30T11:42:00.000Z")): ChatMessageViewModel {
	return {
		id,
		role: "sumo",
		displayName: "SUMO",
		timestamp,
		blocks: [{ type: "tool", tool: { name: "read", status: "success", input: { path }, expanded } }],
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

	it("preserves chat body selection metadata through the scroll viewport", async () => {
		const { root, chat, buffer } = await makeChat(32, 5);
		chat.addMessage("user", "select me");
		const frame = buffer();
		const selection = new SelectionController();

		expect(frame.getSelectionMeta(1, 2)).toEqual({ selectable: true });
		expect(frame.getSelectionMeta(1, 0)).toBeUndefined();
		expect(selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 0, modifiers: { shift: false, alt: false, ctrl: false } }, frame)).toBe(false);
		selection.handleMouseEvent({ type: "down", button: 0, row: 1, col: 2, modifiers: { shift: false, alt: false, ctrl: false } }, frame);
		selection.handleMouseEvent({ type: "drag", button: 0, row: 1, col: 31, modifiers: { shift: false, alt: false, ctrl: false } }, frame);

		expect(selection.extractSelectedText(frame)).toBe("select me");
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

		expect(chat.archivedMessages).toHaveLength(0);
		expect(chat.getArchivedMessageCount()).toBe(4800);
		expect(chat.getRenderedMessages()).toHaveLength(200);
		expect(chat.getLastMessage()?.text).toBe("message 4999");
		expect(chat.scrollBox.children).toHaveLength(201);
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 4800 earlier messages ──" });
		root.dispose();
	});

	it("bounds incremental archives and disposes each evicted message once", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root, { maxRenderedMessages: 10 });
		const disposeFns: Array<() => void> = [];

		for (let index = 0; index < 60; index += 1) {
			const rendered = chat.addViewModel({
				id: `message-${index}`,
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "markdown", text: `message ${index}` }],
			});
			const dispose = rendered.dispose.bind(rendered);
			rendered.dispose = vi.fn(() => dispose());
			disposeFns.push(rendered.dispose);
		}

		expect(chat.archivedMessages).toHaveLength(0);
		expect(chat.getArchivedMessageCount()).toBe(50);
		expect(chat.getRenderedMessages()).toHaveLength(10);
		expect(chat.getRenderedMessages().length).toBeLessThanOrEqual(10);
		expect(chat.getRenderedMessages()[0]?.text).toBe("message 50");
		expect(chat.getRenderedMessages().at(-1)?.text).toBe("message 59");
		expect(chat.scrollBox.children[0]).toMatchObject({ text: "── 50 earlier messages ──" });
		for (let index = 0; index < 50; index += 1) expect(disposeFns[index]).toHaveBeenCalledTimes(1);
		for (let index = 50; index < 60; index += 1) expect(disposeFns[index]).not.toHaveBeenCalled();
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

	it("renders structured tool blocks expanded by default and can collapse them on demand", async () => {
		const { root, chat, buffer } = await makeChat(90, 8);
		chat.addViewModel({
			id: "s1",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "tool", tool: { name: "read", status: "success", input: { path: "src/auth/session.ts" } } }],
		});
		let frame = buffer();
		expect(frame.toPlainRow(1)).toContain("╭─ [read]");
		expect(frame.toPlainRow(2)).toContain("preview collapsed");

		chat.setToolExpansion(false);
		frame = buffer();
		expect(frame.toPlainRow(1)).toContain("✓ [read]  src/auth/session.ts  · ctrl+o expand");
		expect(frame.toPlainRow(2)).toMatch(/^╰─+╯/);
		root.dispose();
	});

	it("keeps the global collapsed tool policy when replacing the last view model", async () => {
		const { root, chat, buffer } = await makeChat(90, 8);
		chat.addViewModel(toolViewModel("tool-1", "src/original.ts", true));
		chat.setToolExpansion(false);

		// This fails against the pre-change code: replaceLastWithViewModel copied
		// the incoming expanded=true block and forgot the pager-wide override.
		chat.replaceLastWithViewModel(toolViewModel("tool-1", "src/replaced.ts", true));
		const frame = buffer();

		expect(chat.getLastMessage()?.toSnapshot().blocks).toMatchObject([{ type: "tool", tool: { expanded: false } }]);
		expect(frame.toPlainRow(1)).toContain("src/replaced.ts");
		expect(frame.toPlainRow(1)).toContain("ctrl+o expand");
		expect(frame.toPlainRow(2)).toMatch(/^╰─+╯/);
		root.dispose();
	});

	it("applies the collapsed tool policy to subsequently added view models", async () => {
		const { root, chat, buffer } = await makeChat(90, 8);
		chat.setToolExpansion(false);

		chat.addViewModel(toolViewModel("tool-after-toggle", "src/appended.ts", true));
		const frame = buffer();

		expect(chat.getLastMessage()?.toSnapshot().blocks).toMatchObject([{ type: "tool", tool: { expanded: false } }]);
		expect(frame.toPlainRow(1)).toContain("src/appended.ts");
		expect(frame.toPlainRow(1)).toContain("ctrl+o expand");
		expect(frame.toPlainRow(2)).toMatch(/^╰─+╯/);
		root.dispose();
	});

	it("applies the collapsed tool policy during replaceViewModels hydration", async () => {
		const { root, chat, buffer } = await makeChat(90, 8);
		chat.setToolExpansion(false);

		chat.replaceViewModels([
			toolViewModel("hydrated-1", "src/hydrated-one.ts", true),
			toolViewModel("hydrated-2", "src/hydrated-two.ts", true),
		]);
		const frame = buffer();

		expect(chat.getRenderedMessages().map((message) => message.toSnapshot().blocks)).toMatchObject([
			[{ type: "tool", tool: { expanded: false } }],
			[{ type: "tool", tool: { expanded: false } }],
		]);
		expect(frame.toPlainRow(1)).toContain("src/hydrated-one.ts");
		expect(frame.toPlainRow(1)).toContain("ctrl+o expand");
		expect(frame.toPlainRow(5)).toContain("src/hydrated-two.ts");
		expect(frame.toPlainRow(5)).toContain("ctrl+o expand");
		root.dispose();
	});

	it("replaceLastWithViewModel adopts the view-model timestamp in the existing rendered message", async () => {
		const { root, chat, buffer } = await makeChat(44, 6);
		const originalTimestamp = new Date("2026-04-30T11:42:00.000");
		const replacementTimestamp = new Date("2026-04-30T12:07:00.000");
		chat.addMessage("sumo", "draft", originalTimestamp);
		const last = chat.getLastMessage();

		chat.replaceLastWithViewModel({
			id: "reply-1",
			role: "sumo",
			displayName: "SUMO",
			timestamp: replacementTimestamp,
			blocks: [{ type: "markdown", text: "final answer" }],
		});
		const frame = buffer();

		expect(chat.getLastMessage()).toBe(last);
		expect(last?.timestamp).toEqual(replacementTimestamp);
		expect(frame.toPlainRow(0)).toContain("12:07");
		expect(frame.toPlainRow(0)).not.toContain("11:42");
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

	it("replaceLastWithViewModel folds a role change into the message and its rendered frame", async () => {
		const { root, chat } = await makeChat(40, 6);
		chat.addMessage("system", "running tool...");
		const last = chat.getLastMessage();
		expect(last?.role).toBe("system");

		// A viewModel whose blocks are tool-only folds role "system" -> "tool"
		// (see chatRoleFromViewModel). This exercises the `last.setRole(...)`
		// call in replaceLastWithViewModel, which must invalidate the ChatMessage
		// render memo — otherwise the frame keeps showing the stale "SYSTEM" label.
		chat.replaceLastWithViewModel({
			id: "msg-1",
			role: "system",
			displayName: "system",
			blocks: [{ type: "tool", tool: { name: "read", status: "success", input: { path: "a.ts" }, expanded: false } }],
		});

		expect(chat.getLastMessage()).toBe(last);
		expect(last?.role).toBe("tool");

		const rows = (last as unknown as { renderRows(width: number): string[] }).renderRows(40);
		expect(rows[0]).toMatch(/TOOL/);
		expect(rows[0]).not.toMatch(/SYSTEM/);
		root.dispose();
	});
});
