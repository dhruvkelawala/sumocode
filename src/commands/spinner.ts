import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { activeThemeColors } from "../themes/index.js";
import {
	CATHEDRAL_INDICATOR_FRAMES,
	CATHEDRAL_INDICATOR_INTERVAL_MS,
	formatSpinnerInspection,
} from "../working-indicator.js";

/**
 * `/sumo:spinner` — debug helper for closing the observability loop on the
 * working indicator. Prints a static, colored preview of every frame so the
 * pattern can be inspected without trying to read animation in motion.
 *
 * Output is sent to stdout in non-TTY mode and as a single info notification
 * in interactive mode. Either way the result is plain text Dhruv can paste
 * back to the agent for review.
 */
export function registerSpinnerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:spinner", {
		description: "Preview every frame of the cathedral working indicator",
		handler: async (_args, ctx: ExtensionContext) => {
			const report = formatSpinnerInspection(
				CATHEDRAL_INDICATOR_FRAMES,
				activeThemeColors().accent,
				CATHEDRAL_INDICATOR_INTERVAL_MS,
			);

			if (!ctx.hasUI) {
				process.stdout.write(`${report}\n`);
				return;
			}

			ctx.ui.notify(report, "info");
		},
	});
}
