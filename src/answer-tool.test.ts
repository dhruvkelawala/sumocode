import { describe, expect, it, vi } from "vitest";
import {
	extractQuestionsFromText,
	installAnswerTool,
	type ExtractionResult,
} from "./answer-tool.js";

function assistantBranch(text: string) {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text }],
			},
		},
	];
}

function registerHarness(extractionResult: ExtractionResult) {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sendMessage = vi.fn();
	const extract = vi.fn(async () => extractionResult);
	const pi = {
		registerCommand: vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		}),
		registerShortcut: vi.fn(),
		sendMessage,
	};
	installAnswerTool(pi as never, { extractQuestionsFromText: extract as never });
	return { handler: handler!, sendMessage, extract };
}

function rpcCtx(input: ReturnType<typeof vi.fn>, custom = vi.fn()) {
	return {
		hasUI: true,
		mode: "rpc",
		model: { id: "current-model" },
		signal: undefined,
		modelRegistry: {
			find: vi.fn(() => undefined),
			getApiKeyAndHeaders: vi.fn(),
		},
		sessionManager: {
			getBranch: () => assistantBranch("Can you choose a path? Also, when should it ship?"),
		},
		ui: {
			input,
			custom,
			notify: vi.fn(),
		},
	};
}

describe("extractQuestionsFromText", () => {
	it("runs the extraction helper without any UI custom callback", async () => {
		const model = { id: "extractor-model" };
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "key", headers: { "x-test": "yes" } }));
		const complete = vi.fn(async () => ({
			stopReason: "stop",
			content: [{
				type: "text",
				text: "```json\n{\"questions\":[{\"question\":\"Ship it?\",\"context\":\"release branch\"}]}\n```",
			}],
		}));

		const result = await extractQuestionsFromText(
			"Ship it?",
			model as never,
			{ getApiKeyAndHeaders } as never,
			undefined,
			complete as never,
		);

		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({
				messages: [expect.objectContaining({ role: "user" })],
			}),
			expect.objectContaining({ apiKey: "key", headers: { "x-test": "yes" } }),
		);
		expect(result).toEqual({ questions: [{ question: "Ship it?", context: "release branch" }] });
	});
});

describe("answer command RPC flow", () => {
	it("extracts questions and collects each answer through primitive input", async () => {
		const { handler, sendMessage, extract } = registerHarness({
			questions: [
				{ question: "Choose a path?", context: "Need deployment target" },
				{ question: "When should it ship?" },
			],
		});
		const input = vi.fn()
			.mockResolvedValueOnce("  production  ")
			.mockResolvedValueOnce("tomorrow");
		const custom = vi.fn();
		const ctx = rpcCtx(input, custom);

		await handler("", ctx);

		expect(extract).toHaveBeenCalledWith(
			"Can you choose a path? Also, when should it ship?",
			ctx.model,
			ctx.modelRegistry,
			undefined,
		);
		expect(input).toHaveBeenNthCalledWith(1, "Choose a path?\nNeed deployment target", "type your answer");
		expect(input).toHaveBeenNthCalledWith(2, "When should it ship?", "type your answer");
		expect(custom).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "answers",
				display: true,
				content: expect.stringContaining("Q: Choose a path?\n> Need deployment target\nA: production"),
				details: {
					entries: [
						{ question: "Choose a path?", context: "Need deployment target", answer: "production" },
						{ question: "When should it ship?", answer: "tomorrow" },
					],
				},
			}),
			{ triggerTurn: true },
		);
	});

	it("cancels without sending answers when a primitive answer is cancelled", async () => {
		const { handler, sendMessage } = registerHarness({
			questions: [
				{ question: "First?" },
				{ question: "Second?" },
			],
		});
		const input = vi.fn()
			.mockResolvedValueOnce("one")
			.mockResolvedValueOnce(undefined);
		const ctx = rpcCtx(input);

		await handler("", ctx);

		expect(sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
	});
});
