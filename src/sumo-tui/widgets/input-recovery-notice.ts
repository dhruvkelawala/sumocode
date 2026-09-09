import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { lineToAnsi, textLine } from "../render/primitives.js";

/** One persistent notice, updated in place; only the router supplies its text. */
export class InputRecoveryNotice implements Component {
	private message = "";

	public setMessage(message: string): void {
		this.message = message;
	}

	public invalidate(): void {}

	public render(width: number): string[] {
		if (!this.message || width <= 0) return [];
		const colors = activeThemeColors();
		return wrapTextWithAnsi(this.message, width).map((text) => lineToAnsi(textLine([text], {
			fg: colors.accent, bg: colors.surface,
		}), { width }));
	}
}
