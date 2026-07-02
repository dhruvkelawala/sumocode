import { keyText } from "@earendil-works/pi-coding-agent";

/** The user's bound expand key (e.g. "ctrl+o"), or a stable fallback when keybindings aren't initialized (tests). */
export function expandKey(): string {
	try {
		const key = keyText("app.tools.expand");
		return key && key.length > 0 ? key : "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}
