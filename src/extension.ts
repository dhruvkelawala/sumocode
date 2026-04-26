import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { installFooter } from "./footer.js";
import { installSidebar } from "./sidebar.js";
import { installWorkingIndicator } from "./working-indicator.js";

const VERSION = "0.2.0";

/**
 * SumoCode — v0.1.0 hello-world scaffold.
 *
 * This is the minimal viable SumoCode extension. It does almost nothing yet —
 * just registers a one-shot notification on session start so you can see it's
 * loaded. Real functionality (persona, footer, sidebar, memory, status signals)
 * lands in v0.2+ after the /skill:grill-me → /skill:to-prd → Stitch flow
 * resolves the remaining design decisions.
 *
 * See PLAN.md for decision log and roadmap.
 */
export default function sumocode(pi: ExtensionAPI): void {
	installFooter(pi);
	installSidebar(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(`SumoCode loaded · v${VERSION}`, "info");
	});
}
