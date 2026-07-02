import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createTranscriptViewModelMapper,
	type ChatMessageViewModel,
	type TranscriptViewModel,
} from "../transcript/view-model.js";

export interface TaskPartialUpdate {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: unknown;
	readonly partialResult: unknown;
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

export class RpcTranscriptPump {
	private readonly mapper = createTranscriptViewModelMapper();
	private committedMessages: unknown[] = [];
	private draftMessage: unknown | undefined;
	private readonly taskPartials = new Map<string, TaskPartialUpdate>();

	public replaceFromMessages(messages: readonly unknown[]): TranscriptViewModel {
		this.mapper.reset();
		this.committedMessages = [...messages];
		this.draftMessage = undefined;
		return this.viewModel();
	}

	public handleAgentEvent(event: AgentSessionEvent | unknown): TranscriptViewModel {
		const record = asRecord(event);
		const taskPartial = taskPartialFromEvent(record);
		if (taskPartial) this.taskPartials.set(taskPartial.toolCallId, taskPartial);

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
		return {
			messages: source
				.map((message, index) => this.mapper.messageFromPiMessage(message, index))
				.filter((message): message is ChatMessageViewModel => message !== undefined),
		};
	}

	public getTaskPartials(): readonly TaskPartialUpdate[] {
		return [...this.taskPartials.values()];
	}
}
