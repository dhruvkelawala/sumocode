import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	streamSimpleOpenAICodexResponses,
	streamSimpleOpenAIResponses,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const SERVICE_TIER = "priority";
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const DEFAULT_FAST_MODELS = [
	"openai/gpt-5.4",
	"openai/gpt-5.5",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
];

type FastModeConfig = {
	enabled: boolean;
	models: readonly string[];
};

type FastModeModel = Pick<Model<Api>, "provider" | "id" | "api" | "maxTokens" | "contextWindow" | "thinkingLevelMap">;

type FastModeStreamers = {
	streamOpenAIResponses: typeof streamOpenAIResponses;
	streamSimpleOpenAIResponses: typeof streamSimpleOpenAIResponses;
	streamOpenAICodexResponses: typeof streamOpenAICodexResponses;
	streamSimpleOpenAICodexResponses: typeof streamSimpleOpenAICodexResponses;
};

export type FastModeState = {
	enabled: boolean;
	models: readonly string[];
};

const DEFAULT_STREAMERS: FastModeStreamers = {
	streamOpenAIResponses,
	streamSimpleOpenAIResponses,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
};

function normalizeModelRef(ref: string): string {
	return ref.trim().toLowerCase();
}

export function isConfiguredFastModel(config: FastModeConfig, model: FastModeModel | undefined): boolean {
	if (!model) return false;
	if (!SUPPORTED_PROVIDERS.has(model.provider)) return false;
	const bare = normalizeModelRef(model.id);
	const full = normalizeModelRef(`${model.provider}/${model.id}`);
	return config.models.some((entry) => {
		const normalized = normalizeModelRef(entry);
		return normalized === bare || normalized === full;
	});
}

export function shouldApplyFastMode(config: FastModeConfig, model: FastModeModel | undefined): boolean {
	return config.enabled && isConfiguredFastModel(config, model) && SUPPORTED_APIS.has(model?.api ?? "");
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const CONTEXT_WINDOW_OUTPUT_TOLERANCE = 1024;

/**
 * Match Pi's native `buildBaseOptions` default-maxTokens logic:
 * only cap at 32k when `maxTokens >= contextWindow - tolerance` (sentinel
 * meaning "context window IS the output limit"). Otherwise preserve the
 * model's own maxTokens so 64k/128k output budgets are not silently reduced.
 */
function defaultMaxTokens(model: Pick<Model<Api>, "maxTokens" | "contextWindow">): number | undefined {
	if (model.maxTokens <= 0) return undefined;
	if (model.maxTokens >= model.contextWindow - CONTEXT_WINDOW_OUTPUT_TOLERANCE) {
		return Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
	}
	return model.maxTokens;
}

function buildBaseProviderOptions(model: Pick<Model<Api>, "maxTokens" | "contextWindow">, options: SimpleStreamOptions | undefined) {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? defaultMaxTokens(model),
		signal: options?.signal,
		apiKey: options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		headers: options?.headers,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

/**
 * Clamp reasoning and convert "off" → undefined to match Pi's native
 * streamSimple* path. OpenAI Responses does not accept "off" as a valid
 * reasoning effort — Pi drops it before calling the provider stream.
 */
function clampReasoning(model: Model<Api>, reasoning: SimpleStreamOptions["reasoning"]): OpenAIResponsesOptions["reasoningEffort"] {
	if (!reasoning) return undefined;
	const clamped = clampThinkingLevel(model, reasoning);
	return (clamped === "off" ? undefined : clamped) as OpenAIResponsesOptions["reasoningEffort"];
}

export function buildOpenAIResponsesFastOptions(model: Model<Api>, options: SimpleStreamOptions | undefined): OpenAIResponsesOptions {
	return {
		...buildBaseProviderOptions(model, options),
		reasoningEffort: clampReasoning(model, options?.reasoning),
		serviceTier: SERVICE_TIER,
	};
}

export function buildOpenAICodexResponsesFastOptions(model: Model<Api>, options: SimpleStreamOptions | undefined): OpenAICodexResponsesOptions {
	return {
		...buildBaseProviderOptions(model, options),
		reasoningEffort: clampReasoning(model, options?.reasoning) as OpenAICodexResponsesOptions["reasoningEffort"],
		serviceTier: SERVICE_TIER,
	};
}

function createFastModeStream(config: () => FastModeConfig, streamers: FastModeStreamers) {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const currentConfig = config();
		if (model.api === "openai-responses") {
			return shouldApplyFastMode(currentConfig, model)
				? streamers.streamOpenAIResponses(model as Model<"openai-responses">, context, buildOpenAIResponsesFastOptions(model, options))
				: streamers.streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, options);
		}
		if (model.api === "openai-codex-responses") {
			return shouldApplyFastMode(currentConfig, model)
				? streamers.streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, buildOpenAICodexResponsesFastOptions(model, options))
				: streamers.streamSimpleOpenAICodexResponses(model as Model<"openai-codex-responses">, context, options);
		}
		throw new Error(`sumocode fast mode: unsupported API override ${String(model.api)}`);
	};
}

function describeFastMode(state: FastModeState, model: FastModeModel | undefined): string {
	const stateText = state.enabled ? "ON" : "OFF";
	if (!model) return `Fast mode ${stateText}. No model selected.`;
	const modelKey = `${model.provider}/${model.id}`;
	if (shouldApplyFastMode(state, model)) return `Fast mode ${stateText}. Applying ${SERVICE_TIER} service tier to ${modelKey}.`;
	if (state.enabled && !isConfiguredFastModel(state, model)) return `Fast mode ${stateText}, inactive for unsupported model ${modelKey}.`;
	return `Fast mode ${stateText}. Current model: ${modelKey}.`;
}

function notify(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export function installFastMode(pi: ExtensionAPI, options: { streamers?: Partial<FastModeStreamers>; initialEnabled?: boolean } = {}): FastModeState {
	const state: FastModeState = {
		enabled: options.initialEnabled ?? false,
		models: DEFAULT_FAST_MODELS,
	};
	let currentModel: FastModeModel | undefined;
	const streamSimple = createFastModeStream(
		() => state,
		{ ...DEFAULT_STREAMERS, ...options.streamers },
	);

	pi.registerProvider("openai", {
		api: "openai-responses",
		streamSimple,
	});
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple,
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		currentModel = ctx.model as FastModeModel | undefined;
	});
	pi.on("model_select", async (event) => {
		currentModel = event.model as FastModeModel;
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI/Codex fast mode",
		handler: async (args, ctx) => {
			currentModel = ctx.model as FastModeModel | undefined;
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "toggle") state.enabled = !state.enabled;
			else if (arg === "on") state.enabled = true;
			else if (arg === "off") state.enabled = false;
			else if (arg === "status") {
				notify(ctx, describeFastMode(state, currentModel), "info");
				return;
			} else {
				notify(ctx, "Usage: /fast [on|off|toggle|status]", "error");
				return;
			}
			notify(ctx, describeFastMode(state, currentModel), state.enabled ? "warning" : "info");
		},
	});

	return state;
}
