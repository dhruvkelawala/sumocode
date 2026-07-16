import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER = "sumocode-visual";
const MODEL_ID = "active-working";
const API = "sumocode-visual-faux";

export default function installRuntimeVisualProvider(pi) {
	pi.registerProvider(PROVIDER, {
		name: "SumoCode Visual",
		baseUrl: "http://localhost:0",
		apiKey: "sumocode-visual-non-secret",
		api: API,
		streamSimple: streamActiveRuntime,
		models: [{
			id: MODEL_ID,
			name: "SumoCode Visual Active Runtime",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}

function streamActiveRuntime(model, _context, options = {}) {
	const stream = createAssistantMessageEventStream();
	const partial = {
		role: "assistant",
		content: [],
		api: API,
		provider: PROVIDER,
		model: model.id,
		usage: usage(),
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		void pumpActiveRuntimeStream(stream, partial, options.signal);
	});

	return stream;
}

async function pumpActiveRuntimeStream(stream, partial, signal) {
	const active = {
		...partial,
		content: [{ type: "text", text: "" }],
	};
	stream.push({ type: "start", partial: { ...partial } });
	stream.push({ type: "text_start", contentIndex: 0, partial: { ...active } });
	for (const chunk of activeRuntimeChunks()) {
		if (signal?.aborted) {
			const aborted = { ...active, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now() };
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}
		await sleep(500);
		active.content[0].text += chunk;
		stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: { ...active, content: [{ ...active.content[0] }] } });
	}
	await sleep(60_000);
}

function activeRuntimeChunks() {
	return [
		"inspecting ",
		"src/auth/session.ts ",
		"and keeping ",
		"the runtime ",
		"active for ",
		"visual parity ",
		"capture. ",
	];
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
