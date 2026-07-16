import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RpcChildFixtureOptions {
	readonly sessionName?: string;
	readonly messages?: readonly unknown[];
	readonly holdPromptUntilAbort?: boolean;
	/**
	 * When set, a `prompt` command streams these chunks as successive
	 * `message_update` events (each appended onto the previous, mirroring a
	 * real token stream), `chunkDelayMs` apart, before the run finishes.
	 * Replaces the fixture's default single `message_update` + 100ms finish.
	 * Models `scripts/visual-v2/runtime-faux-provider.mjs`'s slow real-stream
	 * shape for tests that need to observe intermediate streaming states
	 * (e.g. scrolling up mid-stream) rather than just start/end.
	 */
	readonly streamChunks?: readonly string[];
	readonly chunkDelayMs?: number;
	/**
	 * When true (with `streamChunks`), each streamed chunk N additionally
	 * emits `session_info_changed` with the name `stream-chunk-<N>-landed`
	 * right after its `message_update`. The session name renders in the
	 * host's always-visible chrome, giving PTY tests an ON-SCREEN sentinel
	 * for "chunk N has been processed" even while the transcript viewport is
	 * scrolled away from the streaming tail -- off-screen draft rows are
	 * never painted, so no byte-stream pattern can signal chunk arrival in
	 * that state.
	 */
	readonly streamChunkSentinels?: boolean;
}

export async function createRpcChildFixture(prefix: string, options: RpcChildFixtureOptions = {}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const scriptPath = join(dir, "pi-rpc-fixture.cjs");
	const source = `#!/usr/bin/env node
const readline = require("node:readline");

let sessionName = ${JSON.stringify(options.sessionName ?? "Fixture Session")};
let messages = ${JSON.stringify(options.messages ?? [])};
let isStreaming = false;
let pendingPrompt = null;
let holdNextPromptUntilAbort = ${options.holdPromptUntilAbort ? "true" : "false"};
const streamChunks = ${JSON.stringify(options.streamChunks ?? null)};
const chunkDelayMs = ${JSON.stringify(options.chunkDelayMs ?? 500)};
const streamChunkSentinels = ${options.streamChunkSentinels ? "true" : "false"};

function write(payload) {
	process.stdout.write(JSON.stringify(payload) + "\\n");
}

function state() {
	return {
		model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
		thinkingLevel: "medium",
		isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "fixture-session",
		sessionName,
		autoCompactionEnabled: true,
		messageCount: messages.length,
		pendingMessageCount: isStreaming ? 1 : 0
	};
}

function response(command, data) {
	return { type: "response", id: command.id, command: command.type, success: true, data };
}

function finishPrompt(command, assistantText) {
	isStreaming = false;
	messages = [
		...messages,
		{ id: "fixture-assistant-" + messages.length, role: "assistant", content: assistantText }
	];
	write({ type: "agent_end", messages, willRetry: false });
	write(response(command, {}));
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "get_state") {
		write(response(command, state()));
		return;
	}
	if (command.type === "get_commands") {
		write(response(command, { commands: [] }));
		return;
	}
	if (command.type === "get_messages") {
		write(response(command, { messages }));
		return;
	}
	if (command.type === "get_session_stats") {
		write(response(command, {
			totalMessages: messages.length,
			tokens: { total: 1200 },
			contextUsage: { tokens: 1200, contextWindow: 200000 },
			cost: 0
		}));
		return;
	}
	if (command.type === "new_session") {
		sessionName = "Fresh Session";
		messages = [];
		isStreaming = false;
		write({ type: "session_info_changed", name: sessionName });
		write({ type: "agent_end", messages, willRetry: false });
		write(response(command, { cancelled: false }));
		return;
	}
	if (command.type === "prompt") {
		messages = [
			...messages,
			{ id: "fixture-user-" + messages.length, role: "user", content: command.message }
		];
		isStreaming = true;
		write({ type: "agent_start" });
		if (streamChunks) {
			let text = "";
			let index = 0;
			const pump = () => {
				if (index >= streamChunks.length) {
					finishPrompt(command, text);
					return;
				}
				text += streamChunks[index];
				index += 1;
				write({ type: "message_update", message: { id: "fixture-draft", role: "assistant", content: text } });
				if (streamChunkSentinels) write({ type: "session_info_changed", name: "stream-chunk-" + index + "-landed" });
				setTimeout(pump, chunkDelayMs);
			};
			setTimeout(pump, chunkDelayMs);
			return;
		}
		write({ type: "message_update", message: { id: "fixture-draft", role: "assistant", content: "streaming fixture response" } });
		if (holdNextPromptUntilAbort) {
			holdNextPromptUntilAbort = false;
			pendingPrompt = command;
			return;
		}
		setTimeout(() => finishPrompt(command, "fixture response complete: " + command.message), 100);
		return;
	}
	if (command.type === "abort") {
		write(response(command, {}));
		if (pendingPrompt) {
			const prompt = pendingPrompt;
			pendingPrompt = null;
			finishPrompt(prompt, "aborted by fixture");
		} else {
			isStreaming = false;
			write({ type: "agent_end", messages, willRetry: false });
		}
		return;
	}
	write(response(command, {}));
});
`;
	await writeFile(scriptPath, source, "utf8");
	await chmod(scriptPath, 0o755);
	return scriptPath;
}

export function transcriptMessages(count: number, prefix: string): unknown[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `${prefix} anchor ${String(index).padStart(2, "0")}`,
	}));
}
