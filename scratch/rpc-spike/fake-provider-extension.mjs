import { Type } from "typebox";

const PROVIDER = "sumocode-rpc-spike";
const MODEL = "deterministic";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content, stopReason = "stop", errorMessage) {
	return {
		role: "assistant",
		content,
		api: "sumocode-rpc-spike-api",
		provider: PROVIDER,
		model: MODEL,
		usage: EMPTY_USAGE,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamFromProducer(producer) {
	const queue = [];
	const waiters = [];
	let done = false;
	let resolveResult;
	const result = new Promise((resolve) => {
		resolveResult = resolve;
	});
	const push = (event) => {
		if (event.type === "done") {
			done = true;
			resolveResult(event.message);
		}
		if (event.type === "error") {
			done = true;
			resolveResult(event.error);
		}
		const waiter = waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else queue.push(event);
	};
	void (async () => {
		for await (const event of producer()) push(event);
		done = true;
		while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
	})();
	return {
		async *[Symbol.asyncIterator]() {
			while (true) {
				if (queue.length > 0) {
					yield queue.shift();
					continue;
				}
				if (done) return;
				const next = await new Promise((resolve) => waiters.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		},
		result: () => result,
	};
}

function textStream(text, { signal, slow = false } = {}) {
	return streamFromProducer(async function* produce() {
		let current = assistant([{ type: "text", text: "" }], "stop");
		yield { type: "start", partial: current };
		yield { type: "text_start", contentIndex: 0, partial: current };
		const chunks = slow ? text.split(" ") : [text];
		for (const chunk of chunks) {
			if (signal?.aborted) {
				const error = assistant(current.content, "aborted", "aborted by spike host");
				yield { type: "error", reason: "aborted", error };
				return;
			}
			current = assistant([{ type: "text", text: current.content[0].text + (slow ? `${chunk} ` : chunk) }], "stop");
			yield { type: "text_delta", contentIndex: 0, delta: slow ? `${chunk} ` : chunk, partial: current };
			if (slow) await delay(100);
		}
		yield { type: "text_end", contentIndex: 0, content: current.content[0].text, partial: current };
		yield { type: "done", reason: "stop", message: current };
	});
}

function longTextStream({ signal } = {}) {
	return streamFromProducer(async function* produce() {
		const words = Array.from({ length: 8_000 }, (_, index) => `rpc-token-${index + 1}`);
		let text = "";
		let current = assistant([{ type: "text", text }], "stop");
		yield { type: "start", partial: current };
		yield { type: "text_start", contentIndex: 0, partial: current };
		for (let index = 0; index < words.length; index += 80) {
			if (signal?.aborted) {
				const error = assistant(current.content, "aborted", "aborted by spike host");
				yield { type: "error", reason: "aborted", error };
				return;
			}
			const delta = `${words.slice(index, index + 80).join(" ")} `;
			text += delta;
			current = assistant([{ type: "text", text }], "stop");
			yield { type: "text_delta", contentIndex: 0, delta, partial: current };
			await delay(1);
		}
		yield { type: "text_end", contentIndex: 0, content: text, partial: current };
		yield { type: "done", reason: "stop", message: current };
	});
}

function toolCallStream(name, args) {
	return streamFromProducer(async function* produce() {
		const toolCall = { type: "toolCall", id: `rpc-spike-${name}-1`, name, arguments: args };
		let current = assistant([], "toolUse");
		yield { type: "start", partial: current };
		current = assistant([{ type: "thinking", thinking: "Need to run the requested shell command." }], "toolUse");
		yield { type: "thinking_start", contentIndex: 0, partial: assistant([], "toolUse") };
		yield { type: "thinking_delta", contentIndex: 0, delta: "Need to run the requested shell command.", partial: current };
		yield { type: "thinking_end", contentIndex: 0, content: "Need to run the requested shell command.", partial: current };
		current = assistant([...current.content, toolCall], "toolUse");
		yield { type: "toolcall_start", contentIndex: 1, partial: assistant(current.content.slice(0, 1), "toolUse") };
		yield { type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(toolCall.arguments), partial: current };
		yield { type: "toolcall_end", contentIndex: 1, toolCall, partial: current };
		yield { type: "done", reason: "toolUse", message: current };
	});
}

function hasToolResult(context) {
	return context.messages.some((message) => message.role === "toolResult");
}

function lastUserText(context) {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

function userHasImage(context) {
	return context.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
}

function commandFromPrompt(prompt) {
	const sentinel = prompt.match(/RPC_APPROVAL_SENTINEL=([^\n]+)/)?.[1]?.trim();
	if (sentinel) return `rm -rf "${sentinel.replaceAll("\"", "\\\"")}"`;
	return "printf 'rpc-tool-ok\\n'";
}

function streamSimple(_model, context, options) {
	if (context.systemPrompt?.includes("Extract direct questions")) {
		return textStream("{\"questions\":[{\"prompt\":\"What is your name?\"},{\"prompt\":\"Which city should we use?\"}]}", { signal: options?.signal });
	}
	if (hasToolResult(context)) {
		return textStream("The requested command finished.", { signal: options?.signal });
	}
	const prompt = lastUserText(context);
	if (prompt.includes("RPC_LONG_STREAM")) {
		return longTextStream({ signal: options?.signal });
	}
	if (prompt.includes("RPC_ABORT_STREAM")) {
		return textStream(Array.from({ length: 250 }, (_, index) => `token-${index + 1}`).join(" "), { signal: options?.signal, slow: true });
	}
	if (userHasImage(context)) {
		return textStream("The image is a one-pixel PNG fixture.", { signal: options?.signal });
	}
	if (prompt.includes("RPC_TASK_PARTIAL")) {
		return toolCallStream("task", { prompt: "Summarize the task partial fixture." });
	}
	return toolCallStream("bash", { command: commandFromPrompt(prompt) });
}

export default function fakeProviderSpike(pi) {
	pi.registerProvider(PROVIDER, {
		api: "sumocode-rpc-spike-api",
		baseUrl: "https://sumocode.invalid",
		apiKey: "rpc-spike-key",
		streamSimple,
		models: [{
			id: MODEL,
			name: "SumoCode RPC Spike Deterministic",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16000,
		}],
	});

	pi.registerCommand("sumo:fake-provider-spike", {
		description: "RPC fake provider spike marker",
		handler: () => undefined,
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: "Deterministic RPC task partial fixture.",
		parameters: Type.Object({ prompt: Type.String() }),
		async execute(_toolCallId, params, _signal, onUpdate) {
			const partial = {
				content: [{ type: "text", text: "task partial output" }],
				details: {
					mode: "single",
					results: [{
						prompt: params.prompt,
						exitCode: -1,
						streamingText: "task partial output",
						messages: [],
						toolEvents: [],
					}],
				},
			};
			onUpdate?.(partial);
			return {
				content: [{ type: "text", text: "task final output" }],
				details: {
					mode: "single",
					results: [{
						prompt: params.prompt,
						exitCode: 0,
						finalOutput: "task final output",
						messages: [],
						toolEvents: [],
					}],
				},
			};
		},
	});
}
