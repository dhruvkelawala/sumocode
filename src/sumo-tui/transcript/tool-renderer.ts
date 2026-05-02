import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { lineToAnsi, span, textLine, type Span } from "../render/primitives.js";
import type { ToolCallViewModel, ToolStatus } from "./view-model.js";

const STATUS_GLYPH: Record<ToolStatus, string> = {
	pending: "○",
	running: "▶",
	success: "✓",
	error: "✗",
	cancelled: "✗",
};

const STATUS_COLOR: Record<ToolStatus, string> = {
	pending: CATHEDRAL_TOKENS.colors.foregroundDim,
	running: CATHEDRAL_TOKENS.colors.states.tool,
	success: CATHEDRAL_TOKENS.colors.states.idle,
	error: CATHEDRAL_TOKENS.colors.states.approval,
	cancelled: CATHEDRAL_TOKENS.colors.foregroundDim,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function terminalSafeText(value: string): string {
	// Raw tabs are measured differently by terminals/Pi's final line guard than
	// by our cell renderer, which can make an apparently padded tool row overflow
	// in retained TUI. Expand them before any width accounting.
	return value.replaceAll("\t", "    ");
}

export function toolStatusGlyph(status: ToolStatus): string {
	return STATUS_GLYPH[status] ?? "○";
}

export function toolStatusColor(status: ToolStatus): string {
	return STATUS_COLOR[status] ?? CATHEDRAL_TOKENS.colors.foregroundDim;
}

export function toolTarget(tool: ToolCallViewModel): string {
	const input = asRecord(tool.input);
	const details = asRecord(tool.details);
	const target = firstString(
		input?.path,
		input?.filePath,
		input?.target,
		input?.command,
		details?.path,
		details?.filePath,
		details?.target,
		details?.command,
	);
	if (target) return compactWhitespace(target);

	const outputLine = firstString(tool.output?.split("\n")[0], tool.error?.split("\n")[0]);
	if (outputLine) return compactWhitespace(outputLine.split(" · ")[0] ?? outputLine);
	return tool.name;
}

export function toolNote(tool: ToolCallViewModel): string | undefined {
	const details = asRecord(tool.details);
	const explicit = firstString(details?.summary, details?.note, details?.description, details?.lineCount ? `${details.lineCount} lines` : undefined);
	if (explicit) return compactWhitespace(explicit);

	const outputLine = firstString(tool.output?.split("\n")[0], tool.error?.split("\n")[0]);
	if (!outputLine) return undefined;
	const note = outputLine.split(" · ").slice(1).join(" · ");
	if (note.trim().length > 0) return compactWhitespace(note);
	if (tool.status === "error" || tool.name === "edit" || tool.name === "write") return compactWhitespace(outputLine);
	return undefined;
}

function styledToolHeaderParts(tool: ToolCallViewModel): Span[] {
	return [
		span(toolStatusGlyph(tool.status), { fg: toolStatusColor(tool.status) }),
		span(" "),
		span(`[${tool.name}]`, { fg: CATHEDRAL_TOKENS.colors.accent }),
		span("  "),
		span(toolTarget(tool), { fg: CATHEDRAL_TOKENS.colors.foreground }),
	];
}

function compactHint(tool: ToolCallViewModel): string {
	if (tool.status === "error") return "⌘O error";
	if (tool.name === "edit") return "⌘O diff";
	if (tool.name === "bash") return "⌘O output";
	return "⌘O expand";
}

export function renderCompactToolPill(tool: ToolCallViewModel): string {
	const note = toolNote(tool);
	return lineToAnsi(textLine([
		...styledToolHeaderParts(tool),
		...(note ? [span("  · ", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }), span(note, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })] : []),
		span("  · ", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
		span(compactHint(tool), { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	]));
}

function padAnsi(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible > width) return truncateToWidth(line, width, "");
	return `${line}${" ".repeat(width - visible)}`;
}

/** Header note: only explicit summary from details (bash summary etc). */
function headerNote(tool: ToolCallViewModel): string | undefined {
	const details = asRecord(tool.details);
	return firstString(details?.summary, details?.note);
}

function renderHeader(tool: ToolCallViewModel, width: number): string {
	const note = headerNote(tool);
	const target = toolTarget(tool);
	const right: Span[] = [
		span(" "),
		span(toolStatusGlyph(tool.status), { fg: toolStatusColor(tool.status) }),
		...(note ? [span(" "), span(note, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })] : []),
		span(" "),
	];
	const left: Span[] = [
		span("╭─ ", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(`[${tool.name}]`, { fg: CATHEDRAL_TOKENS.colors.accent }),
		span("  "),
		span(target, { fg: CATHEDRAL_TOKENS.colors.foreground }),
		span(" "),
	];
	const used = [...left, ...right].reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const rule = Math.max(1, width - used);
	return lineToAnsi(textLine([...left, span("─".repeat(rule), { fg: CATHEDRAL_TOKENS.colors.divider }), ...right]), { width });
}

function renderBodyLine(parts: readonly (Span | string)[], width: number): string {
	return lineToAnsi(textLine([
		span("│", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span(" "),
		...parts.map((part) => typeof part === "string" ? span(part, { fg: CATHEDRAL_TOKENS.colors.foreground }) : part),
	]), { width });
}

function renderBottom(width: number): string {
	return lineToAnsi(textLine([
		span("╰", { fg: CATHEDRAL_TOKENS.colors.divider }),
		span("─".repeat(Math.max(0, width - 1)), { fg: CATHEDRAL_TOKENS.colors.divider }),
	]), { width });
}

function outputLines(tool: ToolCallViewModel): string[] {
	const text = tool.status === "error" ? tool.error ?? tool.output ?? "" : tool.output ?? "";
	return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function arrayFromDetails(details: Record<string, unknown> | undefined, key: string): string[] {
	const value = details?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function collapsedMarker(details: Record<string, unknown> | undefined, fallback = 0): string | undefined {
	const count = typeof details?.collapsedLines === "number" ? details.collapsedLines : fallback;
	return count > 0 ? `… ${count} lines collapsed` : undefined;
}

function renderGutterLine(lineNumber: number | undefined, text: string, width: number, style: string = CATHEDRAL_TOKENS.colors.foreground): string {
	const gutter = lineNumber === undefined ? "      " : `${String(lineNumber).padStart(4)}  `;
	return renderBodyLine([
		span(gutter, { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
		span(text, { fg: style }),
	], width);
}

function renderReadLikeBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const excerpt = (arrayFromDetails(details, "excerpt").length > 0 ? arrayFromDetails(details, "excerpt") : outputLines(tool).slice(0, 5)).map(terminalSafeText);
	const startLine = typeof details?.startLine === "number" ? details.startLine : 1;
	const rows = excerpt.slice(0, 5).map((line, index) => renderGutterLine(startLine + index, line, width));
	const collapsed = collapsedMarker(details, typeof details?.totalLines === "number" ? Math.max(0, details.totalLines - excerpt.length) : 0);
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }), span(collapsed, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width));
	if (rows.length === 0) rows.push(renderBodyLine([span("preview collapsed", { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width));
	return rows;
}

function renderEditSummary(text: string, width: number): string[] {
	const additions = text.match(/\+(\d+)/)?.[0];
	const removals = text.match(/-(\d+)/)?.[0];
	const rest = text.replace(/\+\d+|-\d+/g, "").trim();
	return [renderBodyLine([
		...(additions ? [span(additions, { fg: CATHEDRAL_TOKENS.colors.states.idle }), span(" ")] : []),
		...(removals ? [span(removals, { fg: CATHEDRAL_TOKENS.colors.states.approval }), span(" ")] : []),
		span(rest || "diff collapsed", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }),
	], width)];
}

function renderEditBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const diffLines = arrayFromDetails(details, "diff").map(terminalSafeText);

	// No explicit diff array → render summary from output/note
	if (diffLines.length === 0) {
		const note = toolNote(tool) ?? "diff collapsed";
		return renderEditSummary(note, width);
	}

	// Render actual diff lines with gutter
	const startLine = typeof details?.startLine === "number" ? details.startLine : 1;
	const rows = diffLines.slice(0, 6).map((line, index) => {
		const color = line.trimStart().startsWith("+") ? CATHEDRAL_TOKENS.colors.states.idle
			: line.trimStart().startsWith("-") ? CATHEDRAL_TOKENS.colors.states.approval
			: CATHEDRAL_TOKENS.colors.foreground;
		return renderGutterLine(startLine + index, line, width, color);
	});
	const collapsed = collapsedMarker(details, Math.max(0, diffLines.length - rows.length));
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: CATHEDRAL_TOKENS.colors.foregroundDim }), span(collapsed, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width));
	return rows;
}

function renderBashLine(line: string): (Span | string)[] {
	const trimmed = line.trimStart();
	const indent = line.slice(0, line.length - trimmed.length);
	// Lines starting with ✓ or ✗: color only the glyph, rest stays foreground
	if (trimmed.startsWith("✓")) {
		return [span(`${indent}✓`, { fg: CATHEDRAL_TOKENS.colors.states.idle }), span(trimmed.slice(1))];
	}
	if (trimmed.startsWith("✗")) {
		return [span(`${indent}✗`, { fg: CATHEDRAL_TOKENS.colors.states.approval }), span(trimmed.slice(1))];
	}
	// Summary / result lines (no leading > or glyph): dim
	if (!trimmed.startsWith(">")) {
		return [span(line, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })];
	}
	return [line];
}

function renderBashBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const target = toolTarget(tool);
	const lines = outputLines(tool).slice(0, 5).map(terminalSafeText);
	const body = [renderBodyLine([`> ${target}`], width)];
	const collapsed = collapsedMarker(details, Math.max(0, outputLines(tool).length - lines.length));
	if (collapsed) body.push(renderBodyLine([span(`  ${collapsed}`, { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width));
	for (const line of lines) {
		body.push(renderBodyLine(renderBashLine(line), width));
	}
	if (lines.length === 0 && tool.status === "running") body.push(renderBodyLine([span("watching stdout…", { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width));
	return body;
}

function renderToolBody(tool: ToolCallViewModel, width: number): string[] {
	if (tool.name === "edit") return renderEditBody(tool, width);
	if (tool.name === "read" || tool.name === "write") return renderReadLikeBody(tool, width);
	if (tool.name === "bash") return renderBashBody(tool, width);
	return [renderBodyLine([span("preview collapsed", { fg: CATHEDRAL_TOKENS.colors.foregroundDim })], width)];
}

export function renderToolLedgerRows(tool: ToolCallViewModel, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 20) return [padAnsi(renderCompactToolPill(tool), safeWidth)];
	return [
		renderHeader(tool, safeWidth),
		...renderToolBody(tool, safeWidth),
		renderBottom(safeWidth),
	];
}

export function renderToolBlockRows(tool: ToolCallViewModel, width: number): string[] {
	return tool.expanded === false ? [padAnsi(renderCompactToolPill(tool), Math.max(1, Math.floor(width)))] : renderToolLedgerRows(tool, width);
}
