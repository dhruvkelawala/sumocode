import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { ChatMessage, type ChatMessageRole } from "./chat-message.js";
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
}

const DEFAULT_MAX_RENDERED_MESSAGES = 200;

function noop(): void {}

/** Stateful chat scrollback wrapper: messages + ScrollBox + unread banner. */
export class ChatPager extends SumoNode {
	public readonly scrollBox: ScrollBox;
	public readonly banner: ScrolledUpBanner;
	public archivedMessages: ChatMessage[] = [];
	private readonly yoga: Yoga;
	private readonly renderControls: ChatPagerRenderControls;
	private readonly maxRenderedMessages: number;
	private readonly activeMessages: ChatMessage[] = [];
	private placeholder: ChatMessage | undefined;
	private unreadCount = 0;
	private lastReadIndex = -1;
	private previousManualScroll = false;

	public constructor(yogaNode: YogaNode, yoga: Yoga, parent?: SumoNode, options: ChatPagerOptions = {}) {
		super(yogaNode, parent);
		this.yoga = yoga;
		this.renderControls = options.renderControls ?? { scheduleRender: noop, setStreamingMode: noop };
		this.maxRenderedMessages = Math.max(1, Math.round(options.maxRenderedMessages ?? DEFAULT_MAX_RENDERED_MESSAGES));
		this.flexGrow = 1;
		this.flexShrink = 1;
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

	public addMessage(role: ChatMessageRole, text: string): ChatMessage {
		const wasReadingHistory = this.isReadingHistory();
		const message = ChatMessage.create(this.yoga, role, text);
		const addedLines = message.getEstimatedHeight(this.scrollBox.getComputedWidth());
		this.activeMessages.push(message);
		this.scrollBox.addChild(message);
		const virtualized = this.virtualizeIfNeeded();
		if (wasReadingHistory) this.unreadCount += 1;
		this.scrollBox.notifyContentChanged(addedLines + virtualized.addedLines, virtualized.removedLines);
		this.scheduleRender();
		return message;
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
		this.renderControls.setStreamingMode(true);
		this.scheduleRender();
	}

	public replaceLast(text: string): void {
		const last = this.getLastMessage();
		if (!last) {
			this.addMessage("sumo", text);
			return;
		}
		if (last.text === text) return;
		const width = this.scrollBox.getComputedWidth();
		const beforeHeight = last.getEstimatedHeight(width);
		last.setText(text);
		const afterHeight = last.getEstimatedHeight(width);
		this.scrollBox.notifyContentChanged(Math.max(0, afterHeight - beforeHeight), Math.max(0, beforeHeight - afterHeight));
		this.scheduleRender();
	}

	public endStreaming(): void {
		this.renderControls.setStreamingMode(false);
	}

	public clearMessages(): void {
		const previousHeight = this.scrollBox.scrollHeight;
		for (const child of [...this.scrollBox.children]) this.scrollBox.removeChild(child);
		this.activeMessages.length = 0;
		this.archivedMessages = [];
		this.placeholder = undefined;
		this.unreadCount = 0;
		this.lastReadIndex = -1;
		this.previousManualScroll = false;
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

	public getLastReadIndex(): number {
		return this.lastReadIndex;
	}

	public handleKey(event: KeyEvent): boolean {
		return this.scrollBox.handleKey(event);
	}

	public handleMouseEvent(event: MouseEvent): boolean {
		return this.scrollBox.handleMouseEvent(event);
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

		if (this.archivedMessages.length === 0) return { addedLines, removedLines };
		const placeholderText = `── ${this.archivedMessages.length} earlier messages ──`;
		if (!this.placeholder) {
			this.placeholder = ChatMessage.create(this.yoga, "system", placeholderText);
			addedLines += this.placeholder.getEstimatedHeight(width);
			this.rebuildRenderedChildren();
		} else if (this.placeholder.text !== placeholderText) {
			this.placeholder.setText(placeholderText);
		}
		if (archivedAny && this.placeholder.parent !== this.scrollBox) this.rebuildRenderedChildren();
		return { addedLines, removedLines };
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
		return this.archivedMessages.length + this.activeMessages.length;
	}

	private getLastVisibleMessageIndex(): number {
		const total = this.getTotalMessageCount();
		if (total === 0) return -1;
		const viewportTop = this.scrollBox.scrollOffset;
		const viewportBottom = viewportTop + this.scrollBox.viewportHeight;
		let last = -1;
		if (this.placeholder && this.placeholder.parent === this.scrollBox && this.nodeIntersectsViewport(this.placeholder, viewportTop, viewportBottom)) {
			last = Math.max(last, this.archivedMessages.length - 1);
		}
		for (let index = 0; index < this.activeMessages.length; index += 1) {
			const message = this.activeMessages[index];
			if (message && this.nodeIntersectsViewport(message, viewportTop, viewportBottom)) last = this.archivedMessages.length + index;
		}
		if (last !== -1) return last;
		return this.scrollBox.isAtBottom() ? total - 1 : Math.min(total - 1, this.archivedMessages.length);
	}

	private nodeIntersectsViewport(node: ChatMessage, viewportTop: number, viewportBottom: number): boolean {
		const top = node.getComputedTop();
		const bottom = top + node.getComputedHeight();
		return top < viewportBottom && bottom > viewportTop;
	}
}
