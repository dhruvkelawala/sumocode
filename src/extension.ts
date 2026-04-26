import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { installFooter } from "./footer.js";
import { installSidebar } from "./sidebar.js";
import { installWorkingIndicator } from "./working-indicator.js";

/**
 * SumoCode — cathedral-themed Pi extension entry point.
 *
 * No splash, no "loaded" notification. The footer + sidebar + working indicator
 * ARE the splash. See docs/CATHEDRAL_PARITY_PLAN.md (Layer 0 hygiene) for why
 * the previous `ctx.ui.notify("SumoCode loaded · v...", "info")` was removed.
 */
export default function sumocode(pi: ExtensionAPI): void {
	installFooter(pi);
	installSidebar(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);
}
