import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";
import { formatTokenCount, resolveGitBranch } from "./footer.js";
import { createRemnicMemoryClient, type RemnicMemoryClient } from "./memory.js";
import { VOICE } from "./voice.js";

/** Threshold below which the sidebar hides itself. */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 160;
/** Render width for the sidebar overlay (DESIGN.md §5 — cols 112..160). */
export const SIDEBAR_WIDTH = 49;
/** Leading indent inside each sidebar row, matching docs/ui/claude-design/Sidebar.jsx. */
const SIDEBAR_INDENT = "  ";
/** Debounce used when refreshing memories from user prompt changes. */
export const SIDEBAR_MEMORY_DEBOUNCE_MS = 200;
/** Retry cadence while Remnic is unavailable. */
export const SIDEBAR_MEMORY_RETRY_MS = 5_000;

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
	branch?: string;
	inputTokens: number;
	outputTokens: number;
	contextWindow: number;
	costUsd: number;
	mcpServers: readonly McpServerSnapshot[];
	memory: readonly string[];
	/** Total memories in the store; used to compute the 'N more · ⌘M' footer. */
	memoryTotal?: number;
	memoryUnavailable?: boolean;
};

export type SidebarAnchor = "right-center" | "top-right" | "bottom-right";

/**
 * Pick a sidebar anchor responsive to terminal aspect ratio. Override always
 * wins so per-machine `~/.sumocode/local-config.json` can pin a value.
 */
export function chooseSidebarAnchor(
	termWidth: number,
	termHeight: number,
	override?: SidebarAnchor,
): SidebarAnchor {
	if (override) return override;
	if (termHeight > termWidth * 1.4) return "top-right";
	return "right-center";
}

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

function dim(text: string): string {
	return `\u001b[2m${text}${RESET}`;
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

function indent(content: string): string {
	return `${SIDEBAR_INDENT}${content}`;
}

function banner(title: string, width: number): string {
	const upper = title.toUpperCase();
	const inner = ` ${upper} `;
	const available = Math.max(2, width - SIDEBAR_INDENT.length - inner.length);
	const left = Math.floor(available / 2);
	const right = available - left;
	const banner = color(`${"═".repeat(left)}${inner}${"═".repeat(right)}`, CATHEDRAL_TOKENS.colors.accent);
	return surfaceLine(indent(banner), width);
}

const PROGRESS_BAR_TOTAL = 24;

function renderProgressBar(used: number, total: number): string {
	if (total <= 0) {
		return `[${"░".repeat(PROGRESS_BAR_TOTAL)}]`;
	}
	const ratio = Math.max(0, Math.min(1, used / total));
	const filled = Math.round(ratio * PROGRESS_BAR_TOTAL);
	const empty = PROGRESS_BAR_TOTAL - filled;
	const leftBracket = color("[", CATHEDRAL_TOKENS.colors.divider);
	const rightBracket = color("]", CATHEDRAL_TOKENS.colors.divider);
	const fill = color("█".repeat(filled), CATHEDRAL_TOKENS.colors.foreground);
	const rest = color("░".repeat(empty), CATHEDRAL_TOKENS.colors.divider);
	return `${leftBracket}${fill}${rest}${rightBracket}`;
}

function contextLines(snapshot: SidebarSnapshot, width: number): string[] {
	const used = snapshot.inputTokens + snapshot.outputTokens;
	const gauge = `${formatTokenCount(used)}/${formatTokenCount(snapshot.contextWindow)}`;
	const projectLabel = snapshot.branch ? `${snapshot.projectName} (${snapshot.branch})` : snapshot.projectName;
	const progressBar = renderProgressBar(used, snapshot.contextWindow);
	const spend = color(`$${snapshot.costUsd.toFixed(2)} spent · session`, CATHEDRAL_TOKENS.colors.foregroundDim);

	return [
		surfaceLine("", width),
		banner(VOICE.sections.context, width),
		surfaceLine("", width),
		surfaceLine(indent(projectLabel), width),
		surfaceLine(indent(`${progressBar} ${gauge}`), width),
		surfaceLine(indent(spend), width),
	];
}

function statusLabel(status: SumoCodeState): string {
	switch (status) {
		case "idle":
			return "idle";
		case "thinking":
			return "working";
		case "tool":
			return "tool";
		case "approval":
			return "down";
		case "learning":
			return "learning";
	}
}

function mcpLines(snapshot: SidebarSnapshot, width: number): string[] {
	const lines: string[] = [
		surfaceLine("", width),
		banner(VOICE.sections.mcp, width),
		surfaceLine("", width),
	];

	const innerWidth = width - SIDEBAR_INDENT.length;

	for (const server of snapshot.mcpServers) {
		const dot = color("●", CATHEDRAL_TOKENS.colors.states[server.status]);
		const label = statusLabel(server.status);
		const pill = color(label, CATHEDRAL_TOKENS.colors.foregroundDim);
		// Visible chars: "● " + name + spaces + label = innerWidth
		const nameMaxLen = Math.max(0, innerWidth - 2 /* dot + space */ - label.length - 1 /* gap */);
		const name = server.name.length > nameMaxLen
			? `${server.name.slice(0, Math.max(0, nameMaxLen - 1))}…`
			: server.name;
		const gap = Math.max(1, innerWidth - 2 - name.length - label.length);
		const row = `${dot} ${name}${" ".repeat(gap)}${pill}`;
		lines.push(surfaceLine(indent(row), width));
	}
	return lines;
}

const MEMORY_DISPLAY_LIMIT = 5;

function memoryLines(snapshot: SidebarSnapshot, width: number): string[] {
	const lines: string[] = [
		surfaceLine("", width),
		banner(VOICE.sections.memory, width),
		surfaceLine("", width),
	];

	if (snapshot.memoryUnavailable) {
		lines.push(surfaceLine(indent(dim(VOICE.errors.daemonDown)), width));
		return lines;
	}

	if (snapshot.memory.length === 0) {
		lines.push(surfaceLine(indent(dim(VOICE.empty.memory)), width));
		return lines;
	}

	const shown = snapshot.memory.slice(0, MEMORY_DISPLAY_LIMIT);
	for (const item of shown) {
		const bullet = color("❧", CATHEDRAL_TOKENS.colors.accent);
		// truncate item text so visible width never exceeds the column count.
		const available = Math.max(0, width - SIDEBAR_INDENT.length - 2 /* bullet + space */);
		const truncated = item.length > available ? `${item.slice(0, Math.max(0, available - 1))}…` : item;
		lines.push(surfaceLine(indent(`${bullet} ${truncated}`), width));
	}

	const total = snapshot.memoryTotal ?? snapshot.memory.length;
	const hidden = Math.max(0, total - shown.length);
	if (hidden > 0) {
		lines.push(surfaceLine("", width));
		lines.push(surfaceLine(indent(color(`${hidden} more · ⌘M`, CATHEDRAL_TOKENS.colors.foregroundDim)), width));
	}

	return lines;
}

export function renderSidebar(snapshot: SidebarSnapshot, width: number): string[] {
	return [...contextLines(snapshot, width), ...mcpLines(snapshot, width), ...memoryLines(snapshot, width)];
}

export type SidebarMemoryCache = {
	refresh(prompt: string): Promise<void>;
	schedule(prompt: string, onChange: () => void): void;
	snapshot(): Pick<SidebarSnapshot, "memory" | "memoryUnavailable">;
};

export function createSidebarMemoryCache(
	memoryClient: Pick<RemnicMemoryClient, "query">,
	debounceMs = SIDEBAR_MEMORY_DEBOUNCE_MS,
): SidebarMemoryCache {
	let memory: readonly string[] = [];
	let memoryUnavailable = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	async function refresh(prompt: string): Promise<void> {
		const run = ++generation;
		try {
			const facts = await memoryClient.query(prompt, MEMORY_DISPLAY_LIMIT);
			if (run !== generation) return;
			memory = facts.map((fact) => fact.text);
			memoryUnavailable = false;
		} catch {
			if (run !== generation) return;
			memory = [];
			memoryUnavailable = true;
		}
	}

	function clearRetry(): void {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function scheduleRetry(prompt: string, onChange: () => void): void {
		clearRetry();
		retryTimer = setTimeout(() => {
			void refresh(prompt).finally(() => {
				onChange();
				if (memoryUnavailable) scheduleRetry(prompt, onChange);
			});
		}, SIDEBAR_MEMORY_RETRY_MS);
		retryTimer.unref?.();
	}

	return {
		refresh,
		schedule(prompt: string, onChange: () => void): void {
			if (timer) clearTimeout(timer);
			clearRetry();
			timer = setTimeout(() => {
				void refresh(prompt).finally(() => {
					onChange();
					if (memoryUnavailable) scheduleRetry(prompt, onChange);
				});
			}, debounceMs);
			timer.unref?.();
		},
		snapshot(): Pick<SidebarSnapshot, "memory" | "memoryUnavailable"> {
			return { memory, memoryUnavailable };
		},
	};
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const maybe = message as { role?: unknown; content?: unknown };
	if (maybe.role !== "user") return "";
	if (typeof maybe.content === "string") return maybe.content;
	if (Array.isArray(maybe.content)) {
		return maybe.content
			.map((part) => {
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
					return (part as { text?: unknown }).text;
				}
				return undefined;
			})
			.filter((part): part is string => typeof part === "string")
			.join("\n");
	}
	return "";
}

function snapshotFromContext(
	ctx: ExtensionContext,
	memorySnapshot: Pick<SidebarSnapshot, "memory" | "memoryUnavailable">,
): SidebarSnapshot {
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
	const branch = resolveGitBranch(ctx.cwd) ?? undefined;

	return {
		projectName: basename(ctx.cwd) || ctx.cwd,
		branch,
		inputTokens: input,
		outputTokens: output,
		contextWindow,
		costUsd: cost,
		mcpServers: PLACEHOLDER_MCP,
		memory: memorySnapshot.memory,
		memoryTotal: memorySnapshot.memory.length,
		memoryUnavailable: memorySnapshot.memoryUnavailable,
	};
}

/**
 * Read a per-machine sidebar anchor override from `~/.sumocode/local-config.json`.
 * Per #13: this file is intentionally NOT synced via the config repo.
 */
export const SIDEBAR_LOCAL_CONFIG_PATH = join(homedir(), ".sumocode", "local-config.json");

function readSidebarAnchorOverride(): SidebarAnchor | undefined {
	try {
		const raw = readFileSync(SIDEBAR_LOCAL_CONFIG_PATH, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const value = (parsed as { sidebarAnchor?: unknown }).sidebarAnchor;
		if (value === "right-center" || value === "top-right" || value === "bottom-right") {
			return value;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pi-wiring glue. Mounts the sidebar as a non-capturing right-anchored overlay
 * that hides automatically when the terminal is narrower than
 * SIDEBAR_MIN_TERMINAL_WIDTH columns. Untested by design — pure rendering logic
 * lives in `renderSidebar` above.
 */
export function installSidebar(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	let memoryCache: SidebarMemoryCache | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		memoryCache = createSidebarMemoryCache(createRemnicMemoryClient());
		memoryCache.schedule("", () => requestRender?.());

		const override = readSidebarAnchorOverride();

		void ctx.ui
			.custom<void>(
				(tui, _theme: Theme, _keybindings, _done): Component => {
					requestRender = () => tui.requestRender();
					return {
						invalidate(): void {},
						render(width: number): string[] {
							return renderSidebar(snapshotFromContext(ctx, memoryCache?.snapshot() ?? { memory: [] }), width);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: () => ({
						anchor: chooseSidebarAnchor(
							process.stdout.columns ?? 0,
							process.stdout.rows ?? 0,
							override,
						),
						width: SIDEBAR_WIDTH,
						maxHeight: "100%",
						nonCapturing: true,
						visible: (cols: number) => cols >= SIDEBAR_MIN_TERMINAL_WIDTH,
					}),
				},
			)
			.catch(() => {
				/* overlay was dismissed; nothing to clean up */
			});
	});

	pi.on("message_start", (event) => {
		const prompt = messageText(event.message);
		if (!prompt) return;
		memoryCache?.schedule(prompt, () => requestRender?.());
	});

	// Kick a render whenever counters or cost might have moved.
	pi.on("agent_end", () => requestRender?.());
	pi.on("tool_result", () => requestRender?.());
}
