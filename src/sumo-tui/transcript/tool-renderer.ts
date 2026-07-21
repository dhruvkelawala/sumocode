import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeApplicationRoles, activeThemeColors, type ThemeApplicationRoles } from "../../themes/index.js";
import { lineToAnsi, lineWidth, span, textLine, truncateLine, wrapLine, type Span } from "../render/primitives.js";
import { expandKey } from "./expand-key.js";
import type { ToolCallViewModel, ToolStatus } from "./view-model.js";

const STATUS_GLYPH: Record<ToolStatus, string> = {
	pending: "○",
	running: "▶",
	success: "✓",
	error: "✗",
	cancelled: "✗",
};

type ToolLedgerRoles = ThemeApplicationRoles["toolLedger"];

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

function styledToolHeaderParts(tool: ToolCallViewModel, roles: ToolLedgerRoles): Span[] {
	return [
		span(toolStatusGlyph(tool.status), { fg: toolStatusColor(tool.status) }),
		span(" "),
		span(`[${tool.name}]`, { fg: roles.label }),
		span("  "),
		span(toolTarget(tool), { fg: roles.target }),
	];
}

function compactHint(tool: ToolCallViewModel): string {
	const key = expandKey();
	if (tool.status === "error") return `${key} error`;
	if (tool.name === "edit") return `${key} diff`;
	if (tool.name === "bash") return `${key} output`;
	return `${key} expand`;
}

export function renderCompactToolPill(tool: ToolCallViewModel): string {
	const roles = activeThemeApplicationRoles().toolLedger;
	const note = toolNote(tool);
	return lineToAnsi(textLine([
		...styledToolHeaderParts(tool, roles),
		...(note ? [span("  · ", { fg: roles.bodyMuted }), span(note, { fg: roles.bodyMuted })] : []),
		span("  · ", { fg: roles.bodyMuted }),
		span(compactHint(tool), { fg: roles.bodyMuted }),
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

/** Maximum source lines inspected and display rows shown in an expanded tool ledger. */
const TOOL_BODY_MAX_LINES = 25;
// Preserve the previous 25 output rows plus up to three wrapped command rows
// and one consolidated collapse marker.
const TOOL_BODY_MAX_ROWS = TOOL_BODY_MAX_LINES + 4;

function toolLedgerStyle(roles: ToolLedgerRoles): { bg: string } {
	return { bg: roles.surface };
}

function renderHeader(tool: ToolCallViewModel, width: number, roles: ToolLedgerRoles): string {
	const note = headerNote(tool);
	const right: Span[] = [
		span(" "),
		span(toolStatusGlyph(tool.status), { fg: toolStatusColor(tool.status) }),
		...(note ? [span(" "), span(note, { fg: roles.bodyMuted })] : []),
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
		span("╭─ ", { fg: roles.border }),
		span(`[${tool.name}]`, { fg: roles.label }),
		...(filePath ? [span("  "), span(filePath, { fg: roles.target })] : []),
		span(" "),
	];
	const used = [...left, ...right].reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const rule = Math.max(1, width - used);
	return lineToAnsi(textLine([...left, span("─".repeat(rule), { fg: roles.border }), ...right]), { width, style: toolLedgerStyle(roles) });
}

function bodySpan(part: Span | string, roles: ToolLedgerRoles): Span {
	if (typeof part === "string") return span(part, { fg: roles.body });
	if (part.style?.fg) return part;
	return span(part.text, { ...part.style, fg: roles.body });
}

function renderBodyLine(parts: readonly (Span | string)[], width: number, roles: ToolLedgerRoles): string {
	return lineToAnsi(textLine([
		span("│", { fg: roles.border }),
		span(" "),
		...parts.map((part) => bodySpan(part, roles)),
	]), { width, style: toolLedgerStyle(roles) });
}

function renderBodyLines(
	parts: readonly (Span | string)[],
	width: number,
	roles: ToolLedgerRoles,
	maxRows: number,
): { rows: string[]; truncated: boolean } {
	if (maxRows <= 0) return { rows: [], truncated: true };
	const continuationPrefix = "↳ ";
	const firstRowWidth = Math.max(1, width - 2);
	const continuationWidth = Math.max(1, firstRowWidth - visibleWidth(continuationPrefix));
	const content = textLine(parts.map((part) => bodySpan(part, roles)));
	if (maxRows === 1) {
		return {
			rows: [renderBodyLine(truncateLine(content, firstRowWidth).spans, width, roles)],
			truncated: lineWidth(content) > firstRowWidth,
		};
	}
	const cellBudget = firstRowWidth + continuationWidth * Math.max(0, maxRows - 1);
	const sourceTruncated = lineWidth(content) > cellBudget;
	const bounded = sourceTruncated ? truncateLine(content, cellBudget) : content;
	const wrapped = wrapLine(bounded, firstRowWidth, { continuationWidth });
	const renderable = wrapped.filter((line) => lineWidth(line) > 0);
	return {
		rows: renderable.slice(0, maxRows).map((line, index) => renderBodyLine([
			...(index > 0 ? [span(continuationPrefix, { fg: roles.bodyMuted })] : []),
			...line.spans,
		], width, roles)),
		truncated: sourceTruncated || renderable.length > maxRows,
	};
}

function renderBottom(width: number, roles: ToolLedgerRoles): string {
	return lineToAnsi(textLine([
		span("╰", { fg: roles.border }),
		span("─".repeat(Math.max(0, width - 1)), { fg: roles.border }),
	]), { width, style: toolLedgerStyle(roles) });
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

function renderGutterLine(lineNumber: number | undefined, text: string, width: number, roles: ToolLedgerRoles, style: string = roles.body): string {
	const gutter = lineNumber === undefined ? "      " : `${String(lineNumber).padStart(4)}  `;
	return renderBodyLine([
		span(gutter, { fg: roles.bodyMuted }),
		span(text, { fg: style }),
	], width, roles);
}

function renderReadLikeBody(tool: ToolCallViewModel, width: number, roles: ToolLedgerRoles): string[] {
	const details = asRecord(tool.details);
	const excerpt = (arrayFromDetails(details, "excerpt").length > 0 ? arrayFromDetails(details, "excerpt") : outputLines(tool).slice(0, TOOL_BODY_MAX_LINES)).map(terminalSafeText);
	const startLine = typeof details?.startLine === "number" ? details.startLine : 1;
	const rows = excerpt.slice(0, TOOL_BODY_MAX_LINES).map((line, index) => renderGutterLine(startLine + index, line, width, roles));
	const collapsed = collapsedMarker(details, typeof details?.totalLines === "number" ? Math.max(0, details.totalLines - excerpt.length) : 0);
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: roles.bodyMuted }), span(collapsed, { fg: roles.bodyMuted })], width, roles));
	if (rows.length === 0) rows.push(renderBodyLine([span("preview collapsed", { fg: roles.bodyMuted })], width, roles));
	return rows;
}

function renderEditSummary(text: string, width: number, roles: ToolLedgerRoles): string[] {
	const additions = text.match(/\+(\d+)/)?.[0];
	const removals = text.match(/-(\d+)/)?.[0];
	const rest = text.replace(/\+\d+|-\d+/g, "").trim();
	return [renderBodyLine([
		...(additions ? [span(additions, { fg: activeThemeColors().states.idle }), span(" ")] : []),
		...(removals ? [span(removals, { fg: activeThemeColors().states.approval }), span(" ")] : []),
		span(rest || "diff collapsed", { fg: roles.bodyMuted }),
	], width, roles)];
}

function renderEditBody(tool: ToolCallViewModel, width: number, roles: ToolLedgerRoles): string[] {
	const details = asRecord(tool.details);
	const rawDiff = details?.diff;
	const diffLines = (typeof rawDiff === "string"
		? rawDiff.split("\n")
		: arrayFromDetails(details, "diff")
	).map(terminalSafeText);

	if (diffLines.length === 0) {
		const note = toolNote(tool) ?? "diff collapsed";
		return renderEditSummary(note, width, roles);
	}

	const rows = diffLines.slice(0, TOOL_BODY_MAX_LINES).map((line) => {
		const head = line.trimStart();
		const color = head.startsWith("+") ? activeThemeColors().states.idle
			: head.startsWith("-") ? activeThemeColors().states.approval
			: roles.bodyMuted;
		return renderBodyLine([span(line, { fg: color })], width, roles);
	});
	const adds = diffLines.filter((line) => line.trimStart().startsWith("+")).length;
	const removes = diffLines.filter((line) => line.trimStart().startsWith("-")).length;
	const summary = renderBodyLine([
		span(`+${adds}`, { fg: activeThemeColors().states.idle }),
		span(" "),
		span(`-${removes}`, { fg: activeThemeColors().states.approval }),
	], width, roles);
	const collapsed = collapsedMarker(details, Math.max(0, diffLines.length - rows.length));
	if (collapsed) rows.push(renderBodyLine([span("      ", { fg: roles.bodyMuted }), span(collapsed, { fg: roles.bodyMuted })], width, roles));
	return [summary, ...rows];
}

function renderBashLine(line: string, roles: ToolLedgerRoles): (Span | string)[] {
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
		return [span(line, { fg: roles.bodyMuted })];
	}
	return [line];
}

function renderBashBody(tool: ToolCallViewModel, width: number, roles: ToolLedgerRoles): string[] {
	const details = asRecord(tool.details);
	const target = toolTarget(tool);
	const allLines = outputLines(tool);
	const lines = allLines.slice(0, TOOL_BODY_MAX_LINES).map(terminalSafeText);
	const body: string[] = [];
	const collapseReasons: string[] = [];
	let displayRowsCollapsed = false;

	const command = renderBodyLines([`> ${target}`], width, roles, 3);
	body.push(...command.rows);
	if (command.truncated) collapseReasons.push("command rows collapsed");
	const collapsed = collapsedMarker(details, Math.max(0, allLines.length - lines.length));
	if (collapsed) collapseReasons.push(collapsed.replace(/^…\s*/, ""));
	for (let index = 0; index < lines.length; index += 1) {
		const availableRows = Math.max(0, TOOL_BODY_MAX_ROWS - body.length - 1);
		if (availableRows === 0) {
			displayRowsCollapsed = true;
			break;
		}
		const remainingLines = lines.length - index - 1;
		const reservedRows = Math.min(remainingLines, Math.max(0, availableRows - 1));
		const rowsForLine = Math.max(1, availableRows - reservedRows);
		const rendered = renderBodyLines(renderBashLine(lines[index]!, roles), width, roles, rowsForLine);
		body.push(...rendered.rows);
		displayRowsCollapsed ||= rendered.truncated;
	}
	if (lines.length === 0 && tool.status === "running" && body.length < TOOL_BODY_MAX_ROWS) {
		body.push(renderBodyLine([span("watching stdout…", { fg: roles.bodyMuted })], width, roles));
	}
	if (displayRowsCollapsed) collapseReasons.push("display rows collapsed");
	if (collapseReasons.length > 0) {
		const detailedMarker = `… ${collapseReasons.join(" · ")}`;
		const marker = visibleWidth(detailedMarker) <= Math.max(1, width - 2) ? detailedMarker : "… content collapsed";
		body.push(renderBodyLine([span(marker, { fg: roles.bodyMuted })], width, roles));
	}
	return body;
}

function renderToolBody(tool: ToolCallViewModel, width: number, roles: ToolLedgerRoles): string[] {
	if (tool.name === "edit") return renderEditBody(tool, width, roles);
	if (tool.name === "read" || tool.name === "write") return renderReadLikeBody(tool, width, roles);
	if (tool.name === "bash") return renderBashBody(tool, width, roles);
	return [renderBodyLine([span("preview collapsed", { fg: roles.bodyMuted })], width, roles)];
}

export function renderToolLedgerRows(tool: ToolCallViewModel, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 20) return [padAnsi(renderCompactToolPill(tool), safeWidth)];
	const roles = activeThemeApplicationRoles().toolLedger;
	return [
		renderHeader(tool, safeWidth, roles),
		...renderToolBody(tool, safeWidth, roles),
		renderBottom(safeWidth, roles),
	];
}

export function renderToolBlockRows(tool: ToolCallViewModel, width: number): string[] {
	return tool.expanded === false ? [padAnsi(renderCompactToolPill(tool), Math.max(1, Math.floor(width)))] : renderToolLedgerRows(tool, width);
}
