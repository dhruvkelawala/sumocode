import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_WIDTH } from "../../sidebar.js";
import { PORTRAIT_SIDEBAR_GUTTER_WIDTH, SIDEBAR_GUTTER_WIDTH } from "../../sidebar-placement.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { ChatViewportController, installChatViewportBridge, textFromAgentMessage, type ChatViewportHost, type ChatViewportRuntime } from "./chat-viewport-controller.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function rows(count: number): { render(width: number): string[] } {
	return { render: (_width: number) => Array.from({ length: count }, () => "chrome") };
}

async function makeController(options: { terminalRows?: number; terminalColumns?: number } = {}): Promise<{
	root: SumoNode;
	chat: ChatPager;
	host: ChatViewportHost;
	runtime: ChatViewportRuntime & {
		renderCalls: { width: number; height: number }[];
		writeCalls: { top: number; left: number; width: number; height: number }[];
		requestRender: ReturnType<typeof vi.fn>;
		setEmptyChatQuoteState: ReturnType<typeof vi.fn>;
		noteUserMessage: ReturnType<typeof vi.fn>;
	};
	controller: ChatViewportController;
}> {
	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	const chat = ChatPager.create(yoga, root);
	const renderCalls: { width: number; height: number }[] = [];
	const writeCalls: { top: number; left: number; width: number; height: number }[] = [];
	const runtime = {
		renderCalls,
		writeCalls,
		requestRender: vi.fn(),
		setEmptyChatQuoteState: vi.fn(),
		noteUserMessage: vi.fn(),
		renderChatLines(width: number, height: number): string[] {
			renderCalls.push({ width, height });
			root.width = width;
			root.height = height;
			root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
			const frame = new CellBuffer(height, width);
			composite(root, frame);
			return bufferToAnsiLines(frame);
		},
		writeChatViewport(top: number, left: number, width: number, height: number): boolean {
			writeCalls.push({ top, left, width, height });
			return true;
		},
	};
	const host: ChatViewportHost = {
		ui: { terminal: { rows: options.terminalRows ?? 12, columns: options.terminalColumns ?? 80 } },
		headerContainer: rows(1),
		pendingMessagesContainer: rows(0),
		statusContainer: rows(0),
		widgetContainerAbove: rows(0),
		editorContainer: rows(2),
		widgetContainerBelow: rows(0),
		footer: rows(1),
	};
	const controller = new ChatViewportController(runtime, chat, host);
	return { root, chat, host, runtime, controller };
}

describe("ChatViewportController", () => {
	it("extracts streamed assistant text from Pi message shapes", () => {
		expect(textFromAgentMessage({ role: "user", content: "hello" })).toBe("hello");
		expect(textFromAgentMessage({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }] })).toBe("visible");
		expect(textFromAgentMessage({ role: "toolResult", content: [{ type: "text", text: "tool output" }] }).replace(ANSI_PATTERN, "")).toBe("✓ [tool]  tool output  · ⌘O expand");
	});

	it("clamps retained chat lines to the terminal width before handing them to Pi", async () => {
		const { root, runtime, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		runtime.renderChatLines = (width: number, height: number): string[] => {
			runtime.renderCalls.push({ width, height });
			return ["x".repeat(100)];
		};

		const lines = controller.render(80);

		expect(visibleWidth(lines[0]!)).toBe(80);
		root.dispose();
	});

	it("owns chat viewport geometry, including sidebar and portrait gutters", async () => {
		const { root, chat, runtime, controller } = await makeController({ terminalRows: 16, terminalColumns: 130 });

		controller.render(130);
		expect(runtime.renderCalls.at(-1)).toEqual({ width: 130, height: 12 });

		chat.addMessage("user", "hello");
		controller.render(130);
		expect(runtime.renderCalls.at(-1)).toEqual({ width: 130 - SIDEBAR_WIDTH - SIDEBAR_GUTTER_WIDTH, height: 12 });
		root.dispose();

		const portrait = await makeController({ terminalRows: 100, terminalColumns: 60 });
		portrait.chat.addMessage("user", "hello");
		portrait.controller.render(60);
		expect(portrait.runtime.renderCalls.at(-1)).toMatchObject({ width: 59 });
		portrait.root.dispose();

		const portraitWide = await makeController({ terminalRows: 180, terminalColumns: 130 });
		portraitWide.chat.addMessage("user", "hello");
		portraitWide.controller.render(130);
		expect(portraitWide.runtime.renderCalls.at(-1)).toEqual({ width: 130 - SIDEBAR_WIDTH - PORTRAIT_SIDEBAR_GUTTER_WIDTH, height: 176 });
		portraitWide.root.dispose();
	});

	it("caches repeated same-geometry viewport renders until chat content changes", async () => {
		const { root, runtime, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });

		expect(controller.render(80)).toHaveLength(8);
		expect(controller.render(80)).toHaveLength(8);
		expect(runtime.renderCalls).toHaveLength(1);

		controller.handleAgentEvent({ type: "message_start", message: { role: "user", content: "hello" } });
		controller.render(80);
		controller.render(80);
		expect(runtime.renderCalls).toHaveLength(2);
		root.dispose();
	});

	it("translates wheel and jump-to-bottom input into local viewport repaint", async () => {
		const { root, chat, runtime, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		for (let index = 0; index < 50; index += 1) chat.addMessage("user", `message ${index}`);
		controller.render(80);
		const bottom = chat.scrollBox.scrollOffset;

		const wheelResult = controller.handleInput("\x1b[<64;10;5M");
		const afterWheel = chat.scrollBox.scrollOffset;
		const jumpResult = controller.handleInput("\x1b[b");

		expect(wheelResult).toEqual({ consume: true });
		expect(afterWheel).toBe(bottom - 2);
		expect(jumpResult).toEqual({ consume: true });
		expect(chat.scrollBox.scrollOffset).toBe(bottom);
		expect(runtime.writeCalls).toContainEqual({ top: 1, left: 0, width: 80, height: 8 });
		root.dispose();
	});

	it("coalesces batched wheel mouse bytes into one viewport repaint", async () => {
		const { root, chat, runtime, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		for (let index = 0; index < 50; index += 1) chat.addMessage("user", `message ${index}`);
		controller.render(80);
		const bottom = chat.scrollBox.scrollOffset;
		runtime.writeCalls.length = 0;

		const result = controller.handleInput("\x1b[<64;10;5M\x1b[<64;10;5M");

		expect(result).toEqual({ consume: true });
		expect(chat.scrollBox.scrollOffset).toBe(bottom - 4);
		expect(runtime.writeCalls).toEqual([{ top: 1, left: 0, width: 80, height: 8 }]);
		root.dispose();
	});

	it("owns Pi message ingestion and empty-session state", async () => {
		const { root, chat, runtime, controller } = await makeController();

		controller.renderSessionContext({ messages: [] });
		expect(runtime.setEmptyChatQuoteState).toHaveBeenLastCalledWith({ active: true, userMessageCount: 0 });

		controller.handleAgentEvent({ type: "message_start", message: { role: "user", content: "hello" } });
		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: "hello back" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: "hello back" }, assistantMessageEvent: { type: "text_delta", delta: " back" } });
		controller.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: "hello back" } });

		expect(runtime.noteUserMessage).toHaveBeenCalledTimes(1);
		expect(chat.getRenderedMessages().map((message) => message.text)).toEqual(["hello", "hello back"]);
		root.dispose();
	});

	it("folds live tool results into the active SUMO message", async () => {
		const { root, chat, runtime, controller } = await makeController();

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: "Reading." }, assistantMessageEvent: { type: "text_delta", delta: "Reading." } });
		controller.handleAgentEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading." },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth/session.ts" } },
				],
			},
		});
		controller.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth/session.ts" } }] } });
		controller.handleAgentEvent({ type: "message_start", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file contents" }] } });

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("sumo");
		expect(messages[0]?.blocks).toEqual([
			{ type: "markdown", text: "Reading." },
			{ type: "tool", tool: { id: "tc1", name: "read", status: "success", input: { path: "src/auth/session.ts" }, output: "file contents", details: undefined, error: undefined, expanded: true } },
		]);
		expect(runtime.noteUserMessage).not.toHaveBeenCalled();
		root.dispose();
	});

	it("keeps assistant-only tool blocks under SUMO instead of TOOL", async () => {
		const { root, chat, controller } = await makeController();

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pnpm test" } }] } });

		const message = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(message?.role).toBe("sumo");
		expect(message?.blocks?.[0]).toMatchObject({ type: "tool", tool: { id: "tc1", name: "bash", status: "pending" } });
		root.dispose();
	});

	it("coalesces bridge streaming render requests", async () => {
		vi.useFakeTimers();
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		const requestRender = vi.fn();
		const host = {
			ui: { terminal: { rows: 24, columns: 120 }, requestRender },
			chatContainer: { render: vi.fn(() => []), clear: vi.fn(), invalidate: vi.fn() },
		};
		let controls: { scheduleRender(): void; setStreamingMode(enabled: boolean): void } | undefined;
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn((next) => { controls = next; }),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
		};

		const cleanup = installChatViewportBridge(host, runtime);
		controls?.setStreamingMode(true);
		controls?.scheduleRender();
		controls?.scheduleRender();
		controls?.scheduleRender();

		expect(requestRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(100);
		expect(requestRender).toHaveBeenCalledTimes(2);
		controls?.setStreamingMode(false);
		expect(requestRender).toHaveBeenCalledTimes(3);

		cleanup?.();
		root.dispose();
		vi.useRealTimers();
	});

	it("mirrors Pi tool expansion state into retained chat tool blocks", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		chat.addViewModel({
			id: "s1",
			role: "sumo",
			displayName: "SUMO",
			blocks: [{ type: "tool", tool: { name: "read", status: "success", input: { path: "src/auth/session.ts" } } }],
		});
		const originalSetToolsExpanded = vi.fn();
		const host = {
			ui: { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() },
			chatContainer: { render: vi.fn(() => []), clear: vi.fn(), invalidate: vi.fn() },
			setToolsExpanded: originalSetToolsExpanded,
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
		};

		const cleanup = installChatViewportBridge(host, runtime);
		host.setToolsExpanded(true);

		expect(originalSetToolsExpanded).toHaveBeenCalledWith(true);
		expect(chat.getRenderedMessages()[0]?.toSnapshot().blocks?.[0]).toMatchObject({ type: "tool", tool: { expanded: true } });
		cleanup?.();
		root.dispose();
	});

	it("suppresses Pi status loader row in portrait while preserving landscape", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		const originalStatusRender = vi.fn((_width: number) => ["Working..."]);
		const statusContainer = { render: originalStatusRender };
		const host = {
			ui: { terminal: { rows: 100, columns: 60 }, requestRender: vi.fn() },
			chatContainer: { render: vi.fn(() => []), clear: vi.fn(), invalidate: vi.fn() },
			statusContainer,
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
		};

		const cleanup = installChatViewportBridge(host, runtime);
		expect(statusContainer.render(60)).toEqual([]);
		expect(originalStatusRender).not.toHaveBeenCalled();

		host.ui.terminal.columns = 160;
		expect(statusContainer.render(160)).toEqual(["Working..."]);
		expect(originalStatusRender).toHaveBeenCalledWith(160);

		cleanup?.();
		expect(statusContainer.render(60)).toEqual(["Working..."]);
		root.dispose();
	});
});
