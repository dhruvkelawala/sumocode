import { mergeActivitySnapshot, sameActivity } from "../../activity/domain.js";
import type { ChatBlock, ChatMessageViewModel } from "./view-model.js";

export type ActivityBlock = Extract<ChatBlock, { type: "activity" }>;
export type FoldableBlock = Extract<ChatBlock, { type: "activity" | "delegation" }>;

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
	return blocks.findIndex((block) => block.type === "activity" && sameActivity(block.activity, incoming.activity));
}

export function mergeActivityBlock(existing: ActivityBlock, incoming: ActivityBlock): ActivityBlock {
	return { type: "activity", activity: mergeActivitySnapshot(existing.activity, incoming.activity) };
}

export function upsertActivityBlock(blocks: readonly ChatBlock[], incoming: ActivityBlock): ChatBlock[] {
	const index = matchingActivityBlockIndex(blocks, incoming);
	if (index === -1) return [...blocks, incoming];
	return blocks.map((block, blockIndex) => (
		blockIndex === index && block.type === "activity" ? mergeActivityBlock(block, incoming) : block
	));
}

function matchingDelegationBlockIndex(
	blocks: readonly ChatBlock[],
	incoming: Extract<ChatBlock, { type: "delegation" }>,
): number {
	const incomingId = incoming.delegation.id;
	if (incomingId) return blocks.findIndex((block) => block.type === "delegation" && block.delegation.id === incomingId);
	return blocks.findIndex((block) => block.type === "delegation" && (block.delegation.status === "queued" || block.delegation.status === "running"));
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
		return blocks.map((block, blockIndex) => (
			blockIndex === index && block.type === "delegation" ? mergeDelegationBlock(block, incoming) : block
		));
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
		if (predicate(messages[index]!)) return index;
	}
	return -1;
}

function foldableBlockId(block: FoldableBlock): string {
	if (block.type === "activity") return block.activity.id;
	return block.delegation.id ?? block.delegation.title;
}

export function foldBlockIntoMessages(
	messages: readonly ChatMessageViewModel[],
	incoming: FoldableBlock,
	options: { readonly requireMatch: boolean },
): { messages: ChatMessageViewModel[]; folded: boolean } {
	const matchingMessageIndex = findLastMessageIndex(messages, (message) => (
		canOwnFoldableUpdates(message) && matchingFoldableBlockIndex(message.blocks, incoming) !== -1
	));
	const fallbackIndex = options.requireMatch ? -1 : findLastMessageIndex(messages, (message) => message.role === "sumo");
	const targetIndex = matchingMessageIndex !== -1 ? matchingMessageIndex : fallbackIndex;
	if (targetIndex === -1) {
		if (options.requireMatch) return { messages: [...messages], folded: false };
		return {
			messages: [...messages, {
				id: `live-foldable-${foldableBlockId(incoming)}`,
				role: "sumo",
				displayName: "SUMO",
				blocks: [incoming],
			}],
			folded: true,
		};
	}
	return {
		messages: messages.map((message, index) => (
			index === targetIndex ? { ...message, blocks: upsertFoldableBlock(message.blocks, incoming) } : message
		)),
		folded: true,
	};
}

export function foldBlocksIntoMessages(
	messages: readonly ChatMessageViewModel[],
	blocks: readonly FoldableBlock[],
	options: { readonly requireMatch: boolean },
): { messages: ChatMessageViewModel[]; folded: boolean; unmatched: FoldableBlock[] } {
	let next = [...messages];
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
): { messages: ChatMessageViewModel[]; folded: boolean } {
	if (!isFoldableResultViewModel(message)) return { messages: [...messages], folded: false };
	const foldable = message.blocks.filter(isFoldableBlock);
	const targetIndices = foldable.map((block) => findLastMessageIndex(messages, (candidate) => (
		canOwnFoldableUpdates(candidate) && matchingFoldableBlockIndex(candidate.blocks, block) !== -1
	))).filter((index) => index !== -1);
	if (targetIndices.length === 0) return { messages: [...messages], folded: false };
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
		next = [...next, { ...message, blocks: folded.unmatched }];
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
	return [...messages, message];
}
