/**
 * Cathedral scroll/scribe delegation renderer — Bible Element 12.
 *
 * Renders Pi task/sub-agent tool calls as a `[scroll]` assigned to a `scribe`.
 * Outer thick-rule header, inner ledger with nested compact tool pills.
 *
 * Bible source of truth:
 *   docs/ui/bible/12-scroll-running.html
 *   docs/ui/bible/12-scroll-done.html
 */
import { visibleWidth } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { lineToAnsi, span, textLine, type Span } from "../render/primitives.js";
import type { DelegationStatus, DelegationViewModel, ToolCallViewModel } from "./view-model.js";

const STATUS_GLYPH: Record<DelegationStatus, string> = {
	queued: "○",
	running: "▶",
	success: "✓",
	error: "✗",
	cancelled: "✗",
};

const STATUS_COLOR: Record<DelegationStatus, string> = {
	queued: CATHEDRAL_TOKENS.colors.foregroundDim,
	running: CATHEDRAL_TOKENS.colors.states.tool,
	success: CATHEDRAL_TOKENS.colors.states.idle,
	error: CATHEDRAL_TOKENS.colors.states.approval,
	cancelled: CATHEDRAL_TOKENS.colors.foregroundDim,
};

const STATUS_LABEL: Record<DelegationStatus, string> = {
	queued: "queued",
	running: "running",
	success: "done",
	error: "failed",
	cancelled: "cancelled",
};

const TOOL_STATUS_GLYPH: Record<string, string> = {
	pending: "○", running: "▶", success: "✓", error: "✗", cancelled: "✗",
};

const TOOL_STATUS_COLOR: Record<string, string> = {
	pending: CATHEDRAL_TOKENS.colors.foregroundDim,
	running: CATHEDRAL_TOKENS.colors.states.tool,
	success: CATHEDRAL_TOKENS.colors.states.idle,
	error: CATHEDRAL_TOKENS.colors.states.approval,
	cancelled: CATHEDRAL_TOKENS.colors.foregroundDim,
};

function toolTarget(tool: ToolCallViewModel): string {
	const input = typeof tool.input === "object" && tool.input !== null ? tool.input as Record<string, unknown> : {};
	return typeof input.path === "string" ? input.path
		: typeof input.command === "string" ? input.command
		: tool.output ?? "";
}

function formatTokens(tokensIn?: number, tokensOut?: number): string | undefined {
	if (tokensIn === undefined && tokensOut === undefined) return undefined;
	const inStr = tokensIn !== undefined ? `↑${formatK(tokensIn)}` : "";
	const outStr = tokensOut !== undefined ? `↓${formatK(tokensOut)}` : "";
	return [inStr, outStr].filter(Boolean).join(" ");
}

function formatK(n: number): string {
	if (n >= 10000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(n);
}

function formatElapsed(ms?: number): string | undefined {
	if (ms === undefined) return undefined;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s elapsed`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m ${remaining}s elapsed`;
}

// ── Rendering ────────────────────────────────────────────────

function scrollHeader(delegation: DelegationViewModel, width: number): string {
	const statusGlyph = STATUS_GLYPH[delegation.status];
	const statusColor = STATUS_COLOR[delegation.status];
	const statusLabel = STATUS_LABEL[delegation.status];

	const left: Span[] = [
		span("━━━ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("[scroll]", { fg: CATHEDRAL_TOKENS.colors.accent }),
		span(`  ${delegation.title} `, { fg: CATHEDRAL_TOKENS.colors.foreground }),
	];
	const right: Span[] = [
		span(" ━━━ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(statusGlyph, { fg: statusColor }),
		span(` ${statusLabel}`, { fg: CATHEDRAL_TOKENS.colors.foreground }),
	];

	const leftWidth = left.reduce((w, s) => w + visibleWidth(s.text), 0);
	const rightWidth = right.reduce((w, s) => w + visibleWidth(s.text), 0);
	const ruleLen = Math.max(1, width - leftWidth - rightWidth);

	return lineToAnsi(textLine([
		...left,
		span("━".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }),
		...right,
	]), { width });
}

function scribeHeader(delegation: DelegationViewModel, width: number): string {
	const agent = delegation.agent ?? "scribe";
	const metaParts = [agent];
	if (delegation.model) metaParts.push(delegation.model);
	if (delegation.thinking) metaParts.push(delegation.thinking);
	const meta = metaParts.join(" · ");

	const left: Span[] = [
		span("   "),
		span("┌ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(meta, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
		span(" ", { fg: CATHEDRAL_TOKENS.colors.divider }),
	];
	const leftWidth = left.reduce((w, s) => w + visibleWidth(s.text), 0);
	const ruleLen = Math.max(0, width - leftWidth - 4); // trailing spaces

	return lineToAnsi(textLine([
		...left,
		span("─".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("    "),
	]), { width });
}

function nestedToolRow(tool: ToolCallViewModel, width: number): string {
	const glyph = TOOL_STATUS_GLYPH[tool.status] ?? "○";
	const color = TOOL_STATUS_COLOR[tool.status] ?? CATHEDRAL_TOKENS.colors.foregroundDim;
	const target = toolTarget(tool);

	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" "),
		span(glyph, { fg: color }),
		span(" "),
		span(`[${tool.name}]`, { fg: CATHEDRAL_TOKENS.colors.accent }),
		span(`  ${target}`, { fg: CATHEDRAL_TOKENS.colors.foreground }),
	]), { width });
}

function scribeBlankRow(width: number): string {
	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

function scribeMetadataRow(delegation: DelegationViewModel, width: number): string {
	const parts: string[] = [];
	const tokens = formatTokens(delegation.tokensIn, delegation.tokensOut);
	if (tokens) parts.push(`Tokens: ${tokens}`);
	const elapsed = formatElapsed(delegation.elapsedMs);
	if (elapsed) parts.push(elapsed);
	const text = parts.length > 0 ? parts.join(" · ") : "";

	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(` ${text}`, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	]), { width });
}

function scribeBottom(width: number): string {
	const ruleLen = Math.max(0, width - 5); // "   └" + trailing spaces
	return lineToAnsi(textLine([
		span("   "),
		span("└", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("─".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("  "),
	]), { width });
}

export function renderScrollBlock(delegation: DelegationViewModel, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const rows: string[] = [
		scrollHeader(delegation, safeWidth),
		lineToAnsi(textLine([" "]), { width: safeWidth }), // blank after header
		scribeHeader(delegation, safeWidth),
	];

	for (const tool of delegation.nestedTools ?? []) {
		rows.push(nestedToolRow(tool, safeWidth));
	}

	rows.push(scribeBlankRow(safeWidth));

	if (delegation.tokensIn !== undefined || delegation.elapsedMs !== undefined) {
		rows.push(scribeMetadataRow(delegation, safeWidth));
	}

	rows.push(scribeBottom(safeWidth));
	return rows;
}
