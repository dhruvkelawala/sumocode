import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { emitCathedralThemeChanged } from "../sumo-tui/cathedral/theme-bridge.js";

function currentThemeName(ctx: ExtensionContext): string {
	return (ctx.ui.theme as { name?: string } | undefined)?.name ?? "current";
}

/** Register `/sumo:theme [name]` for SumoCode theme switching. */
export function registerThemeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:theme", {
		description: "Show or switch the active SumoCode/Pi theme",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				process.stdout.write("sumo:theme requires interactive UI\n");
				return;
			}

			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(`theme: ${currentThemeName(ctx)}`, "info");
				return;
			}

			const result = ctx.ui.setTheme(requested);
			if (result.success) {
				emitCathedralThemeChanged(requested);
				ctx.ui.notify(`theme set: ${requested}`, "info");
				return;
			}
			ctx.ui.notify(`theme failed: ${result.error ?? requested}`, "warning");
		},
	});
}
