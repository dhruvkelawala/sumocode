import { visibleWidth } from "@earendil-works/pi-tui";
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
		expect(textFromAgentMessage({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }] })).toBe("hidden\nvisible");
		expect(textFromAgentMessage({ role: "toolResult", content: [{ type: "text", text: "tool output" }] }).replace(ANSI_PATTERN, "")).toBe("✓ [tool]  tool output  · ctrl+o expand");
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

	it("buffers SGR mouse sequences split before the ESC prefix completes", async () => {
		const { root, chat, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		for (let index = 0; index < 50; index += 1) chat.addMessage("user", `message ${index}`);
		controller.render(80);
		const bottom = chat.scrollBox.scrollOffset;

		expect(controller.handleInput("\x1b")).toEqual({ consume: true });
		expect(controller.handleInput("[<64;10;5M")).toEqual({ consume: true });

		expect(chat.scrollBox.scrollOffset).toBe(bottom - 2);
		root.dispose();
	});

	it("redispatches delayed bare Escape back to Pi input after the mouse ambiguity window", async () => {
		vi.useFakeTimers();
		const { root, host, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		const redispatchedResults: Array<{ consume?: boolean; data?: string } | void> = [];
		host.ui!.handleInput = (data: string): void => {
			redispatchedResults.push(controller.handleInput(data));
		};

		try {
			expect(controller.handleInput("\x1b")).toEqual({ consume: true });
			expect(redispatchedResults).toEqual([]);

			await vi.advanceTimersByTimeAsync(25);

			expect(redispatchedResults).toEqual([{ data: "\x1b" }]);
		} finally {
			root.dispose();
			vi.useRealTimers();
		}
	});

	it("buffers SGR mouse sequences split after the CSI prefix", async () => {
		const { root, chat, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });
		for (let index = 0; index < 50; index += 1) chat.addMessage("user", `message ${index}`);
		controller.render(80);
		const bottom = chat.scrollBox.scrollOffset;

		expect(controller.handleInput("\x1b[")).toEqual({ consume: true });
		expect(controller.handleInput("<64;10;5M")).toEqual({ consume: true });

		expect(chat.scrollBox.scrollOffset).toBe(bottom - 2);
		root.dispose();
	});

	it("normalizes raw multiline paste before forwarding data back to Pi", async () => {
		const { root, controller } = await makeController({ terminalRows: 12, terminalColumns: 80 });

		expect(controller.handleInput("line one\rline two")).toEqual({ data: "line one\nline two" });
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

	it("streams thinking deltas into the active SUMO message", async () => {
		const { root, chat, controller } = await makeController();

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		controller.handleAgentEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "checking files" },
			message: { role: "assistant", content: [{ type: "thinking", thinking: "checking files" }] },
		});

		const snapshot = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(snapshot?.blocks).toEqual([{ type: "thinking", text: "checking files" }]);
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
		expect(messages[0]?.blocks).toMatchObject([
			{ type: "markdown", text: "Reading." },
			{
				type: "activity",
				activity: {
					id: "tc1",
					kind: "tool",
					title: "read",
					status: "succeeded",
					invocation: { path: "src/auth/session.ts" },
					subject: "src/auth/session.ts",
					outputTail: "file contents",
					body: { kind: "source", text: "file contents", totalLines: 1 },
				},
			},
		]);
		expect(runtime.noteUserMessage).not.toHaveBeenCalled();
		root.dispose();
	});

	it("folds a running non-task tool, then finalizes it to one block", async () => {
		const { root, chat, controller } = await makeController();

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		controller.handleAgentEvent({
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "t1",
			args: { path: "a.ts" },
		});

		let activityBlocks = (chat.getRenderedMessages()[0]?.toSnapshot().blocks ?? []).filter((block) => block.type === "activity");
		expect(activityBlocks).toHaveLength(1);
		expect(activityBlocks?.[0]).toMatchObject({
			type: "activity",
			activity: { id: "t1", title: "read", status: "running", invocation: { path: "a.ts" } },
		});

		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "t1",
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "ok" }] },
		});

		activityBlocks = (chat.getRenderedMessages()[0]?.toSnapshot().blocks ?? []).filter((block) => block.type === "activity");
		expect(activityBlocks).toHaveLength(1);
		expect(activityBlocks?.[0]).toMatchObject({
			type: "activity",
			activity: {
				id: "t1",
				kind: "tool",
				title: "read",
				status: "succeeded",
				invocation: { path: "a.ts" },
				subject: "a.ts",
				outputTail: "ok",
				body: { kind: "source", text: "ok", totalLines: 1 },
			},
		});
		root.dispose();
	});

	it("target-updates the active assistant when a non-last Activity settles", async () => {
		const { root, chat, controller } = await makeController();
		const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } };
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-1", role: "assistant", content: [call] } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "assistant-1", role: "assistant", content: [call] } });
		controller.handleAgentEvent({ type: "compaction_end", result: { summary: "keep this summary", tokensBefore: 1000 } });

		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "t1",
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "alpha" }] },
			isError: false,
		});

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(2);
		expect(messages[0]?.blocks?.[0]).toMatchObject({ type: "activity", activity: { id: "t1", status: "succeeded", outputTail: "alpha" } });
		expect(messages[1]?.blocks?.[0]).toMatchObject({ type: "summary", content: "keep this summary" });
		root.dispose();
	});

	it("target-updates an earlier assistant Activity after a newer assistant starts", async () => {
		const { root, chat, controller } = await makeController();
		const oldCall = { type: "toolCall", id: "old-read", name: "read", arguments: { path: "old.ts" } };
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-old", role: "assistant", content: [oldCall] } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "assistant-old", role: "assistant", content: [oldCall] } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-new", role: "assistant", content: "newer answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "assistant-new", role: "assistant", content: "newer answer" } });

		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "old-read",
			args: { path: "old.ts" },
			result: { content: [{ type: "text", text: "old contents" }] },
			isError: false,
		});

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(2);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "old-read", status: "succeeded", outputTail: "old contents" }) }),
		]);
		expect(messages[1]?.blocks).toEqual([{ type: "markdown", text: "newer answer" }]);
		root.dispose();
	});

	it("keeps tool-call correlation across a mid-run user follow-up", async () => {
		const { root, chat, controller } = await makeController();
		const call = { type: "toolCall", id: "follow-up-read", name: "read", arguments: { path: "a.ts" } };
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-follow-up", role: "assistant", content: [call] } });
		controller.handleAgentEvent({ type: "message_start", message: { id: "user-follow-up", role: "user", content: "also inspect tests" } });

		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "follow-up-read",
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "alpha" }] },
			isError: false,
		});

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(2);
		expect(messages[0]?.blocks?.filter((block) => block.type === "activity")).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "follow-up-read", status: "succeeded", outputTail: "alpha" }) }),
		]);
		expect(messages[1]).toMatchObject({ role: "user", text: "also inspect tests" });
		root.dispose();
	});

	it("folds an image-bearing result once beside its Activity", async () => {
		const { root, chat, controller } = await makeController();
		const call = { type: "toolCall", id: "image-read", name: "read", arguments: { path: "shot.png" } };
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-image", role: "assistant", content: [call] } });
		const result = {
			role: "toolResult",
			toolCallId: "image-read",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", filename: "shot.png" },
			],
		};

		controller.handleAgentEvent({ type: "message_start", message: result });
		controller.handleAgentEvent({ type: "message_start", message: result });

		const blocks = chat.getRenderedMessages()[0]?.toSnapshot().blocks ?? [];
		expect(blocks.filter((block) => block.type === "activity")).toHaveLength(1);
		expect(blocks.filter((block) => block.type === "image")).toEqual([
			{ type: "image", data: "iVBORw0KGgo=", mime: "image/png", filename: "shot.png" },
		]);
		root.dispose();
	});

	it("appends a persistent compaction summary when compaction ends with a result", async () => {
		const { root, chat, runtime, controller } = await makeController();

		controller.handleAgentEvent({
			type: "compaction_end",
			result: {
				summary: "Kept the current implementation plan and verification status.",
				tokensBefore: 42000,
			},
		});

		const message = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(message).toMatchObject({
			role: "system",
			text: "[compaction] Compacted from 42,000 tokens",
			blocks: [{
				type: "summary",
				kind: "compaction",
				label: "[compaction] Compacted from 42,000 tokens",
				content: "Kept the current implementation plan and verification status.",
				expanded: false,
			}],
		});
		expect(runtime.requestRender).toHaveBeenCalledTimes(1);
		root.dispose();
	});

	it("folds live task results into the active Activity block", async () => {
		const { root, chat, controller } = await makeController();
		const taskCall = {
			type: "toolCall",
			id: "tc-task",
			name: "task",
			arguments: {
				type: "single",
				model: "openai-codex/gpt-5.5",
				thinking: "high",
				tasks: [{ prompt: "You are Zeus.\n\n## Verify issue 194 scroll metadata rendering\n\nReturn one line." }],
			},
		};

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [taskCall] } });
		controller.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: [taskCall] } });
		controller.handleAgentEvent({ type: "message_start", message: { role: "toolResult", toolCallId: "tc-task", toolName: "task", name: "task", content: [{ type: "text", text: "Task tool ran." }] } });

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("sumo");
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({
				type: "activity",
				activity: expect.objectContaining({
					id: "tc-task",
					kind: "task",
					title: "Verify issue 194 scroll metadata rendering",
					model: "openai-codex/gpt-5.5",
					thinking: "high",
					status: "succeeded",
					result: { summary: "Task tool ran." },
				}),
			}),
		]);
		root.dispose();
	});

	it("does not merge explicit unmatched task Activity ids", async () => {
		const { root, chat, controller } = await makeController();
		const firstCall = { type: "toolCall", id: "task-a", name: "task", arguments: { type: "single", tasks: [{ prompt: "## First task" }] } };
		const secondCall = { type: "toolCall", id: "task-b", name: "task", arguments: { type: "single", tasks: [{ prompt: "## Second task" }] } };

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [firstCall] } });
		controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "task-b",
			toolName: "task",
			args: secondCall.arguments,
			partialResult: {
				content: [{ type: "text", text: "second running" }],
				details: { mode: "single", results: [{ prompt: "## Second task", exitCode: -1, messages: [], usage: {} }] },
			},
		});

		const blocks = chat.getRenderedMessages()[0]?.toSnapshot().blocks;
		expect(blocks).toHaveLength(2);
		expect(blocks?.[0]).toMatchObject({ type: "activity", activity: { id: "task-a", title: "First task" } });
		expect(blocks?.[1]).toMatchObject({ type: "activity", activity: { id: "task-b", title: "Second task" } });
		root.dispose();
	});

	it("ignores task execution start events without partial result details", async () => {
		const { root, chat, controller } = await makeController();
		const taskCall = { type: "toolCall", id: "tc-task", name: "task", arguments: { type: "single", tasks: [{ prompt: "## Running task" }] } };

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [taskCall] } });
		controller.handleAgentEvent({ type: "tool_execution_start", toolCallId: "tc-task", toolName: "task", args: taskCall.arguments });

		const block = chat.getRenderedMessages()[0]?.toSnapshot().blocks?.[0];
		expect(block).toMatchObject({ type: "activity", activity: { title: "Running task", status: "running" } });
		root.dispose();
	});

	it("updates the active task scroll from tool execution partial details", async () => {
		const { root, chat, controller } = await makeController();
		const taskCall = {
			type: "toolCall",
			id: "tc-task",
			name: "task",
			arguments: { type: "single", tasks: [{ prompt: "## Audit auth\n\nFind risky files." }] },
		};

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [taskCall] } });
		controller.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: taskCall.arguments,
			partialResult: {
				content: [{ type: "text", text: "reading auth files" }],
				details: {
					mode: "single",
					results: [{
						prompt: "## Audit auth\n\nFind risky files.",
						exitCode: -1,
						messages: [],
						toolEvents: [{ id: "read-1", name: "read", args: { path: "src/auth.ts" }, status: "running" }],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: "openai-codex/gpt-5.5",
						thinking: "high",
					}],
				},
			},
		});

		const message = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(message?.blocks?.[0]).toMatchObject({
			type: "activity",
			activity: {
				title: "Audit auth",
				model: "openai-codex/gpt-5.5",
				thinking: "high",
				status: "running",
				activeTools: [{ id: "read-1", title: "read", status: "running", invocation: { path: "src/auth.ts" } }],
			},
		});
		root.dispose();
	});

	it("shows task body while a live scroll is still running", async () => {
		const { root, chat, controller } = await makeController();
		const taskCall = {
			type: "toolCall",
			id: "tc-task",
			name: "task",
			arguments: {
				prompt: "You are Zeus.\n\n## Verify issue 194 live scroll result folding\n\nRespond with exactly this sentence:\nTask output visible inside scribe.",
				thinking: "minimal",
			},
		};

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [taskCall] } });

		const message = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(message?.blocks?.[0]).toMatchObject({
			type: "activity",
			activity: {
				title: "Verify issue 194 live scroll result folding",
				thinking: "minimal",
				status: "running",
				invocation: {
					tasks: [{ prompt: "You are Zeus.\n\n## Verify issue 194 live scroll result folding\n\nRespond with exactly this sentence:\nTask output visible inside scribe." }],
				},
			},
		});
		root.dispose();
	});

	it("uses the shared matcher to adopt and settle canonical subagent identity", async () => {
		const { root, chat, controller } = await makeController();
		const running = {
			id: "subagent:sa-1",
			sourceId: "spawn-call-1",
			kind: "subagent",
			title: "review auth",
			status: "running",
			subject: "sa-1",
			invocation: { prompt: "Review auth" },
		};
		const settled = { ...running, status: "succeeded", result: { summary: "No findings" } };
		const spawnCall = { type: "toolCall", id: "spawn-call-1", name: "subagent_spawn", arguments: { prompt: "Review auth", name: "review auth" } };

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [spawnCall] } });
		controller.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: [spawnCall] } });
		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "spawn-call-1",
			toolName: "subagent_spawn",
			args: spawnCall.arguments,
			result: {
				content: [{ type: "text", text: "Started sa-1" }],
				details: { activity: running },
			},
			isError: false,
		});

		let activities = (chat.getRenderedMessages()[0]?.toSnapshot().blocks ?? []).filter((block) => block.type === "activity");
		expect(activities).toHaveLength(1);
		expect(activities[0]).toMatchObject({ activity: { id: "subagent:sa-1", sourceId: "spawn-call-1", kind: "subagent", status: "running" } });
		controller.handleAgentEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "subagent-result",
				display: true,
				content: "Subagent sa-1 finished.",
				details: { id: "sa-1", title: "review auth", status: "done", activity: settled },
			},
		});

		activities = (chat.getRenderedMessages()[0]?.toSnapshot().blocks ?? []).filter((block) => block.type === "activity");
		expect(activities).toHaveLength(1);
		expect(activities[0]).toMatchObject({ activity: { id: "subagent:sa-1", status: "succeeded", result: { summary: "No findings" } } });
		root.dispose();
	});

	it("folds passive completion into its earlier assistant after a newer assistant starts", async () => {
		const { root, chat, controller } = await makeController();
		const running = {
			id: "subagent:sa-earlier",
			sourceId: "spawn-earlier",
			kind: "subagent",
			title: "review earlier auth",
			status: "running",
			invocation: { prompt: "Review earlier auth" },
		};
		const spawnCall = { type: "toolCall", id: "spawn-earlier", name: "subagent_spawn", arguments: { prompt: "Review earlier auth", name: "review earlier auth" } };
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-earlier", role: "assistant", content: [spawnCall] } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "assistant-earlier", role: "assistant", content: [spawnCall] } });
		controller.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "spawn-earlier",
			toolName: "subagent_spawn",
			args: spawnCall.arguments,
			result: { content: [{ type: "text", text: "Started sa-earlier" }], details: { activity: running } },
			isError: false,
		});
		controller.handleAgentEvent({ type: "message_start", message: { id: "assistant-newer", role: "assistant", content: "newer answer" } });
		controller.handleAgentEvent({ type: "message_end", message: { id: "assistant-newer", role: "assistant", content: "newer answer" } });

		controller.handleAgentEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "subagent-result",
				display: true,
				content: "Earlier complete",
				details: { activity: { ...running, status: "succeeded", result: { summary: "Earlier complete" } } },
			},
		});

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(2);
		expect(messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "subagent:sa-earlier", status: "succeeded", result: { summary: "Earlier complete" } }) }),
		]);
		expect(messages[1]?.blocks).toEqual([{ type: "markdown", text: "newer answer" }]);
		root.dispose();
	});

	it("hydrates a replayed subagent queued/running/final sequence as one canonical card", async () => {
		const { root, chat, controller } = await makeController();
		const running = {
			id: "subagent:sa-replay",
			sourceId: "spawn-replay",
			kind: "subagent",
			title: "review replay auth",
			status: "running",
			invocation: { prompt: "Review replay auth" },
		};
		controller.renderSessionContext({
			messages: [
				{
					id: "assistant-replay",
					role: "assistant",
					content: [{ type: "toolCall", id: "spawn-replay", name: "subagent_spawn", arguments: { prompt: "Review replay auth", name: "review replay auth" } }],
				},
				{
					role: "toolResult",
					toolCallId: "spawn-replay",
					toolName: "subagent_spawn",
					content: [{ type: "text", text: "Started sa-replay" }],
					details: { activity: running },
				},
				{
					role: "custom",
					customType: "subagent-result",
					display: true,
					content: "Replay complete",
					details: { activity: { ...running, status: "succeeded", result: { summary: "Replay complete" } } },
				},
			],
		});

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		const activities = messages.flatMap((message) => message.blocks ?? []).filter((block) => block.type === "activity");
		expect(messages).toHaveLength(1);
		expect(activities).toHaveLength(1);
		expect(activities[0]).toMatchObject({ activity: { id: "subagent:sa-replay", sourceId: "spawn-replay", status: "succeeded", result: { summary: "Replay complete" } } });
		root.dispose();
	});

	it("keeps assistant-only tool blocks under SUMO instead of TOOL", async () => {
		const { root, chat, controller } = await makeController();

		controller.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		controller.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pnpm test" } }] } });

		const message = chat.getRenderedMessages()[0]?.toSnapshot();
		expect(message?.role).toBe("sumo");
		expect(message?.blocks?.[0]).toMatchObject({ type: "activity", activity: { id: "tc1", title: "bash", status: "queued" } });
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
			blocks: [
				{ type: "activity", activity: { id: "read-1", kind: "tool", title: "read", status: "succeeded", invocation: { path: "src/auth/session.ts" }, subject: "src/auth/session.ts", body: { kind: "source", text: "ok" } } },
				{ type: "skill", name: "tdd", expanded: false, content: "skill body" },
				{ type: "summary", kind: "branch", label: "[branch]", content: "summary body", expanded: false },
			],
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
		expect(chat.getActivityExpansion("read-1")).toBe(true);
		expect(chat.getRenderedMessages()[0]?.toSnapshot().blocks).toMatchObject([
			{ type: "activity", activity: { id: "read-1" } },
			{ type: "skill", expanded: true },
			{ type: "summary", expanded: true },
		]);
		cleanup?.();
		root.dispose();
	});

	it("mirrors Pi share status text into retained system messages when owned-shell is active", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		const host = {
			ui: { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() },
			chatContainer: {
				children: [] as unknown[],
				addChild(child: unknown) {
					this.children.push(child);
				},
				render: vi.fn(() => []),
				clear: vi.fn(),
				invalidate: vi.fn(),
			},
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
			isOwnedShellActive: () => true,
		};

		const cleanup = installChatViewportBridge(host, runtime);
		host.chatContainer.addChild({ render: (_width: number) => ["\u001b[2mShare URL: https://pi.dev/session/abc\u001b[0m", "Gist: https://gist.github.com/me/abc"] });
		host.chatContainer.addChild({ render: (_width: number) => [""] });

		const messages = chat.getRenderedMessages().map((message) => message.toSnapshot());
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "system", text: "Share URL: https://pi.dev/session/abc\nGist: https://gist.github.com/me/abc" });
		expect(runtime.requestRender).toHaveBeenCalledTimes(1);

		cleanup?.();
		root.dispose();
	});

	it("does not mirror generic Pi status text into retained chat on splash", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		const host = {
			ui: { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() },
			chatContainer: {
				children: [] as unknown[],
				addChild(child: unknown) {
					this.children.push(child);
				},
				render: vi.fn(() => []),
				clear: vi.fn(),
				invalidate: vi.fn(),
			},
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
			isOwnedShellActive: () => true,
		};

		const cleanup = installChatViewportBridge(host, runtime);
		host.chatContainer.addChild({ render: (_width: number) => ["✓ New session started"] });

		expect(chat.hasMessages()).toBe(false);
		expect(runtime.requestRender).not.toHaveBeenCalled();

		cleanup?.();
		root.dispose();
	});

	it("short-circuits Pi chat rendering when owned-shell becomes active after bridge install", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		let ownedShellActive = false;
		const originalStatusRender = vi.fn((_width: number) => ["Working..."]);
		const host = {
			ui: { terminal: { rows: 100, columns: 60 }, requestRender: vi.fn() },
			chatContainer: { render: vi.fn((_width: number) => ["legacy"]), clear: vi.fn(), invalidate: vi.fn() },
			statusContainer: { render: originalStatusRender },
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => ["retained"]),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
			isOwnedShellActive: () => ownedShellActive,
		};

		const cleanup = installChatViewportBridge(host, runtime);
		ownedShellActive = true;

		expect(host.chatContainer.render(60)).toEqual([]);
		expect(runtime.renderChatLines).not.toHaveBeenCalled();
		expect(host.statusContainer.render(60)).toEqual(["Working..."]);
		expect(originalStatusRender).toHaveBeenCalledWith(60);

		cleanup?.();
		expect(host.chatContainer.render(60)).toEqual(["legacy"]);
		root.dispose();
	});

	it("does not install bottom chrome spacers when owned-shell wires after bridge install", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const chat = ChatPager.create(yoga, root);
		let ownedShellActive = false;
		const footer = rows(1);
		const host = {
			ui: {
				terminal: { rows: 100, columns: 60 },
				children: [footer],
				requestRender: vi.fn(),
			},
			chatContainer: { render: vi.fn((_width: number) => []), clear: vi.fn(), invalidate: vi.fn() },
			footer,
		};
		const runtime = {
			getSnapshot: () => ({ chat }),
			setExternalRenderControls: vi.fn(),
			renderChatLines: vi.fn(() => []),
			writeChatViewport: vi.fn(() => true),
			requestRender: vi.fn(),
			setEmptyChatQuoteState: vi.fn(),
			noteUserMessage: vi.fn(),
			isOwnedShellActive: () => ownedShellActive,
		};

		const cleanup = installChatViewportBridge(host, runtime);
		ownedShellActive = true;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(host.ui.children).toEqual([footer]);

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
