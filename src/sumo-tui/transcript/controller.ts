import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { measureMaybe, type ResumeProfiler, type ResumeProfileMetadata } from "../runtime/resume-profiler.js";
import type { ChatPagerReplaceStats } from "../widgets/chat-pager.js";
import {
	chatMessageViewModelFromPiMessage,
	createTranscriptViewModelMapper,
	type ChatBlock,
	type ChatMessageViewModel,
	type TranscriptViewModel,
	type TranscriptViewModelMapper,
} from "./view-model.js";

export interface TaskPartialUpdate {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: unknown;
	readonly partialResult: unknown;
}

export interface TranscriptControllerLiveStateSnapshot {
	readonly draftMessage: boolean;
	readonly liveTools: number;
	readonly taskPartials: number;
	readonly committedCacheMessages: number;
}

export interface TranscriptControllerChatSink {
	replaceViewModels(messages: readonly ChatMessageViewModel[]): ChatPagerReplaceStats;
	/** Append one new message to the end of the pager without touching scroll/read state. */
	addViewModel(message: ChatMessageViewModel): unknown;
	/** Replace the pager's current last message in place (scroll/read state preserved). */
	replaceLastWithViewModel(message: ChatMessageViewModel): unknown;
}

export interface TranscriptControllerOptions {
	readonly chat?: TranscriptControllerChatSink;
	readonly scheduleRender?: () => void;
	readonly mapper?: TranscriptViewModelMapper;
	readonly startResumeProfile?: () => ResumeProfiler;
	readonly completeResumeHydration?: (profile: ResumeProfiler, metadata: ResumeProfileMetadata) => void;
	readonly setEmptyChatQuoteState?: (state: { active: boolean; userMessageCount: number }) => void;
	readonly noteUserMessage?: () => void;
	readonly setCompactionReason?: (reason: unknown | null) => void;
}

interface LiveToolExecution {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: unknown;
	readonly content: unknown;
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly status: "running" | "success" | "error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function eventMessage(event: unknown): unknown | undefined {
	return asRecord(event)?.message;
}

function eventMessages(event: unknown): unknown[] | undefined {
	const messages = asRecord(event)?.messages;
	return Array.isArray(messages) ? messages : undefined;
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

function taskPartialFromEvent(event: unknown): TaskPartialUpdate | undefined {
	const record = asRecord(event);
	if (!record || record.type !== "tool_execution_update") return undefined;
	if (record.toolName !== "task") return undefined;
	if (record.partialResult === undefined) return undefined;
	const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "task";
	return {
		toolCallId,
		toolName: "task",
		args: record.args,
		partialResult: record.partialResult,
	};
}

function liveToolExecutionFromEvent(event: unknown): LiveToolExecution | undefined {
	const record = asRecord(event);
	if (!record || (record.type !== "tool_execution_start" && record.type !== "tool_execution_update" && record.type !== "tool_execution_end")) return undefined;
	const toolName = typeof record.toolName === "string" && record.toolName.length > 0 ? record.toolName : "tool";
	const toolCallId = typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : toolName;
	const isEnd = record.type === "tool_execution_end";
	const result = isEnd ? record.result : record.partialResult;
	const resultRecord = asRecord(result);
	return {
		toolCallId,
		toolName,
		args: record.args,
		content: resultRecord?.content ?? [],
		details: resultRecord?.details,
		isError: record.isError === true,
		status: isEnd ? (record.isError === true ? "error" : "success") : "running",
	};
}

function liveToolPiMessage(tool: LiveToolExecution): unknown {
	if (tool.status === "running") {
		return {
			role: "assistant",
			content: [{
				type: "tool",
				name: tool.toolName,
				toolCallId: tool.toolCallId,
				status: "running",
				arguments: tool.args,
				content: tool.content,
				details: tool.details,
			}],
		};
	}
	return {
		role: "toolResult",
		toolCallId: tool.toolCallId,
		toolName: tool.toolName,
		name: tool.toolName,
		arguments: tool.args,
		content: tool.content,
		details: tool.details,
		isError: tool.isError,
	};
}

function compactionSummaryMessageFromEvent(event: unknown): unknown | undefined {
	const record = asRecord(event);
	if (record?.type !== "compaction_end") return undefined;
	const result = asRecord(record.result);
	if (typeof result?.summary !== "string") return undefined;
	return {
		role: "compactionSummary",
		summary: result.summary,
		tokensBefore: result.tokensBefore,
	};
}

function isToolBlock(block: ChatBlock): block is Extract<ChatBlock, { type: "tool" }> {
	return block.type === "tool";
}

function isDelegationBlock(block: ChatBlock): block is Extract<ChatBlock, { type: "delegation" }> {
	return block.type === "delegation";
}

function isFoldableBlock(block: ChatBlock): boolean {
	return isToolBlock(block) || isDelegationBlock(block);
}

function isFoldableOnlyViewModel(message: ChatMessageViewModel): boolean {
	return message.blocks.length > 0 && message.blocks.every(isFoldableBlock);
}

function matchingFoldableIndex(blocks: readonly ChatBlock[], incoming: ChatBlock): number {
	if (incoming.type === "tool") {
		const incomingId = incoming.tool.id;
		if (incomingId) {
			const byId = blocks.findIndex((block) => block.type === "tool" && block.tool.id === incomingId);
			if (byId !== -1) return byId;
		}
		return blocks.findIndex((block) => block.type === "tool" && block.tool.id === undefined && incoming.tool.id === undefined && block.tool.name === incoming.tool.name && (block.tool.status === "pending" || block.tool.status === "running"));
	}

	if (incoming.type === "delegation") {
		const incomingId = incoming.delegation.id;
		if (incomingId) {
			const byId = blocks.findIndex((block) => block.type === "delegation" && block.delegation.id === incomingId);
			if (byId !== -1) return byId;
			return -1;
		}
		return blocks.findIndex((block) => block.type === "delegation" && (block.delegation.status === "queued" || block.delegation.status === "running"));
	}

	return -1;
}

function mergeToolBlock(existing: Extract<ChatBlock, { type: "tool" }>, incoming: Extract<ChatBlock, { type: "tool" }>): ChatBlock {
	return {
		type: "tool",
		tool: {
			...existing.tool,
			...incoming.tool,
			input: incoming.tool.input ?? existing.tool.input,
			output: incoming.tool.output ?? existing.tool.output,
			details: incoming.tool.details ?? existing.tool.details,
			error: incoming.tool.error ?? existing.tool.error,
			expanded: incoming.tool.expanded ?? existing.tool.expanded,
		},
	};
}

function mergeDelegationBlock(existing: Extract<ChatBlock, { type: "delegation" }>, incoming: Extract<ChatBlock, { type: "delegation" }>): ChatBlock {
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

function mergeFoldableBlock(existing: ChatBlock, incoming: ChatBlock): ChatBlock {
	if (existing.type === "tool" && incoming.type === "tool") return mergeToolBlock(existing, incoming);
	if (existing.type === "delegation" && incoming.type === "delegation") return mergeDelegationBlock(existing, incoming);
	return incoming;
}

function upsertFoldableBlock(blocks: readonly ChatBlock[], incoming: ChatBlock): ChatBlock[] {
	const index = matchingFoldableIndex(blocks, incoming);
	if (index === -1) return [...blocks, incoming];
	return blocks.map((block, blockIndex) => blockIndex === index ? mergeFoldableBlock(block, incoming) : block);
}

function findLastMessageIndex(messages: readonly ChatMessageViewModel[], predicate: (message: ChatMessageViewModel) => boolean): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (predicate(messages[index]!)) return index;
	}
	return -1;
}

function foldBlockIntoMessages(messages: readonly ChatMessageViewModel[], incoming: ChatBlock, options: { requireMatch: boolean }): { messages: ChatMessageViewModel[]; folded: boolean } {
	const matchingMessageIndex = findLastMessageIndex(messages, (message) => message.role === "sumo" && matchingFoldableIndex(message.blocks, incoming) !== -1);
	const fallbackIndex = options.requireMatch ? -1 : findLastMessageIndex(messages, (message) => message.role === "sumo");
	const targetIndex = matchingMessageIndex !== -1 ? matchingMessageIndex : fallbackIndex;
	if (targetIndex === -1) {
		if (options.requireMatch) return { messages: [...messages], folded: false };
		return {
			messages: [...messages, { id: `live-foldable-${foldableBlockId(incoming)}`, role: "sumo", displayName: "SUMO", blocks: [incoming] }],
			folded: true,
		};
	}
	return {
		messages: messages.map((message, index) => index === targetIndex ? { ...message, blocks: upsertFoldableBlock(message.blocks, incoming) } : message),
		folded: true,
	};
}

function foldableBlockId(block: ChatBlock): string {
	if (block.type === "tool") return block.tool.id ?? block.tool.name;
	if (block.type === "delegation") return block.delegation.id ?? block.delegation.title;
	return "block";
}

function foldBlocksIntoMessages(messages: readonly ChatMessageViewModel[], blocks: readonly ChatBlock[], options: { requireMatch: boolean }): { messages: ChatMessageViewModel[]; folded: boolean } {
	let next = [...messages];
	let foldedAny = false;
	for (const block of blocks) {
		const result = foldBlockIntoMessages(next, block, options);
		if (!result.folded && options.requireMatch) return { messages: [...messages], folded: false };
		next = result.messages;
		foldedAny = result.folded || foldedAny;
	}
	return { messages: next, folded: foldedAny };
}

function foldableBlocksFromCommittedMessage(message: ChatMessageViewModel): ChatBlock[] | undefined {
	if (message.role !== "system") return undefined;
	return isFoldableOnlyViewModel(message) ? [...message.blocks] : undefined;
}

function fallbackReplaceStats(transcript: TranscriptViewModel): ChatPagerReplaceStats {
	return {
		sourceMessages: transcript.messages.length,
		acceptedMessages: transcript.messages.length,
		renderedMessages: transcript.messages.length,
		archivedMessages: 0,
	};
}

export class TranscriptController {
	private readonly mapper: TranscriptViewModelMapper;
	private committedMessages: unknown[] = [];
	private committedViewModelCache: ChatMessageViewModel[] | undefined;
	private draftMessage: unknown | undefined;
	private readonly taskPartials = new Map<string, TaskPartialUpdate>();
	private readonly liveTools = new Map<string, LiveToolExecution>();
	private lastTranscript: TranscriptViewModel = { messages: [] };
	/**
	 * Index into `committedMessages` where the in-flight run's messages begin.
	 * Set on `agent_start` so `agent_end` can reconcile only the current run's
	 * suffix instead of discarding history accumulated by earlier runs. When
	 * undefined (no `agent_start` observed yet — e.g. a replay starting
	 * mid-stream) `agent_end` treats the run as having started at the current
	 * end of `committedMessages`, i.e. append-only.
	 */
	private currentRunStartIndex: number | undefined;
	/**
	 * The exact message array last handed to `options.chat`. Used to compute
	 * the minimal incremental pager operation instead of a full
	 * `replaceViewModels` on every event — see `diffAndApplyToChat` and
	 * `messageContentKey` for why this is compared by rendered content, not
	 * object reference. `undefined` until the first publish, and reset to
	 * `undefined` whenever a full replace is the only correct option (e.g.
	 * `replaceFromMessages`), so the next publish always re-derives the diff
	 * from a known pager state.
	 */
	private lastPublishedToChat: readonly ChatMessageViewModel[] | undefined;

	public constructor(private readonly options: TranscriptControllerOptions = {}) {
		this.mapper = options.mapper ?? createTranscriptViewModelMapper();
	}

	public replaceFromMessages(messages: readonly unknown[]): TranscriptViewModel {
		this.setCommittedMessages(messages);
		return this.publishFullReplace(this.viewModel());
	}

	public replaceFromSessionContext(sessionContext: unknown): TranscriptViewModel {
		const profile = this.options.startResumeProfile?.();
		const messages = measureMaybe(profile, "session_scan", () => sessionMessages(sessionContext));
		this.options.setEmptyChatQuoteState?.({ active: messages.length === 0, userMessageCount: countUserMessages(messages) });
		this.setCommittedMessages(messages);
		const transcript = measureMaybe(profile, "transcript_model", () => this.viewModel());
		const stats = measureMaybe(profile, "transcript_hydrate", () => this.replaceChatFully(transcript));
		this.lastTranscript = transcript;
		if (profile) {
			this.options.completeResumeHydration?.(profile, {
				sourceMessages: messages.length,
				acceptedMessages: stats.acceptedMessages,
				renderedMessages: stats.renderedMessages,
				archivedMessages: stats.archivedMessages,
			});
		}
		return transcript;
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): TranscriptViewModel {
		const record = asRecord(event);
		if (!record || typeof record.type !== "string") return this.lastTranscript;

		const taskPartial = taskPartialFromEvent(record);
		if (taskPartial) this.taskPartials.set(taskPartial.toolCallId, taskPartial);
		const liveTool = liveToolExecutionFromEvent(record);
		if (liveTool) this.liveTools.set(liveTool.toolCallId, liveTool);

		switch (record.type) {
			case "agent_start":
				this.currentRunStartIndex = this.committedMessages.length;
				break;
			case "message_start":
			case "message_update":
				this.draftMessage = eventMessage(record);
				if (asRecord(this.draftMessage)?.role === "user") this.options.noteUserMessage?.();
				break;
			case "message_end": {
				const message = eventMessage(record);
				if (message !== undefined) {
					this.committedMessages.push(message);
					this.invalidateCommittedCache();
				}
				this.draftMessage = undefined;
				break;
			}
			case "agent_end": {
				const messages = eventMessages(record);
				if (messages) {
					// `agent_end.messages` carries only the CURRENT RUN's messages, not
					// the whole session (see pi-agent-core's agentLoop, which seeds
					// `newMessages` from the prompt and never includes prior context).
					// Reconcile by replacing just the suffix that belongs to this run —
					// everything committed before the run started must survive. Most of
					// this suffix was already appended incrementally via `message_end`;
					// this also authoritatively resolves any messages that a `message_end`
					// missed (e.g. an aborted/error turn) using the run's final list.
					const runStart = this.currentRunStartIndex ?? this.committedMessages.length;
					this.committedMessages = [...this.committedMessages.slice(0, runStart), ...messages];
					this.invalidateCommittedCache();
				}
				this.currentRunStartIndex = undefined;
				this.draftMessage = undefined;
				this.liveTools.clear();
				this.taskPartials.clear();
				break;
			}
			case "compaction_start":
				this.options.setCompactionReason?.(record.reason ?? null);
				break;
			case "compaction_end": {
				this.options.setCompactionReason?.(null);
				const summary = compactionSummaryMessageFromEvent(record);
				if (summary) {
					this.committedMessages.push(summary);
					this.invalidateCommittedCache();
				}
				break;
			}
		}

		return this.publish(this.viewModel());
	}

	public viewModel(): TranscriptViewModel {
		let messages = [...this.ensureCommittedViewModels()];
		if (this.draftMessage !== undefined) {
			const message = this.mapper.messageFromPiMessage(this.draftMessage, messages.length);
			if (message) {
				const foldableBlocks = foldableBlocksFromCommittedMessage(message);
				if (foldableBlocks) {
					const folded = foldBlocksIntoMessages(messages, foldableBlocks, { requireMatch: true });
					if (folded.folded) messages = folded.messages;
					else messages.push(message);
				} else {
					messages.push(message);
				}
			}
		}

		for (const liveTool of this.liveTools.values()) {
			const liveMessage = chatMessageViewModelFromPiMessage(liveToolPiMessage(liveTool));
			const blocks = liveMessage?.blocks.filter(isFoldableBlock) ?? [];
			const folded = foldBlocksIntoMessages(messages, blocks, { requireMatch: false });
			messages = folded.messages;
		}

		return { messages };
	}

	public getTaskPartials(): readonly TaskPartialUpdate[] {
		return [...this.taskPartials.values()];
	}

	public getLiveStateSnapshot(): TranscriptControllerLiveStateSnapshot {
		return {
			draftMessage: this.draftMessage !== undefined,
			liveTools: this.liveTools.size,
			taskPartials: this.taskPartials.size,
			committedCacheMessages: this.committedViewModelCache?.length ?? 0,
		};
	}

	private setCommittedMessages(messages: readonly unknown[]): void {
		this.committedMessages = [...messages];
		this.currentRunStartIndex = undefined;
		this.draftMessage = undefined;
		this.liveTools.clear();
		this.taskPartials.clear();
		this.invalidateCommittedCache();
	}

	private invalidateCommittedCache(): void {
		this.committedViewModelCache = undefined;
	}

	private ensureCommittedViewModels(): readonly ChatMessageViewModel[] {
		if (this.committedViewModelCache) return this.committedViewModelCache;
		this.mapper.reset();
		let messages: ChatMessageViewModel[] = [];
		for (const sourceMessage of this.committedMessages) {
			const message = this.mapper.messageFromPiMessage(sourceMessage, messages.length);
			if (!message) continue;
			const foldableBlocks = foldableBlocksFromCommittedMessage(message);
			if (foldableBlocks) {
				const folded = foldBlocksIntoMessages(messages, foldableBlocks, { requireMatch: true });
				if (folded.folded) {
					messages = folded.messages;
					continue;
				}
			}
			messages.push(message);
		}
		this.committedViewModelCache = messages;
		return this.committedViewModelCache;
	}

	/** Incremental publish path: used by `handleAgentEvent` for every live event. */
	private publish(transcript: TranscriptViewModel): TranscriptViewModel {
		this.lastTranscript = transcript;
		this.diffAndApplyToChat(transcript.messages);
		return transcript;
	}

	/**
	 * Full-replace publish path: used ONLY by hydration/session-op callers
	 * (`replaceFromMessages`, `replaceFromSessionContext`) — the one
	 * legitimate use of `chat.replaceViewModels`, matching main's
	 * chat-viewport-controller contract (full replace resets scroll/read
	 * state, which is correct exactly here).
	 */
	private publishFullReplace(transcript: TranscriptViewModel): TranscriptViewModel {
		this.lastTranscript = transcript;
		this.replaceChatFully(transcript);
		return transcript;
	}

	private replaceChatFully(transcript: TranscriptViewModel): ChatPagerReplaceStats {
		const stats = this.options.chat?.replaceViewModels(transcript.messages) ?? fallbackReplaceStats(transcript);
		this.lastPublishedToChat = this.options.chat ? transcript.messages : undefined;
		if (this.options.chat) this.options.scheduleRender?.();
		return stats;
	}

	/**
	 * Computes the minimal pager operation to go from `lastPublishedToChat` to
	 * `next` and applies it, instead of always calling `replaceViewModels`
	 * (which disposes/recreates every rendered ChatMessage and resets
	 * scroll/unread state on every single agent event — audit defects A/B/C).
	 *
	 * Diff strategy: content equality, not reference equality. `viewModel()`
	 * rebuilds its messages array via `[...ensureCommittedViewModels()]` on
	 * every call, but `ensureCommittedViewModels` re-runs the ENTIRE mapper
	 * from scratch whenever its cache is invalidated (message_end, agent_end,
	 * compaction_end) -- committed messages that did not change still get a
	 * brand new object identity in that case (the mapper carries ordered
	 * task-metadata state, so a partial/incremental remap would risk
	 * desyncing it -- out of scope for B9, which must not touch B7's
	 * reconciliation). So reference identity cannot be trusted across a
	 * message_end/agent_end boundary; `messageContentKey` compares the
	 * rendered id/role/blocks instead, which is cheap (no ANSI rendering) and
	 * stable for a message whose content truly did not change:
	 *
	 *   - same length, only the LAST entry's content differs, everything
	 *     before is content-identical -> `replaceLastWithViewModel(next[last])`
	 *     (the common `message_update` streaming-delta case, and the common
	 *     `message_end` case where the committed message renders the same as
	 *     the draft it replaced).
	 *   - next is exactly one longer, and every one of the previous messages
	 *     is still content-identical at the same index -> optionally
	 *     replace-last (if the old last message's content also changed) then
	 *     `addViewModel(next[newLast])` (a fresh message started after the
	 *     previous one finished).
	 *   - anything else (an earlier message changed, or the array shrank, or
	 *     more than one message changed under a length that isn't `+1`) means
	 *     history was actually rewritten (e.g. agent_end's run-suffix splice
	 *     changing an already-committed entry's rendered content, or
	 *     live-tool folding touching a message that isn't the last one) ->
	 *     fall back to a full `replaceViewModels`, the only operation that can
	 *     express an arbitrary rewrite.
	 *
	 * The very first publish (no prior `lastPublishedToChat`) always falls
	 * back to a full replace too, since there is nothing to diff against yet.
	 */
	private diffAndApplyToChat(next: readonly ChatMessageViewModel[]): void {
		const chat = this.options.chat;
		if (!chat) {
			this.lastPublishedToChat = undefined;
			return;
		}
		const previous = this.lastPublishedToChat;
		const operations = previous ? planChatDiff(previous, next) : undefined;
		if (!operations) {
			chat.replaceViewModels(next);
			this.lastPublishedToChat = next;
			this.options.scheduleRender?.();
			return;
		}
		for (const operation of operations) {
			if (operation.kind === "replace-last") chat.replaceLastWithViewModel(operation.message);
			else chat.addViewModel(operation.message);
		}
		this.lastPublishedToChat = next;
		if (operations.length > 0) this.options.scheduleRender?.();
	}
}

type ChatDiffOperation =
	| { readonly kind: "replace-last"; readonly message: ChatMessageViewModel }
	| { readonly kind: "append"; readonly message: ChatMessageViewModel };

/**
 * Returns the minimal ordered list of incremental pager operations to turn
 * `previous` into `next`, or `undefined` when the change cannot be expressed
 * incrementally (history was rewritten) and the caller must fall back to a
 * full `replaceViewModels`. See `diffAndApplyToChat` for the full contract.
 */
function planChatDiff(
	previous: readonly ChatMessageViewModel[],
	next: readonly ChatMessageViewModel[],
): ChatDiffOperation[] | undefined {
	if (next.length === previous.length) {
		if (next.length === 0) return [];
		if (!sameContentExceptLast(previous, next)) return undefined;
		const last = next[next.length - 1]!;
		if (messageContentKey(last) === messageContentKey(previous[previous.length - 1])) return [];
		return [{ kind: "replace-last", message: last }];
	}

	if (next.length === previous.length + 1) {
		if (!sameContentExceptLast(previous, next.slice(0, previous.length))) return undefined;
		const operations: ChatDiffOperation[] = [];
		const previousLast = previous[previous.length - 1];
		const stillPreviousLast = previousLast === undefined ? undefined : next[previous.length - 1];
		if (previousLast !== undefined && messageContentKey(stillPreviousLast) !== messageContentKey(previousLast)) {
			operations.push({ kind: "replace-last", message: stillPreviousLast! });
		}
		operations.push({ kind: "append", message: next[next.length - 1]! });
		return operations;
	}

	return undefined;
}

/** True when every index except the last renders identically between the two arrays (which must be the same length). */
function sameContentExceptLast(previous: readonly ChatMessageViewModel[], next: readonly ChatMessageViewModel[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length - 1; index += 1) {
		if (messageContentKey(previous[index]) !== messageContentKey(next[index])) return false;
	}
	return true;
}

/**
 * Cheap, stable content fingerprint for a `ChatMessageViewModel`: id + role +
 * blocks (which fully determine what the pager renders). Deliberately
 * excludes `displayName`/`timestamp` since those are re-derived
 * deterministically from `role`/the source message and are not meaningful
 * signals of a content change on their own. Two messages with the same key
 * render identically, so the diff can treat them as unchanged even if the
 * committed-message remap (see `diffAndApplyToChat`'s doc comment) gave them
 * a new object identity.
 */
function messageContentKey(message: ChatMessageViewModel | undefined): string {
	if (!message) return "";
	return JSON.stringify([message.id, message.role, message.blocks]);
}
