import { activeThemeColors, type SumoCodeState } from "../../themes/index.js";
import { formatTokenCount } from "../../footer.js";
import { VOICE } from "../../voice.js";
import { fgHex, padAnsiToWidth, SIDEBAR_INDENT, stripAnsi, visibleLength } from "./ansi.js";
import type { MetricsHudSnapshot } from "./metrics-hud.js";

export type SidebarSubTab = "CONTEXT" | "MEMORY";
export const SIDEBAR_SUB_TABS: readonly SidebarSubTab[] = ["CONTEXT", "MEMORY"];

export type McpServerStatus = "ok" | "idle" | "in-flight" | "error" | "down";
export type McpServerStatusLike = McpServerStatus | SumoCodeState;

export interface McpServerSnapshot {
	readonly name: string;
	readonly status: McpServerStatusLike;
}

export interface SidebarSessionSnapshot {
	readonly name: string;
	readonly branch?: string;
	readonly active?: boolean;
}

export interface RegistrySidebarSnapshot {
	readonly projectName: string;
	readonly branch?: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Current context window usage from `ctx.getContextUsage()?.tokens`. Falls back to inputTokens+outputTokens if unavailable. */
	readonly currentContextTokens?: number;
	readonly contextWindow: number;
	readonly cumulativeTokens?: number;
	readonly costUsd: number;
	readonly mcpServers: readonly McpServerSnapshot[];
	readonly memory: readonly string[];
	/** Total memories in the store; used to compute the 'N more · ⌘M' footer. */
	readonly memoryTotal?: number;
	readonly memoryUnavailable?: boolean;
	readonly activeSubTab?: SidebarSubTab;
	readonly sessions?: readonly SidebarSessionSnapshot[];
	readonly metrics?: MetricsHudSnapshot;
}

const TOKEN_BAR_CELLS = 22;
const MEMORY_DISPLAY_LIMIT = 5;
const FG_RESET = "\u001b[39m";
const DIM_OFF = "\u001b[22m";

function colorHex(text: string, hex: string): string {
	return `${fgHex(hex)}${text}${FG_RESET}`;
}

function dim(text: string): string {
	return `\u001b[2m${text}${DIM_OFF}`;
}

function tokenUsageRatio(used: number, total: number): number {
	if (total <= 0 || !Number.isFinite(used) || !Number.isFinite(total)) return 0;
	return Math.max(0, used / total);
}

function clampRatio(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function truncatePlainText(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleLength(text) <= maxWidth) return text;
	return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function indented(content: string): string {
	return `${SIDEBAR_INDENT}${content}`;
}

function tracked(text: string): string {
	return text.split("").join("\u202F");
}

function blank(width: number): string {
	return padAnsiToWidth("", width);
}

function rule(width: number): string {
	const count = Math.max(1, width - visibleLength(SIDEBAR_INDENT) - 2);
	return padAnsiToWidth(indented(colorHex("━".repeat(count), activeThemeColors().divider)), width);
}

function row(content: string, width: number): string {
	return padAnsiToWidth(indented(content), width);
}

export function tokenMeterColor(used: number, total: number): string {
	const ratio = tokenUsageRatio(used, total);
	if (ratio > 1) return activeThemeColors().states.approval;
	if (ratio >= 0.8) return activeThemeColors().accent;
	if (ratio >= 0.5) return activeThemeColors().states.thinking;
	return activeThemeColors().states.idle;
}

/** Cathedral V2 editorial token gauge: `▉▉▉▉▉░░░...` on its own row. */
export function renderTokenMeter(used: number, total: number): string {
	const ratio = tokenUsageRatio(used, total);
	const filled = ratio > 1 ? TOKEN_BAR_CELLS : Math.round(clampRatio(ratio) * TOKEN_BAR_CELLS);
	const empty = TOKEN_BAR_CELLS - filled;
	const meterColor = tokenMeterColor(used, total);
	return `${colorHex("▉".repeat(filled), meterColor)}${colorHex("░".repeat(empty), activeThemeColors().divider)}`;
}

function contextLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const used = snapshot.currentContextTokens ?? (snapshot.inputTokens + snapshot.outputTokens);
	const overBudget = snapshot.contextWindow > 0 && used > snapshot.contextWindow;
	return [
		row(colorHex(snapshot.projectName, activeThemeColors().foreground), width),
		row(colorHex(`on ${snapshot.branch ?? "unknown"}`, activeThemeColors().foregroundDim), width),
		blank(width),
		row(colorHex(tracked("CONTEXT"), activeThemeColors().foregroundDim), width),
		row(renderTokenMeter(used, snapshot.contextWindow), width),
		row(
			`${colorHex(formatTokenCount(used), overBudget ? activeThemeColors().states.approval : activeThemeColors().foreground)} ` +
				`${colorHex(`/ ${formatTokenCount(snapshot.contextWindow)}`, activeThemeColors().foregroundDim)}` +
				(overBudget ? ` ${colorHex("OVER", activeThemeColors().states.approval)}` : ""),
			width,
		),
		blank(width),
		row(colorHex(tracked("SESSION"), activeThemeColors().foregroundDim), width),
		row(
			`${colorHex(`$${snapshot.costUsd.toFixed(2)}`, activeThemeColors().foreground)} ` +
				`${colorHex(`· ${formatTokenCount(snapshot.cumulativeTokens ?? used)} cumul`, activeThemeColors().foregroundDim)}`,
			width,
		),
	];
}

export function normalizeMcpStatus(status: McpServerStatusLike): McpServerStatus {
	switch (status) {
		case "ok":
		case "idle":
		case "in-flight":
		case "error":
		case "down":
			return status;
		case "thinking":
		case "tool":
			return "in-flight";
		case "approval":
			return "error";
		case "learning":
			return "ok";
	}
}

export function mcpStatusColor(status: McpServerStatusLike): string {
	switch (normalizeMcpStatus(status)) {
		case "ok":
			return activeThemeColors().states.idle;
		case "idle":
			return activeThemeColors().foregroundDim;
		case "in-flight":
			return activeThemeColors().states.thinking;
		case "error":
		case "down":
			return activeThemeColors().states.approval;
	}
}

export function mcpStatusLabel(status: McpServerStatusLike): string {
	return normalizeMcpStatus(status);
}

export function renderMcpServerRow(server: McpServerSnapshot, width: number): string {
	const status = mcpStatusLabel(server.status);
	const dot = colorHex("●", mcpStatusColor(server.status));
	const statusText = colorHex(status, activeThemeColors().foregroundDim);
	const reserve = visibleLength(SIDEBAR_INDENT) + 1 + 1 + status.length + 2;
	const name = truncatePlainText(server.name, Math.max(1, width - reserve));
	const gap = Math.max(1, width - visibleLength(SIDEBAR_INDENT) - 2 - visibleLength(name) - status.length - 2);
	return padAnsiToWidth(indented(`${dot} ${colorHex(name, activeThemeColors().foreground)}${" ".repeat(gap)}${statusText}  `), width);
}

function mcpLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const lines = [row(colorHex(tracked("MCP"), activeThemeColors().foregroundDim), width), blank(width)];
	for (const server of snapshot.mcpServers) lines.push(renderMcpServerRow(server, width));
	return lines;
}

export function renderMemoryFactLine(item: string, width: number): string {
	const available = Math.max(0, width - visibleLength(SIDEBAR_INDENT) - 2);
	const bullet = colorHex("❧", activeThemeColors().accent);
	const text = colorHex(truncatePlainText(item, available), activeThemeColors().foreground);
	return padAnsiToWidth(indented(`${bullet} ${text}`), width);
}

function memoryLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const lines = [row(colorHex(tracked("MEMORY"), activeThemeColors().foregroundDim), width), blank(width)];
	if (snapshot.memoryUnavailable) {
		lines.push(row(dim(VOICE.errors.daemonDown), width));
		return lines;
	}
	if (snapshot.memory.length === 0) {
		lines.push(row(dim(VOICE.empty.memory), width));
		return lines;
	}

	const shown = snapshot.memory.slice(0, MEMORY_DISPLAY_LIMIT);
	for (const item of shown) lines.push(renderMemoryFactLine(item, width));

	const total = snapshot.memoryTotal ?? snapshot.memory.length;
	const hidden = Math.max(0, total - shown.length);
	if (hidden > 0) {
		lines.push(blank(width));
		lines.push(rule(width));
		lines.push(row(colorHex(`${hidden} more · ⌘M`, activeThemeColors().foregroundDim), width));
	}
	return lines;
}

export function renderRegistryHeaderLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const active = snapshot.activeSubTab ?? "CONTEXT";
	const lines: string[] = [
		blank(width),
		row(colorHex("REGISTRY", activeThemeColors().accent), width),
		blank(width),
	];

	for (const tab of SIDEBAR_SUB_TABS) {
		const isActive = tab === active;
		const marker = colorHex(isActive ? "◆" : "▢", isActive ? activeThemeColors().accent : activeThemeColors().foregroundDim);
		const label = colorHex(tracked(tab), isActive ? activeThemeColors().foreground : activeThemeColors().foregroundDim);
		lines.push(padAnsiToWidth(indented(`${marker} ${label}`), width));
	}
	lines.push(blank(width));
	lines.push(rule(width));
	lines.push(blank(width));
	return lines;
}

export function renderRegistrySidebarLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const active = snapshot.activeSubTab ?? "CONTEXT";
	const lines = [...renderRegistryHeaderLines(snapshot, width)];

	if (active === "CONTEXT") {
		lines.push(...contextLines(snapshot, width));
		lines.push(blank(width));
		lines.push(rule(width));
		lines.push(blank(width));
		lines.push(...mcpLines(snapshot, width));
	} else {
		lines.push(...memoryLines(snapshot, width));
	}

	return lines.map((line) => padAnsiToWidth(line, width));
}

export function stripSidebarAnsi(text: string): string {
	return stripAnsi(text);
}
