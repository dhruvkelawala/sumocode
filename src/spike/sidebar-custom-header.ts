// Demonstrates public-API sidebar route B: ctx.ui.setHeader() can render a tall
// header that already contains a left canvas plus a right registry column. This
// reserves columns within the header itself, but Pi's real chat still starts
// BELOW the header; it cannot make normal message rows share this split.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

export type HeaderWorkspaceSnapshot = {
	quote: string;
	registryLines: readonly string[];
};

function pad(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

function center(line: string, width: number): string {
	const left = Math.max(0, Math.floor((width - line.length) / 2));
	return pad(`${" ".repeat(left)}${line}`, width);
}

export function renderHeaderDominatedWorkspace(snapshot: HeaderWorkspaceSnapshot, width: number, height: number): string[] {
	const sidebarWidth = width >= 120 ? 49 : 0;
	const gutter = sidebarWidth > 0 ? 1 : 0;
	const leftWidth = Math.max(1, width - sidebarWidth - gutter);
	const rows = Math.max(1, height);
	const middle = Math.floor(rows / 2);
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		const left = row === middle ? center(snapshot.quote, leftWidth) : " ".repeat(leftWidth);
		const right = sidebarWidth > 0 ? pad(snapshot.registryLines[row] ?? "", sidebarWidth) : "";
		lines.push(`${left}${gutter ? " " : ""}${right}`);
	}
	return lines;
}

class HeaderWorkspaceComponent implements Component {
	constructor(private readonly snapshot: () => HeaderWorkspaceSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderHeaderDominatedWorkspace(this.snapshot(), width, 22);
	}
}

export default function sidebarCustomHeaderSpike(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader(() =>
			new HeaderWorkspaceComponent(() => ({
				quote: "perfection is achieved when there is nothing left to take away.",
				registryLines: ["REGISTRY", "v 1.0.0", "", "▢ CONTEXT", "◆ MEMORY", "▢ SCRIPTOR", "▢ FILES"],
			})),
		);
	});
}
