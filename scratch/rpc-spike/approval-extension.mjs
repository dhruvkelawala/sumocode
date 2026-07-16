import fakeProviderSpike from "./fake-provider-extension.mjs";

const danger = /\brm\s+(-[\w]*r[\w]*|--recursive)/i;

export default function approvalSpike(pi) {
	fakeProviderSpike(pi);

	pi.registerCommand("sumo:approval-spike", {
		description: "RPC approval spike marker",
		handler: () => undefined,
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!danger.test(command)) return undefined;

		const choice = await ctx.ui.select("dangerous command", ["No", "Yes", "Always"], { timeout: 1_000 });
		if (choice !== "Yes" && choice !== "Always") {
			return { block: true, reason: "approval-spike-denied" };
		}
		return undefined;
	});
}
