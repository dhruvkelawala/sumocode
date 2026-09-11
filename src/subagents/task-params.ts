// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- shared decoder vocabulary: `isRecord` narrows untrusted producer records, so unknown-typed inputs and open string-keyed records are its real input contract.
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const VALID_THINKING_OPTIONS = ["inherit", ...VALID_THINKING_LEVELS] as const;

export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];
export type TaskThinking = (typeof VALID_THINKING_OPTIONS)[number];

export type TaskWorkItem = {
	prompt: string;
	skill?: string;
	model?: string;
	thinking?: TaskThinking;
	fork: boolean;
};

export type ProviderModel = {
	provider: string;
	modelId: string;
	label: string;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
	return value !== null && typeof value === "object";
};

const parseProviderModel = (value: string): { ok: true; model: ProviderModel } | { ok: false; error: string } => {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return { ok: false, error: `Invalid model format: "${value}". Expected provider/modelId.` };
	}
	const provider = trimmed.slice(0, slashIndex);
	const modelId = trimmed.slice(slashIndex + 1);
	return { ok: true, model: { provider, modelId, label: `${provider}/${modelId}` } };
};

export const resolveModel = (
	modelOverride: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): { ok: true; model: ProviderModel | undefined } | { ok: false; error: string } => {
	if (modelOverride) {
		const parsed = parseProviderModel(modelOverride);
		if (!parsed.ok) return parsed;
		return { ok: true, model: parsed.model };
	}

	if (!ctxModel) return { ok: true, model: undefined };
	return {
		ok: true,
		model: { provider: ctxModel.provider, modelId: ctxModel.id, label: `${ctxModel.provider}/${ctxModel.id}` },
	};
};
