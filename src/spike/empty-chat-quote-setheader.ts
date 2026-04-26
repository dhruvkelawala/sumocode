// Demonstrates the empty-active-chat quote route: ctx.ui.setHeader() can render
// a centered quote while the session branch has no messages. Limits: header
// content sits above chat rather than inside Pi's message scrollback.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

export type EmptyQuoteSnapshot = {
	quote: string;
	attribution: string;
	hasMessages: boolean;
};

function center(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	const left = Math.max(0, Math.floor((width - clipped.length) / 2));
	return `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, width - left - clipped.length))}`;
}

export function renderEmptyChatQuote(snapshot: EmptyQuoteSnapshot, width: number, height = 10): string[] {
	if (snapshot.hasMessages) return [];
	const lines = Array.from({ length: Math.max(2, height) }, () => " ".repeat(Math.max(0, width)));
	const mid = Math.floor(lines.length / 2) - 1;
	lines[mid] = center(`"${snapshot.quote}"`, width);
	lines[mid + 1] = center(`— ${snapshot.attribution}`, width);
	return lines;
}

class EmptyQuoteComponent implements Component {
	constructor(private readonly snapshot: () => EmptyQuoteSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderEmptyChatQuote(this.snapshot(), width, 10);
	}
}

function hasMessages(branch: readonly { type?: string }[]): boolean {
	return branch.some((entry) => entry.type === "message");
}

export default function emptyChatQuoteSetHeaderSpike(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader(() =>
			new EmptyQuoteComponent(() => ({
				quote: "perfection is achieved when there is nothing left to take away.",
				attribution: "saint-exupéry",
				hasMessages: hasMessages(ctx.sessionManager.getBranch()),
			})),
		);
	});
}
