/**
 * Cathedral input keybind hint row (Element 4 from CATHEDRAL_DECISIONS.md).
 * Mounted via `setWidget(... { placement: "belowEditor" })`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { renderInputHints } from "./input-frame.js";

class InputHintsComponent implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return [renderInputHints(width)];
	}
}

export function installInputHints(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"sumocode-input-hints",
			() => new InputHintsComponent(),
			{ placement: "belowEditor" },
		);
	});
}
