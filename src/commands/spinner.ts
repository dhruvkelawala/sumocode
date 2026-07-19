import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveTheme, resolveThemeWorkingIndicator } from "../themes/index.js";
import { formatSpinnerInspection } from "../working-indicator.js";

export function formatActiveSpinnerInspection(env: NodeJS.ProcessEnv = process.env): string {
	const theme = getActiveTheme();
	const indicator = resolveThemeWorkingIndicator(theme, env);
	const lines = [
		`theme=${theme.name}`,
		`variant=${indicator.name}`,
	];
	if (indicator.capabilityEnv) {
		lines.push(`capability=${indicator.capabilityEnv}`);
		lines.push(`capabilityState=${indicator.capabilityState}`);
	}
	if (indicator.capabilityState === "unrecognized" && indicator.capabilityEnv) {
		lines.push(`warning: ${indicator.capabilityEnv}=${env[indicator.capabilityEnv]} is unrecognized; previewing fallback frames`);
	}
	lines.push(formatSpinnerInspection(indicator.frames, theme.tokens.colors.accent, indicator.intervalMs));
	return lines.join("\n");
}

/**
 * `/sumo:spinner` — debug helper for closing the observability loop on the
 * active working indicator. Prints a static, colored preview of every resolved
 * frame so the pattern can be inspected without trying to read animation in motion.
 *
 * Output is sent to stdout in non-TTY mode and as a single info notification
 * in interactive mode. Either way the result is plain text the user can
 * paste back to the agent for review.
 */
export function registerSpinnerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:spinner", {
		description: "Preview every frame of the active working indicator",
		handler: async (_args, ctx: ExtensionContext) => {
			const report = formatActiveSpinnerInspection();

			if (!ctx.hasUI) {
				process.stdout.write(`${report}\n`);
				return;
			}

			ctx.ui.notify(report, "info");
		},
	});
}
