function asRecord(value) {
	return value && typeof value === "object" ? value : undefined;
}

function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? record.text : undefined;
		})
		.filter(Boolean)
		.join("");
}

function imageBlockFromRecord(record) {
	const source = asRecord(record.source);
	const data = firstString(record.data, record.base64, record.base64Data, source?.data, source?.base64, source?.base64Data);
	const mime = firstString(record.mime, record.mimeType, record.mediaType, record.media_type, source?.mime, source?.mimeType, source?.mediaType, source?.media_type);
	if (!data || !mime) return [];
	return [{ type: "image", data, mime, filename: firstString(record.filename, record.name, source?.filename) }];
}

function blockFromPart(part) {
	const record = asRecord(part);
	if (!record) return [];
	if (record.type === "text") return record.text ? [{ type: "markdown", text: record.text }] : [];
	if (record.type === "thinking" || record.type === "reasoning") {
		const text = firstString(record.thinking, record.reasoning, record.text, record.content, record.delta);
		if (!text) return [];
		return [{ type: "thinking", text: text.trim(), hidden: record.hidden === true || record.redacted === true || record.encrypted === true }];
	}
	if (record.type === "image" || record.type === "input_image") return imageBlockFromRecord(record);
	if (record.type === "toolCall") {
		return [{
			type: "tool",
			tool: {
				id: firstString(record.id, record.toolCallId),
				name: firstString(record.name, record.toolName) ?? "tool",
				status: "running",
				input: record.arguments ?? record.input,
			},
		}];
	}
	return [];
}

function blocksFromMessage(record) {
	if (record.role === "bashExecution") {
		return [{
			type: "tool",
			tool: {
				name: "bash",
				status: record.cancelled === true ? "cancelled" : record.exitCode === 0 || record.exitCode === undefined ? "success" : "error",
				input: { command: record.command },
				output: record.output,
				error: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
			},
		}];
	}
	if (record.role === "toolResult") {
		return [{
			type: "tool",
			tool: {
				id: firstString(record.id, record.toolCallId),
				name: firstString(record.toolName, record.name) ?? "tool",
				status: record.isError === true ? "error" : "success",
				output: textFromContent(record.content) || firstString(record.output),
				details: record.details,
			},
		}];
	}
	const content = record.content;
	if (typeof content === "string") return content ? [{ type: "markdown", text: content }] : [];
	if (Array.isArray(content)) return content.flatMap(blockFromPart);
	return [];
}

function roleFrom(record) {
	if (record.role === "user") return "user";
	if (record.role === "assistant") return "sumo";
	return "system";
}

export function transcriptFromMessages(messages) {
	return {
		messages: (Array.isArray(messages) ? messages : [])
			.filter((message) => !(message?.role === "custom" && message.display === false))
			.map((message, index) => {
				const record = asRecord(message);
				if (!record) return undefined;
				const role = roleFrom(record);
				return {
					id: firstString(record.id, record.messageId, record.responseId, record.toolCallId) ?? `message-${index}`,
					role,
					blocks: blocksFromMessage(record),
				};
			})
			.filter(Boolean),
	};
}

export function transcriptFromEvents(events) {
	return transcriptFromMessages(events.filter((event) => event.type === "message_end" && event.message).map((event) => event.message));
}
