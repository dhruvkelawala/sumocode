import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTaskModeAutoExit } from "../../../src/task-mode.js";

// Synthetic provider only: real Pi drives the stream and task-mode lifecycle.
export default function install(pi: ExtensionAPI): void {
	const root = process.env.PLAN112_ROOT!;
	const role = process.env.PLAN112_ROLE!;
	const append = <T>(name: string, value: T): void => appendFileSync(join(root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
	if (role === "parent") {
		const generation = randomUUID();
		pi.on("session_start", (event) => append("parents.jsonl", { event: "start", reason: event.reason, pid: process.pid, generation }));
		pi.on("session_shutdown", (event) => append("parents.jsonl", { event: "shutdown", reason: event.reason, pid: process.pid, generation }));
		pi.registerCommand("proof-control", {
			handler: async (action) => append("requests.jsonl", { generation, pid: process.pid, action }),
		});
		pi.registerCommand("proof-recover", {
			handler: async () => append("recovered.jsonl", { generation, pid: process.pid, events: readFileSync(join(root, "events.jsonl"), "utf8") }),
		});
		pi.registerCommand("proof-quit", { handler: async (_args, ctx) => ctx.shutdown() });
		return;
	}
	pi.registerProvider("plan112-fixture", {
		baseUrl: "http://127.0.0.1", apiKey: "synthetic-not-a-credential", api: "plan112-fixture",
		models: [{ id: "held", name: "held", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const output: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending", timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				writeFileSync(join(root, "stream-ready"), String(process.pid), { mode: 0o600 });
				const poll = setInterval(() => {
					if (!options?.signal?.aborted && !existsSync(join(root, "release"))) return;
					clearInterval(poll);
					if (options?.signal?.aborted) {
						output.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
					} else {
						const steered = JSON.stringify(context.messages).includes("post-replacement-steer");
						const text = steered ? "recovered-steered-result" : "recovered-result";
						output.content = [{ type: "text", text }];
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
						output.stopReason = "stop";
						stream.push({ type: "done", reason: "stop", message: output });
					}
					stream.end();
				}, 20);
			});
			return stream;
		},
	});
	if (role === "visible") {
		installTaskModeAutoExit(pi);
		pi.on("session_start", () => {
			pi.sendUserMessage(readFileSync(join(process.env.PLAN112_TASK_DIR!, "prompt.txt"), "utf8"));
		});
	}
}
