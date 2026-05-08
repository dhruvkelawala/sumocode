// Demonstrates the robust top-chrome route: ctx.ui.setHeader() owns a
// passive, state-driven two-line SUMOCODE workspace tab bar. Limits: setHeader
// renders above Pi's built-in chat; it cannot constrain chat width or reserve a
// side column by itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type CathedralTopTab = "EDITOR" | "TERMINAL" | "ARCHIVE" | "SCRIPTOR" | "SETTINGS";

export type TopChromeSnapshot = {
	activeTab: CathedralTopTab;
};

const TABS: readonly CathedralTopTab[] = ["EDITOR", "TERMINAL", "ARCHIVE", "SCRIPTOR", "SETTINGS"];

function fit(line: string, width: number): string {
	const text = truncateToWidth(line, Math.max(0, width), "");
	return `${text}${" ".repeat(Math.max(0, width - text.length))}`;
}

export function renderTopChrome(snapshot: TopChromeSnapshot, width: number): string[] {
	if (width <= 0) return ["", ""];
	const visibleTabs = [...TABS];
	while (visibleTabs.length > 1 && visibleTabs.join("  ").length + 12 > width) visibleTabs.pop();
	const showBrand = width >= 60;
	const brand = showBrand ? "SUMOCODE" : "";
	const tabs = visibleTabs.join("  ");
	const gap = Math.max(1, width - brand.length - tabs.length);
	const first = `${brand}${" ".repeat(gap)}${tabs}`;

	const activeOffset = first.indexOf(snapshot.activeTab);
	let underline = "";
	if (activeOffset >= 0) {
		underline = `${" ".repeat(activeOffset)}${"─".repeat(snapshot.activeTab.length)}`;
	}
	return [fit(first, width), fit(underline, width)];
}

class TopChromeComponent implements Component {
	constructor(private readonly snapshot: () => TopChromeSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderTopChrome(this.snapshot(), width);
	}
}

export default function topChromeSetHeaderSpike(pi: ExtensionAPI): void {
	let activeTab: CathedralTopTab = "EDITOR";
	let rerender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHeader((tui) => {
			rerender = () => tui.requestRender();
			return new TopChromeComponent(() => ({ activeTab }));
		});
	});
	pi.on("agent_start", () => {
		activeTab = "SCRIPTOR";
		rerender?.();
	});
	pi.on("tool_call", () => {
		activeTab = "TERMINAL";
		rerender?.();
	});
	pi.on("agent_end", () => {
		activeTab = "EDITOR";
		rerender?.();
	});
}
