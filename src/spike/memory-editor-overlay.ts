// Demonstrates the robust memory-editor route: a slash command opens a focused
// ctx.ui.custom({ overlay: true }) component. Limits: read-only prototype; Pi
// overlay composition does not physically dim the rest of the terminal.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type MemoryEditorSnapshot = {
	user: string;
	org: string;
	preferences: readonly string[];
	stack: readonly string[];
	projects: readonly string[];
	learning: boolean;
};

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderMemoryEditor(snapshot: MemoryEditorSnapshot, width: number): string[] {
	const inner = Math.max(0, width - 2);
	const learning = snapshot.learning ? "  ◆ learning" : "";
	const lines = [
		`╔${"═".repeat(inner)}╗`,
		`║${fit(`  CATHEDRAL-MEMORY-EDITOR${learning}`, inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit("  ┌ IDENTITY ─────────┐     ┌ PREFERENCES ─────────────┐", inner)}║`,
		`║${fit(`  │ User: ${snapshot.user.padEnd(12, " ")}│     │ ❧ ${snapshot.preferences[0] ?? ""}`, inner)}║`,
		`║${fit(`  │ Org:  ${snapshot.org.padEnd(12, " ")}│     │ ❧ ${snapshot.preferences[1] ?? ""}`, inner)}║`,
		`║${fit("  └───────────────────┘     └──────────────────────────┘", inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit("  ┌ STACK ────────────┐     ┌ PROJECTS ────────────────┐", inner)}║`,
		`║${fit(`  │ ${snapshot.stack[0] ?? ""}`, inner)}║`,
		`║${fit(`  │ ${snapshot.stack[1] ?? ""}`, inner)}║`,
		`║${fit(`  └───────────────────┘     │ ▶ ${snapshot.projects[0] ?? ""}`, inner)}║`,
		`║${fit("                              └──────────────────────────┘", inner)}║`,
		`║${fit("", inner)}║`,
		`║${fit("                  ⌘S SAVE · ⌘W CLOSE", inner)}║`,
		`╚${"═".repeat(inner)}╝`,
	];
	return lines;
}

class MemoryEditorComponent implements Component {
	constructor(private readonly done: () => void) {}
	invalidate(): void {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("w"))) this.done();
	}
	render(width: number): string[] {
		return renderMemoryEditor(
			{
				user: "You",
				org: "BigCo",
				preferences: ["TypeScript (Strict)", "pnpm execution"],
				stack: ["React 18+", "Vite bundler"],
				projects: ["main-app [active]"],
				learning: true,
			},
			width,
		);
	}
}

export default function memoryEditorOverlaySpike(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:memory-edit-spike", {
		description: "Open Cathedral memory editor spike",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => new MemoryEditorComponent(done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", minWidth: 70, maxHeight: "80%" },
			});
		},
	});
}
