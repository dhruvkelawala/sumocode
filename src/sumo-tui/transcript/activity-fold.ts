import { mergeActivitySnapshot, sameActivity } from "../../activity/domain.js";
import type { ChatBlock } from "./view-model.js";

export type ActivityBlock = Extract<ChatBlock, { type: "activity" }>;

export function isActivityBlock(block: ChatBlock): block is ActivityBlock {
	return block.type === "activity";
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
