import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	chatMessageViewModelFromPiMessage,
	createTranscriptViewModelMapper,
	type ChatBlock,
	type ChatMessageViewModel,
	type TranscriptViewModel,
} from "../transcript/view-model.js";

export interface TaskPartialUpdate {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: unknown;
	readonly partialResult: unknown;
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
	if (toolName === "task") return undefined;
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

function isToolBlock(block: ChatBlock): block is Extract<ChatBlock, { type: "tool" }> {
	return block.type === "tool";
}

function matchingToolIndex(blocks: readonly ChatBlock[], incoming: Extract<ChatBlock, { type: "tool" }>): number {
	const incomingId = incoming.tool.id;
	if (incomingId) {
		const byId = blocks.findIndex((block) => block.type === "tool" && block.tool.id === incomingId);
		if (byId !== -1) return byId;
	}
	return blocks.findIndex((block) => block.type === "tool" && block.tool.id === undefined && incoming.tool.id === undefined && block.tool.name === incoming.tool.name && (block.tool.status === "pending" || block.tool.status === "running"));
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

function upsertToolBlock(blocks: readonly ChatBlock[], incoming: Extract<ChatBlock, { type: "tool" }>): ChatBlock[] {
	const index = matchingToolIndex(blocks, incoming);
	if (index === -1) return [...blocks, incoming];
	return blocks.map((block, blockIndex) => blockIndex === index && block.type === "tool" ? mergeToolBlock(block, incoming) : block);
}

function findLastMessageIndex(messages: readonly ChatMessageViewModel[], predicate: (message: ChatMessageViewModel) => boolean): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (predicate(messages[index]!)) return index;
	}
	return -1;
}

function foldToolBlockIntoMessages(messages: readonly ChatMessageViewModel[], incoming: Extract<ChatBlock, { type: "tool" }>, options: { requireMatch: boolean }): { messages: ChatMessageViewModel[]; folded: boolean } {
	const matchingMessageIndex = findLastMessageIndex(messages, (message) => message.role === "sumo" && matchingToolIndex(message.blocks, incoming) !== -1);
	const fallbackIndex = options.requireMatch ? -1 : findLastMessageIndex(messages, (message) => message.role === "sumo");
	const targetIndex = matchingMessageIndex !== -1 ? matchingMessageIndex : fallbackIndex;
	if (targetIndex === -1) {
		if (options.requireMatch) return { messages: [...messages], folded: false };
		return {
			messages: [...messages, { id: `live-tool-${incoming.tool.id ?? incoming.tool.name}`, role: "sumo", displayName: "SUMO", blocks: [incoming] }],
			folded: true,
		};
	}
	return {
		messages: messages.map((message, index) => index === targetIndex ? { ...message, blocks: upsertToolBlock(message.blocks, incoming) } : message),
		folded: true,
	};
}

function foldToolBlocksIntoMessages(messages: readonly ChatMessageViewModel[], blocks: readonly Extract<ChatBlock, { type: "tool" }>[], options: { requireMatch: boolean }): { messages: ChatMessageViewModel[]; folded: boolean } {
	let next = [...messages];
	let foldedAny = false;
	for (const block of blocks) {
		const result = foldToolBlockIntoMessages(next, block, options);
		if (!result.folded && options.requireMatch) return { messages: [...messages], folded: false };
		next = result.messages;
		foldedAny = result.folded || foldedAny;
	}
	return { messages: next, folded: foldedAny };
}

function foldableToolBlocksFromMessage(message: ChatMessageViewModel): Extract<ChatBlock, { type: "tool" }>[] | undefined {
	if (message.role !== "system") return undefined;
	const blocks = message.blocks.filter(isToolBlock);
	return blocks.length === message.blocks.length && blocks.length > 0 ? blocks : undefined;
}

export class RpcTranscriptPump {
	private readonly mapper = createTranscriptViewModelMapper();
	private committedMessages: unknown[] = [];
	private draftMessage: unknown | undefined;
	private readonly taskPartials = new Map<string, TaskPartialUpdate>();
	private readonly liveTools = new Map<string, LiveToolExecution>();

	public replaceFromMessages(messages: readonly unknown[]): TranscriptViewModel {
		this.mapper.reset();
		this.committedMessages = [...messages];
		this.draftMessage = undefined;
		this.liveTools.clear();
		return this.viewModel();
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): TranscriptViewModel {
		const record = asRecord(event);
		const taskPartial = taskPartialFromEvent(record);
		if (taskPartial) this.taskPartials.set(taskPartial.toolCallId, taskPartial);
		const liveTool = liveToolExecutionFromEvent(record);
		if (liveTool) this.liveTools.set(liveTool.toolCallId, liveTool);

		switch (record?.type) {
			case "message_start":
			case "message_update":
				this.draftMessage = eventMessage(record);
				break;
			case "message_end": {
				const message = eventMessage(record);
				if (message !== undefined) this.committedMessages.push(message);
				this.draftMessage = undefined;
				break;
			}
			case "agent_end": {
				const messages = eventMessages(record);
				if (messages) this.committedMessages = messages;
				this.draftMessage = undefined;
				break;
			}
		}

		return this.viewModel();
	}

	public viewModel(): TranscriptViewModel {
		this.mapper.reset();
		const source = this.draftMessage === undefined
			? this.committedMessages
			: [...this.committedMessages, this.draftMessage];
		let messages: ChatMessageViewModel[] = [];
		for (const sourceMessage of source) {
			const message = this.mapper.messageFromPiMessage(sourceMessage, messages.length);
			if (!message) continue;
			const foldableToolBlocks = foldableToolBlocksFromMessage(message);
			if (foldableToolBlocks) {
				const folded = foldToolBlocksIntoMessages(messages, foldableToolBlocks, { requireMatch: true });
				if (folded.folded) {
					messages = folded.messages;
					continue;
				}
			}
			messages.push(message);
		}
		for (const liveTool of this.liveTools.values()) {
			const liveMessage = chatMessageViewModelFromPiMessage(liveToolPiMessage(liveTool));
			const blocks = liveMessage?.blocks.filter(isToolBlock) ?? [];
			const folded = foldToolBlocksIntoMessages(messages, blocks, { requireMatch: false });
			messages = folded.messages;
		}
		return {
			messages,
		};
	}

	public getTaskPartials(): readonly TaskPartialUpdate[] {
		return [...this.taskPartials.values()];
	}
}
