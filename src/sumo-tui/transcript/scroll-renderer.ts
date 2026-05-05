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
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

const SCRIBE_BODY_MAX_LINES = 25;

function singleLinePreview(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function toolTarget(tool: ToolCallViewModel): string {
	const input = typeof tool.input === "object" && tool.input !== null ? tool.input as Record<string, unknown> : {};
	const target = typeof input.path === "string" ? input.path
		: typeof input.command === "string" ? input.command
		: typeof tool.output === "string" ? tool.output
		: "";
	return singleLinePreview(target);
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

function scrollPromptRow(text: string, width: number): string {
	const contentWidth = Math.max(1, width - 6);
	const clipped = visibleWidth(text) > contentWidth ? truncateToWidth(text, contentWidth, "") : text;
	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" "),
		span(clipped, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	]), { width });
}

function scrollPromptRows(prompt: string | undefined, width: number): string[] {
	if (!prompt || prompt.trim().length === 0) return [];
	const lines = prompt
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, 6);
	if (lines.length === 0) return [];

	const label = "task";
	const left: Span[] = [
		span("   "),
		span("┌ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(label, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
		span(" ", { fg: CATHEDRAL_TOKENS.colors.divider }),
	];
	const leftWidth = left.reduce((w, s) => w + visibleWidth(s.text), 0);
	const ruleLen = Math.max(0, width - leftWidth - 2);
	return [
		lineToAnsi(textLine([...left, span("─".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }), span("  ")]), { width }),
		...lines.map((line) => scrollPromptRow(line, width)),
		lineToAnsi(textLine([
			span("   "),
			span("└", { fg: CATHEDRAL_TOKENS.colors.divider }),
			span("─".repeat(Math.max(0, width - 6)), { fg: CATHEDRAL_TOKENS.colors.divider }),
			span("  "),
		]), { width }),
	];
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
	// Match bottom border alignment: indent(3) + └(1) + dashes + trailing(2)
	// Header rule ends at the same column as the bottom rule.
	const bottomRuleEnd = width - 2;  // bottom: 3+1+dashes+2 → last dash at width-3
	const ruleLen = Math.max(0, bottomRuleEnd - leftWidth);
	const trailing = Math.max(0, width - leftWidth - ruleLen);

	return lineToAnsi(textLine([
		...left,
		span("─".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" ".repeat(trailing)),
	]), { width });
}

function nestedToolRow(tool: ToolCallViewModel, width: number): string {
	const glyph = TOOL_STATUS_GLYPH[tool.status] ?? "○";
	const color = TOOL_STATUS_COLOR[tool.status] ?? CATHEDRAL_TOKENS.colors.foregroundDim;
	const target = toolTarget(tool);
	const prefixWidth = visibleWidth(`   │ ${glyph} [${tool.name}]  `);
	const contentWidth = Math.max(1, width - prefixWidth);
	const clipped = visibleWidth(target) > contentWidth ? truncateToWidth(target, contentWidth, "") : target;

	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" "),
		span(glyph, { fg: color }),
		span(" "),
		span(`[${tool.name}]`, { fg: CATHEDRAL_TOKENS.colors.accent }),
		span("  "),
		span(clipped, { fg: CATHEDRAL_TOKENS.colors.foreground }),
	]), { width });
}

function scribeBlankRow(width: number): string {
	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

function scribeTextRow(text: string, width: number): string {
	const contentWidth = Math.max(1, width - 6); // indent(3) + │ + spaces around content
	const clipped = visibleWidth(text) > contentWidth ? truncateToWidth(text, contentWidth, "") : text;
	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" "),
		span(clipped, { fg: CATHEDRAL_TOKENS.colors.foreground }),
	]), { width });
}

function scribeCollapsedRow(remaining: number, width: number): string {
	return lineToAnsi(textLine([
		span("   "),
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(` … ${remaining} lines collapsed`, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	]), { width });
}

function scribeSummaryRows(summary: string | undefined, width: number): string[] {
	if (!summary || summary.trim().length === 0) return [];
	const lines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const visible = lines.slice(0, SCRIBE_BODY_MAX_LINES);
	const rows = visible.map((line) => scribeTextRow(line, width));
	const collapsed = lines.length - visible.length;
	if (collapsed > 0) rows.push(scribeCollapsedRow(collapsed, width));
	return rows;
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
	const ruleLen = Math.max(0, width - 6); // 3(indent) + 1(└) + dashes + 2(trailing)
	return lineToAnsi(textLine([
		span("   "),
		span("└", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("─".repeat(ruleLen), { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("  "),
	]), { width });
}

export function renderScrollBlock(delegation: DelegationViewModel, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const promptRows = scrollPromptRows(delegation.prompt, safeWidth);
	const rows: string[] = [
		scrollHeader(delegation, safeWidth),
	];
	if (promptRows.length > 0) {
		rows.push(lineToAnsi(textLine([" "]), { width: safeWidth }));
		rows.push(...promptRows);
	}
	rows.push(lineToAnsi(textLine([" "]), { width: safeWidth }));
	rows.push(scribeHeader(delegation, safeWidth));

	for (const tool of delegation.nestedTools ?? []) {
		rows.push(nestedToolRow(tool, safeWidth));
	}

	const summaryRows = scribeSummaryRows(delegation.summary, safeWidth);
	if (summaryRows.length > 0) rows.push(...summaryRows);
	else rows.push(scribeBlankRow(safeWidth));

	if (delegation.tokensIn !== undefined || delegation.elapsedMs !== undefined) {
		rows.push(scribeMetadataRow(delegation, safeWidth));
	}

	rows.push(scribeBottom(safeWidth));
	return rows;
}
