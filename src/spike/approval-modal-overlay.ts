// Demonstrates a robust custom approval route: intercept a tool_call and use
// ctx.ui.custom({ overlay: true }) for a Cathedral-styled confirmation. Limits:
// it only covers approval gates owned by this extension; Pi core confirmations
// still use ctx.ui.confirm's built-in modal unless upstream exposes theming.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderApprovalModal(command: string, width: number): string[] {
	const inner = Math.max(0, width - 2);
	return [
		`╔${"═".repeat(inner)}╗`,
		`║${fit("          ◆ APPROVAL REQUIRED", inner)}║`,
		`╠${"═".repeat(inner)}╣`,
		`║${fit("", inner)}║`,
		`║${fit("   You are about to execute:", inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit(`   ┌ ${command}`, inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit("   — This command requires approval.", inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit("   ■ SYSTEM NOTICE                         Proceed? [Y/n]", inner)}║`,
		`║${fit("", inner)}║`,
		`╚${"═".repeat(inner)}╝`,
	];
}

class ApprovalModalComponent implements Component {
	constructor(private readonly command: string, private readonly done: (accepted: boolean) => void) {}
	invalidate(): void {}
	handleInput(data: string): void {
		if (data.toLowerCase() === "y" || matchesKey(data, Key.enter)) this.done(true);
		else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) this.done(false);
	}
	render(width: number): string[] {
		return renderApprovalModal(this.command, width);
	}
}

export default function approvalModalOverlaySpike(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI || event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!/rm\s+-rf|sudo\s+/.test(command)) return;
		const accepted = await ctx.ui.custom<boolean>((_tui, _theme, _keybindings, done) => new ApprovalModalComponent(command, done), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "60%", minWidth: 50, maxHeight: "80%" },
		});
		if (!accepted) return { block: true, reason: "blocked by cathedral approval spike" };
	});
}
