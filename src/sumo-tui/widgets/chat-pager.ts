import { sameActivity, type ActivitySnapshot } from "../../activity/domain.js";
import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { chatMessageViewModelToPlainText, type ChatBlock, type ChatMessageViewModel } from "../transcript/view-model.js";
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
	const onlyActivityBlocks = message.blocks.length > 0 && message.blocks.every((block) => block.type === "activity");
	if (message.role === "system" && onlyActivityBlocks) return "tool";
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
	private readonly activityExpansionOverrides = new Map<string, boolean>();
	private readonly activityExpansionStates = new Map<string, boolean>();
	private readonly activityStatuses = new Map<string, ActivitySnapshot["status"]>();
	private defaultActivityExpansionOverride: boolean | undefined;
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
		this.migrateCorrelatedActivityState(this.activitiesFromRenderedMessages(), this.activitiesFromViewModels(messages));
		const transcriptActivityIds = this.activityIdsFromViewModels(messages);
		for (const id of this.activityExpansionOverrides.keys()) {
			if (!transcriptActivityIds.has(id)) this.activityExpansionOverrides.delete(id);
		}
		const width = this.scrollBox.getComputedWidth();
		const renderedWindow: PreparedChatMessage[] = [];
		let acceptedMessages = 0;
		for (const message of messages) {
			const prepared = prepareChatMessage(message);
			if (prepared.text.length === 0) continue;
			const windowSlot = acceptedMessages % this.maxRenderedMessages;
			acceptedMessages += 1;
			if (renderedWindow.length < this.maxRenderedMessages) renderedWindow.push(prepared);
			else renderedWindow[windowSlot] = prepared;
		}
		const windowStart = acceptedMessages > renderedWindow.length ? acceptedMessages % this.maxRenderedMessages : 0;
		const orderedWindow = windowStart === 0 ? renderedWindow : [...renderedWindow.slice(windowStart), ...renderedWindow.slice(0, windowStart)];
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
		this.pruneInactiveActivityState();
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
		this.scrollBox.notifyChildrenResized([{
			top: last.getComputedTop(),
			previousHeight: beforeHeight,
			nextHeight: afterHeight,
		}]);
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
		this.updateMessage(last, () => last.setText(text));
	}

	public replaceLastWithViewModel(message: ChatMessageViewModel): void {
		const lastIndex = this.getTotalMessageCount() - 1;
		if (lastIndex < 0) {
			this.addViewModel(message);
			return;
		}
		this.replaceViewModelAt(lastIndex, message);
	}

	/** Update one rendered transcript node without resetting pager-wide state. */
	public replaceViewModelAt(index: number, message: ChatMessageViewModel): boolean {
		const activeIndex = Math.floor(index) - this.getArchivedMessageCount();
		const target = this.activeMessages[activeIndex];
		if (!target) return false;
		const previousBlocks = target.toSnapshot().blocks ?? [];
		this.migrateCorrelatedActivityState(this.activitiesFromBlocks(previousBlocks), this.activitiesFromBlocks(message.blocks));
		this.updateMessage(target, () => {
			target.setRole(chatRoleFromViewModel(message));
			target.setBlocks(message.blocks, chatMessageViewModelToPlainText(message));
			if (message.timestamp) target.setTimestamp(message.timestamp);
			this.registerActivities(message.blocks);
			this.applyExpansionPresentation(target, message.blocks);
		});
		return true;
	}

	public getActivityExpansion(id: string): boolean {
		return this.activityExpansionOverrides.get(id) ?? this.activityExpansionStates.get(id) ?? true;
	}

	public setActivityExpansion(id: string, expanded: boolean): void {
		this.activityExpansionOverrides.set(id, expanded);
		this.activityExpansionStates.set(id, expanded);
		this.applyActivityExpansion(id, expanded);
	}

	public toggleActivityExpansion(id?: string): boolean {
		if (id === undefined) return this.toggleToolExpansion();
		const expanded = !this.getActivityExpansion(id);
		this.setActivityExpansion(id, expanded);
		return expanded;
	}

	/** Global Ctrl+O policy across Activities and compatibility collapsibles. */
	public toggleToolExpansion(): boolean {
		const hasCollapsedActivity = [...this.activityStatuses.keys()].some((id) => !this.getActivityExpansion(id));
		const compatibilityBlocks = this.activeMessages.flatMap((message) => message.toSnapshot().blocks ?? [])
			.filter((block): block is Extract<ChatBlock, { type: "skill" | "summary" }> => block.type === "skill" || block.type === "summary");
		const hasCollapsedCompatibilityBlock = compatibilityBlocks.some((block) => !block.expanded);
		const hasAnyExpandable = this.activityStatuses.size > 0 || compatibilityBlocks.length > 0;
		const expanded = hasAnyExpandable
			? hasCollapsedActivity || hasCollapsedCompatibilityBlock
			: this.defaultActivityExpansionOverride === undefined || !this.defaultActivityExpansionOverride;
		this.setToolExpansion(expanded);
		return expanded;
	}

	/** Compatibility/global policy API used by Pi's app.tools.expand bridge. */
	public setToolExpansion(expanded: boolean): void {
		this.defaultActivityExpansionOverride = expanded;
		this.activityExpansionOverrides.clear();
		for (const id of this.activityStatuses.keys()) this.activityExpansionStates.set(id, expanded);
		this.applyToolExpansion(expanded);
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
		this.activityExpansionOverrides.clear();
		this.activityExpansionStates.clear();
		this.activityStatuses.clear();
		this.defaultActivityExpansionOverride = undefined;
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
		return this.activeMessages[this.activeMessages.length - 1];
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

	public getMessageCount(): number {
		return this.getTotalMessageCount();
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
		this.registerActivities(message.blocks);
		const chatMessage = ChatMessage.create(
			this.yoga,
			message.role,
			message.text,
			undefined,
			message.timestamp,
			message.blocks,
			this.chatMessageOptions,
		);
		this.applyExpansionPresentation(chatMessage, message.blocks);
		return chatMessage;
	}

	private registerActivities(blocks: readonly ChatMessageViewModel["blocks"][number][]): void {
		for (const block of blocks) {
			if (block.type !== "activity") continue;
			const activity = block.activity;
			const hasState = this.activityExpansionStates.has(activity.id);
			const hasExplicitOverride = this.activityExpansionOverrides.has(activity.id) || this.defaultActivityExpansionOverride !== undefined;
			if (!hasState) {
				const defaultExpanded = this.defaultActivityExpansionOverride ?? (
					activity.status === "queued" || activity.status === "running" || activity.status === "failed"
				);
				this.activityExpansionStates.set(activity.id, defaultExpanded);
			} else if (activity.status === "failed" && !hasExplicitOverride) {
				this.activityExpansionStates.set(activity.id, true);
			}
			this.activityStatuses.set(activity.id, activity.status);
		}
	}

	private activitiesFromBlocks(blocks: readonly ChatBlock[]): ActivitySnapshot[] {
		return blocks.flatMap((block): ActivitySnapshot[] => block.type === "activity" ? [block.activity] : []);
	}

	private activitiesFromViewModels(messages: readonly ChatMessageViewModel[]): ActivitySnapshot[] {
		return messages.flatMap((message) => this.activitiesFromBlocks(message.blocks));
	}

	private activitiesFromRenderedMessages(): ActivitySnapshot[] {
		return this.activeMessages.flatMap((message) => this.activitiesFromBlocks(message.toSnapshot().blocks ?? []));
	}

	private activityIdsFromViewModels(messages: readonly ChatMessageViewModel[]): Set<string> {
		return new Set(this.activitiesFromViewModels(messages).map((activity) => activity.id));
	}

	private migrateCorrelatedActivityState(existing: readonly ActivitySnapshot[], incoming: readonly ActivitySnapshot[]): void {
		for (const next of incoming) {
			const previous = existing.find((candidate) => candidate.id !== next.id && sameActivity(candidate, next));
			if (!previous) continue;
			const previousId = previous.id;
			const nextId = next.id;
			if (this.activityExpansionOverrides.has(previousId) && !this.activityExpansionOverrides.has(nextId)) {
				this.activityExpansionOverrides.set(nextId, this.activityExpansionOverrides.get(previousId)!);
			}
			if (this.activityExpansionStates.has(previousId) && !this.activityExpansionStates.has(nextId)) {
				this.activityExpansionStates.set(nextId, this.activityExpansionStates.get(previousId)!);
			}
			if (this.activityStatuses.has(previousId) && !this.activityStatuses.has(nextId)) {
				this.activityStatuses.set(nextId, this.activityStatuses.get(previousId)!);
			}
			this.activityExpansionOverrides.delete(previousId);
			this.activityExpansionStates.delete(previousId);
			this.activityStatuses.delete(previousId);
		}
	}

	private activeActivityIds(): Set<string> {
		const ids = new Set<string>();
		for (const message of this.activeMessages) {
			for (const block of message.toSnapshot().blocks ?? []) {
				if (block.type === "activity") ids.add(block.activity.id);
			}
		}
		return ids;
	}

	private pruneInactiveActivityState(): void {
		const activeIds = this.activeActivityIds();
		for (const id of this.activityStatuses.keys()) {
			if (activeIds.has(id) || this.activityExpansionOverrides.has(id)) continue;
			this.activityStatuses.delete(id);
			this.activityExpansionStates.delete(id);
		}
	}

	private effectiveActivityExpansions(blocks: readonly ChatMessageViewModel["blocks"][number][]): ReadonlyMap<string, boolean> {
		const states = new Map<string, boolean>();
		for (const block of blocks) {
			if (block.type !== "activity") continue;
			states.set(block.activity.id, this.getActivityExpansion(block.activity.id));
		}
		return states;
	}

	private applyExpansionPresentation(message: ChatMessage, blocks: readonly ChatBlock[]): void {
		if (this.defaultActivityExpansionOverride !== undefined) {
			message.setToolExpansion(this.defaultActivityExpansionOverride);
		}
		// A per-Activity explicit choice wins over the global compatibility policy.
		message.setActivityExpansions(this.effectiveActivityExpansions(blocks));
	}

	private applyActivityExpansion(id: string, expanded: boolean): void {
		this.applyMessageMutations((message) => message.setActivityExpansion(id, expanded));
	}

	private applyToolExpansion(expanded: boolean): void {
		this.applyMessageMutations((message) => message.setToolExpansion(expanded));
	}

	private applyMessageMutations(mutate: (message: ChatMessage) => boolean): void {
		const width = this.scrollBox.getComputedWidth();
		const changes: Array<{ top: number; previousHeight: number; nextHeight: number }> = [];
		for (const message of this.activeMessages) {
			const previousHeight = message.getEstimatedHeight(width);
			const top = message.getComputedTop();
			if (!mutate(message)) continue;
			changes.push({ top, previousHeight, nextHeight: message.getEstimatedHeight(width) });
		}
		if (changes.length === 0) return;
		this.scrollBox.notifyChildrenResized(changes);
		this.scheduleRender();
	}

	private updateMessage(message: ChatMessage, update: () => void): void {
		const width = this.scrollBox.getComputedWidth();
		const previousHeight = message.getEstimatedHeight(width);
		const top = message.getComputedTop();
		update();
		const nextHeight = message.getEstimatedHeight(width);
		this.scrollBox.notifyChildrenResized([{ top, previousHeight, nextHeight }]);
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
			if (archived.parent === this.scrollBox) this.scrollBox.removeChild(archived);
			archived.dispose();
			this.virtualArchivedCount += 1;
			archivedAny = true;
		}

		this.pruneInactiveActivityState();
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
