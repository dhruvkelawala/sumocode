// Demonstrates the robust tool-pill route: pi.registerTool() with renderShell:
// "self" plus renderCall/renderResult owns its own chapter-like framing. Limits:
// this prototype registers a spike tool; production should re-register built-in
// read/bash/edit with the same public override pattern and delegate execution.

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type ToolPillSnapshot = {
	name: string;
	target: string;
	status: "running" | "success" | "failed";
	body?: string;
};

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

export function renderToolPill(snapshot: ToolPillSnapshot, width: number): string[] {
	const status = snapshot.status === "running" ? "▶ running" : snapshot.status === "success" ? "✓" : "✗ failed";
	const headerBase = `━━━ [${snapshot.name}]  ${snapshot.target}`;
	const suffix = ` ━━━ ${status}`;
	const header = `${truncateToWidth(headerBase, Math.max(0, width - suffix.length), "…")}${suffix}`;
	const body = snapshot.body ? snapshot.body.split("\n").map((line) => fit(`  ${line}`, width)) : [];
	return [fit(header, width), ...body];
}

class ToolPillComponent implements Component {
	constructor(private readonly snapshot: ToolPillSnapshot) {}
	invalidate(): void {}
	render(width: number): string[] {
		return renderToolPill(this.snapshot, width);
	}
}

export default function toolPillRendererSpike(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "cathedral_echo",
		label: "cathedral_echo",
		description: "Spike tool proving self-rendered tool pills.",
		parameters: Type.Object({ text: Type.String() }),
		renderShell: "self",
		async execute(_toolCallId, params): Promise<AgentToolResult<{ echoed: string }>> {
			return { content: [{ type: "text", text: params.text }], details: { echoed: params.text } };
		},
		renderCall(args) {
			return new ToolPillComponent({ name: "cathedral_echo", target: args.text, status: "running" });
		},
		renderResult(result, { isPartial }) {
			const content = result.content[0];
			const body = content?.type === "text" ? content.text : "";
			return new ToolPillComponent({ name: "cathedral_echo", target: "result", status: isPartial ? "running" : "success", body });
		},
	});
}
