import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_MODEL_PROVIDER_ENV = "SUMOCODE_CHILD_MODEL_PROVIDER";
export const CHILD_MODEL_ID_ENV = "SUMOCODE_CHILD_MODEL_ID";

type TerminateChild = (message: string) => never;

const terminateChild: TerminateChild = (message) => {
	// Print mode does not bind ExtensionContext.shutdown, and Pi catches event
	// handler exceptions. A direct non-zero exit is the only fail-closed boundary
	// that guarantees the initial prompt cannot fall through to another account.
	process.stderr.write(`[sumocode] ${message}\n`);
	process.exit(1);
};

/**
 * Select a provider that another child extension registers during session_start.
 * Pi resolves CLI --provider/--model flags before that event, so numbered Claude
 * providers must be selected here after the OAuth adapter has registered them.
 */
export default function installPiChildModelBootstrap(pi: ExtensionAPI, terminate: TerminateChild = terminateChild): void {
	pi.on("session_start", async (_event, ctx) => {
		const provider = process.env[CHILD_MODEL_PROVIDER_ENV]?.trim();
		const modelId = process.env[CHILD_MODEL_ID_ENV]?.trim();
		if (!provider && !modelId) return;
		if (!provider || !modelId) terminate("Incomplete SumoCode child model selection");

		let failure: string | undefined;
		try {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) failure = `Child model unavailable after provider registration: ${provider}/${modelId}`;
			else if (!(await pi.setModel(model))) failure = `Child model authentication unavailable: ${provider}/${modelId}`;
		} catch {
			failure = `Child model selection failed: ${provider}/${modelId}`;
		}
		if (failure) terminate(failure);
	});
}
