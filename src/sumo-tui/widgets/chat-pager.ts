import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { chatMessageViewModelToPlainText, type ChatMessageViewModel } from "../transcript/view-model.js";
import { ChatMessage, type ChatMessageOptions, type ChatMessageRole } from "./chat-message.js";
import { ScrolledUpBanner } from "./scrolled-up-banner.js";
import { ScrollBox, type ScrollBoxStateChange } from "./scrollbox.js";

export interface ChatPagerRenderControls {
	scheduleRender(): void;
	setStreamingMode(enabled: boolean): void;
}

export interface ChatPagerOptions {
	readonly renderControls?: ChatPagerRenderControls;
	readonly maxRenderedMessages?: number;
	readonly stickyBottom?: boolean;
	readonly primaryAgentName?: string;
}

export interface ChatPagerReplaceStats {
	readonly sourceMessages: number;
	readonly acceptedMessages: number;
	readonly renderedMessages: number;
	readonly archivedMessages: number;
}

const DEFAULT_MAX_RENDERED_MESSAGES = 200;

function noop(): void {}

function chatRoleFromViewModel(message: ChatMessageViewModel): ChatMessageRole {
	const onlyToolBlocks = message.blocks.length > 0 && message.blocks.every((block) => block.type === "tool");
	if (message.role === "system" && onlyToolBlocks) return "tool";
	return message.role;
}

interface PreparedChatMessage {
	readonly role: ChatMessageRole;
	readonly text: string;
	readonly timestamp?: Date;
	readonly blocks: readonly ChatMessageViewModel["blocks"][number][];
}

function prepareChatMessage(message: ChatMessageViewModel): PreparedChatMessage {
	return {
		role: chatRoleFromViewModel(message),
		text: chatMessageViewModelToPlainText(message),
		timestamp: message.timestamp,
		blocks: message.blocks,
	};
}

function hasRenderablePlainText(message: ChatMessageViewModel): boolean {
	for (const block of message.blocks) {
		switch (block.type) {
			case "markdown":
				if (block.text.length > 0) return true;
				break;
			case "thinking":
				if (block.hidden || block.text.length > 0) return true;
				break;
			case "code":
				return true;
			case "tool":
			case "skill":
			case "question":
			case "delegation":
				return true;
		}
	}
	return false;
}

/** Stateful chat scrollback wrapper: messages + ScrollBox + unread banner. */
export class ChatPager extends SumoNode {
	public readonly scrollBox: ScrollBox;
	public readonly banner: ScrolledUpBanner;
	public archivedMessages: ChatMessage[] = [];
	private readonly yoga: Yoga;
	private readonly renderControls: ChatPagerRenderControls;
	private readonly maxRenderedMessages: number;
	private readonly chatMessageOptions: ChatMessageOptions;
	private readonly activeMessages: ChatMessage[] = [];
	private placeholder: ChatMessage | undefined;
	private virtualArchivedCount = 0;
	private unreadCount = 0;
	private lastReadIndex = -1;
	private previousManualScroll = false;

	public constructor(yogaNode: YogaNode, yoga: Yoga, parent?: SumoNode, options: ChatPagerOptions = {}) {
		super(yogaNode, parent);
		this.yoga = yoga;
		this.renderControls = options.renderControls ?? { scheduleRender: noop, setStreamingMode: noop };
		this.maxRenderedMessages = Math.max(1, Math.round(options.maxRenderedMessages ?? DEFAULT_MAX_RENDERED_MESSAGES));
		this.chatMessageOptions = { primaryAgentName: options.primaryAgentName };
		this.flexGrow = 1;
		this.flexShrink = 1;
		// `flexBasis: 0` is the canonical viewport contract: the pager never
		// claims its content's natural size as a layout hint. Without this Yoga
		// can fall back to a min-content cross-size (e.g. height 1) when the
		// pager sits next to fixed-width siblings, collapsing the chat region
		// after a scroll-state change. See OwnedShellRenderer chat-row mount.
		this.flexBasis = 0;
		this.flexDirection = FLEX_DIRECTION_COLUMN;
		this.scrollBox = new ScrollBox(yoga.Node.create(), this, {
			stickyBottom: options.stickyBottom ?? true,
			onScrollStateChange: (state) => this.handleScrollStateChange(state),
		});
		this.banner = new ScrolledUpBanner(yoga.Node.create(), this, {
			isVisible: () => this.shouldShowBanner(),
			getUnreadCount: () => this.unreadCount,
			onJumpToBottom: () => this.jumpToBottom(),
		});
	}

	public static create(yoga: Yoga, parent?: SumoNode, options: ChatPagerOptions = {}): ChatPager {
		return new ChatPager(yoga.Node.create(), yoga, parent, options);
	}

	public addMessage(role: ChatMessageRole, text: string, timestamp?: Date): ChatMessage {
		return this.addChatMessage(ChatMessage.create(this.yoga, role, text, undefined, timestamp, undefined, this.chatMessageOptions));
	}

	public addViewModel(message: ChatMessageViewModel): ChatMessage {
		return this.addPreparedMessage(prepareChatMessage(message));
	}

	public replaceViewModels(messages: readonly ChatMessageViewModel[]): ChatPagerReplaceStats {
		const previousHeight = this.scrollBox.scrollHeight;
		const width = this.scrollBox.getComputedWidth();
		const renderedWindow: PreparedChatMessage[] = [];
		let acceptedMessages = 0;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || !hasRenderablePlainText(message)) continue;
			acceptedMessages += 1;
			if (renderedWindow.length < this.maxRenderedMessages) {
				renderedWindow.push(prepareChatMessage(message));
			}
		}
		const orderedWindow = renderedWindow.reverse();
		this.disposeMessageNodes();
		this.activeMessages.length = 0;
		this.archivedMessages = [];
		this.virtualArchivedCount = Math.max(0, acceptedMessages - renderedWindow.length);
		this.placeholder = undefined;
		this.unreadCount = 0;
		this.previousManualScroll = false;
		this.scrollBox.manualScroll = false;

		for (const message of orderedWindow) {
			this.activeMessages.push(this.createChatMessage(message));
		}
		if (this.virtualArchivedCount > 0) {
			this.placeholder = this.createPlaceholder();
		}
		this.rebuildRenderedChildren();
		this.lastReadIndex = this.getTotalMessageCount() - 1;
		this.scrollBox.notifyContentChanged(this.getRenderedEstimatedHeight(width), previousHeight);
		this.scheduleRender();
		return {
			sourceMessages: messages.length,
			acceptedMessages,
			renderedMessages: this.activeMessages.length,
			archivedMessages: this.getArchivedMessageCount(),
		};
	}

	public beginStreaming(): void {
		this.renderControls.setStreamingMode(true);
	}

	public appendToLast(chunk: string): void {
		if (chunk.length === 0) return;
		const last = this.getLastMessage();
		if (!last) {
			this.addMessage("sumo", chunk);
			return;
		}
		const width = this.scrollBox.getComputedWidth();
		const beforeHeight = last.getEstimatedHeight(width);
		last.appendText(chunk);
		const afterHeight = last.getEstimatedHeight(width);
		this.scrollBox.notifyContentChanged(Math.max(0, afterHeight - beforeHeight), Math.max(0, beforeHeight - afterHeight));
		this.beginStreaming();
		this.scheduleRender();
	}

	public replaceLast(text: string): void {
		const last = this.getLastMessage();
		if (!last) {
			this.addMessage("sumo", text);
			return;
		}
		if (last.text === text) return;
		this.updateLast(last, () => last.setText(text));
	}

	public replaceLastWithViewModel(message: ChatMessageViewModel): void {
		const last = this.getLastMessage();
		if (!last) {
			this.addViewModel(message);
			return;
		}
		last.role = chatRoleFromViewModel(message);
		this.updateLast(last, () => last.setBlocks(message.blocks, chatMessageViewModelToPlainText(message)));
	}

	public setToolExpansion(expanded: boolean): void {
		const width = this.scrollBox.getComputedWidth();
		let beforeHeight = 0;
		let afterHeight = 0;
		let changed = false;
		for (const message of this.activeMessages) {
			beforeHeight += message.getEstimatedHeight(width);
			changed = message.setToolExpansion(expanded) || changed;
			afterHeight += message.getEstimatedHeight(width);
		}
		if (!changed) return;
		this.scrollBox.notifyContentChanged(Math.max(0, afterHeight - beforeHeight), Math.max(0, beforeHeight - afterHeight));
		this.scheduleRender();
	}

	public endStreaming(): void {
		this.renderControls.setStreamingMode(false);
	}

	public clearMessages(): void {
		const previousHeight = this.scrollBox.scrollHeight;
		this.disposeMessageNodes();
		this.activeMessages.length = 0;
		this.archivedMessages = [];
		this.virtualArchivedCount = 0;
		this.placeholder = undefined;
		this.unreadCount = 0;
		this.lastReadIndex = -1;
		this.previousManualScroll = false;
		this.scrollBox.manualScroll = false;
		this.scrollBox.notifyContentChanged(0, previousHeight);
		this.scheduleRender();
	}

	public getRenderedMessages(): readonly ChatMessage[] {
		return this.activeMessages;
	}

	public getLastMessage(): ChatMessage | undefined {
		return this.activeMessages[this.activeMessages.length - 1] ?? this.archivedMessages[this.archivedMessages.length - 1];
	}

	public getUnreadCount(): number {
		return this.unreadCount;
	}

	public getArchivedMessageCount(): number {
		return this.virtualArchivedCount + this.archivedMessages.length;
	}

	public getLastReadIndex(): number {
		return this.lastReadIndex;
	}

	public hasMessages(): boolean {
		return this.getTotalMessageCount() > 0;
	}

	public handleKey(event: KeyEvent): boolean {
		return this.scrollBox.handleKey(event);
	}

	public handleMouseEvent(event: MouseEvent): boolean {
		return this.scrollBox.handleMouseEvent(event);
	}

	private addChatMessage(message: ChatMessage): ChatMessage {
		const wasReadingHistory = this.isReadingHistory();
		const addedLines = message.getEstimatedHeight(this.scrollBox.getComputedWidth());
		this.activeMessages.push(message);
		this.scrollBox.addChild(message);
		const virtualized = this.virtualizeIfNeeded();
		if (wasReadingHistory) this.unreadCount += 1;
		this.scrollBox.notifyContentChanged(addedLines + virtualized.addedLines, virtualized.removedLines);
		this.scheduleRender();
		return message;
	}

	private addPreparedMessage(message: PreparedChatMessage): ChatMessage {
		return this.addChatMessage(this.createChatMessage(message));
	}

	private createChatMessage(message: PreparedChatMessage): ChatMessage {
		return ChatMessage.create(
			this.yoga,
			message.role,
			message.text,
			undefined,
			message.timestamp,
			message.blocks,
			this.chatMessageOptions,
		);
	}

	private updateLast(message: ChatMessage, update: () => void): void {
		const width = this.scrollBox.getComputedWidth();
		const beforeHeight = message.getEstimatedHeight(width);
		update();
		const afterHeight = message.getEstimatedHeight(width);
		this.scrollBox.notifyContentChanged(Math.max(0, afterHeight - beforeHeight), Math.max(0, beforeHeight - afterHeight));
		this.scheduleRender();
	}

	private scheduleRender(): void {
		this.renderControls.scheduleRender();
	}

	private isReadingHistory(): boolean {
		return this.scrollBox.manualScroll && !this.scrollBox.isAtBottom();
	}

	private shouldShowBanner(): boolean {
		return this.scrollBox.manualScroll && !this.scrollBox.isAtBottom();
	}

	private jumpToBottom(): void {
		this.scrollBox.scrollToBottom();
		this.scrollBox.manualScroll = false;
		this.unreadCount = 0;
		this.lastReadIndex = this.getTotalMessageCount() - 1;
		this.scheduleRender();
	}

	private virtualizeIfNeeded(): { addedLines: number; removedLines: number } {
		let removedLines = 0;
		let addedLines = 0;
		let archivedAny = false;
		const width = this.scrollBox.getComputedWidth();
		while (this.activeMessages.length > this.maxRenderedMessages) {
			const archived = this.activeMessages.shift();
			if (!archived) break;
			removedLines += archived.getEstimatedHeight(width);
			this.archivedMessages.push(archived);
			if (archived.parent === this.scrollBox) this.scrollBox.removeChild(archived);
			archivedAny = true;
		}

		if (this.getArchivedMessageCount() === 0) return { addedLines, removedLines };
		const placeholderText = this.placeholderText();
		if (!this.placeholder) {
			this.placeholder = this.createPlaceholder();
			addedLines += this.placeholder.getEstimatedHeight(width);
			this.rebuildRenderedChildren();
		} else if (this.placeholder.text !== placeholderText) {
			this.placeholder.setText(placeholderText);
		}
		if (archivedAny && this.placeholder.parent !== this.scrollBox) this.rebuildRenderedChildren();
		return { addedLines, removedLines };
	}

	private createPlaceholder(): ChatMessage {
		return ChatMessage.create(this.yoga, "system", this.placeholderText(), undefined, undefined, undefined, this.chatMessageOptions);
	}

	private placeholderText(): string {
		return `── ${this.getArchivedMessageCount()} earlier messages ──`;
	}

	private getRenderedEstimatedHeight(width: number): number {
		let height = this.placeholder ? this.placeholder.getEstimatedHeight(width) : 0;
		for (const message of this.activeMessages) height += message.getEstimatedHeight(width);
		return height;
	}

	private disposeMessageNodes(): void {
		const nodes = new Set<ChatMessage>([...this.activeMessages, ...this.archivedMessages]);
		if (this.placeholder) nodes.add(this.placeholder);
		for (const child of [...this.scrollBox.children]) this.scrollBox.removeChild(child);
		for (const node of nodes) node.dispose();
	}

	private rebuildRenderedChildren(): void {
		for (const child of [...this.scrollBox.children]) this.scrollBox.removeChild(child);
		if (this.placeholder) this.scrollBox.addChild(this.placeholder);
		for (const message of this.activeMessages) this.scrollBox.addChild(message);
	}

	private handleScrollStateChange(state: ScrollBoxStateChange): void {
		if (state.manualScroll && !state.atBottom && !this.previousManualScroll) {
			this.lastReadIndex = this.getLastVisibleMessageIndex();
		}
		if (!state.manualScroll || state.atBottom) {
			this.unreadCount = 0;
			this.lastReadIndex = this.getTotalMessageCount() - 1;
		}
		this.previousManualScroll = state.manualScroll && !state.atBottom;
	}

	private getTotalMessageCount(): number {
		return this.getArchivedMessageCount() + this.activeMessages.length;
	}

	private getLastVisibleMessageIndex(): number {
		const total = this.getTotalMessageCount();
		if (total === 0) return -1;
		const viewportTop = this.scrollBox.scrollOffset;
		const viewportBottom = viewportTop + this.scrollBox.viewportHeight;
		let last = -1;
		if (this.placeholder && this.placeholder.parent === this.scrollBox && this.nodeIntersectsViewport(this.placeholder, viewportTop, viewportBottom)) {
			last = Math.max(last, this.getArchivedMessageCount() - 1);
		}
		for (let index = 0; index < this.activeMessages.length; index += 1) {
			const message = this.activeMessages[index];
			if (message && this.nodeIntersectsViewport(message, viewportTop, viewportBottom)) last = this.getArchivedMessageCount() + index;
		}
		if (last !== -1) return last;
		return this.scrollBox.isAtBottom() ? total - 1 : Math.min(total - 1, this.getArchivedMessageCount());
	}

	private nodeIntersectsViewport(node: ChatMessage, viewportTop: number, viewportBottom: number): boolean {
		const top = node.getComputedTop();
		const bottom = top + node.getComputedHeight();
		return top < viewportBottom && bottom > viewportTop;
	}
}
