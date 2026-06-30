import { complete } from "@earendil-works/pi-ai";
import fakeProviderSpike from "./fake-provider-extension.mjs";

const SYSTEM_PROMPT = "Extract direct questions from the user text. Return JSON only with shape {\"questions\":[{\"prompt\":\"...\"}]}.";

function parseExtractionResult(text) {
	const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
	const parsed = JSON.parse(json);
	return {
		questions: Array.isArray(parsed.questions)
			? parsed.questions.map((item) => ({ prompt: String(item.prompt ?? item.question ?? "") })).filter((item) => item.prompt)
			: [],
	};
}

export default function answerRpcSpike(pi) {
	fakeProviderSpike(pi);

	const runExtraction = async (ctx) => {
		if (ctx.mode !== "rpc") return false;
		if (!ctx.model) {
			ctx.ui.notify("answer-rpc-spike: no model selected", "error");
			return true;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			ctx.ui.notify(`answer-rpc-spike: ${auth.error}`, "error");
			return true;
		}
		const response = await complete(
			ctx.model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{
					role: "user",
					content: [{ type: "text", text: "What is your name? Which city should we use?" }],
					timestamp: Date.now(),
				}],
			},
			{ apiKey: auth.apiKey, headers: auth.headers },
		);
		const responseText = response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const result = parseExtractionResult(responseText);
		pi.sendMessage({
			customType: "answer-rpc-spike-result",
			content: JSON.stringify(result),
			display: true,
			details: result,
		});
		ctx.ui.notify(`answer-rpc-spike:${JSON.stringify(result)}`, "info");
		return true;
	};

	pi.registerCommand("sumo:answer-rpc-spike", {
		description: "Run answer-tool extraction outside custom UI in RPC mode",
		handler: async (_args, ctx) => {
			await runExtraction(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.includes("RPC_ANSWER_EXTRACT")) return undefined;
		await runExtraction(ctx);
		return { action: "handled" };
	});
}
