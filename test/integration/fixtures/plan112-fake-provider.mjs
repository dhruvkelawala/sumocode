import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Generate only synthetic provider state in a fresh caller-owned namespace. */
export function generateFakeProvider(directory, aiEntry) {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || realpathSync(directory) !== directory || (stat.mode & 0o777) !== 0o700
		|| stat.uid !== process.getuid()) throw new Error("provider requires a private owned directory");
	const entry = join(directory, "provider.mjs");
	writeFileSync(entry, `import { createAssistantMessageEventStream } from ${JSON.stringify(aiEntry)};
import { existsSync, renameSync, writeFileSync } from "node:fs";
const directory = ${JSON.stringify(directory)};
export default function(pi) {
	pi.registerProvider("source-proof", {
		baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-not-a-credential", api: "source-proof",
		models: [{ id: "fixed", name: "fixed", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
		streamSimple(model, context) {
			writeFileSync(directory + "/provider-called.pending", JSON.stringify({
				promptPresent: JSON.stringify(context.messages).includes("synthetic recovery task"),
				privateRolePresent: context.systemPrompt.includes("synthetic private role"),
				toolsEmpty: !context.tools?.length,
			}), { mode: 0o600, flag: "wx" });
			renameSync(directory + "/provider-called.pending", directory + "/provider-called.json");
			const stream = createAssistantMessageEventStream();
			const timer = setInterval(() => {
				if (!existsSync(directory + "/finish")) return;
				clearInterval(timer);
				const output = { role: "assistant", content: [{ type: "text", text: "preserved result" }],
					api: model.api, provider: model.provider, model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: Date.now() };
				stream.push({ type: "start", partial: output });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "preserved result", partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: "preserved result", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			}, 25);
			return stream;
		},
	});
}
`, { mode: 0o600, flag: "wx" });
	return entry;
}
