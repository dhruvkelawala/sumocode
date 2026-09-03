import { mergeActivitySnapshot, sameActivity } from "../../activity/domain.js";
import type { ChatBlock, ChatMessageViewModel } from "./view-model.js";

export type ActivityBlock = Extract<ChatBlock, { type: "activity" }>;
export type FoldableBlock = Extract<ChatBlock, { type: "activity" | "delegation" }>;

export interface ActivityFoldOperationCounts {
	readonly historyMessageVisits: number;
	readonly messageEnvelopeCopies: number;
	readonly indexedIdentityLookups: number;
	readonly indexedCandidateVisits: number;
	readonly targetBlockVisits: number;
	readonly changedMessagePaths: number;
}

let historyMessageVisits = 0;
let messageEnvelopeCopies = 0;
let indexedIdentityLookups = 0;
let indexedCandidateVisits = 0;
let targetBlockVisits = 0;
let changedMessagePaths = 0;

export function resetActivityFoldOperationCountsForTests(): void {
	historyMessageVisits = 0;
	messageEnvelopeCopies = 0;
	indexedIdentityLookups = 0;
	indexedCandidateVisits = 0;
	targetBlockVisits = 0;
	changedMessagePaths = 0;
}

export function getActivityFoldOperationCountsForTests(): ActivityFoldOperationCounts {
	return { historyMessageVisits, messageEnvelopeCopies, indexedIdentityLookups, indexedCandidateVisits, targetBlockVisits, changedMessagePaths };
}

function copyMessages(messages: readonly ChatMessageViewModel[]): ChatMessageViewModel[] {
	messageEnvelopeCopies += 1;
	return [...messages];
}

function copyAndAppendMessage(
	messages: readonly ChatMessageViewModel[],
	message: ChatMessageViewModel,
): ChatMessageViewModel[] {
	messageEnvelopeCopies += 1;
	return [...messages, message];
}

function mapMessages(
	messages: readonly ChatMessageViewModel[],
	map: (message: ChatMessageViewModel, index: number) => ChatMessageViewModel,
): ChatMessageViewModel[] {
	messageEnvelopeCopies += 1;
	return messages.map(map);
}

export function isActivityBlock(block: ChatBlock): block is ActivityBlock {
	return block.type === "activity";
}

export function isFoldableBlock(block: ChatBlock): block is FoldableBlock {
	return block.type === "activity" || block.type === "delegation";
}

export function isFoldableResultViewModel(message: ChatMessageViewModel): boolean {
	return message.blocks.some(isFoldableBlock)
		&& message.blocks.every((block) => isFoldableBlock(block) || block.type === "image");
}

export function canOwnFoldableUpdates(message: ChatMessageViewModel): boolean {
	return message.role === "sumo" || (message.role === "system" && isFoldableResultViewModel(message));
}

export function matchingActivityBlockIndex(blocks: readonly ChatBlock[], incoming: ActivityBlock): number {
	for (let index = 0; index < blocks.length; index += 1) {
		targetBlockVisits += 1;
		const block = blocks[index];
		if (block?.type === "activity" && sameActivity(block.activity, incoming.activity)) return index;
	}
	return -1;
}

export function mergeActivityBlock(existing: ActivityBlock, incoming: ActivityBlock): ActivityBlock {
	return { type: "activity", activity: mergeActivitySnapshot(existing.activity, incoming.activity) };
}

export function upsertActivityBlock(blocks: readonly ChatBlock[], incoming: ActivityBlock): ChatBlock[] {
	const index = matchingActivityBlockIndex(blocks, incoming);
	if (index === -1) return [...blocks, incoming];
	return blocks.map((block, blockIndex) => {
		targetBlockVisits += 1;
		return blockIndex === index && block.type === "activity" ? mergeActivityBlock(block, incoming) : block;
	});
}

function matchingDelegationBlockIndex(
	blocks: readonly ChatBlock[],
	incoming: Extract<ChatBlock, { type: "delegation" }>,
): number {
	const incomingId = incoming.delegation.id;
	for (let index = 0; index < blocks.length; index += 1) {
		targetBlockVisits += 1;
		const block = blocks[index];
		if (block?.type !== "delegation") continue;
		if (incomingId ? block.delegation.id === incomingId : block.delegation.status === "queued" || block.delegation.status === "running") return index;
	}
	return -1;
}

function mergeDelegationBlock(
	existing: Extract<ChatBlock, { type: "delegation" }>,
	incoming: Extract<ChatBlock, { type: "delegation" }>,
): Extract<ChatBlock, { type: "delegation" }> {
	const incomingTitle = incoming.delegation.title;
	const keepExistingTitle = existing.delegation.title !== "task" && (incomingTitle === "task" || incomingTitle === "delegation");
	return {
		type: "delegation",
		delegation: {
			...existing.delegation,
			...incoming.delegation,
			title: keepExistingTitle ? existing.delegation.title : incoming.delegation.title,
			agent: incoming.delegation.agent ?? existing.delegation.agent,
			model: incoming.delegation.model ?? existing.delegation.model,
			thinking: incoming.delegation.thinking ?? existing.delegation.thinking,
			nestedTools: (incoming.delegation.nestedTools?.length ?? 0) > 0 ? incoming.delegation.nestedTools : existing.delegation.nestedTools,
			tokensIn: incoming.delegation.tokensIn ?? existing.delegation.tokensIn,
			tokensOut: incoming.delegation.tokensOut ?? existing.delegation.tokensOut,
			elapsedMs: incoming.delegation.elapsedMs ?? existing.delegation.elapsedMs,
		},
	};
}

export function matchingFoldableBlockIndex(blocks: readonly ChatBlock[], incoming: FoldableBlock): number {
	if (incoming.type === "activity") return matchingActivityBlockIndex(blocks, incoming);
	return matchingDelegationBlockIndex(blocks, incoming);
}

export function upsertFoldableBlock(blocks: readonly ChatBlock[], incoming: ChatBlock): ChatBlock[] {
	if (incoming.type === "activity") return upsertActivityBlock(blocks, incoming);
	if (incoming.type === "delegation") {
		const index = matchingDelegationBlockIndex(blocks, incoming);
		if (index === -1) return [...blocks, incoming];
		return blocks.map((block, blockIndex) => {
			targetBlockVisits += 1;
			return blockIndex === index && block.type === "delegation" ? mergeDelegationBlock(block, incoming) : block;
		});
	}
	if (incoming.type === "image") {
		const key = imageBlockKey(incoming);
		if (blocks.some((block) => block.type === "image" && imageBlockKey(block) === key)) return [...blocks];
	}
	return [...blocks, incoming];
}

function findLastMessageIndex(
	messages: readonly ChatMessageViewModel[],
	predicate: (message: ChatMessageViewModel) => boolean,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		historyMessageVisits += 1;
		if (predicate(messages[index]!)) return index;
	}
	return -1;
}

function foldableBlockId(block: FoldableBlock): string {
	if (block.type === "activity") return block.activity.id;
	return block.delegation.id ?? block.delegation.title;
}

interface FoldableBlockLocation {
	readonly messageIndex: number;
	readonly blockIndex: number;
}

export interface FoldableBlockIndex {
	readonly locationsByIdentity: ReadonlyMap<string, readonly FoldableBlockLocation[]>;
	readonly lastSumoMessageIndex: number;
}

export interface FoldableBlockCursor {
	readonly base: FoldableBlockIndex;
	readonly addedLocationsByIdentity: Map<string, FoldableBlockLocation[]>;
	lastSumoMessageIndex: number;
}

function foldableIndexKeys(block: FoldableBlock): string[] {
	if (block.type === "delegation") {
		const keys = block.delegation.id ? [`delegation:${block.delegation.id}`] : [];
		if (block.delegation.status === "queued" || block.delegation.status === "running") keys.push("delegation:pending");
		return keys;
	}
	return [...new Set([block.activity.id, block.activity.sourceId].filter((value): value is string => value !== undefined))]
		.map((value) => `activity:${value}`);
}

interface FoldableLookupKeys {
	readonly preferred: readonly string[];
	readonly fallback: readonly string[];
}

function foldableLookupKeys(block: FoldableBlock): FoldableLookupKeys {
	if (block.type === "delegation") {
		return {
			preferred: block.delegation.id ? [`delegation:${block.delegation.id}`] : ["delegation:pending"],
			fallback: [],
		};
	}
	const sourceId = block.activity.sourceId;
	return sourceId && sourceId !== block.activity.id
		? {
			preferred: [`activity:${sourceId}`],
			fallback: block.activity.kind === "subagent" ? [] : [`activity:${block.activity.id}`],
		}
		: { preferred: [`activity:${block.activity.id}`], fallback: [] };
}

function addIndexedLocation(
	locationsByIdentity: Map<string, FoldableBlockLocation[]>,
	block: FoldableBlock,
	location: FoldableBlockLocation,
): void {
	for (const key of foldableIndexKeys(block)) {
		const locations = locationsByIdentity.get(key) ?? [];
		if (!locations.some((candidate) => candidate.messageIndex === location.messageIndex && candidate.blockIndex === location.blockIndex)) {
			locations.push(location);
			locationsByIdentity.set(key, locations);
		}
	}
}

export function indexFoldableBlocks(messages: readonly ChatMessageViewModel[]): FoldableBlockIndex {
	const locationsByIdentity = new Map<string, FoldableBlockLocation[]>();
	let lastSumoMessageIndex = -1;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex]!;
		if (message.role === "sumo") lastSumoMessageIndex = messageIndex;
		if (!canOwnFoldableUpdates(message)) continue;
		for (let blockIndex = 0; blockIndex < message.blocks.length; blockIndex += 1) {
			const block = message.blocks[blockIndex];
			if (block && isFoldableBlock(block)) addIndexedLocation(locationsByIdentity, block, { messageIndex, blockIndex });
		}
	}
	return { locationsByIdentity, lastSumoMessageIndex };
}

export function createFoldableBlockCursor(base: FoldableBlockIndex): FoldableBlockCursor {
	return {
		base,
		addedLocationsByIdentity: new Map(),
		lastSumoMessageIndex: base.lastSumoMessageIndex,
	};
}

function indexedMatchingLocation(
	messages: readonly ChatMessageViewModel[],
	incoming: FoldableBlock,
	cursor: FoldableBlockCursor,
): FoldableBlockLocation | undefined {
	indexedIdentityLookups += 1;
	const lookup = (keys: readonly string[]): FoldableBlockLocation | undefined => {
		const candidates = new Map<string, FoldableBlockLocation>();
		for (const key of keys) {
			for (const location of cursor.base.locationsByIdentity.get(key) ?? []) {
				candidates.set(`${location.messageIndex}:${location.blockIndex}`, location);
			}
			for (const location of cursor.addedLocationsByIdentity.get(key) ?? []) {
				candidates.set(`${location.messageIndex}:${location.blockIndex}`, location);
			}
		}
		return [...candidates.values()]
			.sort((left, right) => right.messageIndex - left.messageIndex || left.blockIndex - right.blockIndex)
			.find((location) => {
				indexedCandidateVisits += 1;
				const message = messages[location.messageIndex];
				return message !== undefined
					&& canOwnFoldableUpdates(message)
					&& matchingFoldableBlockIndex([message.blocks[location.blockIndex]!], incoming) === 0;
			});
	};
	const keys = foldableLookupKeys(incoming);
	return lookup(keys.preferred) ?? lookup(keys.fallback);
}

function recordIndexedBlock(
	message: ChatMessageViewModel,
	messageIndex: number,
	incoming: FoldableBlock,
	cursor: FoldableBlockCursor,
): void {
	const blockIndex = matchingFoldableBlockIndex(message.blocks, incoming);
	if (blockIndex !== -1) addIndexedLocation(cursor.addedLocationsByIdentity, incoming, { messageIndex, blockIndex });
}

export interface IndexedFoldResult {
	readonly folded: boolean;
	readonly messageIndex?: number;
}

export function foldBlockIntoIndexedMessages(
	messages: ChatMessageViewModel[],
	incoming: FoldableBlock,
	cursor: FoldableBlockCursor,
	options: { readonly requireMatch: boolean },
): IndexedFoldResult {
	const matchingLocation = indexedMatchingLocation(messages, incoming, cursor);
	const targetIndex = matchingLocation?.messageIndex ?? (options.requireMatch ? -1 : cursor.lastSumoMessageIndex);
	if (targetIndex === -1) {
		if (options.requireMatch) return { folded: false };
		const created: ChatMessageViewModel = {
			id: `live-foldable-${foldableBlockId(incoming)}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [incoming],
		};
		messages.push(created);
		cursor.lastSumoMessageIndex = messages.length - 1;
		recordIndexedBlock(created, messages.length - 1, incoming, cursor);
		return { folded: true, messageIndex: messages.length - 1 };
	}
	const target = messages[targetIndex];
	if (!target) return { folded: false };
	changedMessagePaths += 1;
	const updated = { ...target, blocks: upsertFoldableBlock(target.blocks, incoming) };
	messages[targetIndex] = updated;
	recordIndexedBlock(updated, targetIndex, incoming, cursor);
	return { folded: true, messageIndex: targetIndex };
}

export interface IndexedAppendResult {
	readonly changedMessageIndices: readonly number[];
}

export function appendOrFoldTranscriptMessageIndexed(
	messages: ChatMessageViewModel[],
	message: ChatMessageViewModel,
	cursor: FoldableBlockCursor,
): IndexedAppendResult {
	const changedMessageIndices = new Set<number>();
	if (message.role === "system" && isFoldableResultViewModel(message)) {
		const unmatched: FoldableBlock[] = [];
		let targetIndex = -1;
		for (const block of message.blocks.filter(isFoldableBlock)) {
			const result = foldBlockIntoIndexedMessages(messages, block, cursor, { requireMatch: true });
			if (result.folded) {
				targetIndex = Math.max(targetIndex, result.messageIndex ?? -1);
				if (result.messageIndex !== undefined) changedMessageIndices.add(result.messageIndex);
			}
			else unmatched.push(block);
		}
		if (targetIndex !== -1) {
			const images = message.blocks.filter((block): block is Extract<ChatBlock, { type: "image" }> => block.type === "image");
			const target = messages[targetIndex];
			if (target && images.length > 0) messages[targetIndex] = { ...target, blocks: upsertFoldableImages(target.blocks, images) };
			if (unmatched.length === 0) return { changedMessageIndices: [...changedMessageIndices] };
			message = { ...message, blocks: unmatched };
		}
	}
	messages.push(message);
	changedMessageIndices.add(messages.length - 1);
	if (message.role === "sumo") cursor.lastSumoMessageIndex = messages.length - 1;
	for (const block of message.blocks) {
		if (isFoldableBlock(block)) recordIndexedBlock(message, messages.length - 1, block, cursor);
	}
	return { changedMessageIndices: [...changedMessageIndices] };
}

function upsertFoldableImages(
	blocks: readonly ChatBlock[],
	images: readonly Extract<ChatBlock, { type: "image" }>[],
): ChatBlock[] {
	const keys = new Set(blocks
		.filter((block): block is Extract<ChatBlock, { type: "image" }> => block.type === "image")
		.map(imageBlockKey));
	return [...blocks, ...images.filter((image) => {
		const key = imageBlockKey(image);
		if (keys.has(key)) return false;
		keys.add(key);
		return true;
	})];
}

export interface FoldResult {
	messages: ChatMessageViewModel[];
	folded: boolean;
}

export interface FoldedBlocksResult extends FoldResult {
	unmatched: FoldableBlock[];
}

export function foldBlockIntoMessages(
	messages: readonly ChatMessageViewModel[],
	incoming: FoldableBlock,
	options: { readonly requireMatch: boolean },
) {
	const matchingMessageIndex = findLastMessageIndex(messages, (message) => (
		canOwnFoldableUpdates(message) && matchingFoldableBlockIndex(message.blocks, incoming) !== -1
	));
	const fallbackIndex = options.requireMatch ? -1 : findLastMessageIndex(messages, (message) => message.role === "sumo");
	const targetIndex = matchingMessageIndex !== -1 ? matchingMessageIndex : fallbackIndex;
	if (targetIndex === -1) {
		if (options.requireMatch) return { messages: copyMessages(messages), folded: false };
		const created: ChatMessageViewModel = {
			id: `live-foldable-${foldableBlockId(incoming)}`,
			role: "sumo",
			displayName: "SUMO",
			blocks: [incoming],
		};
		return { messages: copyAndAppendMessage(messages, created), folded: true };
	}
	return {
		messages: mapMessages(messages, (message, index) => (
			index === targetIndex ? { ...message, blocks: upsertFoldableBlock(message.blocks, incoming) } : message
		)),
		folded: true,
	};
}

export function foldBlocksIntoMessages(
	messages: readonly ChatMessageViewModel[],
	blocks: readonly FoldableBlock[],
	options: { readonly requireMatch: boolean },
): FoldedBlocksResult {
	let next = copyMessages(messages);
	let foldedAny = false;
	const unmatched: FoldableBlock[] = [];
	for (const block of blocks) {
		const result = foldBlockIntoMessages(next, block, options);
		if (!result.folded) {
			unmatched.push(block);
			continue;
		}
		next = result.messages;
		foldedAny = true;
	}
	return { messages: next, folded: foldedAny, unmatched };
}

function imageBlockKey(block: Extract<ChatBlock, { type: "image" }>): string {
	return JSON.stringify([block.mime, block.data, block.filename ?? null]);
}

export function foldResultViewModelIntoMessages(
	messages: readonly ChatMessageViewModel[],
	message: ChatMessageViewModel,
) {
	if (!isFoldableResultViewModel(message)) return { messages: copyMessages(messages), folded: false };
	const foldable = message.blocks.filter(isFoldableBlock);
	const targetIndices = foldable.map((block) => findLastMessageIndex(messages, (candidate) => (
		canOwnFoldableUpdates(candidate) && matchingFoldableBlockIndex(candidate.blocks, block) !== -1
	))).filter((index) => index !== -1);
	if (targetIndices.length === 0) return { messages: copyMessages(messages), folded: false };
	const folded = foldBlocksIntoMessages(messages, foldable, { requireMatch: true });
	const targetIndex = Math.max(...targetIndices);
	const images = message.blocks.filter((block): block is Extract<ChatBlock, { type: "image" }> => block.type === "image");
	let next = images.length === 0 ? folded.messages : folded.messages.map((candidate, index) => {
		if (index !== targetIndex) return candidate;
		const existingImageKeys = new Set(candidate.blocks
			.filter((block): block is Extract<ChatBlock, { type: "image" }> => block.type === "image")
			.map(imageBlockKey));
		const uniqueImages = images.filter((image) => {
			const key = imageBlockKey(image);
			if (existingImageKeys.has(key)) return false;
			existingImageKeys.add(key);
			return true;
		});
		return uniqueImages.length > 0 ? { ...candidate, blocks: [...candidate.blocks, ...uniqueImages] } : candidate;
	});
	if (folded.unmatched.length > 0) {
		next = copyAndAppendMessage(next, { ...message, blocks: folded.unmatched });
	}
	return { messages: next, folded: true };
}

/** Fold one ordered replay message through the same identity rules used by live events. */
export function appendOrFoldTranscriptMessage(
	messages: readonly ChatMessageViewModel[],
	message: ChatMessageViewModel,
): ChatMessageViewModel[] {
	if (message.role === "system") {
		const folded = foldResultViewModelIntoMessages(messages, message);
		if (folded.folded) return folded.messages;
	}
	return copyAndAppendMessage(messages, message);
}
