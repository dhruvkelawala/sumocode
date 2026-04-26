import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";
import { formatTokenCount } from "./footer.js";
import { VOICE } from "./voice.js";

/** Threshold below which the sidebar hides itself. */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 120;
/** Render width for the sidebar overlay. */
export const SIDEBAR_WIDTH = 32;

/** Static placeholder until #8 wires real memory data. */
export const PLACEHOLDER_MEMORY: readonly string[] = [
	"prefers pnpm and bun",
	"commits in cathedral voice",
	"never autoformats go",
	"opus-4 code, haiku-4 memory",
	"argent-x is the day job",
];

/** Static placeholder until Pi exposes MCP server health. */
export const PLACEHOLDER_MCP: readonly McpServerSnapshot[] = [
	{ name: "github", status: "idle" },
	{ name: "stitch", status: "idle" },
	{ name: "context7", status: "idle" },
	{ name: "chrome-devtools", status: "idle" },
];

export type McpServerSnapshot = {
	name: string;
	status: SumoCodeState;
};

export type SidebarSnapshot = {
	projectName: string;
	inputTokens: number;
	outputTokens: number;
	contextWindow: number;
	costUsd: number;
	mcpServers: readonly McpServerSnapshot[];
	memory: readonly string[];
};

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function parseHex(hex: string): { r: number; g: number; b: number } {
	const n = hex.replace("#", "");
	return {
		r: Number.parseInt(n.slice(0, 2), 16),
		g: Number.parseInt(n.slice(2, 4), 16),
		b: Number.parseInt(n.slice(4, 6), 16),
	};
}

function fg(hex: string): string {
	const { r, g, b } = parseHex(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function bg(hex: string): string {
	const { r, g, b } = parseHex(hex);
	return `\u001b[48;2;${r};${g};${b}m`;
}

function color(text: string, hex: string): string {
	return `${fg(hex)}${text}${RESET}`;
}

/** Visible cell length (strips SGR escapes). */
function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

/** Pad a line to exactly `width` visible cells, then wrap in cathedral surface. */
function surfaceLine(content: string, width: number): string {
	const short = visibleLength(content);
	const padding = short < width ? " ".repeat(width - short) : "";
	const surface = bg(CATHEDRAL_TOKENS.colors.surface);
	const foreground = fg(CATHEDRAL_TOKENS.colors.foreground);
	return `${surface}${foreground}${content}${padding}${RESET}`;
}

function banner(title: string, width: number): string {
	const upper = title.toUpperCase();
	const inner = ` ${upper} `;
	const dashCount = Math.max(2, width - inner.length);
	const left = Math.floor(dashCount / 2);
	const right = dashCount - left;
	const content = color(`${"═".repeat(left)}${inner}${"═".repeat(right)}`, CATHEDRAL_TOKENS.colors.accent);
	return surfaceLine(content, width);
}

function contextLines(snapshot: SidebarSnapshot, width: number): string[] {
	const used = snapshot.inputTokens + snapshot.outputTokens;
	const gauge = `${formatTokenCount(used)}/${formatTokenCount(snapshot.contextWindow)}`;
	const cost = `$${snapshot.costUsd.toFixed(2)}`;
	return [
		banner(VOICE.sections.context, width),
		surfaceLine(snapshot.projectName, width),
		surfaceLine(gauge, width),
		surfaceLine(cost, width),
	];
}

function mcpLines(snapshot: SidebarSnapshot, width: number): string[] {
	const lines: string[] = [surfaceLine("", width), banner(VOICE.sections.mcp, width)];
	for (const server of snapshot.mcpServers) {
		const dot = color("●", CATHEDRAL_TOKENS.colors.states[server.status]);
		lines.push(surfaceLine(`${dot} ${server.name}`, width));
	}
	return lines;
}

const MEMORY_DISPLAY_LIMIT = 5;

function memoryLines(snapshot: SidebarSnapshot, width: number): string[] {
	const lines: string[] = [surfaceLine("", width), banner(VOICE.sections.memory, width)];
	for (const item of snapshot.memory.slice(0, MEMORY_DISPLAY_LIMIT)) {
		const bullet = color("❧", CATHEDRAL_TOKENS.colors.accent);
		// truncate item text so visible width never exceeds the column count.
		const available = Math.max(0, width - 2 /* bullet + space */);
		const truncated = item.length > available ? `${item.slice(0, Math.max(0, available - 1))}…` : item;
		lines.push(surfaceLine(`${bullet} ${truncated}`, width));
	}
	return lines;
}

export function renderSidebar(snapshot: SidebarSnapshot, width: number): string[] {
	return [...contextLines(snapshot, width), ...mcpLines(snapshot, width), ...memoryLines(snapshot, width)];
}

function snapshotFromContext(ctx: ExtensionContext): SidebarSnapshot {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cost += entry.message.usage.cost.total;
	}

	const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	return {
		projectName: basename(ctx.cwd) || ctx.cwd,
		inputTokens: input,
		outputTokens: output,
		contextWindow,
		costUsd: cost,
		mcpServers: PLACEHOLDER_MCP,
		memory: PLACEHOLDER_MEMORY,
	};
}

/**
 * Pi-wiring glue. Mounts the sidebar as a non-capturing right-anchored overlay
 * that hides automatically when the terminal is narrower than
 * SIDEBAR_MIN_TERMINAL_WIDTH columns. Untested by design — pure rendering logic
 * lives in `renderSidebar` above.
 */
export function installSidebar(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		void ctx.ui
			.custom<void>(
				(tui, _theme: Theme, _keybindings, _done): Component => {
					requestRender = () => tui.requestRender();
					return {
						invalidate(): void {},
						render(width: number): string[] {
							return renderSidebar(snapshotFromContext(ctx), width);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: SIDEBAR_WIDTH,
						maxHeight: "100%",
						nonCapturing: true,
						visible: (cols: number) => cols >= SIDEBAR_MIN_TERMINAL_WIDTH,
					},
				},
			)
			.catch(() => {
				/* overlay was dismissed; nothing to clean up */
			});
	});

	// Kick a render whenever counters or cost might have moved.
	pi.on("agent_end", () => requestRender?.());
	pi.on("tool_result", () => requestRender?.());
}
