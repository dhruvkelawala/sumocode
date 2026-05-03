import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showApprovalModal } from "../approval-modal.js";

const TEST_COMMAND = `cd "/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode" && gh issue create --title "Approval modal leaks long commands across the terminal" --body "long quoted body with spaces"`;

/**
 * `/sumo:approval` — manual QA helper for the Cathedral approval modal.
 * Opens the same runtime overlay used by the approval gate, without requiring
 * a dangerous tool call to trigger it.
 */
export function registerApprovalCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:approval", {
		description: "Open a test Cathedral approval modal",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				process.stdout.write("sumo:approval requires interactive UI\n");
				return;
			}

			const choice = await showApprovalModal(ctx, {
				command: TEST_COMMAND,
				descriptionLines: [
					"This command mutates GitHub state and has a very long quoted body that should wrap inside the lifted modal without leaking past the terminal edge.",
				],
			});
			ctx.ui.notify(`Approval selected: ${choice}`, choice === "no" ? "warning" : "info");
		},
	});
}
