// Demonstrates the robust command-palette route: ctx.ui.custom({ overlay:
// true }) opens a focused component with keyboard handling. Limits: Pi overlays
// do not dim underlying rows; they composite over the existing content.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

export type PaletteRow = {
	label: string;
	value: string;
};

const DEFAULT_ROWS: readonly PaletteRow[] = [
	{ label: "SESSION", value: "WORK-20260424" },
	{ label: "MODEL", value: "CLAUDE-OPUS-4-7" },
	{ label: "THINKING", value: "MEDIUM" },
	{ label: "MEMORY", value: "55 FACTS" },
];

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderCommandPalette(rows: readonly PaletteRow[], selected: number, width: number): string[] {
	const inner = Math.max(0, width - 2);
	const top = `╔${"═".repeat(inner)}╗`;
	const bottom = `╚${"═".repeat(inner)}╝`;
	const out = [top, `║${fit("        ═══ COMMAND PALETTE ═══", inner)}║`, `║${fit("", inner)}║`, `║${fit("  ▶ ENTER COMMAND OR SEARCH…", inner)}║`, `║${fit("", inner)}║`];
	rows.forEach((row, index) => {
		const marker = index === selected ? "★" : "▷";
		out.push(`║${fit(`  ${marker} ${row.label.padEnd(9, " ")} ▶ CURRENT: ${row.value}`, inner)}║`);
	});
	out.push(`║${fit("", inner)}║`, `║${fit("        ↑↓ NAVIGATE   ✓ SELECT   ESC CLOSE", inner)}║`, bottom);
	return out;
}

class CommandPaletteComponent implements Component {
	private selected = 0;
	constructor(private readonly done: (result: string | undefined) => void) {}
	invalidate(): void {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.down)) this.selected = Math.min(DEFAULT_ROWS.length - 1, this.selected + 1);
		else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.enter)) this.done(DEFAULT_ROWS[this.selected]?.label);
		else if (matchesKey(data, Key.escape)) this.done(undefined);
	}
	render(width: number): string[] {
		return renderCommandPalette(DEFAULT_ROWS, this.selected, width);
	}
}

export default function commandPaletteOverlaySpike(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+/", {
		description: "Open Cathedral command palette spike",
		handler: (ctx) => {
			if (!ctx.hasUI) return;
			void ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => new CommandPaletteComponent(done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "60%", minWidth: 50, maxHeight: "80%" },
			});
		},
	});
}
