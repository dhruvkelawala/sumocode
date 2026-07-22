import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { safeValuePreview } from "../../activity/domain.js";
import { measureMaybe, type ResumeProfiler, type ResumeProfileMetadata } from "../runtime/resume-profiler.js";
import type { ChatPagerReplaceStats } from "../widgets/chat-pager.js";
import {
	appendOrFoldTranscriptMessage,
	foldBlocksIntoMessages,
	isFoldableBlock,
} from "./activity-fold.js";
import {
	chatMessageViewModelFromPiMessage,
	createTranscriptViewModelMapper,
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
	addViewModel(message: ChatMessageViewModel, sourceIndex?: number): unknown;
	/** Replace one rendered transcript node in place (scroll/read state preserved). */
	replaceViewModelAt(index: number, message: ChatMessageViewModel): unknown;
	/** Replace the pager's current last message in place (scroll/read state preserved). */
	replaceLastWithViewModel(message: ChatMessageViewModel, sourceIndex?: number): unknown;
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
	const toolCallId = typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : undefined;
	if (!toolCallId) return undefined;
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
	// Pi's AgentSessionEvent contract requires toolCallId:string on every tool execution event.
	// Drop malformed unknown input rather than reintroducing name-only correlation collisions.
	const toolCallId = typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : undefined;
	if (!toolCallId) return undefined;
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

function fallbackReplaceStats(transcript: TranscriptViewModel): ChatPagerReplaceStats {
	return {
		sourceMessages: transcript.messages.length,
		acceptedMessages: transcript.messages.length,
		renderedMessages: transcript.messages.length,
		archivedMessages: 0,
	};
}

type ChatDiffHint = "incremental" | "rewrite";

let messageContentKeyCache = new WeakMap<ChatMessageViewModel, string>();
let messageContentKeyCacheMisses = 0;

export function resetMessageContentKeyCacheForTests(): void {
	messageContentKeyCache = new WeakMap<ChatMessageViewModel, string>();
	messageContentKeyCacheMisses = 0;
}

export function getMessageContentKeyCacheMissesForTests(): number {
	return messageContentKeyCacheMisses;
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
	private pendingChatOp: ChatDiffHint | undefined;
	/**
	 * Bumped on every `publish`/`publishFullReplace`, i.e. every time
	 * `lastTranscript` changes. A consumer that also receives the raw
	 * `TranscriptViewModel` out-of-band (e.g. `RpcShellAdapter.update`, which
	 * gets it via `RpcHostRuntime`) can compare this against the revision it
	 * last applied through its OWN full-replace path to tell whether the
	 * transcript it was just handed was already pushed into the same chat
	 * sink incrementally (skip the redundant replace) or arrived through some
	 * other route, e.g. before the sink was wired up (apply it).
	 */
	private revision = 0;

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
		this.pendingChatOp = undefined;
		const record = asRecord(event);
		if (!record || typeof record.type !== "string") return this.lastTranscript;
		const taskPartial = taskPartialFromEvent(record);
		if (taskPartial) this.taskPartials.set(taskPartial.toolCallId, taskPartial);
		const liveTool = liveToolExecutionFromEvent(record);
		if (liveTool) {
			const existing = this.liveTools.get(liveTool.toolCallId);
			if (!existing || existing.status === "running" || liveTool.status !== "running") {
				this.liveTools.set(liveTool.toolCallId, liveTool);
			}
		}

		switch (record.type) {
			case "agent_start":
				this.currentRunStartIndex = this.committedMessages.length;
				break;
			case "message_start":
			case "message_update":
				this.pendingChatOp = "incremental";
				this.draftMessage = eventMessage(record);
				if (asRecord(this.draftMessage)?.role === "user") this.options.noteUserMessage?.();
				break;
			case "message_end": {
				this.pendingChatOp = "incremental";
				const message = eventMessage(record);
				if (message !== undefined) {
					this.committedMessages.push(message);
					this.invalidateCommittedCache();
				}
				this.draftMessage = undefined;
				break;
			}
			case "agent_end": {
				this.pendingChatOp = "rewrite";
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
					//
					// Mid-run user messages (steer/followUp) are NOT dropped by this
					// splice — pinned @earendil-works/pi-agent-core 0.79.1: the loop's
					// `runLoop` is the ONLY emitter of `message_end` for a queued
					// message mid-run, and the same block pushes that message into
					// `newMessages` (dist/agent-loop.js:95-103; follow-up drain at
					// :157-161); every `agent_end` carries exactly that array
					// (dist/agent-loop.js:109,151,166; prompts seeded at :43,50-53).
					// A queued message the loop never drained gets no `message_end`
					// (nothing committed here to drop) and instead seeds the NEXT
					// run's prompts (pi-agent-core dist/agent.js:233-242). The session
					// never emits its own `message_end` while streaming (pi-coding-agent
					// dist/core/agent-session.js:988-1004). Pinned by the "mid-run
					// follow-up" test in controller.test.ts.
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
			if (message) messages = appendOrFoldTranscriptMessage(messages, message);
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

	/**
	 * Monotonically increasing counter bumped every time `lastTranscript`
	 * changes (whether the change was applied to the chat sink incrementally
	 * or via a full replace). Lets an out-of-band consumer of the raw
	 * `TranscriptViewModel` (see `RpcShellAdapter.update`) tell whether it
	 * already reflects the sink-applied state without deep-comparing message
	 * arrays.
	 */
	public getRevision(): number {
		return this.revision;
	}

	private setCommittedMessages(messages: readonly unknown[]): void {
		this.committedMessages = [...messages];
		this.currentRunStartIndex = undefined;
		this.draftMessage = undefined;
		this.pendingChatOp = undefined;
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
			messages = appendOrFoldTranscriptMessage(messages, message);
		}
		this.committedViewModelCache = messages;
		return this.committedViewModelCache;
	}

	/** Incremental publish path: used by `handleAgentEvent` for every live event. */
	private publish(transcript: TranscriptViewModel): TranscriptViewModel {
		this.lastTranscript = transcript;
		this.revision += 1;
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
		this.revision += 1;
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
	 *   - same length, exactly one entry differs -> update that retained node;
	 *     the last entry keeps the O(1) `replaceLastWithViewModel` fast path,
	 *     while a folded non-last Activity uses `replaceViewModelAt`.
	 *   - next is exactly one longer, with at most one changed shared entry ->
	 *     apply that targeted update (if any), then append the new message.
	 *   - array shrinkage, growth by more than one, or multiple changed entries
	 *     means history was actually rewritten -> fall back to a full
	 *     `replaceViewModels`, the only operation that can express it safely.
	 *
	 * The very first publish (no prior `lastPublishedToChat`) always falls
	 * back to a full replace too, since there is nothing to diff against yet.
	 */
	private diffAndApplyToChat(next: readonly ChatMessageViewModel[]): void {
		const hint = this.pendingChatOp;
		this.pendingChatOp = undefined;
		const chat = this.options.chat;
		if (!chat) {
			this.lastPublishedToChat = undefined;
			return;
		}
		const previous = this.lastPublishedToChat;
		const operations = previous
			? hint === "incremental"
				? planHintedIncrementalChatDiff(previous, next) ?? planChatDiff(previous, next)
				: planChatDiff(previous, next)
			: undefined;
		if (!operations) {
			chat.replaceViewModels(next);
			this.lastPublishedToChat = next;
			this.options.scheduleRender?.();
			return;
		}
		for (const operation of operations) {
			const applied = operation.kind === "replace-last"
				? chat.replaceLastWithViewModel(operation.message, operation.index)
				: operation.kind === "replace"
					? chat.replaceViewModelAt(operation.index, operation.message)
					: chat.addViewModel(operation.message, operation.index);
			if (applied === false) {
				chat.replaceViewModels(next);
				this.lastPublishedToChat = next;
				this.options.scheduleRender?.();
				return;
			}
		}
		this.lastPublishedToChat = next;
		if (operations.length > 0) this.options.scheduleRender?.();
	}
}

export type ChatDiffOperation =
	| { readonly kind: "replace"; readonly index: number; readonly message: ChatMessageViewModel }
	| { readonly kind: "replace-last"; readonly index: number; readonly message: ChatMessageViewModel }
	| { readonly kind: "append"; readonly index: number; readonly message: ChatMessageViewModel };

function planHintedIncrementalChatDiff(
	previous: readonly ChatMessageViewModel[],
	next: readonly ChatMessageViewModel[],
): ChatDiffOperation[] | undefined {
	if (next.length !== previous.length) return undefined;
	if (next.length === 0) return [];
	const last = next[next.length - 1]!;
	// A changed last boundary is the common streaming-delta case and is safe to
	// plan in O(1). If it is unchanged, fall back to the full content diff: a
	// tool result may have folded into a non-last assistant message.
	if (messageContentKey(last) === messageContentKey(previous[previous.length - 1])) return undefined;
	return [{ kind: "replace-last", index: next.length - 1, message: last }];
}

/**
 * Returns the minimal ordered list of incremental pager operations to turn
 * `previous` into `next`, or `undefined` when the change cannot be expressed
 * incrementally (history was rewritten) and the caller must fall back to a
 * full `replaceViewModels`. See `diffAndApplyToChat` for the full contract.
 */
export function planChatDiff(
	previous: readonly ChatMessageViewModel[],
	next: readonly ChatMessageViewModel[],
): ChatDiffOperation[] | undefined {
	if (next.length !== previous.length && next.length !== previous.length + 1) return undefined;
	const sharedLength = previous.length;
	let changedIndex: number | undefined;
	for (let index = 0; index < sharedLength; index += 1) {
		if (messageContentKey(previous[index]) === messageContentKey(next[index])) continue;
		if (changedIndex !== undefined) return undefined;
		changedIndex = index;
	}

	const operations: ChatDiffOperation[] = [];
	if (changedIndex !== undefined) {
		const message = next[changedIndex]!;
		operations.push(changedIndex === previous.length - 1
			? { kind: "replace-last", index: changedIndex, message }
			: { kind: "replace", index: changedIndex, message });
	}
	if (next.length === previous.length + 1) operations.push({ kind: "append", index: next.length - 1, message: next[next.length - 1]! });
	return operations;
}

/**
 * Cheap, stable content fingerprint for a `ChatMessageViewModel`: id + role +
 * timestamp + blocks (which fully determine what the pager renders).
 * Deliberately excludes `displayName` since it is re-derived deterministically
 * from `role` and is not a meaningful signal of a content change on its own.
 * `timestamp` is parsed from the source message, and assistant/sumo timestamps
 * are rendered chrome, so timestamp changes are visible content changes. Two
 * messages with the same key render identically, so the diff can treat them as
 * unchanged even if the committed-message remap (see `diffAndApplyToChat`'s doc
 * comment) gave them a new object identity.
 */
function stringifyContentKey(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, current: unknown) => {
			if (typeof current === "bigint") return `${current.toString()}n`;
			if (typeof current !== "object" || current === null) return current;
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
			return current;
		}) ?? "";
	} catch {
		return safeValuePreview(value, {
			maxChars: 100_000,
			maxDepth: 20,
			maxEntries: 10_000,
			maxStringChars: 100_000,
		});
	}
}

function messageContentKey(message: ChatMessageViewModel | undefined): string {
	if (!message) return "";
	const cached = messageContentKeyCache.get(message);
	if (cached !== undefined) return cached;
	const key = stringifyContentKey([message.id, message.role, message.timestamp?.getTime() ?? null, message.blocks]);
	messageContentKeyCache.set(message, key);
	messageContentKeyCacheMisses += 1;
	return key;
}
