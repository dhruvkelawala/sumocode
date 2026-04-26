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
import { renderInputFrame } from "./input-frame.js";

const SPLASH_LABEL = "DIVINE INVOCATION";
const SPLASH_PLACEHOLDER = 'Ask anything... "Refactor the auth flow."';

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
			return super.render(width);
		}

		// Splash state: render carved cathedral frame with DIVINE INVOCATION label.
		const text = this.getText();
		return renderInputFrame(text, width, {
			label: SPLASH_LABEL,
			placeholder: SPLASH_PLACEHOLDER,
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
