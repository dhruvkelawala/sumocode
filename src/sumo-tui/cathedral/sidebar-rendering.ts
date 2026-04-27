import { CATHEDRAL_TOKENS, type SumoCodeState } from "../../tokens.js";
import { formatTokenCount } from "../../footer.js";
import { VOICE } from "../../voice.js";
import { bold, colorHex, dim, italic, padAnsiToWidth, renderSidebarSectionHeader, SIDEBAR_INDENT, visibleLength } from "./ansi.js";
import { renderMetricsHudLines, type MetricsHudSnapshot } from "./metrics-hud.js";

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
	readonly contextWindow: number;
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

const TOKEN_BAR_CELLS = 10;
const MEMORY_DISPLAY_LIMIT = 5;

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

export function tokenMeterColor(used: number, total: number): string {
	const ratio = tokenUsageRatio(used, total);
	if (ratio > 1) return CATHEDRAL_TOKENS.colors.states.approval;
	if (ratio >= 0.8) return CATHEDRAL_TOKENS.colors.accent;
	if (ratio >= 0.5) return CATHEDRAL_TOKENS.colors.states.thinking;
	return CATHEDRAL_TOKENS.colors.states.idle;
}

/** CATHEDRAL_UX_SPEC.md §4.2 token gauge: `[██████░░░] 42k/200k`. */
export function renderTokenMeter(used: number, total: number): string {
	const ratio = tokenUsageRatio(used, total);
	const filled = Math.round(clampRatio(ratio) * TOKEN_BAR_CELLS);
	const empty = TOKEN_BAR_CELLS - filled;
	const overBudget = ratio > 1;
	const meterColor = tokenMeterColor(used, total);
	const leftBracket = colorHex("[", CATHEDRAL_TOKENS.colors.divider);
	const rightBracket = colorHex("]", CATHEDRAL_TOKENS.colors.divider);
	const fill = colorHex("█".repeat(filled), meterColor);
	const rest = colorHex("░".repeat(empty), CATHEDRAL_TOKENS.colors.divider);
	const usageText = `${formatTokenCount(used)}/${formatTokenCount(total)}${overBudget ? " OVER" : ""}`;
	const usage = colorHex(usageText, overBudget ? CATHEDRAL_TOKENS.colors.states.approval : CATHEDRAL_TOKENS.colors.foreground);
	return `${leftBracket}${fill}${rest}${rightBracket} ${usage}`;
}

function contextLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const used = snapshot.inputTokens + snapshot.outputTokens;
	const projectLabel = snapshot.branch ? `${snapshot.projectName} (${snapshot.branch})` : snapshot.projectName;
	return [
		renderSidebarSectionHeader("ACTIVE_CONTEXT", width),
		padAnsiToWidth(indented(colorHex(projectLabel, CATHEDRAL_TOKENS.colors.foreground)), width),
		padAnsiToWidth(indented(renderTokenMeter(used, snapshot.contextWindow)), width),
		padAnsiToWidth(indented(colorHex(`$${snapshot.costUsd.toFixed(2)} spent · session`, CATHEDRAL_TOKENS.colors.foregroundDim)), width),
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
			return CATHEDRAL_TOKENS.colors.states.idle;
		case "idle":
			return CATHEDRAL_TOKENS.colors.foregroundDim;
		case "in-flight":
			return CATHEDRAL_TOKENS.colors.states.thinking;
		case "error":
		case "down":
			return CATHEDRAL_TOKENS.colors.states.approval;
	}
}

export function mcpStatusLabel(status: McpServerStatusLike): string {
	return normalizeMcpStatus(status);
}

export function renderMcpServerRow(server: McpServerSnapshot, width: number): string {
	const innerWidth = Math.max(1, width - SIDEBAR_INDENT.length);
	const status = mcpStatusLabel(server.status);
	const dot = colorHex("●", mcpStatusColor(server.status));
	const statusText = colorHex(status, CATHEDRAL_TOKENS.colors.foregroundDim);
	const nameMaxWidth = Math.max(1, innerWidth - 2 - status.length - 1);
	const name = truncatePlainText(server.name, nameMaxWidth);
	const gap = Math.max(1, innerWidth - 2 - visibleLength(name) - status.length);
	return padAnsiToWidth(indented(`${dot} ${colorHex(name, CATHEDRAL_TOKENS.colors.foreground)}${" ".repeat(gap)}${statusText}`), width);
}

function mcpLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const lines = [renderSidebarSectionHeader("MCP", width)];
	for (const server of snapshot.mcpServers) lines.push(renderMcpServerRow(server, width));
	return lines;
}

export function renderMemoryFactLine(item: string, width: number): string {
	const available = Math.max(0, width - SIDEBAR_INDENT.length - 2);
	const bullet = colorHex("❧", CATHEDRAL_TOKENS.colors.accent);
	const text = colorHex(truncatePlainText(item, available), CATHEDRAL_TOKENS.colors.foreground);
	return padAnsiToWidth(indented(`${bullet} ${text}`), width);
}

function memoryLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const lines = [renderSidebarSectionHeader("ACTIVE_MEMORY", width)];
	if (snapshot.memoryUnavailable) {
		lines.push(padAnsiToWidth(indented(dim(VOICE.errors.daemonDown)), width));
		return lines;
	}
	if (snapshot.memory.length === 0) {
		lines.push(padAnsiToWidth(indented(dim(VOICE.empty.memory)), width));
		return lines;
	}

	const shown = snapshot.memory.slice(0, MEMORY_DISPLAY_LIMIT);
	for (const item of shown) lines.push(renderMemoryFactLine(item, width));

	const total = snapshot.memoryTotal ?? snapshot.memory.length;
	const hidden = Math.max(0, total - shown.length);
	if (hidden > 0) {
		lines.push(padAnsiToWidth(indented(italic(colorHex(`${hidden} more · ⌘M`, CATHEDRAL_TOKENS.colors.foregroundDim))), width));
	}
	return lines;
}

function sessionLabel(session: SidebarSessionSnapshot): string {
	return session.branch ? `${session.name} (${session.branch})` : session.name;
}

function registrySessions(snapshot: RegistrySidebarSnapshot): readonly SidebarSessionSnapshot[] {
	return snapshot.sessions?.length
		? snapshot.sessions
		: [{ name: snapshot.projectName, branch: snapshot.branch, active: true }];
}

export function renderRegistryHeaderLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const active = snapshot.activeSubTab ?? "CONTEXT";
	const lines: string[] = [
		padAnsiToWidth("", width),
		padAnsiToWidth(indented(colorHex("REGISTRY", CATHEDRAL_TOKENS.colors.accent)), width),
		padAnsiToWidth(indented(colorHex("v 1.0.0", CATHEDRAL_TOKENS.colors.foregroundDim)), width),
		padAnsiToWidth("", width),
	];

	for (const [index, session] of registrySessions(snapshot).entries()) {
		const isActive = session.active ?? index === 0;
		const marker = colorHex(isActive ? "◆" : "▢", isActive ? CATHEDRAL_TOKENS.colors.accent : CATHEDRAL_TOKENS.colors.foregroundDim);
		const label = colorHex(sessionLabel(session), isActive ? CATHEDRAL_TOKENS.colors.foreground : CATHEDRAL_TOKENS.colors.foregroundDim);
		lines.push(padAnsiToWidth(indented(`${marker} ${label}`), width));
	}

	lines.push(padAnsiToWidth("", width));
	for (const tab of SIDEBAR_SUB_TABS) {
		const isActive = tab === active;
		const marker = colorHex(isActive ? "◆" : "▢", isActive ? CATHEDRAL_TOKENS.colors.accent : CATHEDRAL_TOKENS.colors.foregroundDim);
		const label = isActive
			? bold(colorHex(tab, CATHEDRAL_TOKENS.colors.accent))
			: colorHex(tab, CATHEDRAL_TOKENS.colors.foregroundDim);
		lines.push(padAnsiToWidth(indented(`${marker} ${label}`), width));
	}
	lines.push(padAnsiToWidth("", width));
	return lines;
}

export function renderRegistrySidebarLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const active = snapshot.activeSubTab ?? "CONTEXT";
	const lines = [...renderRegistryHeaderLines(snapshot, width)];

	if (active === "CONTEXT") {
		lines.push(...contextLines(snapshot, width));
		lines.push(padAnsiToWidth("", width));
		lines.push(...mcpLines(snapshot, width));
		lines.push(padAnsiToWidth("", width));
		// Issue #56 polish keeps v1's two-tab sidebar (DECISIONS Element 1) while
		// surfacing Remnic facts in the active-state registry per UX_SPEC.md §4.2.
		lines.push(...memoryLines(snapshot, width));
	} else {
		lines.push(...memoryLines(snapshot, width));
	}

	lines.push(padAnsiToWidth("", width));
	lines.push(...renderMetricsHudLines(snapshot.metrics, width));
	return lines.map((line) => padAnsiToWidth(line, width));
}
