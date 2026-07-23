import { createHash } from "node:crypto";
import { isSettledActivityStatus, mergeActivitySnapshot, sameActivity, type ActivitySnapshot } from "../../activity/domain.js";
import { ACTIVITY_UI_MAX_EXPANSION_ENTRIES } from "../../activity/store.js";
import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import {
	isFoldableBlock,
	matchingFoldableBlockIndex,
	upsertActivityBlock,
	upsertFoldableBlock,
	type ActivityBlock,
	type FoldableBlock,
} from "../transcript/activity-fold.js";
import { activityCardViewModel } from "../transcript/activity-view-model.js";
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
	readonly maxActivityBookkeepingEntries?: number;
	readonly onActivityExpansionChange?: (id: string, expanded: boolean) => void;
	readonly onActivityExpansionMigration?: (previousId: string, nextId: string, expanded: boolean) => void;
	readonly onAllActivityExpansionChange?: (expanded: boolean, activityIds: readonly string[]) => void;
}

export interface ChatPagerReplaceStats {
	readonly sourceMessages: number;
	readonly acceptedMessages: number;
	readonly renderedMessages: number;
	readonly archivedMessages: number;
}

const DEFAULT_MAX_RENDERED_MESSAGES = 200;

function noop(): void {}

function activityExpansionPersistenceKey(activity: ActivitySnapshot): string {
	if (activity.kind !== "subagent" || !activity.sourceId) return activity.id;
	const generation = createHash("sha256").update(activity.sourceId, "utf8").digest("hex").slice(0, 12);
	return `${activity.id}#${generation}`;
}

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

interface ActivityCorrelationIndex {
	readonly byId: ReadonlyMap<string, readonly ActivitySnapshot[]>;
	readonly bySourceId: ReadonlyMap<string, readonly ActivitySnapshot[]>;
}

function activityCorrelationIndex(activities: readonly ActivitySnapshot[]): ActivityCorrelationIndex {
	const byId = new Map<string, ActivitySnapshot[]>();
	const bySourceId = new Map<string, ActivitySnapshot[]>();
	for (const activity of activities) {
		byId.set(activity.id, [...byId.get(activity.id) ?? [], activity]);
		if (activity.sourceId) bySourceId.set(activity.sourceId, [...bySourceId.get(activity.sourceId) ?? [], activity]);
	}
	return { byId, bySourceId };
}

function correlatedActivity(index: ActivityCorrelationIndex, activity: ActivitySnapshot): ActivitySnapshot | undefined {
	const candidates = new Set<ActivitySnapshot>([
		...(index.byId.get(activity.id) ?? []),
		...(activity.sourceId ? index.bySourceId.get(activity.sourceId) ?? [] : []),
		...(activity.sourceId ? index.byId.get(activity.sourceId) ?? [] : []),
		...(index.bySourceId.get(activity.id) ?? []),
	]);
	return [...candidates].find((candidate) => sameActivity(candidate, activity));
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
	private readonly maxActivityBookkeepingEntries: number;
	private readonly onActivityExpansionChange: ((id: string, expanded: boolean) => void) | undefined;
	private readonly onActivityExpansionMigration: ((previousId: string, nextId: string, expanded: boolean) => void) | undefined;
	private readonly onAllActivityExpansionChange: ((expanded: boolean, activityIds: readonly string[]) => void) | undefined;
	private readonly activeMessages: ChatMessage[] = [];
	private readonly activeMessageSourceIndices: number[] = [];
	private readonly transcriptOwnedMessages = new Set<ChatMessage>();
	private readonly feedOwnedActivityIds = new Map<ChatMessage, Set<string>>();
	private readonly feedActivities = new Map<string, ActivitySnapshot>();
	private readonly transcriptClaimedActivityStatuses = new Map<string, ActivitySnapshot["status"]>();
	private readonly virtualizedFeedActivityIds = new Set<string>();
	private readonly virtualizedFeedOnlyActivityIds = new Set<string>();
	private readonly virtualizedTranscriptFeedActivityIds = new Set<string>();
	private readonly materializedArchivedTranscriptFeedActivityIds = new Set<string>();
	/** Claim index proportional to the retained transcript, not optional expansion bookkeeping. */
	private readonly virtualizedTranscriptClaimIds = new Set<string>();
	private nextFeedSourceIndex = -1;
	private readonly activityExpansionOverrides = new Map<string, boolean>();
	private readonly persistedActivityExpansionOverrides = new Map<string, boolean>();
	private readonly activityExpansionPersistenceKeys = new Map<string, string>();
	private readonly activityExpansionStates = new Map<string, boolean>();
	private readonly activityStatuses = new Map<string, ActivitySnapshot["status"]>();
	private readonly activityBookkeepingLru = new Map<string, true>();
	private readonly pendingRenderedActivityIds = new Set<string>();
	private defaultActivityExpansionOverride: boolean | undefined;
	private placeholder: ChatMessage | undefined;
	private virtualArchivedCount = 0;
	private sourceMessageCount = 0;
	private unreadCount = 0;
	private lastReadIndex = -1;
	private previousManualScroll = false;

	public constructor(yogaNode: YogaNode, yoga: Yoga, parent?: SumoNode, options: ChatPagerOptions = {}) {
		super(yogaNode, parent);
		this.yoga = yoga;
		this.renderControls = options.renderControls ?? { scheduleRender: noop, setStreamingMode: noop };
		this.maxRenderedMessages = Math.max(1, Math.round(options.maxRenderedMessages ?? DEFAULT_MAX_RENDERED_MESSAGES));
		this.chatMessageOptions = { primaryAgentName: options.primaryAgentName };
		this.maxActivityBookkeepingEntries = Math.max(1, Math.floor(options.maxActivityBookkeepingEntries ?? ACTIVITY_UI_MAX_EXPANSION_ENTRIES));
		this.onActivityExpansionChange = options.onActivityExpansionChange;
		this.onActivityExpansionMigration = options.onActivityExpansionMigration;
		this.onAllActivityExpansionChange = options.onAllActivityExpansionChange;
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

	public addViewModel(message: ChatMessageViewModel, sourceIndex?: number): ChatMessage {
		const effectiveSourceIndex = sourceIndex ?? this.sourceMessageCount;
		const virtualFeedIds = this.claimVirtualizedFeedActivities(message);
		const claimed = this.claimFeedCards(message, effectiveSourceIndex);
		let result: ChatMessage;
		if (claimed?.residual) result = this.addPreparedMessage(prepareChatMessage(claimed.residual), effectiveSourceIndex, true);
		else if (claimed) result = claimed.primary;
		else result = this.addPreparedMessage(prepareChatMessage(message), sourceIndex, true);
		for (const id of virtualFeedIds) this.addFeedOwnership(result, id);
		return result;
	}

	public replaceViewModels(messages: readonly ChatMessageViewModel[]): ChatPagerReplaceStats {
		const previousHeight = this.scrollBox.scrollHeight;
		const feedActivities = [...this.feedActivities.values()];
		const feedIndex = activityCorrelationIndex(feedActivities);
		this.transcriptClaimedActivityStatuses.clear();
		for (const activity of this.activitiesFromViewModels(messages)) {
			const feedActivity = correlatedActivity(feedIndex, activity);
			if (feedActivity) this.transcriptClaimedActivityStatuses.set(feedActivity.id, activity.status);
		}
		this.migrateCorrelatedActivityState(this.activitiesFromRenderedMessages(), this.activitiesFromViewModels(messages));
		const width = this.scrollBox.getComputedWidth();
		const renderedWindow: Array<{ message: PreparedChatMessage; sourceIndex: number }> = [];
		let acceptedMessages = 0;
		for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
			const prepared = prepareChatMessage(messages[sourceIndex]!);
			if (prepared.text.length === 0) continue;
			const windowSlot = acceptedMessages % this.maxRenderedMessages;
			acceptedMessages += 1;
			const entry = { message: prepared, sourceIndex };
			if (renderedWindow.length < this.maxRenderedMessages) renderedWindow.push(entry);
			else renderedWindow[windowSlot] = entry;
		}
		const windowStart = acceptedMessages > renderedWindow.length ? acceptedMessages % this.maxRenderedMessages : 0;
		const orderedWindow = windowStart === 0 ? renderedWindow : [...renderedWindow.slice(windowStart), ...renderedWindow.slice(0, windowStart)];
		const renderedSourceIndices = new Set(orderedWindow.map((entry) => entry.sourceIndex));
		this.pendingRenderedActivityIds.clear();
		for (const entry of orderedWindow) {
			for (const activity of this.activitiesFromBlocks(entry.message.blocks)) this.pendingRenderedActivityIds.add(activity.id);
		}
		const archivedTranscriptFeedIds = new Set<string>();
		for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
			if (renderedSourceIndices.has(sourceIndex)) continue;
			const message = messages[sourceIndex];
			if (!message || prepareChatMessage(message).text.length === 0) continue;
			for (const activity of this.activitiesFromBlocks(message.blocks)) {
				const feedActivity = correlatedActivity(feedIndex, activity);
				if (feedActivity) archivedTranscriptFeedIds.add(feedActivity.id);
			}
		}
		this.disposeMessageNodes();
		this.activeMessages.length = 0;
		this.activeMessageSourceIndices.length = 0;
		this.transcriptOwnedMessages.clear();
		this.feedOwnedActivityIds.clear();
		this.virtualizedFeedActivityIds.clear();
		this.virtualizedFeedOnlyActivityIds.clear();
		this.virtualizedTranscriptFeedActivityIds.clear();
		this.materializedArchivedTranscriptFeedActivityIds.clear();
		this.virtualizedTranscriptClaimIds.clear();
		for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
			if (renderedSourceIndices.has(sourceIndex)) continue;
			for (const activity of this.activitiesFromBlocks(messages[sourceIndex]?.blocks ?? [])) this.noteVirtualizedTranscriptActivity(activity);
		}
		for (const id of archivedTranscriptFeedIds) {
			this.virtualizedFeedActivityIds.add(id);
			this.virtualizedTranscriptFeedActivityIds.add(id);
		}
		this.archivedMessages = [];
		this.virtualArchivedCount = Math.max(0, acceptedMessages - renderedWindow.length);
		this.sourceMessageCount = messages.length;
		this.placeholder = undefined;
		this.unreadCount = 0;
		this.previousManualScroll = false;
		this.scrollBox.manualScroll = false;

		for (const entry of orderedWindow) {
			const message = this.createChatMessage(entry.message);
			this.activeMessages.push(message);
			this.activeMessageSourceIndices.push(entry.sourceIndex);
			this.transcriptOwnedMessages.add(message);
		}
		this.pendingRenderedActivityIds.clear();
		this.pruneInactiveActivityState();
		if (this.virtualArchivedCount > 0) {
			this.placeholder = this.createPlaceholder();
		}
		this.rebuildRenderedChildren();
		this.scrollBox.notifyContentChanged(this.getRenderedEstimatedHeight(width), previousHeight);
		this.reconcileFeedActivities(feedActivities);
		this.lastReadIndex = this.getTotalMessageCount() - 1;
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

	public replaceLastWithViewModel(message: ChatMessageViewModel, sourceIndex?: number): boolean {
		const targetSourceIndex = sourceIndex ?? this.activeMessageSourceIndices.at(-1);
		if (targetSourceIndex === undefined) {
			this.addViewModel(message);
			return true;
		}
		return this.replaceViewModelAt(targetSourceIndex, message);
	}

	/** Update one rendered transcript node without resetting pager-wide state. */
	public replaceViewModelAt(index: number, message: ChatMessageViewModel): boolean {
		const sourceIndex = Math.floor(index);
		const activeIndex = this.activeMessageSourceIndices.indexOf(sourceIndex);
		const target = this.activeMessages[activeIndex];
		if (!target) return false;
		const previousBlocks = target.toSnapshot().blocks ?? [];
		const feedIds = this.feedOwnedActivityIds.get(target) ?? new Set<string>();
		let nextBlocks = [...message.blocks];
		for (const id of feedIds) {
			const activity = this.feedActivities.get(id);
			if (activity) nextBlocks = upsertActivityBlock(nextBlocks, { type: "activity", activity });
		}
		const effectiveMessage = nextBlocks === message.blocks ? message : { ...message, blocks: nextBlocks };
		const prepared = prepareChatMessage(effectiveMessage);
		const previousActivities = this.activitiesFromBlocks(previousBlocks);
		this.migrateCorrelatedActivityState(previousActivities, this.activitiesFromBlocks(nextBlocks));
		if (prepared.text.length === 0) {
			this.removeRenderedMessageAt(activeIndex, target);
			this.discardActivitiesRemovedByRewrite(previousActivities);
			return true;
		}
		this.updateMessage(target, () => {
			target.setRole(prepared.role);
			target.setBlocks(prepared.blocks, prepared.text);
			if (prepared.timestamp) target.setTimestamp(prepared.timestamp);
			this.registerActivities(prepared.blocks);
			this.applyExpansionPresentation(target, prepared.blocks);
		});
		this.discardActivitiesRemovedByRewrite(previousActivities);
		return true;
	}

	public getActivityExpansion(id: string): boolean {
		return this.activityExpansionOverrides.get(id) ?? this.activityExpansionStates.get(id) ?? true;
	}

	public setActivityExpansion(id: string, expanded: boolean): void {
		if (!this.currentActivityIds().has(id)) return;
		this.touchActivityBookkeeping(id);
		this.activityExpansionOverrides.set(id, expanded);
		this.activityExpansionStates.set(id, expanded);
		const persistenceKey = this.activityExpansionPersistenceKeys.get(id) ?? id;
		this.setPersistedActivityExpansion(persistenceKey, expanded);
		this.applyActivityExpansion(id, expanded);
		this.onActivityExpansionChange?.(persistenceKey, expanded);
	}

	/** Apply host-owned persisted UI state without writing it back to the producer. */
	public applyActivityExpansionSnapshot(expansion: Readonly<Record<string, boolean>>, defaultExpansion?: boolean): void {
		const currentIds = this.ownedActivityIds();
		const currentKeys = new Set([...currentIds].map((id) => this.activityExpansionPersistenceKeys.get(id) ?? id));
		this.persistedActivityExpansionOverrides.clear();
		for (const [id, expanded] of Object.entries(expansion)) {
			if (currentKeys.has(id)) this.setPersistedActivityExpansion(id, expanded);
		}
		this.activityExpansionOverrides.clear();
		this.defaultActivityExpansionOverride = defaultExpansion;
		for (const id of currentIds) {
			this.touchActivityBookkeeping(id);
			const persistenceKey = this.activityExpansionPersistenceKeys.get(id) ?? id;
			const expanded = this.persistedActivityExpansionOverrides.get(persistenceKey) ?? defaultExpansion;
			if (expanded !== undefined) {
				this.activityExpansionOverrides.set(id, expanded);
				this.activityExpansionStates.set(id, expanded);
			}
		}
		this.applyMessageMutations((message) => {
			let changed = defaultExpansion === undefined ? false : message.setToolExpansion(defaultExpansion);
			for (const [id, expanded] of this.activityExpansionOverrides) {
				changed = message.setActivityExpansion(id, expanded) || changed;
			}
			return changed;
		});
	}

	public getKnownActivityIds(): readonly string[] {
		return [...this.currentActivityIds()];
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
		const ids = this.getKnownActivityIds();
		const persistenceKeys: string[] = [];
		for (const id of ids) {
			this.activityExpansionOverrides.set(id, expanded);
			this.activityExpansionStates.set(id, expanded);
			this.touchActivityBookkeeping(id);
			const persistenceKey = this.activityExpansionPersistenceKeys.get(id) ?? id;
			this.setPersistedActivityExpansion(persistenceKey, expanded);
			persistenceKeys.push(persistenceKey);
		}
		this.applyToolExpansion(expanded);
		this.onAllActivityExpansionChange?.(expanded, persistenceKeys);
	}

	public endStreaming(): void {
		this.renderControls.setStreamingMode(false);
	}

	public clearMessages(): void {
		const previousHeight = this.scrollBox.scrollHeight;
		this.disposeMessageNodes();
		this.activeMessages.length = 0;
		this.activeMessageSourceIndices.length = 0;
		this.archivedMessages = [];
		this.virtualArchivedCount = 0;
		this.sourceMessageCount = 0;
		this.activityExpansionOverrides.clear();
		this.persistedActivityExpansionOverrides.clear();
		this.activityExpansionPersistenceKeys.clear();
		this.activityExpansionStates.clear();
		this.activityStatuses.clear();
		this.activityBookkeepingLru.clear();
		this.pendingRenderedActivityIds.clear();
		this.transcriptOwnedMessages.clear();
		this.feedOwnedActivityIds.clear();
		this.feedActivities.clear();
		this.transcriptClaimedActivityStatuses.clear();
		this.virtualizedFeedActivityIds.clear();
		this.virtualizedFeedOnlyActivityIds.clear();
		this.virtualizedTranscriptFeedActivityIds.clear();
		this.materializedArchivedTranscriptFeedActivityIds.clear();
		this.virtualizedTranscriptClaimIds.clear();
		this.defaultActivityExpansionOverride = undefined;
		this.placeholder = undefined;
		this.unreadCount = 0;
		this.lastReadIndex = -1;
		this.previousManualScroll = false;
		this.scrollBox.manualScroll = false;
		this.scrollBox.notifyContentChanged(0, previousHeight);
		this.scheduleRender();
	}

	/** Reconcile durable feed cards by Activity identity without rebuilding chat. */
	public reconcileFeedActivities(activities: readonly ActivitySnapshot[]): void {
		const previous = [...this.feedActivities.values()];
		const previousIndex = activityCorrelationIndex(previous);
		const incomingIndex = activityCorrelationIndex(activities);
		const releasedFeedIds = new Set<string>();
		const renderedActivityMessages = new Map<ActivitySnapshot, ChatMessage>();
		for (const message of this.activeMessages) {
			for (const activity of this.activitiesFromBlocks(message.toSnapshot().blocks ?? [])) renderedActivityMessages.set(activity, message);
		}
		const renderedIndex = activityCorrelationIndex([...renderedActivityMessages.keys()]);
		let removedVirtualLines = 0;
		for (const oldActivity of previous) {
			if (!correlatedActivity(incomingIndex, oldActivity)) {
				removedVirtualLines += this.removeFeedOwnership(oldActivity.id);
				releasedFeedIds.add(oldActivity.id);
			}
		}
		this.feedActivities.clear();
		const ordered = [...activities].sort((left, right) => {
			const time = (left.createdAt ?? 0) - (right.createdAt ?? 0);
			return time !== 0 ? time : left.id.localeCompare(right.id);
		});
		for (const activity of ordered) {
			const previousActivity = correlatedActivity(previousIndex, activity);
			this.feedActivities.set(activity.id, activity);
			const virtualized = previousActivity && this.virtualizedFeedActivityIds.has(previousActivity.id);
			const materializedArchivedTranscript = previousActivity && this.materializedArchivedTranscriptFeedActivityIds.has(previousActivity.id);
			if (materializedArchivedTranscript && isSettledActivityStatus(this.effectiveFeedStatus(activity))) {
				if (previousActivity.id !== activity.id) {
					this.transferVirtualizedFeedIdentity(previousActivity.id, activity.id);
					this.migrateFeedActivityState([previousActivity], activity);
				}
				this.returnMaterializedCardToTranscriptArchive(activity);
				continue;
			}
			const rematerializingArchivedTranscript = previousActivity && virtualized && this.virtualizedTranscriptFeedActivityIds.has(previousActivity.id);
			if (virtualized && isSettledActivityStatus(this.effectiveFeedStatus(activity))) {
				if (previousActivity.id !== activity.id) {
					this.transferVirtualizedFeedIdentity(previousActivity.id, activity.id);
					this.migrateFeedActivityState([previousActivity], activity);
				}
				// Settled cards remain count-only history even when their cached feed
				// snapshot changes. Only a transition back to live may rematerialize.
				continue;
			}
			if (previousActivity && previousActivity.id !== activity.id) {
				removedVirtualLines += this.releaseVirtualizedFeedActivity(previousActivity.id);
				this.transferFeedOwnership(previousActivity.id, activity.id);
				this.migrateFeedActivityState([previousActivity], activity);
			}
			removedVirtualLines += this.releaseVirtualizedFeedActivity(activity.id);
			if (rematerializingArchivedTranscript) this.materializedArchivedTranscriptFeedActivityIds.add(activity.id);
			const renderedActivity = correlatedActivity(renderedIndex, activity);
			const target = renderedActivity ? renderedActivityMessages.get(renderedActivity) : undefined;
			if (target) {
				this.addFeedOwnership(target, activity.id);
				this.updateActivityInMessage(target, activity);
				continue;
			}
			this.addPreparedMessage(prepareChatMessage(activityCardViewModel(activity)), this.nextFeedSourceIndex--, false, activity.id);
		}
		for (const id of releasedFeedIds) {
			if (!this.feedActivities.has(id)) this.touchActivityBookkeeping(id);
		}
		const virtualized = this.virtualizeIfNeeded();
		if (virtualized.addedLines > 0 || virtualized.removedLines > 0 || removedVirtualLines > 0) {
			this.scrollBox.notifyContentChanged(virtualized.addedLines, virtualized.removedLines + removedVirtualLines);
		}
		this.pruneInactiveActivityState();
	}

	public getRenderedMessages(): readonly ChatMessage[] {
		return this.activeMessages;
	}

	/** Fold an Activity/delegation into the newest matching SUMO message. */
	public foldBlockIntoMatchingMessage(incoming: FoldableBlock): number | undefined {
		for (let activeIndex = this.activeMessages.length - 1; activeIndex >= 0; activeIndex -= 1) {
			const target = this.activeMessages[activeIndex];
			if (!target) continue;
			const blocks = target.toSnapshot().blocks ?? [];
			const isStandaloneActivityMessage = (target.role === "tool" || target.role === "system")
				&& blocks.some(isFoldableBlock)
				&& blocks.every((block) => isFoldableBlock(block) || block.type === "image");
			if (target.role !== "sumo" && target.role !== "assistant" && !isStandaloneActivityMessage) continue;
			if (matchingFoldableBlockIndex(blocks, incoming) === -1) continue;
			const sourceIndex = this.activeMessageSourceIndices[activeIndex];
			if (sourceIndex === undefined) return undefined;
			this.replaceBlocksAtSourceIndex(sourceIndex, upsertFoldableBlock(blocks, incoming));
			return sourceIndex;
		}
		return undefined;
	}

	/** Attach a correlated sibling block (notably an image) to a known message. */
	public upsertBlockAtSourceIndex(sourceIndex: number, incoming: ChatBlock): boolean {
		const activeIndex = this.activeMessageSourceIndices.indexOf(Math.floor(sourceIndex));
		const target = this.activeMessages[activeIndex];
		if (!target) return false;
		return this.replaceBlocksAtSourceIndex(sourceIndex, upsertFoldableBlock(target.toSnapshot().blocks ?? [], incoming));
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
		return this.sourceMessageCount;
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

	private claimVirtualizedFeedActivities(message: ChatMessageViewModel): string[] {
		const claimedIds: string[] = [];
		let removedLines = 0;
		for (const activity of this.activitiesFromBlocks(message.blocks)) {
			const feedActivity = [...this.feedActivities.values()].find((candidate) => sameActivity(candidate, activity));
			if (!feedActivity || !this.virtualizedFeedOnlyActivityIds.has(feedActivity.id)) continue;
			this.transcriptClaimedActivityStatuses.set(feedActivity.id, activity.status);
			claimedIds.push(feedActivity.id);
			removedLines += this.releaseVirtualizedFeedActivity(feedActivity.id);
		}
		if (removedLines > 0) this.scrollBox.notifyContentChanged(0, removedLines);
		return claimedIds;
	}

	private claimFeedCards(
		message: ChatMessageViewModel,
		sourceIndex: number,
	): { readonly primary: ChatMessage; readonly residual?: ChatMessageViewModel } | undefined {
		if (message.role !== "system") return undefined;
		const claims: Array<{ blockIndex: number; activity: ActivitySnapshot; target: ChatMessage }> = [];
		const claimedTargets = new Set<ChatMessage>();
		for (let blockIndex = 0; blockIndex < message.blocks.length; blockIndex += 1) {
			const block = message.blocks[blockIndex];
			if (block?.type !== "activity") continue;
			const target = this.findRenderedActivityMessage(block.activity);
			if (!target || !this.feedOwnedActivityIds.has(target) || claimedTargets.has(target)) continue;
			claims.push({ blockIndex, activity: block.activity, target });
			claimedTargets.add(target);
		}
		const primaryClaim = claims[0];
		if (!primaryClaim) return undefined;
		for (const claim of claims) {
			for (const id of this.feedOwnedActivityIds.get(claim.target) ?? []) {
				this.transcriptClaimedActivityStatuses.set(id, claim.activity.status);
			}
			const previousActivities = this.activitiesFromBlocks(claim.target.toSnapshot().blocks ?? []);
			this.migrateCorrelatedActivityState(previousActivities, [claim.activity]);
			this.updateActivityInMessage(claim.target, claim.activity);
			if (message.timestamp) this.updateMessage(claim.target, () => claim.target.setTimestamp(message.timestamp!));
			this.transcriptOwnedMessages.add(claim.target);
		}
		const claimedBlockIndices = new Set(claims.map((claim) => claim.blockIndex));
		const residualBlocks = message.blocks.filter((_block, index) => !claimedBlockIndices.has(index));
		this.sourceMessageCount = Math.max(this.sourceMessageCount, sourceIndex + 1);
		if (residualBlocks.length > 0) {
			return { primary: primaryClaim.target, residual: { ...message, blocks: residualBlocks } };
		}
		const activeIndex = this.activeMessages.indexOf(primaryClaim.target);
		if (activeIndex !== -1) this.activeMessageSourceIndices[activeIndex] = sourceIndex;
		return { primary: primaryClaim.target };
	}

	private findRenderedActivityMessage(activity: ActivitySnapshot): ChatMessage | undefined {
		return this.activeMessages.find((message) => (message.toSnapshot().blocks ?? []).some(
			(block) => block.type === "activity" && sameActivity(block.activity, activity),
		));
	}

	private updateActivityInMessage(message: ChatMessage, activity: ActivitySnapshot): void {
		const blocks = message.toSnapshot().blocks ?? [];
		const index = blocks.findIndex((block) => block.type === "activity" && sameActivity(block.activity, activity));
		const existing = index === -1 || blocks[index]?.type !== "activity" ? undefined : blocks[index] as ActivityBlock;
		const transcriptCanonicalSubagent = existing?.activity.kind === "subagent" && activity.kind === "subagent"
			&& this.transcriptOwnedMessages.has(message) && sameActivity(existing.activity, activity);
		if (existing && !transcriptCanonicalSubagent) this.migrateFeedActivityState([existing.activity], activity);
		const merged = existing ? mergeActivitySnapshot(existing.activity, activity) : activity;
		const incoming: ActivityBlock = {
			type: "activity",
			activity: transcriptCanonicalSubagent ? { ...merged, id: existing.activity.id } : merged,
		};
		const next = upsertActivityBlock(blocks, incoming);
		this.updateMessage(message, () => {
			message.setBlocks(next, chatMessageViewModelToPlainText({
				id: `feed:${activity.id}`,
				role: message.role === "user" ? "user" : message.role === "system" || message.role === "tool" ? "system" : "sumo",
				displayName: "ACTIVITY",
				blocks: next,
			}));
			this.registerActivities(next);
			this.applyExpansionPresentation(message, next);
		});
	}

	private addFeedOwnership(message: ChatMessage, id: string): void {
		const ids = this.feedOwnedActivityIds.get(message) ?? new Set<string>();
		ids.add(id);
		this.feedOwnedActivityIds.set(message, ids);
	}

	private transferFeedOwnership(previousId: string, nextId: string): void {
		this.transferTranscriptClaimedStatus(previousId, nextId);
		for (const ids of this.feedOwnedActivityIds.values()) {
			if (!ids.delete(previousId)) continue;
			ids.add(nextId);
			return;
		}
	}

	private removeFeedOwnership(id: string): number {
		this.feedActivities.delete(id);
		this.transcriptClaimedActivityStatuses.delete(id);
		const removedVirtualLines = this.releaseVirtualizedFeedActivity(id);
		for (const [message, ids] of this.feedOwnedActivityIds) {
			if (!ids.delete(id)) continue;
			if (ids.size > 0) return removedVirtualLines;
			this.feedOwnedActivityIds.delete(message);
			if (this.transcriptOwnedMessages.has(message)) return removedVirtualLines;
			const index = this.activeMessages.indexOf(message);
			if (index !== -1) {
				this.adjustReadStateForRemoval(index);
				this.removeRenderedMessageAt(index, message);
			}
			return removedVirtualLines;
		}
		return removedVirtualLines;
	}

	private transferVirtualizedFeedIdentity(previousId: string, nextId: string): void {
		this.transferTranscriptClaimedStatus(previousId, nextId);
		if (this.virtualizedFeedActivityIds.delete(previousId)) this.virtualizedFeedActivityIds.add(nextId);
		if (this.virtualizedFeedOnlyActivityIds.delete(previousId)) this.virtualizedFeedOnlyActivityIds.add(nextId);
		if (this.virtualizedTranscriptFeedActivityIds.delete(previousId)) this.virtualizedTranscriptFeedActivityIds.add(nextId);
		if (this.materializedArchivedTranscriptFeedActivityIds.delete(previousId)) this.materializedArchivedTranscriptFeedActivityIds.add(nextId);
	}

	private transferTranscriptClaimedStatus(previousId: string, nextId: string): void {
		const status = this.transcriptClaimedActivityStatuses.get(previousId);
		if (status === undefined) return;
		this.transcriptClaimedActivityStatuses.delete(previousId);
		this.transcriptClaimedActivityStatuses.set(nextId, status);
	}

	private returnMaterializedCardToTranscriptArchive(activity: ActivitySnapshot): void {
		const target = this.findRenderedActivityMessage(activity);
		if (target && this.feedOwnedActivityIds.has(target) && !this.transcriptOwnedMessages.has(target)) {
			const index = this.activeMessages.indexOf(target);
			if (index !== -1) {
				this.adjustReadStateForRemoval(index);
				this.feedOwnedActivityIds.delete(target);
				this.removeRenderedMessageAt(index, target);
			}
		}
		this.materializedArchivedTranscriptFeedActivityIds.delete(activity.id);
		this.virtualizedFeedActivityIds.add(activity.id);
		this.virtualizedTranscriptFeedActivityIds.add(activity.id);
	}

	private releaseVirtualizedFeedActivity(id: string): number {
		this.virtualizedFeedActivityIds.delete(id);
		this.virtualizedTranscriptFeedActivityIds.delete(id);
		this.materializedArchivedTranscriptFeedActivityIds.delete(id);
		if (!this.virtualizedFeedOnlyActivityIds.delete(id)) return 0;
		this.virtualArchivedCount = Math.max(0, this.virtualArchivedCount - 1);
		if (this.getArchivedMessageCount() > 0) {
			if (this.placeholder) this.placeholder.setText(this.placeholderText());
			return 0;
		}
		if (!this.placeholder) return 0;
		const removedLines = this.placeholder.getEstimatedHeight(this.scrollBox.getComputedWidth());
		if (this.placeholder.parent === this.scrollBox) this.scrollBox.removeChild(this.placeholder);
		this.placeholder.dispose();
		this.placeholder = undefined;
		return removedLines;
	}

	private replaceBlocksAtSourceIndex(sourceIndex: number, blocks: readonly ChatBlock[]): boolean {
		const activeIndex = this.activeMessageSourceIndices.indexOf(Math.floor(sourceIndex));
		const target = this.activeMessages[activeIndex];
		if (!target) return false;
		const snapshot = target.toSnapshot();
		const role = target.role === "user" ? "user" : target.role === "sumo" || target.role === "assistant" ? "sumo" : "system";
		return this.replaceViewModelAt(sourceIndex, {
			id: `pager-message-${Math.floor(sourceIndex)}`,
			role,
			displayName: role === "user" ? "YOU" : role === "sumo" ? "SUMO" : "SYSTEM",
			timestamp: snapshot.timestamp,
			blocks,
		});
	}

	private addChatMessage(message: ChatMessage, sourceIndex = this.sourceMessageCount, transcriptOwned = true, feedActivityId?: string): ChatMessage {
		const wasReadingHistory = this.isReadingHistory();
		const addedLines = message.getEstimatedHeight(this.scrollBox.getComputedWidth());
		this.activeMessages.push(message);
		this.activeMessageSourceIndices.push(sourceIndex);
		if (transcriptOwned) {
			this.transcriptOwnedMessages.add(message);
			this.sourceMessageCount = Math.max(this.sourceMessageCount, sourceIndex + 1);
		}
		if (feedActivityId) this.addFeedOwnership(message, feedActivityId);
		this.scrollBox.addChild(message);
		const virtualized = this.virtualizeIfNeeded();
		if (wasReadingHistory) this.unreadCount += 1;
		this.scrollBox.notifyContentChanged(addedLines + virtualized.addedLines, virtualized.removedLines);
		this.scheduleRender();
		return message;
	}

	private addPreparedMessage(message: PreparedChatMessage, sourceIndex?: number, transcriptOwned = true, feedActivityId?: string): ChatMessage {
		return this.addChatMessage(this.createChatMessage(message), sourceIndex, transcriptOwned, feedActivityId);
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
			this.virtualizedTranscriptClaimIds.delete(activity.id);
			this.touchActivityBookkeeping(activity.id);
			const persistenceKey = activityExpansionPersistenceKey(activity);
			const previousPersistenceKey = this.activityExpansionPersistenceKeys.get(activity.id);
			if (previousPersistenceKey !== undefined && previousPersistenceKey !== persistenceKey) {
				this.activityExpansionOverrides.delete(activity.id);
				this.activityExpansionStates.delete(activity.id);
				this.activityStatuses.delete(activity.id);
			}
			this.activityExpansionPersistenceKeys.set(activity.id, persistenceKey);
			const persisted = this.persistedActivityExpansionOverrides.get(persistenceKey);
			if (persisted !== undefined) {
				this.activityExpansionOverrides.set(activity.id, persisted);
				this.activityExpansionStates.set(activity.id, persisted);
			}
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

	private migrateFeedActivityState(existing: readonly ActivitySnapshot[], incoming: ActivitySnapshot): void {
		const previous = existing.find((candidate) => candidate.id !== incoming.id && sameActivity(candidate, incoming));
		const explicit = previous ? this.activityExpansionOverrides.get(previous.id) : undefined;
		const previousPersistenceKey = previous
			? this.activityExpansionPersistenceKeys.get(previous.id) ?? activityExpansionPersistenceKey(previous)
			: undefined;
		const nextPersistenceKey = activityExpansionPersistenceKey(incoming);
		this.migrateCorrelatedActivityState(existing, [incoming]);
		if (previous) {
			this.activityExpansionPersistenceKeys.delete(previous.id);
			this.activityExpansionPersistenceKeys.set(incoming.id, nextPersistenceKey);
		}
		if (explicit !== undefined && previousPersistenceKey !== undefined) {
			// Preserve a user-owned choice under the canonical identity. This moves
			// only the already-chosen boolean; the producer never chooses expansion.
			this.persistedActivityExpansionOverrides.delete(previousPersistenceKey);
			this.setPersistedActivityExpansion(nextPersistenceKey, explicit);
			this.onActivityExpansionMigration?.(previousPersistenceKey, nextPersistenceKey, explicit);
		}
	}

	private migrateCorrelatedActivityState(existing: readonly ActivitySnapshot[], incoming: readonly ActivitySnapshot[]): void {
		const existingIndex = activityCorrelationIndex(existing);
		for (const next of incoming) {
			const previous = correlatedActivity(existingIndex, next);
			if (previous?.id === next.id) continue;
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
			this.activityBookkeepingLru.delete(previousId);
			this.touchActivityBookkeeping(nextId);
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

	private ownedActivityIds(): Set<string> {
		return new Set([
			...this.activeActivityIds(),
			...this.feedActivities.keys(),
			...this.virtualizedTranscriptFeedActivityIds,
			...this.virtualizedTranscriptClaimIds,
		]);
	}

	private currentActivityIds(): Set<string> {
		return new Set([
			...this.activeActivityIds(),
			...this.feedActivities.keys(),
			...this.virtualizedTranscriptFeedActivityIds,
			...this.virtualizedTranscriptClaimIds,
		]);
	}

	private noteVirtualizedTranscriptActivity(activity: ActivitySnapshot): void {
		const id = activity.id;
		this.virtualizedTranscriptClaimIds.delete(id);
		this.virtualizedTranscriptClaimIds.add(id);
		const persistenceKey = activityExpansionPersistenceKey(activity);
		const previousPersistenceKey = this.activityExpansionPersistenceKeys.get(id);
		if (previousPersistenceKey !== undefined && previousPersistenceKey !== persistenceKey) {
			this.activityExpansionOverrides.delete(id);
			this.activityExpansionStates.delete(id);
		}
		this.activityExpansionPersistenceKeys.set(id, persistenceKey);
		const hasExplicitState = this.activityExpansionOverrides.has(id) || this.persistedActivityExpansionOverrides.has(persistenceKey);
		if (hasExplicitState) this.activityStatuses.set(id, activity.status);
		else {
			this.activityExpansionStates.delete(id);
			this.activityStatuses.delete(id);
		}
		this.touchActivityBookkeeping(id);
	}

	private touchActivityBookkeeping(id: string): void {
		this.activityBookkeepingLru.delete(id);
		this.activityBookkeepingLru.set(id, true);
		while (this.activityBookkeepingLru.size > this.maxActivityBookkeepingEntries) {
			const oldest = [...this.activityBookkeepingLru.keys()].find((candidate) => candidate !== id);
			if (!oldest) break;
			if (this.isActivityExpansionProtected(oldest)) {
				// LRU membership is optional bookkeeping. Keep live/feed-owned
				// status/override/key state, but evict its marker so owner count does
				// not become a hidden execution cap.
				this.activityBookkeepingLru.delete(oldest);
			} else {
				// Transcript-only history remains claimable through the virtualized ID
				// set, but its optional expansion state is LRU-bounded.
				this.dropActivityBookkeeping(oldest);
			}
		}
	}

	private setPersistedActivityExpansion(key: string, expanded: boolean): void {
		this.persistedActivityExpansionOverrides.delete(key);
		this.persistedActivityExpansionOverrides.set(key, expanded);
		while (this.persistedActivityExpansionOverrides.size > this.maxActivityBookkeepingEntries) {
			const evictable = [...this.persistedActivityExpansionOverrides.keys()].find((candidate) => candidate !== key && !this.isPersistenceKeyProtected(candidate));
			if (!evictable) break;
			this.persistedActivityExpansionOverrides.delete(evictable);
		}
	}

	private isPersistenceKeyProtected(key: string): boolean {
		for (const [id, persistenceKey] of this.activityExpansionPersistenceKeys) {
			if (persistenceKey === key && this.isActivityExpansionProtected(id)) return true;
		}
		return false;
	}

	private isActivityExpansionProtected(id: string): boolean {
		if (this.pendingRenderedActivityIds.has(id) || this.feedActivities.has(id) || this.virtualizedTranscriptFeedActivityIds.has(id)) return true;
		return this.activeMessages.some((message) => this.activitiesFromBlocks(message.toSnapshot().blocks ?? []).some((activity) => activity.id === id));
	}

	private dropActivityBookkeeping(id: string): void {
		const persistenceKey = this.activityExpansionPersistenceKeys.get(id);
		this.activityBookkeepingLru.delete(id);
		this.activityExpansionOverrides.delete(id);
		this.activityExpansionStates.delete(id);
		this.activityStatuses.delete(id);
		this.activityExpansionPersistenceKeys.delete(id);
		if (persistenceKey && ![...this.activityExpansionPersistenceKeys.values()].includes(persistenceKey)) {
			this.persistedActivityExpansionOverrides.delete(persistenceKey);
		}
	}

	private pruneInactiveActivityState(): void {
		const currentIds = this.currentActivityIds();
		for (const id of [...this.activityBookkeepingLru.keys()]) {
			if (!currentIds.has(id)) this.dropActivityBookkeeping(id);
		}
		for (const id of [...this.activityStatuses.keys()]) {
			if (!currentIds.has(id)) this.dropActivityBookkeeping(id);
		}
		for (const id of [...this.activityExpansionPersistenceKeys.keys()]) {
			if (!currentIds.has(id)) this.dropActivityBookkeeping(id);
		}
	}

	private discardActivitiesRemovedByRewrite(_previous: readonly ActivitySnapshot[]): void {
		this.pruneInactiveActivityState();
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

	private adjustReadStateForRemoval(activeIndex: number): void {
		const removedIndex = this.getArchivedMessageCount() + activeIndex;
		if (removedIndex > this.lastReadIndex) this.unreadCount = Math.max(0, this.unreadCount - 1);
		else this.lastReadIndex = Math.max(-1, this.lastReadIndex - 1);
		this.lastReadIndex = Math.min(this.lastReadIndex, this.getTotalMessageCount() - 2);
	}

	private removeRenderedMessageAt(index: number, message: ChatMessage): void {
		const width = this.scrollBox.getComputedWidth();
		const top = message.getComputedTop();
		const previousHeight = message.getEstimatedHeight(width);
		this.activeMessages.splice(index, 1);
		this.activeMessageSourceIndices.splice(index, 1);
		this.transcriptOwnedMessages.delete(message);
		this.feedOwnedActivityIds.delete(message);
		if (message.parent === this.scrollBox) this.scrollBox.removeChild(message);
		message.dispose();
		this.scrollBox.notifyChildrenResized(
			[{ top, previousHeight, nextHeight: 0 }],
			{ scrollHeightAlreadyUpdated: true },
		);
		this.scheduleRender();
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
		while (this.activeMessages.filter((message) => !this.isLiveFeedCard(message)).length > this.maxRenderedMessages) {
			const archivedIndex = this.activeMessages.findIndex((message) => !this.isLiveFeedCard(message));
			if (archivedIndex === -1) break;
			const [archived] = this.activeMessages.splice(archivedIndex, 1);
			this.activeMessageSourceIndices.splice(archivedIndex, 1);
			if (!archived) break;
			removedLines += archived.getEstimatedHeight(width);
			if (archived.parent === this.scrollBox) this.scrollBox.removeChild(archived);
			const transcriptOwned = this.transcriptOwnedMessages.has(archived);
			if (transcriptOwned) {
				for (const activity of this.activitiesFromBlocks(archived.toSnapshot().blocks ?? [])) {
					this.noteVirtualizedTranscriptActivity(activity);
				}
			}
			for (const id of this.feedOwnedActivityIds.get(archived) ?? []) {
				this.virtualizedFeedActivityIds.add(id);
				if (transcriptOwned) this.virtualizedTranscriptFeedActivityIds.add(id);
				else this.virtualizedFeedOnlyActivityIds.add(id);
			}
			this.feedOwnedActivityIds.delete(archived);
			this.transcriptOwnedMessages.delete(archived);
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

	private effectiveFeedStatus(activity: ActivitySnapshot): ActivitySnapshot["status"] {
		return this.transcriptClaimedActivityStatuses.get(activity.id) ?? activity.status;
	}

	private isLiveFeedCard(message: ChatMessage): boolean {
		const renderedActivities = this.activitiesFromBlocks(message.toSnapshot().blocks ?? []);
		for (const id of this.feedOwnedActivityIds.get(message) ?? []) {
			const feedActivity = this.feedActivities.get(id);
			const renderedActivity = renderedActivities.find((activity) =>
				activity.id === id || (feedActivity !== undefined && sameActivity(activity, feedActivity))
			);
			const status = renderedActivity?.status ?? (feedActivity ? this.effectiveFeedStatus(feedActivity) : undefined);
			if (status !== undefined && !isSettledActivityStatus(status)) return true;
		}
		return false;
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
