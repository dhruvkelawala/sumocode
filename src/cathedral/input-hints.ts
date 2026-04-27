/**
 * Cathedral input keybind hint row (Elements 3 + 4 from CATHEDRAL_DECISIONS.md).
 *
 * Active state (Element 4):
 *   right-aligned dim:    TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Splash state (Element 3):
 *   left dim flavour:     └─ AWAITING DIVINE INVOCATION
 *   right-aligned dim:    TAB · AGENTS  CTRL+/ · COMMANDS
 *
 * Mounted via `setWidget(..., { placement: "belowEditor" })`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { INPUT_FRAME_HINT_AWAITING, renderInputHints } from "./input-frame.js";

class InputHintsComponent implements Component {
	constructor(private readonly isSplash: () => boolean) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (this.isSplash()) {
			return [renderInputHints(width, { leftHint: INPUT_FRAME_HINT_AWAITING })];
		}
		return [renderInputHints(width)];
	}
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	} catch {
		return false;
	}
}

export function installInputHints(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"sumocode-input-hints",
			() => new InputHintsComponent(() => !sessionHasMessages(ctx)),
			{ placement: "belowEditor" },
		);
	});
}
