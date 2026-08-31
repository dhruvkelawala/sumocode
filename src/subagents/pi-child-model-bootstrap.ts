import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_MODEL_PROVIDER_ENV = "SUMOCODE_CHILD_MODEL_PROVIDER";
export const CHILD_MODEL_ID_ENV = "SUMOCODE_CHILD_MODEL_ID";

/**
 * Select a provider that another child extension registers during session_start.
 * Pi resolves CLI --provider/--model flags before that event, so numbered Claude
 * providers must be selected here after the OAuth adapter has registered them.
 */
export default function installPiChildModelBootstrap(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const provider = process.env[CHILD_MODEL_PROVIDER_ENV]?.trim();
		const modelId = process.env[CHILD_MODEL_ID_ENV]?.trim();
		if (!provider && !modelId) return;
		if (!provider || !modelId) throw new Error("Incomplete SumoCode child model selection");

		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Child model unavailable after provider registration: ${provider}/${modelId}`);
		if (!(await pi.setModel(model))) throw new Error(`Child model authentication unavailable: ${provider}/${modelId}`);
	});
}
