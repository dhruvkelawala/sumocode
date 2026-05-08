import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { lineToAnsi, span, textLine, type Span } from "../render/primitives.js";
import type { ToolCallViewModel, ToolStatus } from "./view-model.js";

const STATUS_GLYPH: Record<ToolStatus, string> = {
	pending: "○",
	running: "▶",
	success: "✓",
	error: "✗",
	cancelled: "✗",
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
	const colors = activeThemeColors();
	const statusColor: Record<ToolStatus, string> = {
		pending: colors.foregroundDim,
		running: colors.states.tool,
		success: colors.states.idle,
		error: colors.states.approval,
		cancelled: colors.foregroundDim,
	};
	return statusColor[status] ?? colors.foregroundDim;
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
		span(`[${tool.name}]`, { fg: activeThemeColors().accent }),
		span("  "),
		span(toolTarget(tool), { fg: activeThemeColors().foreground }),
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
		...(note ? [span("  · ", { fg: activeThemeColors().foregroundDim }), span(note, { fg: activeThemeColors().foregroundDim })] : []),
		span("  · ", { fg: activeThemeColors().foregroundDim }),
		span(compactHint(tool), { fg: activeThemeColors().foregroundDim }),
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

/** Maximum body lines shown in an expanded tool ledger row before collapsing. */
const TOOL_BODY_MAX_LINES = 25;

function toolLedgerStyle(): { bg: string } {
	return { bg: activeThemeColors().surfaceRecess };
}

function renderHeader(tool: ToolCallViewModel, width: number): string {
	const note = headerNote(tool);
	const right: Span[] = [
		span(" "),
		span(toolStatusGlyph(tool.status), { fg: toolStatusColor(tool.status) }),
		...(note ? [span(" "), span(note, { fg: activeThemeColors().foregroundDim })] : []),
		span(" "),
	];
	const input = asRecord(tool.input);
	const rawFilePath = firstString(input?.path, input?.filePath);
	// Reserve space for right side (glyph + note) + minimum rule of 4 dashes
	const rightWidth = right.reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const baseLeftWidth = 3 + tool.name.length + 2 + 1; // "╭─ " + "[name]" + " "
	const maxPathWidth = Math.max(0, width - baseLeftWidth - rightWidth - 4 - 2); // 4 dashes min, 2 for "  " before path
	const filePath = rawFilePath && rawFilePath.length > maxPathWidth
		? (maxPathWidth > 3 ? `…${rawFilePath.slice(-(maxPathWidth - 1))}` : undefined)
		: rawFilePath;
	const left: Span[] = [
		span("╭─ ", { fg: activeThemeColors().divider }),
		span(`[${tool.name}]`, { fg: activeThemeColors().accent }),
		...(filePath ? [span("  "), span(filePath, { fg: activeThemeColors().foreground })] : []),
		span(" "),
	];
	const used = [...left, ...right].reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const rule = Math.max(1, width - used);
	return lineToAnsi(textLine([...left, span("─".repeat(rule), { fg: activeThemeColors().divider }), ...right]), { width, style: toolLedgerStyle() });
}

function renderBodyLine(parts: readonly (Span | string)[], width: number): string {
	return lineToAnsi(textLine([
		span("│", { fg: activeThemeColors().divider }),
		span(" "),
		...parts.map((part) => typeof part === "string" ? span(part, { fg: activeThemeColors().foreground }) : part),
	]), { width, style: toolLedgerStyle() });
}

function renderBottom(width: number): string {
	return lineToAnsi(textLine([
		span("╰", { fg: activeThemeColors().divider }),
		span("─".repeat(Math.max(0, width - 1)), { fg: activeThemeColors().divider }),
	]), { width, style: toolLedgerStyle() });
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

function renderGutterLine(lineNumber: number | undefined, text: string, width: number, style: string = activeThemeColors().foreground): string {
	const gutter = lineNumber === undefined ? "      " : `${String(lineNumber).padStart(4)}  `;
	return renderBodyLine([
		span(gutter, { fg: activeThemeColors().foregroundDim }),
		span(text, { fg: style }),
	], width);
}

function renderReadLikeBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const excerpt = (arrayFromDetails(details, "excerpt").length > 0 ? arrayFromDetails(details, "excerpt") : outputLines(tool).slice(0, TOOL_BODY_MAX_LINES)).map(terminalSafeText);
	const startLine = typeof details?.startLine === "number" ? details.startLine : 1;
	const rows = excerpt.slice(0, TOOL_BODY_MAX_LINES).map((line, index) => renderGutterLine(startLine + index, line, width));
	const collapsed = collapsedMarker(details, typeof details?.totalLines === "number" ? Math.max(0, details.totalLines - excerpt.length) : 0);
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: activeThemeColors().foregroundDim }), span(collapsed, { fg: activeThemeColors().foregroundDim })], width));
	if (rows.length === 0) rows.push(renderBodyLine([span("preview collapsed", { fg: activeThemeColors().foregroundDim })], width));
	return rows;
}

function renderEditSummary(text: string, width: number): string[] {
	const additions = text.match(/\+(\d+)/)?.[0];
	const removals = text.match(/-(\d+)/)?.[0];
	const rest = text.replace(/\+\d+|-\d+/g, "").trim();
	return [renderBodyLine([
		...(additions ? [span(additions, { fg: activeThemeColors().states.idle }), span(" ")] : []),
		...(removals ? [span(removals, { fg: activeThemeColors().states.approval }), span(" ")] : []),
		span(rest || "diff collapsed", { fg: activeThemeColors().foregroundDim }),
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
	const rows = diffLines.slice(0, TOOL_BODY_MAX_LINES).map((line, index) => {
		const color = line.trimStart().startsWith("+") ? activeThemeColors().states.idle
			: line.trimStart().startsWith("-") ? activeThemeColors().states.approval
			: activeThemeColors().foreground;
		return renderGutterLine(startLine + index, line, width, color);
	});
	const collapsed = collapsedMarker(details, Math.max(0, diffLines.length - rows.length));
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: activeThemeColors().foregroundDim }), span(collapsed, { fg: activeThemeColors().foregroundDim })], width));
	return rows;
}

function renderBashLine(line: string): (Span | string)[] {
	const trimmed = line.trimStart();
	const indent = line.slice(0, line.length - trimmed.length);
	// Lines starting with ✓ or ✗: color only the glyph, rest stays foreground
	if (trimmed.startsWith("✓")) {
		return [span(`${indent}✓`, { fg: activeThemeColors().states.idle }), span(trimmed.slice(1))];
	}
	if (trimmed.startsWith("✗")) {
		return [span(`${indent}✗`, { fg: activeThemeColors().states.approval }), span(trimmed.slice(1))];
	}
	// Summary / result lines (no leading > or glyph): dim
	if (!trimmed.startsWith(">")) {
		return [span(line, { fg: activeThemeColors().foregroundDim })];
	}
	return [line];
}

function renderBashBody(tool: ToolCallViewModel, width: number): string[] {
	const details = asRecord(tool.details);
	const target = toolTarget(tool);
	const lines = outputLines(tool).slice(0, TOOL_BODY_MAX_LINES).map(terminalSafeText);
	const body = [renderBodyLine([`> ${target}`], width)];
	const collapsed = collapsedMarker(details, Math.max(0, outputLines(tool).length - lines.length));
	if (collapsed) body.push(renderBodyLine([span(`  ${collapsed}`, { fg: activeThemeColors().foregroundDim })], width));
	for (const line of lines) {
		body.push(renderBodyLine(renderBashLine(line), width));
	}
	if (lines.length === 0 && tool.status === "running") body.push(renderBodyLine([span("watching stdout…", { fg: activeThemeColors().foregroundDim })], width));
	return body;
}

function renderToolBody(tool: ToolCallViewModel, width: number): string[] {
	if (tool.name === "edit") return renderEditBody(tool, width);
	if (tool.name === "read" || tool.name === "write") return renderReadLikeBody(tool, width);
	if (tool.name === "bash") return renderBashBody(tool, width);
	return [renderBodyLine([span("preview collapsed", { fg: activeThemeColors().foregroundDim })], width)];
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
