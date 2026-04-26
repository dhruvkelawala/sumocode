import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installInputHints } from "./cathedral/input-hints.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerTabsCommand } from "./commands/tabs.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
import { installApprovalGate } from "./approval-modal.js";
import { installAltscreen } from "./cathedral/altscreen.js";
import { installCathedralEditor } from "./cathedral/cathedral-editor.js";
import { installCommandPalette } from "./command-palette.js";
import { installFooter } from "./footer.js";
import { registerMemoryCommand } from "./memory-editor.js";
import { installSidebar } from "./sidebar.js";
import { installTopChrome } from "./top-chrome.js";
import { installWorkingIndicator } from "./working-indicator.js";

/**
 * SumoCode — cathedral-themed Pi extension entry point.
 *
 * Element 2 (top chrome) replaces the previous tab-bar. The splash and
 * subsequent elements continue to install as separate modules.
 *
 * The sidebar is intentionally NOT installed here yet. Element 1 in the
 * cathedral parity rework re-enables it via `installSidebar(pi)` once
 * the active-state chrome below it is stable.
 */
export default function sumocode(pi: ExtensionAPI): void {
	installAltscreen(pi);
	installTopChrome(pi);
	installFooter(pi);
	installCathedralEditor(pi);
	installInputHints(pi);
	installCommandPalette(pi);
	installApprovalGate(pi);
	installSidebar(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);
	registerTabsCommand(pi);
	registerThemeCheckCommand(pi);
	registerMemoryCommand(pi);
}
