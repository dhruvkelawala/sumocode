import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRemnicMemoryClient, type MemoryObservationMessage, type RemnicMemoryClient } from "./memory.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const chunks: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			const text = item.trim();
			if (text) chunks.push(text);
			continue;
		}
		const record = asRecord(item);
		const type = typeof record?.type === "string" ? record.type : "";
		const text = asText(record?.text)
			|| asText(record?.content)
			|| (type === "input_text" ? asText(record?.value) : "");
		if (text) chunks.push(text);
	}
	return chunks.join("\n\n").trim();
}

export function observedMessagesFromAgentMessages(messages: readonly unknown[]): MemoryObservationMessage[] {
	const observed: MemoryObservationMessage[] = [];
	for (const message of messages) {
		const record = asRecord(message);
		const role = record?.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = textFromContent(record?.content);
		if (!content) continue;
		observed.push({ role, content });
	}
	return observed;
}

function sessionKeyFromContext(ctx: ExtensionContext): string | undefined {
	return asText(safeCall(() => ctx.sessionManager.getSessionId()))
		|| asText(safeCall(() => ctx.sessionManager.getSessionFile()))
		|| asText(safeCall(() => ctx.cwd));
}

function safeCall<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

export function installMemoryExtraction(
	pi: ExtensionAPI,
	createClient: () => Pick<RemnicMemoryClient, "observe"> = createRemnicMemoryClient,
): void {
	const client = createClient();

	pi.on("agent_end", (event, ctx) => {
		const sessionKey = sessionKeyFromContext(ctx);
		if (!sessionKey) return;
		const messages = observedMessagesFromAgentMessages(event.messages);
		if (messages.length === 0) return;
		logDiagnostic("remnic_observe_enqueue", { sessionKey, messages: messages.length });
		void client.observe(sessionKey, messages).then(() => {
			logDiagnostic("remnic_observe_ok", { sessionKey, messages: messages.length });
		}).catch((error) => {
			logDiagnostic("remnic_observe_failed", {
				sessionKey,
				messages: messages.length,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
}
