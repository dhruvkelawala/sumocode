import { activeThemeChrome, activeThemeColors, type SumoCodeState } from "../../themes/index.js";
import { formatTokenCount } from "../../footer.js";
import { fgHex, padAnsiToWidth, SIDEBAR_INDENT, stripAnsi, visibleLength } from "./ansi.js";
import type { MetricsHudSnapshot } from "./metrics-hud.js";

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
	readonly sessions?: readonly SidebarSessionSnapshot[];
	readonly metrics?: MetricsHudSnapshot;
}

const TOKEN_BAR_CELLS = 22;
const FG_RESET = "\u001b[39m";

function colorHex(text: string, hex: string): string {
	return `${fgHex(hex)}${text}${FG_RESET}`;
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

function sectionLabel(text: string): string {
	const chrome = activeThemeChrome();
	const label = chrome.sectionTracked ? text.split("").join("\u202F") : text;
	const glyph = chrome.sectionGlyphs[text.toLowerCase()] ?? "";
	return glyph ? `${glyph}  ${label}` : label;
}

function blank(width: number): string {
	return padAnsiToWidth("", width);
}

function rule(width: number): string {
	const chrome = activeThemeChrome();
	const count = Math.max(1, width - visibleLength(SIDEBAR_INDENT) - 2);
	return padAnsiToWidth(indented(colorHex(chrome.ruleChar.repeat(count), activeThemeColors().divider)), width);
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
		row(colorHex(sectionLabel("CONTEXT"), activeThemeColors().foregroundDim), width),
		row(renderTokenMeter(used, snapshot.contextWindow), width),
		row(
			`${colorHex(formatTokenCount(used), overBudget ? activeThemeColors().states.approval : activeThemeColors().foreground)} ` +
				`${colorHex(`/ ${formatTokenCount(snapshot.contextWindow)}`, activeThemeColors().foregroundDim)}` +
				(overBudget ? ` ${colorHex("OVER", activeThemeColors().states.approval)}` : ""),
			width,
		),
		blank(width),
		row(colorHex(sectionLabel("SESSION"), activeThemeColors().foregroundDim), width),
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
	const lines = [row(colorHex(sectionLabel("MCP"), activeThemeColors().foregroundDim), width), blank(width)];
	for (const server of snapshot.mcpServers) lines.push(renderMcpServerRow(server, width));
	return lines;
}

export function renderRegistryHeaderLines(width: number): string[] {
	const marker = colorHex(activeThemeChrome().tabActive, activeThemeColors().accent);
	const label = colorHex(sectionLabel("CONTEXT"), activeThemeColors().foreground);
	return [
		blank(width),
		row(colorHex("REGISTRY", activeThemeColors().accent), width),
		blank(width),
		row(`${marker} ${label}`, width),
		blank(width),
		rule(width),
		blank(width),
	];
}

export function renderRegistrySidebarLines(snapshot: RegistrySidebarSnapshot, width: number): string[] {
	const lines = [
		...renderRegistryHeaderLines(width),
		...contextLines(snapshot, width),
		blank(width),
		rule(width),
		blank(width),
		...mcpLines(snapshot, width),
	];
	return lines.map((line) => padAnsiToWidth(line, width));
}

export function stripSidebarAnsi(text: string): string {
	return stripAnsi(text);
}
