// Demonstrates the robust footer route: ctx.ui.setFooter() replaces the Pi
// footer with a registry-tone single-line status bar. Limits: setFooter can
// only own the bottom footer row; it cannot alter editor placement.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { SumoCodeState } from "../tokens.js";

export type RegistryFooterSnapshot = {
	state: SumoCodeState;
	thinkingLevel: string;
	wire: string;
	latencyMs?: number;
	scriptorium: "active" | "idle";
};

const STATE_LABELS: Record<SumoCodeState, string> = {
	idle: "READY",
	thinking: "THINKING",
	tool: "WORKING",
	approval: "NEEDS YOU",
	learning: "LEARNING",
};

function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "");
}

export function formatRegistryFooter(snapshot: RegistryFooterSnapshot, width: number): string {
	if (width < 50) return fit(`● ${STATE_LABELS[snapshot.state].toLowerCase()}`, width);
	const left = `SYSTEM STATUS [ ${STATE_LABELS[snapshot.state]} · ${snapshot.thinkingLevel.toUpperCase()} ]`;
	const rightParts: string[] = [];
	if (width >= 110) rightParts.push(`LANGS ${snapshot.wire.toUpperCase()}`);
	if (width >= 90) rightParts.push(`LATENCY: ${snapshot.latencyMs === undefined ? "—" : snapshot.latencyMs}MS`);
	if (width >= 70) rightParts.push(`SCRIPTORIUM ${snapshot.scriptorium.toUpperCase()}`);
	const right = rightParts.join("   ");
	const gap = Math.max(1, width - left.length - right.length);
	return fit(`${left}${" ".repeat(gap)}${right}`, width);
}

class RegistryFooterComponent implements Component {
	constructor(private readonly snapshot: () => RegistryFooterSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [formatRegistryFooter(this.snapshot(), width)];
	}
}

export default function footerRegistryToneSpike(pi: ExtensionAPI): void {
	let state: SumoCodeState = "idle";
	let rerender: (() => void) | undefined;
	const snapshot = (): RegistryFooterSnapshot => ({
		state,
		thinkingLevel: pi.getThinkingLevel(),
		wire: "wire",
		latencyMs: undefined,
		scriptorium: state === "thinking" ? "active" : "idle",
	});
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui) => {
			rerender = () => tui.requestRender();
			return new RegistryFooterComponent(snapshot);
		});
	});
	pi.on("agent_start", () => {
		state = "thinking";
		rerender?.();
	});
	pi.on("tool_call", () => {
		state = "tool";
		rerender?.();
	});
	pi.on("agent_end", () => {
		state = "idle";
		rerender?.();
	});
}
