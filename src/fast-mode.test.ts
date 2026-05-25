import { describe, expect, it, vi } from "vitest";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildOpenAICodexResponsesFastOptions, buildOpenAIResponsesFastOptions, installFastMode, isConfiguredFastModel, shouldApplyFastMode } from "./fast-mode.js";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-codex-responses",
		baseUrl: "https://example.test",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: {},
		...overrides,
	} as Model<Api>;
}

describe("fast mode", () => {
	it("matches configured provider-qualified and bare model ids", () => {
		const config = { enabled: true, models: ["openai/gpt-5.5", "gpt-5.4"] };
		expect(isConfiguredFastModel(config, model({ provider: "openai", id: "gpt-5.5" }))).toBe(true);
		expect(isConfiguredFastModel(config, model({ provider: "openai-codex", id: "gpt-5.4" }))).toBe(true);
		expect(isConfiguredFastModel(config, model({ provider: "anthropic", id: "gpt-5.5" }))).toBe(false);
	});

	it("only applies to enabled OpenAI response APIs", () => {
		const config = { enabled: true, models: ["openai-codex/gpt-5.5"] };
		expect(shouldApplyFastMode(config, model())).toBe(true);
		expect(shouldApplyFastMode({ ...config, enabled: false }, model())).toBe(false);
		expect(shouldApplyFastMode(config, model({ api: "openai-completions" }))).toBe(false);
	});

	it("builds native OpenAI provider options with serviceTier, not payload patches", () => {
		const options: SimpleStreamOptions = {
			reasoning: "high",
			temperature: 0.2,
			maxTokens: 4096,
			sessionId: "session-1",
		};
		expect(buildOpenAIResponsesFastOptions(model({ api: "openai-responses" }), options)).toMatchObject({
			reasoningEffort: "high",
			serviceTier: "priority",
			temperature: 0.2,
			maxTokens: 4096,
			sessionId: "session-1",
		});
		expect(buildOpenAICodexResponsesFastOptions(model(), options)).toMatchObject({
			reasoningEffort: "high",
			serviceTier: "priority",
		});
	});

	it("preserves model maxTokens when below contextWindow (does not cap at 32k)", () => {
		// Model with 64k maxTokens, 1M contextWindow → should keep 64k, not cap at 32k
		const largeOutputModel = model({ api: "openai-responses", maxTokens: 64_000, contextWindow: 1_000_000 });
		const result = buildOpenAIResponsesFastOptions(largeOutputModel, undefined);
		expect(result.maxTokens).toBe(64_000);
	});

	it("caps maxTokens at 32k when maxTokens ≈ contextWindow (sentinel)", () => {
		// Model where maxTokens == contextWindow → sentinel, cap at 32k
		const sentinelModel = model({ api: "openai-responses", maxTokens: 200_000, contextWindow: 200_000 });
		const result = buildOpenAIResponsesFastOptions(sentinelModel, undefined);
		expect(result.maxTokens).toBe(32_000);
	});

	it("clamps unsupported reasoning levels via clampThinkingLevel", () => {
		// Model whose thinkingLevelMap maps xhigh → max (supported)
		const supportedModel = model({
			api: "openai-responses",
			thinkingLevelMap: { xhigh: "max" },
		});
		const result = buildOpenAIResponsesFastOptions(supportedModel, { reasoning: "xhigh" });
		expect(result.reasoningEffort).toBe("xhigh");

		// Model with empty thinkingLevelMap — xhigh is unsupported, should be clamped down
		const unsupportedModel = model({
			api: "openai-responses",
			thinkingLevelMap: {},
		});
		const clamped = buildOpenAIResponsesFastOptions(unsupportedModel, { reasoning: "xhigh" });
		expect(clamped.reasoningEffort).not.toBe("xhigh");
	});

	it("omits reasoning when not provided in options", () => {
		const result = buildOpenAICodexResponsesFastOptions(model(), undefined);
		expect(result.reasoningEffort).toBeUndefined();
	});

	it("converts clamped 'off' reasoning to undefined (matches Pi native path)", () => {
		// Model that only supports "off" — clampThinkingLevel will return "off"
		// for any input, and fast mode must convert that to undefined
		const offOnlyModel = model({
			api: "openai-responses",
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null },
		});
		const result = buildOpenAIResponsesFastOptions(offOnlyModel, { reasoning: "high" });
		expect(result.reasoningEffort).toBeUndefined();

		const codexResult = buildOpenAICodexResponsesFastOptions(
			{ ...offOnlyModel, api: "openai-codex-responses" } as typeof offOnlyModel,
			{ reasoning: "medium" },
		);
		expect(codexResult.reasoningEffort).toBeUndefined();
	});

	it("delegates unsupported OpenAI APIs to Pi's native simple stream", () => {
		const fallbackStream = {};
		const streamUnsupportedApi = vi.fn(() => fallbackStream as never);
		const registerProvider = vi.fn();
		installFastMode({
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerProvider,
		} as never, {
			initialEnabled: true,
			streamers: { streamUnsupportedApi },
		});

		const openAIProvider = registerProvider.mock.calls.find(([provider]) => provider === "openai")?.[1];
		const unsupportedModel = model({ provider: "openai", id: "gpt-legacy", api: "openai-completions" });
		const context = {} as never;
		const options = { maxTokens: 123 };

		const result = openAIProvider.streamSimple(unsupportedModel, context, options);

		expect(result).toBe(fallbackStream);
		expect(streamUnsupportedApi).toHaveBeenCalledWith(unsupportedModel, context, options);
	});

	it("resets enabled state on each session_start", async () => {
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const pi = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}),
			registerCommand: vi.fn(),
			registerProvider: vi.fn(),
		};
		const state = installFastMode(pi as never, { initialEnabled: true });
		expect(state.enabled).toBe(true);

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({}, { model: model() });
		}
		expect(state.enabled).toBe(false);
	});
});
