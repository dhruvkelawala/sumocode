import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, RpcProcess, repoRoot, writeJsonl } from "./rpc-process.mjs";
import { transcriptFromEvents, transcriptFromMessages } from "./view-model-copy.mjs";

const outDir = resolve(repoRoot, "scratch/rpc-spike");

function scenarioPath(name) {
	return resolve(outDir, `events-${name}.jsonl`);
}

function summarizeCommands(commands) {
	return commands
		.filter((command) => command.source === "extension")
		.map((command) => command.name)
		.sort();
}

async function waitUntil(predicate, { timeoutMs, label }) {
	const started = performance.now();
	while (performance.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function selftest() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["src/extension.ts"] });
	try {
		const state = await rpc.send({ type: "get_state", id: "1" });
		console.log("GET_STATE_RESPONSE", JSON.stringify(state));
		const commands = await rpc.send({ type: "get_commands", id: "2" });
		const extensionCommands = summarizeCommands(commands.data?.commands ?? []);
		console.log("GET_COMMANDS_EXTENSION_COMMANDS", JSON.stringify(extensionCommands));
		if (!state.success || state.command !== "get_state") throw new Error("get_state did not return a success response");
		if (extensionCommands.length === 0) throw new Error("get_commands returned no extension commands");
	} finally {
		await rpc.dispose();
	}
}

async function captureBashToolScenario() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/fake-provider-extension.mjs"] });
	const events = [];
	rpc.onEvent((event) => events.push(event));
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const response = await rpc.send({ type: "prompt", message: "Call the bash tool for the deterministic RPC tool scenario." }, { timeoutMs: 15_000 });
		await rpc.waitFor((event) => event.type === "agent_end", { timeoutMs: 30_000, label: "tool agent_end" });
		const messages = await rpc.send({ type: "get_messages" }, { timeoutMs: 15_000 });
		await writeJsonl(scenarioPath("tool"), events);
		await writeFile(resolve(outDir, "messages-tool.json"), canonicalJson(messages.data?.messages ?? []), "utf8");
		console.log("TOOL_SCENARIO", JSON.stringify({
			responseSuccess: response.success,
			eventTypes: [...new Set(events.map((event) => event.type))],
			messageCount: messages.data?.messages?.length ?? 0,
		}));
	} finally {
		await rpc.dispose();
	}
}

async function captureTaskPartialScenario() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/fake-provider-extension.mjs"] });
	const events = [];
	rpc.onEvent((event) => events.push(event));
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const response = await rpc.send({ type: "prompt", message: "RPC_TASK_PARTIAL call the task tool." }, { timeoutMs: 15_000 });
		await rpc.waitFor((event) => event.type === "agent_end", { timeoutMs: 30_000, label: "task agent_end" });
		const messages = await rpc.send({ type: "get_messages" }, { timeoutMs: 15_000 });
		await writeJsonl(scenarioPath("task-partial"), events);
		await writeFile(resolve(outDir, "messages-task-partial.json"), canonicalJson(messages.data?.messages ?? []), "utf8");
		console.log("TASK_PARTIAL_SCENARIO", JSON.stringify({
			responseSuccess: response.success,
			partialUpdates: events.filter((event) => event.type === "tool_execution_update" && event.toolName === "task").length,
			eventTypes: [...new Set(events.map((event) => event.type))],
			messageCount: messages.data?.messages?.length ?? 0,
		}));
	} finally {
		await rpc.dispose();
	}
}

async function captureImageScenario() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/fake-provider-extension.mjs"] });
	const events = [];
	rpc.onEvent((event) => events.push(event));
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const image = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lUzpWQAAAABJRU5ErkJggg==",
		};
		const response = await rpc.send({
			type: "prompt",
			message: "Describe this image in one short sentence.",
			images: [image],
		}, { timeoutMs: 45_000 });
		await rpc.waitFor((event) => event.type === "agent_end", { timeoutMs: 120_000, label: "image agent_end" });
		const messages = await rpc.send({ type: "get_messages" }, { timeoutMs: 15_000 });
		await writeJsonl(scenarioPath("image"), events);
		await writeFile(resolve(outDir, "messages-image.json"), canonicalJson(messages.data?.messages ?? []), "utf8");
		console.log("IMAGE_SCENARIO", JSON.stringify({
			responseSuccess: response.success,
			eventTypes: [...new Set(events.map((event) => event.type))],
			messageCount: messages.data?.messages?.length ?? 0,
		}));
	} finally {
		await rpc.dispose();
	}
}

async function captureAbortScenario() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/fake-provider-extension.mjs"] });
	const events = [];
	rpc.onEvent((event) => events.push(event));
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const response = await rpc.send({
			type: "prompt",
			message: "RPC_ABORT_STREAM count slowly from 1 to 200, writing one number per line.",
		}, { timeoutMs: 45_000 });
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
		const abort = await rpc.send({ type: "abort" }, { timeoutMs: 15_000 });
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
		const messages = await rpc.send({ type: "get_messages" }, { timeoutMs: 15_000 });
		await writeJsonl(scenarioPath("abort"), events);
		await writeFile(resolve(outDir, "messages-abort.json"), canonicalJson(messages.data?.messages ?? []), "utf8");
		console.log("ABORT_SCENARIO", JSON.stringify({
			responseSuccess: response.success,
			abortSuccess: abort.success,
			eventTypes: [...new Set(events.map((event) => event.type))],
			messageCount: messages.data?.messages?.length ?? 0,
		}));
	} finally {
		await rpc.dispose();
	}
}

async function compareScenario(name) {
	const eventsText = await readFile(scenarioPath(name), "utf8");
	const events = eventsText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const messages = JSON.parse(await readFile(resolve(outDir, `messages-${name}.json`), "utf8"));
	const fromEvents = transcriptFromEvents(events);
	const fromMessages = transcriptFromMessages(messages);
	const equal = canonicalJson(fromEvents) === canonicalJson(fromMessages);
	await writeFile(resolve(outDir, `view-model-${name}-events.json`), canonicalJson(fromEvents), "utf8");
	await writeFile(resolve(outDir, `view-model-${name}-messages.json`), canonicalJson(fromMessages), "utf8");
	console.log("VIEW_MODEL_COMPARE", JSON.stringify({ scenario: name, equal }));
	return equal;
}

async function perfBench() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/fake-provider-extension.mjs"] });
	const events = [];
	let firstUpdateMs;
	const started = performance.now();
	rpc.onEvent((event) => {
		events.push({ event, atMs: performance.now() - started });
		if (event.type === "message_update" && firstUpdateMs === undefined) firstUpdateMs = performance.now() - started;
	});
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const response = await rpc.send({
			type: "prompt",
			message: "RPC_LONG_STREAM Write a long deterministic assistant message.",
		}, { timeoutMs: 60_000 });
		await rpc.waitFor((event) => event.type === "agent_end", { timeoutMs: 240_000, label: "perf agent_end" });
		const elapsedMs = performance.now() - started;
		await writeJsonl(scenarioPath("perf-long-stream"), events.map((entry) => ({ ...entry.event, observedAtMs: entry.atMs })));
		const updateTimes = events.filter((entry) => entry.event.type === "message_update").map((entry) => entry.atMs);
		const deltas = updateTimes.slice(1).map((time, index) => time - updateTimes[index]);
		const averageDeltaMs = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : undefined;
		const metrics = {
			responseSuccess: response.success,
			elapsedMs,
			firstUpdateMs,
			messageUpdateCount: updateTimes.length,
			averageDeltaMs,
			stdoutBytes: rpc.metrics.stdoutBytes,
			parseMs: rpc.metrics.parseMs,
			bytesPerSecond: rpc.metrics.stdoutBytes / (elapsedMs / 1000),
		};
		await writeFile(resolve(outDir, "perf-long-stream.json"), canonicalJson(metrics), "utf8");
		console.log("PERF_BENCH", JSON.stringify(metrics));
	} finally {
		await rpc.dispose();
	}
}

async function answerRpc() {
	const rpc = new RpcProcess({ cwd: repoRoot, extensions: ["scratch/rpc-spike/answer-rpc-extension.mjs"] });
	const events = [];
	const ui = [];
	rpc.onEvent((event) => events.push(event));
	rpc.setUiRequestHandler((request) => {
		ui.push(request);
	});
	try {
		await rpc.send({ type: "set_model", provider: "sumocode-rpc-spike", modelId: "deterministic" }, { timeoutMs: 10_000 });
		const promptId = rpc.sendNoWait({ type: "prompt", message: "RPC_ANSWER_EXTRACT" });
		await waitUntil(
			() => ui.some((request) => request.method === "notify" && request.message?.startsWith("answer-rpc-spike:")),
			{ timeoutMs: 30_000, label: "answer-rpc notify" },
		);
		const messages = await rpc.send({ type: "get_messages" }, { timeoutMs: 15_000 });
		await writeJsonl(scenarioPath("answer-rpc"), events);
		await writeFile(resolve(outDir, "messages-answer-rpc.json"), canonicalJson(messages.data?.messages ?? []), "utf8");
		await writeFile(resolve(outDir, "ui-answer-rpc.json"), canonicalJson(ui), "utf8");
		const resultMessage = (messages.data?.messages ?? []).find((message) => message.customType === "answer-rpc-spike-result");
		console.log("ANSWER_RPC", JSON.stringify({
			promptId,
			resultContent: resultMessage?.content,
			uiRequests: ui,
		}));
		if (!resultMessage?.content) throw new Error("answer-rpc-spike produced no result message");
	} finally {
		await rpc.dispose();
	}
}

async function main() {
	await mkdir(outDir, { recursive: true });
	const args = new Set(process.argv.slice(2));
	if (args.has("--selftest")) return await selftest();
	if (args.has("--tool-scenario")) return await captureBashToolScenario();
	if (args.has("--task-scenario")) return await captureTaskPartialScenario();
	if (args.has("--image-scenario")) return await captureImageScenario();
	if (args.has("--abort-scenario")) return await captureAbortScenario();
	if (args.has("--compare-tool")) return await compareScenario("tool");
	if (args.has("--compare-image")) return await compareScenario("image");
	if (args.has("--compare-abort")) return await compareScenario("abort");
	if (args.has("--perf")) return await perfBench();
	if (args.has("--answer-rpc")) return await answerRpc();
	console.log("usage: node scratch/rpc-spike/host.mjs --selftest|--tool-scenario|--task-scenario|--image-scenario|--abort-scenario|--compare-tool|--compare-image|--compare-abort|--perf|--answer-rpc");
}

main().catch((error) => {
	console.error(error.stack ?? String(error));
	process.exit(1);
});
