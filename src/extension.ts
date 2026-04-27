import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installInputHints } from "./cathedral/input-hints.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerTabsCommand } from "./commands/tabs.js";
import { registerThemeCommand } from "./commands/theme.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
// Element 6 approval gate disabled per Dhruv's request 2026-04-27.
// The cathedral approval modal was blocking bash/edit/write tool calls and
// slowing down agent iteration. We trust Pi's own tool security model for now.
// Re-enable later if we want a per-tool consent UX (Phase 7+).
// import { installApprovalGate } from "./approval-modal.js";
import { installAltscreen } from "./cathedral/altscreen.js";
import { installCathedralEditor } from "./cathedral/cathedral-editor.js";
import { installCommandPalette } from "./command-palette.js";
import { installFooter } from "./footer.js";
import { registerMemoryCommand } from "./memory-editor.js";
import { installSidebar } from "./sidebar.js";
import { installSplash } from "./splash.js";
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
	installSplash(pi);
	installFooter(pi);
	installCathedralEditor(pi);
	installInputHints(pi);
	installCommandPalette(pi);
	// installApprovalGate(pi); // disabled — see import comment above
	installSidebar(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);
	registerTabsCommand(pi);
	registerThemeCommand(pi);
	registerThemeCheckCommand(pi);
	registerMemoryCommand(pi);
}
