import { parseSgrMouseStream, type MouseEvent } from "../input/mouse.js";
import type { KeyEvent } from "../input/key-router.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { measureMaybe, ResumeProfiler, type ResumeProfileMetadata } from "../runtime/resume-profiler.js";
import {
	chatMessageViewModelFromPiMessage,
	chatMessageViewModelToPlainText,
	markdownAndCodeBlocksFromText,
	transcriptFromSessionContext,
	type ChatBlock,
	type ChatMessageViewModel,
} from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { chatScrollCommandFromInput } from "../widgets/chat-scroll-command.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH } from "../../sidebar.js";
import { sidebarGutterWidth } from "../../sidebar-placement.js";
import { normalizeRawMultilinePasteInput } from "../../cathedral/multiline-paste.js";

const CHAT_VIEWPORT_BRIDGE_INSTALLED = Symbol("sumo-tui.chat-viewport-bridge-installed");
const PORTRAIT_STATUS_MIN_WIDTH = 80;
const PORTRAIT_CHAT_GUTTER_MIN_WIDTH = 80;
const STREAMING_CHAT_RENDER_COALESCE_MS = 100;
const MOUSE_CHAT_RENDER_COALESCE_MS = 50;

interface PiRenderableComponent {
	render(width: number): string[];
}

interface PiChatContainer {
	clear?(): void;
	invalidate?(): void;
	render?(width: number): string[];
}

interface PiTuiLike {
	readonly terminal?: { readonly rows?: number; readonly columns?: number };
	requestRender?(force?: boolean): void;
	addInputListener?(listener: (data: string) => { consume?: boolean; data?: string } | void): () => void;
}

export interface ChatViewportHost {
	readonly ui?: PiTuiLike;
	readonly headerContainer?: PiRenderableComponent;
	readonly pendingMessagesContainer?: PiRenderableComponent;
	readonly statusContainer?: PiRenderableComponent;
	readonly widgetContainerAbove?: PiRenderableComponent;
	readonly widgetContainerBelow?: PiRenderableComponent;
	readonly editorContainer?: PiRenderableComponent;
	readonly footer?: PiRenderableComponent;
	setToolsExpanded?(expanded: boolean): void;
	getToolsExpanded?(): boolean;
}

export interface ChatViewportRuntime {
	renderChatLines(width: number, height: number): string[];
	writeChatViewport(top: number, left: number, width: number, height: number): boolean;
	requestRender(): void;
	setEmptyChatQuoteState(state: { active: boolean; userMessageCount: number }): void;
	noteUserMessage(): void;
	handleSelectionMouse?(event: MouseEvent, width: number, height: number): boolean;
	handleSelectionKey?(event: KeyEvent, width: number, height: number): boolean;
	startResumeProfile?(): ResumeProfiler;
	completeResumeHydration?(profile: ResumeProfiler, metadata: ResumeProfileMetadata): void;
}

interface ChatViewportBridgeRuntime extends ChatViewportRuntime {
	getSnapshot(): { readonly chat: ChatPager } | undefined;
	setExternalRenderControls(controls: { scheduleRender(): void; setStreamingMode(enabled: boolean): void } | undefined): void;
}

interface ChatViewportBridgeHost extends ChatViewportHost {
	chatContainer?: PiChatContainer;
	handleEvent?(event: unknown): unknown;
	renderSessionContext?(sessionContext: unknown, options?: unknown): unknown;
	[CHAT_VIEWPORT_BRIDGE_INSTALLED]?: () => void;
}

interface MouseInputDiagnosticsFields {
	readonly dataLength: number;
	readonly sourceLength: number;
	readonly eventCount: number;
	readonly consumed: boolean;
	readonly pendingLength: number;
	readonly leftoverLength: number;
	readonly sourceHex: string;
	readonly leftoverHex: string;
}

const COMPLETE_SGR_MOUSE_SEQUENCE = /\x1b\[<\d+;\d+;\d+[Mm]/g;
/**
 * Match a trailing prefix of an SGR mouse sequence so we can buffer partial
 * input across stdin chunks. Matches any of:
 *
 *   ESC, ESC [, ESC [ <, ESC [ < digits, ESC [ < digits ; digits ...
 *
 * The terminating M / m is intentionally absent — that's what makes it a
 * prefix. Anchored to end-of-string only.
 */
const SGR_MOUSE_PREFIX_TAIL_PATTERN = /(?:\x1b(?:\[(?:<\d*(?:;\d*){0,2})?)?)$/;

function toHex(value: string): string {
	let hex = "";
	for (let index = 0; index < value.length; index += 1) {
		hex += value.charCodeAt(index).toString(16).padStart(2, "0");
	}
	return hex;
}

function diagnoseMouseInput(fields: MouseInputDiagnosticsFields): void {
	logDiagnostic("sumo_mouse_input", {
		data_length: fields.dataLength,
		source_length: fields.sourceLength,
		events: fields.eventCount,
		consumed: fields.consumed,
		pending_length: fields.pendingLength,
		leftover_length: fields.leftoverLength,
		source_hex: fields.sourceHex,
		leftover_hex: fields.leftoverHex,
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function textFromAgentMessage(message: unknown): string {
	const viewModel = chatMessageViewModelFromPiMessage(message);
	return viewModel ? chatMessageViewModelToPlainText(viewModel) : "";
}

function addViewModel(chat: ChatPager, message: ChatMessageViewModel): void {
	chat.addViewModel(message);
}

function isToolOnlyViewModel(message: ChatMessageViewModel): boolean {
	return message.blocks.length > 0 && message.blocks.every((block) => block.type === "tool");
}

function mergeToolBlock(existing: ChatBlock, incoming: ChatBlock): ChatBlock {
	if (existing.type !== "tool" || incoming.type !== "tool") return incoming;
	return {
		type: "tool",
		tool: {
			...existing.tool,
			...incoming.tool,
			input: incoming.tool.input ?? existing.tool.input,
			details: incoming.tool.details ?? existing.tool.details,
		},
	};
}

function upsertToolBlock(blocks: readonly ChatBlock[], incoming: ChatBlock): ChatBlock[] {
	if (incoming.type !== "tool") return [...blocks, incoming];
	const incomingId = incoming.tool.id;
	const byId = incomingId
		? blocks.findIndex((block) => block.type === "tool" && block.tool.id === incomingId)
		: -1;
	const byName = byId === -1
		? blocks.findIndex((block) => block.type === "tool" && block.tool.id === undefined && block.tool.name === incoming.tool.name && (block.tool.status === "pending" || block.tool.status === "running"))
		: -1;
	const index = byId !== -1 ? byId : byName;
	if (index === -1) return [...blocks, incoming];
	return blocks.map((block, blockIndex) => blockIndex === index ? mergeToolBlock(block, incoming) : block);
}

function renderableLineCount(component: PiRenderableComponent | undefined, width: number): number {
	if (!component) return 0;
	try {
		return component.render(width).length;
	} catch {
		return 0;
	}
}

function sessionMessages(sessionContext: unknown): unknown[] {
	const messages = asRecord(sessionContext)?.messages;
	return Array.isArray(messages) ? messages : [];
}

function isUserMessage(message: unknown): boolean {
	return asRecord(message)?.role === "user";
}

function countUserMessages(messages: readonly unknown[]): number {
	return messages.filter(isUserMessage).length;
}

/**
 * Deep Module for the retained chat viewport seam.
 *
 * SumoInteractiveMode owns Pi lifecycle wiring; this Module owns the chat
 * viewport interface: geometry, input translation, message ingestion, and the
 * repaint strategy needed to keep chat scroll local to the retained viewport.
 */
export class ChatViewportController {
	private lastAssistantText = "";
	private liveAssistant: ChatMessageViewModel | undefined;
	private liveAssistantBlocks: ChatBlock[] = [];
	private lastChatTop = 0;
	private lastChatWidth = 1;
	private lastChatHeight = 1;
	private pendingMouseInput = "";
	private pendingMouseRender: ReturnType<typeof setTimeout> | undefined;
	private lastMouseRenderAt = 0;
	private lastMouseInputAt = 0;
	private renderRevision = 0;
	private cachedRender: { revision: number; requestedWidth: number; chatTop: number; chatWidth: number; chatHeight: number; terminalRows: number; lines: string[] } | undefined;

	public constructor(
		private readonly runtime: ChatViewportRuntime,
		private readonly chat: ChatPager,
		private readonly host: ChatViewportHost,
	) {}

	public render(width: number): string[] {
		// Pi's chatContainer is allocated the full terminal width by Pi's TUI.
		// But Pi separately mounts our installSidebar() widget at the right
		// SIDEBAR_WIDTH cols (when the session has messages and terminal width >=
		// 120). If we composite the chat tree at full width, our chat content paints
		// into the cols Pi will overpaint with the sidebar — visually that's chat
		// text running INTO the sidebar boundary before being clobbered.
		// Fix: narrow our composite to (terminal - SIDEBAR_WIDTH) when the same
		// predicate Pi uses for showing the sidebar is true. The sidebar's own
		// right-side cols come from Pi's separate widget paint.
		const terminalWidth = Math.max(1, Math.floor(width));
		const terminalHeight = Math.max(1, this.host.ui?.terminal?.rows ?? 24);
		const sidebarVisible = terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH && this.chat.hasMessages();
		const sidebarGutter = sidebarVisible ? sidebarGutterWidth(terminalWidth, terminalHeight) : 0;
		const portraitGutterVisible = !sidebarVisible && this.chat.hasMessages() && terminalWidth < PORTRAIT_CHAT_GUTTER_MIN_WIDTH;
		const effectiveWidth = sidebarVisible
			? Math.max(1, terminalWidth - SIDEBAR_WIDTH - sidebarGutter)
			: portraitGutterVisible
				? Math.max(1, terminalWidth - 1)
				: terminalWidth;
		const chatTop = this.computeChatTop(effectiveWidth);
		const chatHeight = this.computeChatHeight(effectiveWidth);
		this.lastChatWidth = effectiveWidth;
		this.lastChatTop = chatTop;
		this.lastChatHeight = chatHeight;
		const cached = this.cachedRender;
		if (
			cached &&
			cached.revision === this.renderRevision &&
			cached.requestedWidth === terminalWidth &&
			cached.chatTop === chatTop &&
			cached.chatWidth === effectiveWidth &&
			cached.chatHeight === chatHeight &&
			cached.terminalRows === terminalHeight
		) {
			logDiagnostic("chat_viewport_render_cache_hit", { width: effectiveWidth, height: chatHeight, revision: this.renderRevision });
			return [...cached.lines];
		}
		const lines = this.runtime.renderChatLines(this.lastChatWidth, this.lastChatHeight);
		this.cachedRender = { revision: this.renderRevision, requestedWidth: terminalWidth, chatTop, chatWidth: effectiveWidth, chatHeight, terminalRows: terminalHeight, lines: [...lines] };
		return lines;
	}

	public clear(): void {
		this.markRenderDirty();
		this.chat.clearMessages();
		this.lastAssistantText = "";
		this.liveAssistant = undefined;
		this.liveAssistantBlocks = [];
		this.pendingMouseInput = "";
		this.runtime.setEmptyChatQuoteState({ active: false, userMessageCount: 0 });
	}

	public handleInput(data: string): { consume?: boolean; data?: string } | void {
		const source = this.pendingMouseInput + data;
		this.pendingMouseInput = "";
		let nextData = source;
		let consumed = false;

		if (source.includes("\x1b")) {
			const parsed = parseSgrMouseStream(source);
			logDiagnostic("mouse_batch", {
				rawBytes: source.length,
				events: parsed.events.length,
				types: parsed.events.map((event) => event.type),
			});
			let mouseViewportDirty = false;
			for (const event of parsed.events) {
				mouseViewportDirty = this.handleMouse(event, { deferRender: true }) || mouseViewportDirty;
			}
			if (mouseViewportDirty) this.scheduleMouseChatViewportRender();

			// Strip every complete SGR mouse sequence — including wheel-left/right
			// (button codes 66/67) and any other variants the parser may not
			// recognize. Anything matching `\x1b[<\d+;\d+;\d+[Mm]` is mouse input
			// and must never reach Pi's editor as visible text.
			const beforeCompleteStrip = nextData;
			nextData = nextData.replace(COMPLETE_SGR_MOUSE_SEQUENCE, "");
			if (nextData !== beforeCompleteStrip) consumed = true;

			// Buffer trailing partial mouse sequences across chunks.
			const tailMatch = nextData.match(SGR_MOUSE_PREFIX_TAIL_PATTERN);
			if (tailMatch && tailMatch[0].length > 0) {
				this.pendingMouseInput = tailMatch[0];
				nextData = nextData.slice(0, nextData.length - tailMatch[0].length);
				consumed = true;
			}

			// Anything else starting with `\x1b[<` is a corrupt/stale mouse
			// fragment. Drop it instead of forwarding raw bytes to Pi's editor.
			if (nextData.includes("\x1b[<")) {
				const stripped = nextData.replace(/\x1b\[<[\d;]*[Mm]?/g, "");
				if (stripped !== nextData) {
					nextData = stripped;
					consumed = true;
				}
			}

			diagnoseMouseInput({
				dataLength: data.length,
				sourceLength: source.length,
				eventCount: parsed.events.length,
				consumed,
				pendingLength: this.pendingMouseInput.length,
				leftoverLength: nextData.length,
				sourceHex: toHex(source.slice(0, 64)),
				leftoverHex: toHex(nextData.slice(0, 64)),
			});
		}

		const normalizedPasteData = normalizeRawMultilinePasteInput(nextData);
		if (normalizedPasteData !== nextData) {
			logDiagnostic("raw_multiline_paste_normalized", { sourceLength: nextData.length, normalizedLength: normalizedPasteData.length });
			nextData = normalizedPasteData;
			consumed = true;
		}

		const keyEvent = chatScrollCommandFromInput(nextData);
		if (keyEvent && this.chat.handleKey(keyEvent)) {
			this.markRenderDirty();
			this.renderChatViewportOrRequest();
			return { consume: true };
		}

		const selectionKey = selectionCopyKeyFromInput(nextData);
		if (selectionKey && this.runtime.handleSelectionKey?.(selectionKey, this.lastChatWidth, this.lastChatHeight) === true) {
			this.markRenderDirty();
			this.renderChatViewportOrRequest();
			return { consume: true };
		}

		if (nextData.length === 0 && consumed) return { consume: true };
		if (nextData !== data) return { data: nextData };
		return undefined;
	}

	public handleAgentEvent(event: unknown): void {
		const record = asRecord(event);
		if (!record || typeof record.type !== "string") return;
		const message = record.message;
		switch (record.type) {
			case "message_start":
				this.handleMessageStart(message);
				break;
			case "message_update":
				this.handleMessageUpdate(message, record.assistantMessageEvent);
				break;
			case "message_end":
				this.handleMessageEnd(message);
				break;
			case "agent_end":
				this.chat.endStreaming();
				break;
		}
	}

	public renderSessionContext(sessionContext: unknown): void {
		this.lastAssistantText = "";
		this.liveAssistant = undefined;
		this.liveAssistantBlocks = [];
		this.pendingMouseInput = "";
		// Resume uses bulk transcript replacement instead of `clear()` + per-message
		// replay; `replaceViewModels()` resets the chat-side scroll/banner state.
		const profile = this.runtime.startResumeProfile?.();
		const messages = measureMaybe(profile, "session_scan", () => sessionMessages(sessionContext));
		this.markRenderDirty();
		this.runtime.setEmptyChatQuoteState({ active: messages.length === 0, userMessageCount: countUserMessages(messages) });
		const transcript = measureMaybe(profile, "transcript_model", () => transcriptFromSessionContext(sessionContext));
		const stats = measureMaybe(profile, "transcript_hydrate", () => this.chat.replaceViewModels(transcript.messages));
		if (profile) {
			this.runtime.completeResumeHydration?.(profile, {
				sourceMessages: messages.length,
				acceptedMessages: stats.acceptedMessages,
				renderedMessages: stats.renderedMessages,
				archivedMessages: stats.archivedMessages,
			});
		}
	}

	private handleMessageStart(message: unknown): void {
		this.markRenderDirty();
		const role = asRecord(message)?.role;
		if (role === "user") {
			this.liveAssistant = undefined;
			this.liveAssistantBlocks = [];
			this.runtime.noteUserMessage();
		}
		if (role === "assistant") {
			this.startAssistantMessage(message);
			return;
		}
		const viewModel = chatMessageViewModelFromPiMessage(message);
		if (!viewModel || chatMessageViewModelToPlainText(viewModel).length === 0) return;
		if (isToolOnlyViewModel(viewModel) && this.liveAssistant) {
			this.foldToolBlocksIntoAssistant(viewModel.blocks);
			return;
		}
		addViewModel(this.chat, viewModel);
		this.runtime.requestRender();
	}

	private handleMessageUpdate(message: unknown, assistantMessageEvent: unknown): void {
		if (asRecord(message)?.role !== "assistant") return;
		this.markRenderDirty();
		const streamEvent = asRecord(assistantMessageEvent);
		if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
			this.chat.beginStreaming();
			this.appendAssistantTextDelta(streamEvent.delta);
			return;
		}
		const viewModel = chatMessageViewModelFromPiMessage(message);
		const text = viewModel ? chatMessageViewModelToPlainText(viewModel) : textFromAgentMessage(message);
		if (text.length === 0 || text === this.lastAssistantText) return;
		this.chat.beginStreaming();
		if (viewModel) {
			this.liveAssistant = { ...viewModel, role: "sumo", displayName: "SUMO" };
			this.liveAssistantBlocks = [...viewModel.blocks];
			this.chat.replaceLastWithViewModel(this.liveAssistant);
		} else {
			this.chat.replaceLast(text);
			this.liveAssistantBlocks = markdownAndCodeBlocksFromText(text);
		}
		this.lastAssistantText = text;
	}

	private handleMessageEnd(message: unknown): void {
		this.markRenderDirty();
		if (asRecord(message)?.role === "assistant") {
			const viewModel = chatMessageViewModelFromPiMessage(message);
			const text = viewModel ? chatMessageViewModelToPlainText(viewModel) : textFromAgentMessage(message);
			if (text.length > 0 && text !== this.lastAssistantText) {
				if (viewModel) {
					this.liveAssistant = { ...viewModel, role: "sumo", displayName: "SUMO" };
					this.liveAssistantBlocks = [...viewModel.blocks];
					this.chat.replaceLastWithViewModel(this.liveAssistant);
				} else {
					this.chat.replaceLast(text);
					this.liveAssistantBlocks = markdownAndCodeBlocksFromText(text);
				}
				this.lastAssistantText = text;
			}
			this.chat.endStreaming();
		}
	}

	private startAssistantMessage(message: unknown): void {
		const viewModel = chatMessageViewModelFromPiMessage(message);
		this.liveAssistant = viewModel
			? { ...viewModel, role: "sumo", displayName: "SUMO" }
			: { id: "live-assistant", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "" }] };
		this.liveAssistantBlocks = viewModel ? [...viewModel.blocks] : [];
		this.lastAssistantText = chatMessageViewModelToPlainText({ ...this.liveAssistant, blocks: this.liveAssistantBlocks });
		this.chat.addViewModel({ ...this.liveAssistant, blocks: this.liveAssistantBlocks.length > 0 ? this.liveAssistantBlocks : [{ type: "markdown", text: "" }] });
	}

	private appendAssistantTextDelta(delta: string): void {
		if (!this.liveAssistant) {
			this.chat.appendToLast(delta);
			this.lastAssistantText += delta;
			return;
		}
		const lastBlock = this.liveAssistantBlocks.at(-1);
		if (lastBlock?.type === "markdown") {
			this.liveAssistantBlocks = this.liveAssistantBlocks.map((block, index) => index === this.liveAssistantBlocks.length - 1 && block.type === "markdown" ? { type: "markdown", text: block.text + delta } : block);
		} else {
			this.liveAssistantBlocks = [...this.liveAssistantBlocks, { type: "markdown", text: delta }];
		}
		this.lastAssistantText = chatMessageViewModelToPlainText({ ...this.liveAssistant, blocks: this.liveAssistantBlocks });
		this.publishLiveAssistant();
	}

	private foldToolBlocksIntoAssistant(blocks: readonly ChatBlock[]): void {
		for (const block of blocks) {
			this.liveAssistantBlocks = upsertToolBlock(this.liveAssistantBlocks, block);
		}
		this.lastAssistantText = this.liveAssistant ? chatMessageViewModelToPlainText({ ...this.liveAssistant, blocks: this.liveAssistantBlocks }) : this.lastAssistantText;
		this.publishLiveAssistant();
	}

	private publishLiveAssistant(): void {
		if (!this.liveAssistant) return;
		this.chat.replaceLastWithViewModel({
			...this.liveAssistant,
			blocks: this.liveAssistantBlocks.length > 0 ? this.liveAssistantBlocks : [{ type: "markdown", text: "" }],
		});
	}

	private handleMouse(event: MouseEvent, options: { deferRender?: boolean } = {}): boolean {
		const localEvent: MouseEvent = {
			...event,
			row: event.row - this.lastChatTop,
			col: event.col,
		};
		const inViewport = localEvent.row >= 0 && localEvent.row < this.lastChatHeight && localEvent.col >= 0 && localEvent.col < this.lastChatWidth;
		if (!inViewport) {
			logDiagnostic("mouse_dispatch", { type: event.type, row: event.row, col: event.col, target: "outside_chat", handled: false });
			return false;
		}
		const beforeOffset = this.chat.scrollBox.scrollOffset;
		this.lastMouseInputAt = Date.now();
		const handled = this.chat.handleMouseEvent(localEvent);
		const handledSelection = this.runtime.handleSelectionMouse?.(localEvent, this.lastChatWidth, this.lastChatHeight) === true;
		logDiagnostic("mouse_dispatch", {
			type: event.type,
			row: event.row,
			col: event.col,
			localRow: localEvent.row,
			localCol: localEvent.col,
			target: "chat",
			handledScroll: handled,
			handledSelection,
			scrollOffsetBefore: beforeOffset,
			scrollOffsetAfter: this.chat.scrollBox.scrollOffset,
		});
		if (handled || handledSelection) this.markRenderDirty();
		if ((handled || handledSelection) && options.deferRender !== true) this.renderChatViewportOrRequest();
		return handled || handledSelection;
	}

	public markRenderDirty(): void {
		this.renderRevision += 1;
		this.cachedRender = undefined;
	}

	private renderChatViewportOrRequest(): void {
		if (!this.runtime.writeChatViewport(this.lastChatTop, 0, this.lastChatWidth, this.lastChatHeight)) {
			this.runtime.requestRender();
		}
	}

	public shouldCoalesceChatRenderAsMouse(): boolean {
		return Date.now() - this.lastMouseInputAt <= MOUSE_CHAT_RENDER_COALESCE_MS;
	}

	public scheduleMouseChatViewportRender(): void {
		const now = Date.now();
		const elapsed = now - this.lastMouseRenderAt;
		if (elapsed >= MOUSE_CHAT_RENDER_COALESCE_MS && !this.pendingMouseRender) {
			this.lastMouseRenderAt = now;
			logDiagnostic("chat_viewport_mouse_render_request", { source: "mouse", coalesceMs: MOUSE_CHAT_RENDER_COALESCE_MS });
			this.renderChatViewportOrRequest();
			return;
		}
		if (this.pendingMouseRender) return;
		const delay = Math.max(0, MOUSE_CHAT_RENDER_COALESCE_MS - elapsed);
		this.pendingMouseRender = setTimeout(() => {
			this.pendingMouseRender = undefined;
			this.lastMouseRenderAt = Date.now();
			logDiagnostic("chat_viewport_mouse_render_request", { source: "mouse", coalesceMs: MOUSE_CHAT_RENDER_COALESCE_MS });
			this.renderChatViewportOrRequest();
		}, delay);
		this.pendingMouseRender.unref?.();
	}

	public dispose(): void {
		if (this.pendingMouseRender) clearTimeout(this.pendingMouseRender);
		this.pendingMouseRender = undefined;
	}

	private computeChatTop(width: number): number {
		return renderableLineCount(this.host.headerContainer, width);
	}

	private computeChatHeight(width: number): number {
		const hostRows = Math.max(1, this.host.ui?.terminal?.rows ?? 24);
		const stdoutRows = (process.stdout as { rows?: number }).rows ?? 0;
		const terminalRows = Math.max(1, hostRows, stdoutRows);
		const terminalWidth = Math.max(1, this.host.ui?.terminal?.columns ?? width);
		// On splash, skip counting Pi's empty pre-editor containers
		// (pendingMessages, status, widgetAbove) so the chat slot extends
		// through that space and the splash content sits close to the editor.
		const isSplash = !this.chat.hasMessages();
		const preEditorRows = isSplash ? 0
			: renderableLineCount(this.host.pendingMessagesContainer, width) +
				renderableLineCount(this.host.statusContainer, width) +
				renderableLineCount(this.host.widgetContainerAbove, terminalWidth);
		const chromeRows =
			renderableLineCount(this.host.headerContainer, width) +
			preEditorRows +
			renderableLineCount(this.host.editorContainer, terminalWidth) +
			renderableLineCount(this.host.widgetContainerBelow, terminalWidth) +
			renderableLineCount(this.host.footer, terminalWidth);
		return Math.max(1, terminalRows - chromeRows);
	}
}

function selectionCopyKeyFromInput(data: string): KeyEvent | undefined {
	if (data.length === 0) return undefined;
	const lower = data.toLowerCase();
	if (lower === "cmd+c" || lower === "command+c" || lower === "meta+c") return { key: "c", sequence: data, meta: true };
	return undefined;
}

export function installChatViewportBridge(upstream: unknown, runtime: ChatViewportBridgeRuntime): (() => void) | undefined {
	const target = upstream as ChatViewportBridgeHost;
	if (target[CHAT_VIEWPORT_BRIDGE_INSTALLED]) return undefined;
	const snapshot = runtime.getSnapshot();
	if (!snapshot || !target.chatContainer) return undefined;
	const controller = new ChatViewportController(runtime, snapshot.chat, target);
	const chatContainer = target.chatContainer;
	const originalRender = chatContainer.render?.bind(chatContainer);
	const originalClear = chatContainer.clear?.bind(chatContainer);
	const originalInvalidate = chatContainer.invalidate?.bind(chatContainer);
	const statusContainer = target.statusContainer as (PiRenderableComponent & { render?: (width: number) => string[] }) | undefined;
	const originalStatusRender = statusContainer?.render?.bind(statusContainer);
	const originalHandleEvent = target.handleEvent?.bind(target);
	const originalRenderSessionContext = target.renderSessionContext?.bind(target);
	const originalSetToolsExpanded = target.setToolsExpanded?.bind(target);
	const removeInputListener = target.ui?.addInputListener?.((data) => controller.handleInput(data));
	let streaming = false;
	let pendingStreamingRender: ReturnType<typeof setTimeout> | undefined;
	let lastStreamingRenderAt = 0;
	const requestForcedRender = (source: "immediate" | "streaming" | "stream-end"): void => {
		lastStreamingRenderAt = Date.now();
		logDiagnostic("chat_viewport_render_request", { source, force: true });
		target.ui?.requestRender?.(true);
	};
	const flushPendingStreamingRender = (): void => {
		if (pendingStreamingRender) {
			clearTimeout(pendingStreamingRender);
			pendingStreamingRender = undefined;
		}
		requestForcedRender("stream-end");
	};
	const scheduleStreamingRender = (): void => {
		const now = Date.now();
		const elapsed = now - lastStreamingRenderAt;
		if (elapsed >= STREAMING_CHAT_RENDER_COALESCE_MS && !pendingStreamingRender) {
			requestForcedRender("streaming");
			return;
		}
		if (pendingStreamingRender) return;
		const delay = Math.max(0, STREAMING_CHAT_RENDER_COALESCE_MS - elapsed);
		pendingStreamingRender = setTimeout(() => {
			pendingStreamingRender = undefined;
			requestForcedRender("streaming");
		}, delay);
		pendingStreamingRender.unref?.();
	};

	runtime.setExternalRenderControls({
		// Pi's normal differential renderer optimizes line shifts with terminal
		// scroll sequences. In SumoCode's hybrid shell, chat scroll changes only
		// the left content while the sidebar/footer remain fixed; terminal scroll
		// sequences move the whole screen and leave stale sidebar/chat fragments.
		// Force Pi's full redraw path for retained chat updates until Sumo owns the
		// entire root renderer, but coalesce token-stream bursts so input remains
		// responsive while the assistant is streaming.
		scheduleRender: () => {
			if (streaming) {
				scheduleStreamingRender();
				return;
			}
			if (controller.shouldCoalesceChatRenderAsMouse()) {
				controller.scheduleMouseChatViewportRender();
				return;
			}
			requestForcedRender("immediate");
		},
		setStreamingMode: (enabled) => {
			if (streaming === enabled) return;
			streaming = enabled;
			logDiagnostic("chat_viewport_streaming_mode", { enabled, coalesceMs: STREAMING_CHAT_RENDER_COALESCE_MS });
			if (!enabled) flushPendingStreamingRender();
		},
	});
	chatContainer.render = (width: number): string[] => controller.render(width);
	chatContainer.clear = (): void => {
		controller.clear();
		originalClear?.();
	};
	chatContainer.invalidate = (): void => {
		controller.markRenderDirty();
		originalInvalidate?.();
		runtime.requestRender();
	};
	if (statusContainer && originalStatusRender) {
		statusContainer.render = (width: number): string[] => {
			const terminalWidth = target.ui?.terminal?.columns ?? width;
			// Portrait V1 Bible rhythm reserves the pre-input row as breathing
			// space. Suppress Pi's loader/status row at compact widths so the input,
			// hint, and footer land on the target rows.
			if (terminalWidth < PORTRAIT_STATUS_MIN_WIDTH) return [];
			return originalStatusRender(width);
		};
	}
	if (originalSetToolsExpanded) {
		target.setToolsExpanded = (expanded: boolean): void => {
			controller.markRenderDirty();
			snapshot.chat.setToolExpansion(expanded);
			originalSetToolsExpanded(expanded);
		};
	}
	if (originalHandleEvent) {
		target.handleEvent = async (event: unknown): Promise<unknown> => {
			controller.handleAgentEvent(event);
			return originalHandleEvent(event);
		};
	}
	if (originalRenderSessionContext) {
		target.renderSessionContext = (sessionContext: unknown, options?: unknown): unknown => {
			controller.renderSessionContext(sessionContext);
			return originalRenderSessionContext(sessionContext, options);
		};
	}

	const cleanup = (): void => {
		if (pendingStreamingRender) clearTimeout(pendingStreamingRender);
		pendingStreamingRender = undefined;
		controller.dispose();
		removeInputListener?.();
		runtime.setExternalRenderControls(undefined);
		if (originalRender) chatContainer.render = originalRender;
		else delete chatContainer.render;
		if (originalClear) chatContainer.clear = originalClear;
		else delete chatContainer.clear;
		if (originalInvalidate) chatContainer.invalidate = originalInvalidate;
		else delete chatContainer.invalidate;
		if (statusContainer && originalStatusRender) statusContainer.render = originalStatusRender;
		if (originalSetToolsExpanded) target.setToolsExpanded = originalSetToolsExpanded;
		if (originalHandleEvent) target.handleEvent = originalHandleEvent;
		if (originalRenderSessionContext) target.renderSessionContext = originalRenderSessionContext;
		delete target[CHAT_VIEWPORT_BRIDGE_INSTALLED];
	};
	target[CHAT_VIEWPORT_BRIDGE_INSTALLED] = cleanup;
	return cleanup;
}
