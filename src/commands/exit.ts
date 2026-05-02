import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerExitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Exit SumoCode cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
