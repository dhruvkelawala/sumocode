import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showApprovalModal } from "../approval-modal.js";

/**
 * A representative dangerous command for the approval-modal QA harness. The
 * exact wording isn't important — the modal renders whatever string it's
 * handed — but a long, multi-flag `gh` invocation gives the wrap / row-cap
 * logic something realistic to chew on.
 */
function buildTestCommand(cwd: string): string {
	return `cd ${JSON.stringify(cwd)} && gh issue create --title "Approval modal QA: long command" --body "a representative long quoted body that should wrap inside the lifted modal without leaking past the terminal edge."`;
}

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
				command: buildTestCommand(process.cwd()),
				descriptionLines: [
					"This command mutates GitHub state and has a very long quoted body that should wrap inside the lifted modal without leaking past the terminal edge.",
				],
			});
			ctx.ui.notify(`Approval selected: ${choice}`, choice === "no" ? "warning" : "info");
		},
	});
}
