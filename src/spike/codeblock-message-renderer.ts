// Demonstrates the public custom-message rendering route: pi.registerMessageRenderer()
// can render extension-owned code blocks with Cathedral framing. Limits: this
// does not replace Pi's built-in assistant markdown renderer; normal assistant
// fenced code relies on the active Theme slots.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

export type CodeBlockSnapshot = {
	language: string;
	code: string;
};

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderCathedralCodeBlock(snapshot: CodeBlockSnapshot, width: number): string[] {
	const lines = snapshot.code.split("\n");
	const numberWidth = String(lines.length).length;
	const top = `┌ ${snapshot.language} ${"─".repeat(Math.max(0, width - snapshot.language.length - 4))}`;
	return [fit(top, width), ...lines.map((line, index) => fit(`${String(index + 1).padStart(numberWidth, " ")}   ${line}`, width))];
}

class CodeBlockComponent implements Component {
	constructor(private readonly snapshot: CodeBlockSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderCathedralCodeBlock(this.snapshot, width);
	}
}

function isCodeBlockDetails(details: unknown): details is CodeBlockSnapshot {
	return typeof details === "object" && details !== null && "language" in details && "code" in details;
}

export default function codeblockMessageRendererSpike(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("cathedral-codeblock", (message) => {
		if (!isCodeBlockDetails(message.details)) return undefined;
		return new CodeBlockComponent(message.details);
	});
	pi.registerCommand("cathedral-codeblock-spike", {
		description: "Send a Cathedral custom code block message",
		handler: async () => {
			pi.sendMessage({
				customType: "cathedral-codeblock",
				content: "code block",
				display: true,
				details: { language: "typescript", code: "const ok = true;\nreturn ok;" },
			});
		},
	});
}
