import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
import { installFooter } from "./footer.js";
import { installTabBar } from "./tab-bar.js";
import { installWorkingIndicator } from "./working-indicator.js";

/**
 * SumoCode — cathedral-themed Pi extension entry point.
 *
 * No splash, no "loaded" notification. The footer + working indicator + tab
 * bar (with splash inside it) ARE the visible cathedral surface for now.
 *
 * The sidebar is intentionally NOT installed here. It used to be a static
 * column-reserving dock (`installSidebar`) wrapping Pi's root containers,
 * but it was competing with chat content and the design was unclear. It is
 * disabled while we decide whether the cathedral mockup's right-pane
 * registry belongs in SumoCode at all (vs. footer / slash commands /
 * /sumo:context overlay). The rendering code itself remains in
 * `src/sidebar.ts` so we can re-enable it later behind a flag without
 * losing the work.
 */
export default function sumocode(pi: ExtensionAPI): void {
	installTabBar(pi);
	installFooter(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);
	registerThemeCheckCommand(pi);
}
