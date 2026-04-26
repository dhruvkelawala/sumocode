/**
 * Cathedral editor (Element 3 + 4 polish from CATHEDRAL_DECISIONS.md).
 *
 * Wraps Pi's CustomEditor with cathedral chrome:
 *
 *   Splash state (no messages):
 *     ┌─ DIVINE INVOCATION ──────────────────────┐
 *     │ > Ask anything... "Refactor the auth flow." █ │
 *     └────────────────────────────────────────────┘
 *
 *   Active state (after first message):
 *     defers to Pi's default editor (full features: autocomplete,
 *     multi-line, IME, paste handling, syntax mode, etc.)
 *
 * Trade-off documented in CATHEDRAL_DECISIONS.md Q4.1: the carved frame
 * is the splash ceremony only. Pi's editor takes over once you start
 * working so you don't lose autocomplete + multi-line.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import {
	INPUT_FRAME_LABEL_ACTIVE,
	INPUT_FRAME_LABEL_SPLASH,
	INPUT_FRAME_PLACEHOLDER,
	renderInputFrame,
} from "./input-frame.js";

class CathedralEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly isSplash: () => boolean,
	) {
		super(tui, theme, keybindings);
	}

	override render(width: number): string[] {
		if (!this.isSplash()) {
			// Active state: defer to Pi's full editor for autocomplete + multi-line.
			// (We deliberately do NOT wrap it in our cathedral frame because that
			// would cost autocomplete display, multi-line wrap, and IME support.
			// Active-state cathedral input is tracked as a v2 follow-up.)
			void INPUT_FRAME_LABEL_ACTIVE; // re-export touch so deletions surface here
			return super.render(width);
		}

		// Splash state: render the carved cathedral frame with `SCRIPTOR INPUT`
		// label and the canonical placeholder text from the Stitch mockup.
		const text = this.getText();
		return renderInputFrame(text, width, {
			label: INPUT_FRAME_LABEL_SPLASH,
			placeholder: INPUT_FRAME_PLACEHOLDER,
			promptColor: "oxidized",
		});
	}
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	} catch {
		return false;
	}
}

/**
 * Mount the cathedral editor via setEditorComponent. Replaces Pi's default
 * editor with our wrapper that branches on splash vs active state.
 */
export function installCathedralEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new CathedralEditor(tui, theme, keybindings, () => !sessionHasMessages(ctx));
		});
	});
}
