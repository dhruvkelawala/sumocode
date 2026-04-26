// Demonstrates public-API sidebar route A: ctx.ui.setEditorComponent() can
// render a bottom input frame and even draw a side band inside editor lines.
// Limits: editor render output is mounted at the editor slot only, so this
// cannot own or reserve the full-height chat/sidebar content area.

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

export function renderEditorOwnedSideBand(input: string, width: number): string[] {
	const sidebarWidth = width >= 120 ? 49 : 0;
	const gutter = sidebarWidth > 0 ? 1 : 0;
	const leftWidth = Math.max(1, width - sidebarWidth - gutter);
	const top = `┌${"─".repeat(Math.max(0, leftWidth - 2))}┐`;
	const bodyText = `│ > ${input}█`;
	const body = `${truncateToWidth(bodyText, Math.max(0, leftWidth - 1), "").padEnd(Math.max(0, leftWidth - 1), " ")}│`;
	const bottom = `└${"─".repeat(Math.max(0, leftWidth - 2))}┘`;
	const side = sidebarWidth > 0 ? `${" ".repeat(gutter)}${"REGISTRY".padEnd(sidebarWidth, " ")}` : "";
	return [top + side, body + (sidebarWidth > 0 ? `${" ".repeat(gutter)}${"editor-only side band".padEnd(sidebarWidth, " ")}` : ""), bottom + (sidebarWidth > 0 ? `${" ".repeat(gutter)}${"".padEnd(sidebarWidth, " ")}` : "")];
}

class SidebarBoundaryEditor extends CustomEditor {
	render(width: number): string[] {
		return renderEditorOwnedSideBand(this.getText(), width);
	}
}

class ReadmeComponent implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return renderEditorOwnedSideBand("", width);
	}
}

export default function sidebarEditorBoundarySpike(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SidebarBoundaryEditor(tui, theme, keybindings));
		ctx.ui.setWidget("editor-boundary-note", () => new ReadmeComponent(), { placement: "aboveEditor" });
	});
}
