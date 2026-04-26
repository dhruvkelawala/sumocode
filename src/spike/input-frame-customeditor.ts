// Demonstrates the robust carved-input route: ctx.ui.setEditorComponent()
// installs a CustomEditor subclass and delegates handleInput() to super for Pi
// keybindings. Limits: it only replaces the editor slot, not chat rendering.

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

function pad(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderCarvedInputFrame(text: string, width: number): string[] {
	if (width < 4) return [pad("█", width)];
	const inner = Math.max(0, width - 2);
	const top = `┌${"─".repeat(inner)}┐`;
	const content = truncateToWidth(`> ${text}█`, inner, "").padEnd(inner, " ");
	const bottom = `└${"─".repeat(inner)}┘`;
	return [top, `│${content}│`, bottom];
}

class CarvedInputEditor extends CustomEditor {
	render(width: number): string[] {
		return renderCarvedInputFrame(this.getText(), width);
	}
}

export default function inputFrameCustomEditorSpike(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new CarvedInputEditor(tui, theme, keybindings));
	});
}
