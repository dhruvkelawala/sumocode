import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showDivineQuery } from "../divine-query.js";

const TEST_TITLE = "Divine Query test modal\nUse this to verify the runtime overlay without waiting for the LLM.";
const TEST_OPTIONS = [
	"Looks good — ship it",
	"Needs visual polish",
	"Cancel / escape path works",
] as const;

/**
 * `/sumo:query` — manual QA helper for the Cathedral Divine Query modal.
 * Opens the same runtime overlay used by SumoCode-owned question/selection
 * flows, without requiring an LLM/tool call to trigger it.
 */
export function registerDivineQueryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:query", {
		description: "Open a test Cathedral Divine Query modal",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				process.stdout.write("sumo:query requires interactive UI\n");
				return;
			}

			const selected = await showDivineQuery(ctx, TEST_TITLE, TEST_OPTIONS);
			if (selected === undefined) {
				ctx.ui.notify("Divine Query cancelled", "warning");
				return;
			}
			ctx.ui.notify(`Divine Query selected: ${selected}`, "info");
		},
	});
}
