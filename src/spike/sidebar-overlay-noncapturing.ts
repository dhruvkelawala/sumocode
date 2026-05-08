// Demonstrates public-API side-panel route C: ctx.ui.custom({ overlay: true,
// nonCapturing: true, anchor: "top-right" }). This proves a passive registry can
// coexist with editor focus. Limits: overlays composite on top of Pi chat; they
// do NOT reserve columns, so long chat lines can draw underneath the sidebar.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type RegistryTab = "CONTEXT" | "MEMORY" | "SCRIPTOR" | "FILES";

export type SidebarOverlaySnapshot = {
	active: RegistryTab;
	version: string;
	facts: readonly string[];
};

const TABS: readonly RegistryTab[] = ["CONTEXT", "MEMORY", "SCRIPTOR", "FILES"];

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderRegistrySidebar(snapshot: SidebarOverlaySnapshot, width: number): string[] {
	const lines = ["REGISTRY", `v ${snapshot.version}`, ""];
	for (const tab of TABS) {
		lines.push(`${tab === snapshot.active ? "◆" : "▢"} ${tab}`);
	}
	lines.push("", "┌ ACTIVE_MEMORY ────");
	for (const fact of snapshot.facts.slice(0, 5)) lines.push(`❧ ${fact}`);
	if (snapshot.facts.length === 0) lines.push("no memory match");
	return lines.map((line) => fit(`  ${line}`, width));
}

class RegistryOverlayComponent implements Component {
	constructor(private readonly snapshot: () => SidebarOverlaySnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderRegistrySidebar(this.snapshot(), width);
	}
}

export default function sidebarOverlayNonCapturingSpike(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void ctx.ui.custom<void>(
			() =>
				new RegistryOverlayComponent(() => ({
					active: "MEMORY",
					version: "1.0.0",
					facts: ["prefers TypeScript strict", "pnpm not npm", "based in London"],
				})),
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: 49,
					margin: { top: 2, right: 0 },
					visible: (termWidth) => termWidth >= 120,
					nonCapturing: true,
				},
			},
		);
	});
}
