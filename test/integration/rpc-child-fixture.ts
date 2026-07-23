import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RpcChildFixtureOptions {
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly messages?: readonly unknown[];
	readonly newSessionId?: string;
	readonly newSessionName?: string;
	readonly switchSessions?: Readonly<Record<string, { readonly sessionId: string; readonly sessionName: string; readonly messages?: readonly unknown[] }>>;
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
	readonly compactDelayMs?: number;
	readonly promptDelayMs?: number;
	readonly settleDelayMs?: number;
	/** Emit a post-get_state message_update→agent_end→agent_settled suffix while get_messages returns its older snapshot. */
	readonly sessionHydrationRace?: boolean;
	readonly compactReason?: "manual" | "threshold" | "overflow";
	readonly compactSummary?: string;
	readonly compactTokensBefore?: number;
}

export async function createRpcChildFixture(prefix: string, options: RpcChildFixtureOptions = {}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const scriptPath = join(dir, "pi-rpc-fixture.cjs");
	const source = `#!/usr/bin/env node
const readline = require("node:readline");

let sessionId = ${JSON.stringify(options.sessionId ?? "fixture-session")};
let sessionName = ${JSON.stringify(options.sessionName ?? "Fixture Session")};
let messages = ${JSON.stringify(options.messages ?? [])};
const newSessionId = ${JSON.stringify(options.newSessionId ?? "fixture-session-new")};
const newSessionName = ${JSON.stringify(options.newSessionName ?? "Fresh Session")};
const switchSessions = ${JSON.stringify(options.switchSessions ?? {})};
let isStreaming = false;
let isCompacting = false;
let pendingPrompt = null;
let holdNextPromptUntilAbort = ${options.holdPromptUntilAbort ? "true" : "false"};
let sessionHydrationRacePending = false;
const sessionHydrationRace = ${options.sessionHydrationRace ? "true" : "false"};
const streamChunks = ${JSON.stringify(options.streamChunks ?? null)};
const chunkDelayMs = ${JSON.stringify(options.chunkDelayMs ?? 500)};
const streamChunkSentinels = ${options.streamChunkSentinels ? "true" : "false"};
const compactDelayMs = ${JSON.stringify(options.compactDelayMs ?? 250)};
const promptDelayMs = ${JSON.stringify(options.promptDelayMs ?? 100)};
const settleDelayMs = ${JSON.stringify(options.settleDelayMs ?? 0)};
const compactReason = ${JSON.stringify(options.compactReason ?? "manual")};
const compactSummary = ${JSON.stringify(options.compactSummary ?? "Fixture compaction summary.")};
const compactTokensBefore = ${JSON.stringify(options.compactTokensBefore ?? 42000)};
const commandLogPath = process.env.SUMOCODE_RPC_FIXTURE_LOG;

function write(payload) {
	process.stdout.write(JSON.stringify(payload) + "\\n");
}

function state() {
	return {
		model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
		thinkingLevel: "medium",
		isStreaming,
		isCompacting,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId,
		sessionName,
		autoCompactionEnabled: true,
		messageCount: messages.length,
		pendingMessageCount: isStreaming ? 1 : 0
	};
}

function response(command, data) {
	return { type: "response", id: command.id, command: command.type, success: true, data };
}

function logCommand(command) {
	if (!commandLogPath) return;
	require("node:fs").appendFileSync(commandLogPath, JSON.stringify(command) + "\\n");
}

function finishPrompt(command, assistantText) {
	isStreaming = false;
	messages = [
		...messages,
		{ id: "fixture-assistant-" + messages.length, role: "assistant", content: assistantText }
	];
	write({ type: "agent_end", messages, willRetry: false });
	setTimeout(() => write({ type: "agent_settled" }), settleDelayMs);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	logCommand(command);
	if (command.type === "get_state") {
		write(response(command, state()));
		return;
	}
	if (command.type === "get_commands") {
		write(response(command, { commands: [] }));
		return;
	}
	if (command.type === "get_messages") {
		if (sessionHydrationRacePending) {
			sessionHydrationRacePending = false;
			const hydrationSnapshot = [...messages];
			setTimeout(() => write({ type: "message_update", message: { id: "session-race-draft", role: "assistant", content: "session race draft" } }), 5);
			setTimeout(() => {
				messages = [{ id: "session-race-complete", role: "assistant", content: "session race completed" }];
				isStreaming = false;
				write({ type: "agent_end", messages, willRetry: false });
			}, 10);
			setTimeout(() => write({ type: "agent_settled" }), 15);
			setTimeout(() => write(response(command, { messages: hydrationSnapshot })), 40);
			return;
		}
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
		sessionId = newSessionId;
		sessionName = newSessionName;
		messages = [];
		isStreaming = sessionHydrationRace;
		isCompacting = false;
		write({ type: "session_info_changed", name: sessionName });
		if (sessionHydrationRace) sessionHydrationRacePending = true;
		else write({ type: "agent_end", messages, willRetry: false });
		write(response(command, { cancelled: false }));
		return;
	}
	if (command.type === "switch_session") {
		const target = switchSessions[command.sessionPath];
		if (!target) {
			write(response(command, { cancelled: true }));
			return;
		}
		sessionId = target.sessionId;
		sessionName = target.sessionName;
		messages = target.messages || [];
		isStreaming = false;
		isCompacting = false;
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
		write(response(command, {}));
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
		setTimeout(() => finishPrompt(command, "fixture response complete: " + command.message), promptDelayMs);
		return;
	}
	if (command.type === "compact") {
		isCompacting = true;
		write({ type: "compaction_start", reason: compactReason });
		setTimeout(() => {
			isCompacting = false;
			write({
				type: "compaction_end",
				reason: compactReason,
				aborted: false,
				willRetry: false,
				result: { summary: compactSummary, tokensBefore: compactTokensBefore }
			});
			write(response(command, {}));
		}, compactDelayMs);
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
