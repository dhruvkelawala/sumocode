import { matchesKey } from "@earendil-works/pi-tui";
import type { KeyEvent } from "../input/key-router.js";

export type ChatScrollCommand = "page-up" | "page-down" | "jump-top" | "jump-bottom";

export const CHAT_SCROLL_JUMP_BOTTOM_HINT = "⇧↓";

export function chatScrollCommandFromInput(data: string): KeyEvent | undefined {
	switch (data) {
		case "\x1b[5~":
			return { key: "PageUp", sequence: data };
		case "\x1b[6~":
			return { key: "PageDown", sequence: data };
		case "\x1b[H":
		case "\x1b[1~":
			return { key: "Home", sequence: data };
		case "\x1b[F":
		case "\x1b[4~":
			return { key: "End", sequence: data };
		default:
			if (matchesKey(data, "shift+down")) return { key: "End", sequence: data };
			return undefined;
	}
}

export function chatScrollCommandFromKey(event: KeyEvent): ChatScrollCommand | undefined {
	const key = event.key.toLowerCase();
	if (key === "pageup" || key === "pgup") return "page-up";
	if (key === "pagedown" || key === "pgdn") return "page-down";
	if (key === "home") return "jump-top";
	if (key === "end" || key === "shift+down") return "jump-bottom";
	return undefined;
}

export function chatScrollHintLabel(command: ChatScrollCommand): string {
	switch (command) {
		case "jump-bottom":
			return CHAT_SCROLL_JUMP_BOTTOM_HINT;
		case "page-up":
			return "PgUp";
		case "page-down":
			return "PgDn";
		case "jump-top":
			return "Home";
	}
}
