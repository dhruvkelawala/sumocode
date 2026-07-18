import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeThemeColors } from "../themes/index.js";
import { defaultTerminalSessionOwner, type TerminalSessionOwner } from "../sumo-tui/runtime/terminal-controller.js";

export type CursorCommandMode = "accent" | "reset" | "status";

function normalizeCursorCommand(args: string): CursorCommandMode | undefined {
	const value = args.trim().toLowerCase();
	if (value === "" || value === "status") return "status";
	// `orange` / `cathedral` are deprecated aliases kept for muscle memory from
	// the Cathedral-only era. They resolve the CURRENT theme accent, not orange.
	if (["accent", "orange", "cathedral"].includes(value)) return "accent";
	if (["reset", "default", "system"].includes(value)) return "reset";
	return undefined;
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
	if (!ctx.hasUI) {
		process.stdout.write(`${message}\n`);
		return;
	}
	ctx.ui.notify(message, level);
}

/** Register `/sumo:cursor accent|reset|status` for explicit cursor color overrides. */
export function registerCursorCommand(pi: ExtensionAPI, terminalSession: TerminalSessionOwner = defaultTerminalSessionOwner): void {
	pi.registerCommand("sumo:cursor", {
		description: "Explicitly set or reset the terminal cursor color",
		handler: async (args: string, ctx: ExtensionContext) => {
			const mode = normalizeCursorCommand(args);
			if (mode === "accent") {
				terminalSession.setCursorColor(activeThemeColors().accent);
				report(ctx, "cursor color: theme accent", "info");
				return;
			}
			if (mode === "reset") {
				terminalSession.resetCursorColor();
				report(ctx, "cursor color: terminal default", "info");
				return;
			}
			if (mode === "status") {
				const state = terminalSession.getState();
				report(ctx, `cursor color: ${state.cursorColorOverridden ? "theme accent" : "terminal default"}`, "info");
				return;
			}
			report(ctx, "usage: /sumo:cursor accent|reset|status", "warning");
		},
	});
}
