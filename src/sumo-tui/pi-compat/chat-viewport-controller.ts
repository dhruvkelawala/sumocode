import { matchesKey } from "@mariozechner/pi-tui";
import type { KeyEvent } from "../input/key-router.js";
import { parseSgrMouseStream, type MouseEvent } from "../input/mouse.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH } from "../../sidebar.js";

const CHAT_VIEWPORT_BRIDGE_INSTALLED = Symbol("sumo-tui.chat-viewport-bridge-installed");

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
}

export interface ChatViewportRuntime {
	renderChatLines(width: number, height: number): string[];
	writeChatViewport(top: number, left: number, width: number, height: number): boolean;
	requestRender(): void;
	setEmptyChatQuoteState(state: { active: boolean; userMessageCount: number }): void;
	noteUserMessage(): void;
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

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			if (!record || record.type !== "text") return undefined;
			return typeof record.text === "string" ? record.text : undefined;
		})
		.filter((part): part is string => typeof part === "string")
		.join("");
}

export function textFromAgentMessage(message: unknown): string {
	const record = asRecord(message);
	if (!record) return "";
	if (record.role === "bashExecution") {
		const command = typeof record.command === "string" ? record.command : "bash";
		const output = typeof record.output === "string" ? record.output : "";
		return output ? `$ ${command}\n${output}` : `$ ${command}`;
	}
	const text = textFromContent(record.content);
	if (text.length > 0) return text;
	return typeof record.errorMessage === "string" ? record.errorMessage : "";
}

function chatRoleFromAgentMessage(message: unknown): string {
	const role = asRecord(message)?.role;
	if (role === "assistant") return "sumo";
	if (role === "toolResult" || role === "bashExecution") return "tool";
	if (typeof role === "string") return role;
	return "system";
}

function keyFromInput(data: string): KeyEvent | undefined {
	switch (data) {
		case "\x1b[5~":
			return { key: "PageUp", sequence: data };
		case "\x1b[6~":
			return { key: "PageDown", sequence: data };
		case "\x1b[H":
		case "\x1b[1~":
			return { key: "Home", sequence: data };
		case "\x1b[F":
		case "\x1b[4~":
			return { key: "End", sequence: data };
		default:
			if (matchesKey(data, "shift+down")) return { key: "End", sequence: data };
			return undefined;
	}
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
	private lastChatTop = 0;
	private lastChatWidth = 1;
	private lastChatHeight = 1;
	private pendingMouseInput = "";

	public constructor(
		private readonly runtime: ChatViewportRuntime,
		private readonly chat: ChatPager,
		private readonly host: ChatViewportHost,
	) {}

	public render(width: number): string[] {
		// Pi's chatContainer is allocated the full terminal width by Pi's TUI.
		// But Pi separately mounts our installSidebar() widget at the right 49
		// cols (when the session has messages and terminal width >= 120). If we
		// composite the chat tree at full width, our chat content paints into the
		// cols Pi will overpaint with the sidebar — visually that's chat text
		// running INTO the sidebar boundary before being clobbered.
		// Fix: narrow our composite to (terminal - SIDEBAR_WIDTH) when the same
		// predicate Pi uses for showing the sidebar is true. The sidebar's own
		// 49 cols on the right come from Pi's separate widget paint.
		const terminalWidth = Math.max(1, Math.floor(width));
		const sidebarVisible = terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH && this.chat.hasMessages();
		const effectiveWidth = sidebarVisible ? Math.max(1, terminalWidth - SIDEBAR_WIDTH) : terminalWidth;
		this.lastChatWidth = effectiveWidth;
		this.lastChatTop = this.computeChatTop(this.lastChatWidth);
		this.lastChatHeight = this.computeChatHeight(this.lastChatWidth);
		return this.runtime.renderChatLines(this.lastChatWidth, this.lastChatHeight);
	}

	public clear(): void {
		this.chat.clearMessages();
		this.lastAssistantText = "";
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
			for (const event of parsed.events) {
				this.handleMouse(event);
			}

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

		const keyEvent = keyFromInput(nextData);
		if (keyEvent && this.chat.handleKey(keyEvent)) {
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
		this.clear();
		const messages = sessionMessages(sessionContext);
		this.runtime.setEmptyChatQuoteState({ active: messages.length === 0, userMessageCount: countUserMessages(messages) });
		for (const message of messages) {
			const text = textFromAgentMessage(message);
			if (text.length === 0) continue;
			this.chat.addMessage(chatRoleFromAgentMessage(message), text);
		}
	}

	private handleMessageStart(message: unknown): void {
		const role = asRecord(message)?.role;
		if (role === "user") this.runtime.noteUserMessage();
		if (role === "assistant") {
			this.lastAssistantText = "";
			this.chat.addMessage("sumo", "");
			return;
		}
		const text = textFromAgentMessage(message);
		if (text.length === 0) return;
		this.chat.addMessage(chatRoleFromAgentMessage(message), text);
	}

	private handleMessageUpdate(message: unknown, assistantMessageEvent: unknown): void {
		if (asRecord(message)?.role !== "assistant") return;
		const streamEvent = asRecord(assistantMessageEvent);
		if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
			this.chat.appendToLast(streamEvent.delta);
			this.lastAssistantText += streamEvent.delta;
			return;
		}
		const text = textFromAgentMessage(message);
		if (text.length === 0 || text === this.lastAssistantText) return;
		this.chat.replaceLast(text);
		this.lastAssistantText = text;
	}

	private handleMessageEnd(message: unknown): void {
		if (asRecord(message)?.role === "assistant") {
			const text = textFromAgentMessage(message);
			if (text.length > 0 && text !== this.lastAssistantText) {
				this.chat.replaceLast(text);
				this.lastAssistantText = text;
			}
			this.chat.endStreaming();
		}
	}

	private handleMouse(event: MouseEvent): boolean {
		const localEvent: MouseEvent = {
			...event,
			row: event.row - this.lastChatTop,
			col: event.col,
		};
		if (localEvent.row < 0 || localEvent.row >= this.lastChatHeight || localEvent.col < 0 || localEvent.col >= this.lastChatWidth) return false;
		const handled = this.chat.handleMouseEvent(localEvent);
		if (handled) this.renderChatViewportOrRequest();
		return handled;
	}

	private renderChatViewportOrRequest(): void {
		if (!this.runtime.writeChatViewport(this.lastChatTop, 0, this.lastChatWidth, this.lastChatHeight)) {
			this.runtime.requestRender();
		}
	}

	private computeChatTop(width: number): number {
		return renderableLineCount(this.host.headerContainer, width);
	}

	private computeChatHeight(width: number): number {
		const terminalRows = Math.max(1, this.host.ui?.terminal?.rows ?? 24);
		const terminalWidth = Math.max(1, this.host.ui?.terminal?.columns ?? width);
		const chromeRows =
			renderableLineCount(this.host.headerContainer, width) +
			renderableLineCount(this.host.pendingMessagesContainer, width) +
			renderableLineCount(this.host.statusContainer, width) +
			renderableLineCount(this.host.widgetContainerAbove, terminalWidth) +
			renderableLineCount(this.host.editorContainer, terminalWidth) +
			renderableLineCount(this.host.widgetContainerBelow, terminalWidth) +
			renderableLineCount(this.host.footer, terminalWidth);
		return Math.max(1, terminalRows - chromeRows);
	}
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
	const originalHandleEvent = target.handleEvent?.bind(target);
	const originalRenderSessionContext = target.renderSessionContext?.bind(target);
	const removeInputListener = target.ui?.addInputListener?.((data) => controller.handleInput(data));

	runtime.setExternalRenderControls({
		// Pi's normal differential renderer optimizes line shifts with terminal
		// scroll sequences. In SumoCode's hybrid shell, chat scroll changes only
		// the left content while the sidebar/footer remain fixed; terminal scroll
		// sequences move the whole screen and leave stale sidebar/chat fragments.
		// Force Pi's full redraw path for retained chat updates until Sumo owns the
		// entire root renderer.
		scheduleRender: () => target.ui?.requestRender?.(true),
		setStreamingMode: () => target.ui?.requestRender?.(true),
	});
	chatContainer.render = (width: number): string[] => controller.render(width);
	chatContainer.clear = (): void => {
		controller.clear();
		originalClear?.();
	};
	chatContainer.invalidate = (): void => {
		originalInvalidate?.();
		runtime.requestRender();
	};
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
		removeInputListener?.();
		runtime.setExternalRenderControls(undefined);
		if (originalRender) chatContainer.render = originalRender;
		else delete chatContainer.render;
		if (originalClear) chatContainer.clear = originalClear;
		else delete chatContainer.clear;
		if (originalInvalidate) chatContainer.invalidate = originalInvalidate;
		else delete chatContainer.invalidate;
		if (originalHandleEvent) target.handleEvent = originalHandleEvent;
		if (originalRenderSessionContext) target.renderSessionContext = originalRenderSessionContext;
		delete target[CHAT_VIEWPORT_BRIDGE_INSTALLED];
	};
	target[CHAT_VIEWPORT_BRIDGE_INSTALLED] = cleanup;
	return cleanup;
}
