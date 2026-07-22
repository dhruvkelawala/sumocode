import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	isSettledActivityStatus,
	safeValuePreview,
	sanitizeActivityText,
	type ActivitySnapshot,
	type ActivityStatus,
} from "../../activity/domain.js";
import { activeThemeApplicationRoles, activeThemeColors, type ThemeApplicationRoles } from "../../themes/index.js";
import { lineToAnsi, lineWidth, span, textLine, truncateLine, wrapLine, type Span } from "../render/primitives.js";
import { expandKey } from "./expand-key.js";

const STATUS_GLYPH: Record<ActivityStatus, string> = {
	queued: "○",
	running: "▶",
	succeeded: "✓",
	failed: "✗",
	cancelled: "✗",
	lost: "✗",
};

const BODY_MAX_SOURCE_LINES = 25;
const BODY_MAX_ROWS = 29;
const INVOCATION_MAX_ROWS = 4;
const FALLBACK_RUNNING = "waiting for output…";
const FALLBACK_SETTLED = "no output captured";

type ActivityLedgerRoles = ThemeApplicationRoles["toolLedger"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function compactWhitespace(value: string): string {
	return sanitizeActivityText(value).replace(/\s+/g, " ").trim();
}

function activityTitle(activity: ActivitySnapshot): string {
	return compactWhitespace(activity.title) || "activity";
}

function firstLine(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const line = sanitizeActivityText(value).split("\n").find((candidate) => candidate.trim().length > 0);
	return line ? compactWhitespace(line) : undefined;
}

export function activityStatusGlyph(status: ActivityStatus): string {
	return STATUS_GLYPH[status];
}

export function activityStatusColor(status: ActivityStatus): string {
	const colors = activeThemeColors();
	const colorsByStatus: Record<ActivityStatus, string> = {
		queued: colors.foregroundDim,
		running: colors.states.tool,
		succeeded: colors.states.idle,
		failed: colors.states.approval,
		cancelled: colors.foregroundDim,
		lost: colors.states.approval,
	};
	return colorsByStatus[status];
}

export function activityTarget(activity: ActivitySnapshot): string {
	if (activity.subject) return compactWhitespace(activity.subject);
	const invocation = asRecord(activity.invocation);
	for (const value of [invocation?.path, invocation?.filePath, invocation?.target, invocation?.command]) {
		if (typeof value === "string" && compactWhitespace(value).length > 0) return compactWhitespace(value);
	}
	if (activity.body?.kind === "terminal" && activity.body.command) return compactWhitespace(activity.body.command);
	return firstLine(activity.result?.error ?? activity.result?.summary ?? activity.outputTail ?? activity.body?.text) ?? activityTitle(activity);
}

export function activityNote(activity: ActivitySnapshot): string | undefined {
	const explicit = firstLine(activity.result?.error ?? activity.result?.summary ?? activity.currentStep);
	if (explicit) return explicit;
	if (activity.body?.kind === "source" && activity.body.totalLines !== undefined) return `${activity.body.totalLines} lines`;
	const output = firstLine(activity.outputTail ?? activity.body?.text);
	if (!output) return undefined;
	const note = output.split(" · ").slice(1).join(" · ").trim();
	if (note.length > 0) return note;
	if (activity.body?.kind === "text" || activity.body?.kind === "terminal") return output;
	if (activity.status === "failed" || activity.title === "edit" || activity.title === "write") return output;
	return undefined;
}

function styledHeaderParts(activity: ActivitySnapshot, roles: ActivityLedgerRoles): Span[] {
	return [
		span(activityStatusGlyph(activity.status), { fg: activityStatusColor(activity.status) }),
		span(" "),
		span(`[${activityTitle(activity)}]`, { fg: roles.label }),
		span("  "),
		span(activityTarget(activity), { fg: roles.target }),
	];
}

function compactHint(activity: ActivitySnapshot): string {
	const key = expandKey();
	if (activity.status === "failed") return `${key} error`;
	if (activity.body?.kind === "diff") return `${key} diff`;
	if (activity.body?.kind === "terminal") return `${key} output`;
	return `${key} expand`;
}

export function renderCompactActivityPill(activity: ActivitySnapshot): string {
	const roles = activeThemeApplicationRoles().toolLedger;
	const target = activityTarget(activity);
	const noteValue = activityNote(activity);
	const note = noteValue === target ? undefined : noteValue;
	return lineToAnsi(textLine([
		...styledHeaderParts(activity, roles),
		...(note ? [span("  · ", { fg: roles.bodyMuted }), span(note, { fg: roles.bodyMuted })] : []),
		span("  · ", { fg: roles.bodyMuted }),
		span(compactHint(activity), { fg: roles.bodyMuted }),
	]));
}

function padAnsi(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible > width) return truncateToWidth(line, width, "");
	return `${line}${" ".repeat(width - visible)}`;
}

function ledgerStyle(roles: ActivityLedgerRoles): { bg: string } {
	return { bg: roles.surface };
}

function renderHeader(activity: ActivitySnapshot, width: number, roles: ActivityLedgerRoles): string {
	const title = activityTitle(activity);
	const note = firstLine(activity.result?.error ?? activity.result?.summary ?? activity.currentStep);
	const right: Span[] = [
		span(" "),
		span(activityStatusGlyph(activity.status), { fg: activityStatusColor(activity.status) }),
		...(note ? [span(" "), span(note, { fg: roles.bodyMuted })] : []),
		span(" "),
	];
	const rawSubject = activity.subject ?? (activity.body?.kind === "terminal" ? activity.body.command : undefined);
	const rightWidth = right.reduce((sum, part) => sum + visibleWidth(part.text), 0);
	const baseLeftWidth = 3 + visibleWidth(title) + 2 + 1;
	const maxSubjectWidth = Math.max(0, width - baseLeftWidth - rightWidth - 4 - 2);
	const sanitizedSubject = rawSubject ? compactWhitespace(rawSubject) : undefined;
	const subject = sanitizedSubject && visibleWidth(sanitizedSubject) > maxSubjectWidth
		? (maxSubjectWidth > 3 ? `…${truncateToWidth(sanitizedSubject, maxSubjectWidth - 1, "", true)}` : undefined)
		: sanitizedSubject;
	const left: Span[] = [
		span("╭─ ", { fg: roles.border }),
		span(`[${title}]`, { fg: roles.label }),
		...(subject ? [span("  "), span(subject, { fg: roles.target })] : []),
		span(" "),
	];
	const used = [...left, ...right].reduce((sum, part) => sum + visibleWidth(part.text), 0);
	return lineToAnsi(textLine([
		...left,
		span("─".repeat(Math.max(1, width - used)), { fg: roles.border }),
		...right,
	]), { width, style: ledgerStyle(roles) });
}

function bodySpan(part: Span | string, roles: ActivityLedgerRoles): Span {
	if (typeof part === "string") return span(part, { fg: roles.body });
	return part.style?.fg ? part : span(part.text, { ...part.style, fg: roles.body });
}

function renderBodyLine(parts: readonly (Span | string)[], width: number, roles: ActivityLedgerRoles): string {
	return lineToAnsi(textLine([
		span("│", { fg: roles.border }),
		span(" "),
		...parts.map((part) => bodySpan(part, roles)),
	]), { width, style: ledgerStyle(roles) });
}

function renderBodyLines(
	parts: readonly (Span | string)[],
	width: number,
	roles: ActivityLedgerRoles,
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
	const cellBudget = firstRowWidth + continuationWidth * (maxRows - 1);
	const sourceTruncated = lineWidth(content) > cellBudget;
	const bounded = sourceTruncated ? truncateLine(content, cellBudget) : content;
	const wrapped = wrapLine(bounded, firstRowWidth, { continuationWidth }).filter((line) => lineWidth(line) > 0);
	return {
		rows: wrapped.slice(0, maxRows).map((line, index) => renderBodyLine([
			...(index > 0 ? [span(continuationPrefix, { fg: roles.bodyMuted })] : []),
			...line.spans,
		], width, roles)),
		truncated: sourceTruncated || wrapped.length > maxRows,
	};
}

function renderBottom(width: number, roles: ActivityLedgerRoles): string {
	return lineToAnsi(textLine([
		span("╰", { fg: roles.border }),
		span("─".repeat(Math.max(0, width - 1)), { fg: roles.border }),
	]), { width, style: ledgerStyle(roles) });
}

function contentLines(text: string): string[] {
	return sanitizeActivityText(text).split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function sourceContentLines(text: string): string[] {
	const lines = sanitizeActivityText(text).split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines;
}

function emptyText(activity: ActivitySnapshot): string {
	return isSettledActivityStatus(activity.status) ? FALLBACK_SETTLED : FALLBACK_RUNNING;
}

function collapseMarker(reasons: readonly string[], width: number): string | undefined {
	if (reasons.length === 0) return undefined;
	const detailed = `… ${reasons.join(" · ")}`;
	return visibleWidth(detailed) <= Math.max(1, width - 2) ? detailed : "… content collapsed";
}

function renderSourceBody(activity: ActivitySnapshot, width: number, roles: ActivityLedgerRoles): string[] {
	if (activity.body?.kind !== "source") return [];
	const lines = sourceContentLines(activity.body.text);
	if (lines.length === 0) return [renderBodyLine([span(emptyText(activity), { fg: roles.bodyMuted })], width, roles)];
	const visible = lines.slice(0, BODY_MAX_SOURCE_LINES);
	const startLine = activity.body.startLine ?? 1;
	const rows = visible.map((line, index) => renderBodyLine([
		span(`${String(startLine + index).padStart(4)}  `, { fg: roles.bodyMuted }),
		span(line, { fg: roles.body }),
	], width, roles));
	const remainingFromStart = activity.body.totalLines === undefined
		? 0
		: Math.max(0, activity.body.totalLines - startLine + 1);
	const hidden = Math.max(lines.length, remainingFromStart) - visible.length;
	if (hidden > 0) rows.push(renderBodyLine([
		span("      ", { fg: roles.bodyMuted }),
		span(`… ${hidden} lines collapsed`, { fg: roles.bodyMuted }),
	], width, roles));
	return rows;
}

function diffSummary(lines: readonly string[], width: number, roles: ActivityLedgerRoles): string {
	const additions = lines.filter((line) => line.trimStart().startsWith("+")).length;
	const removals = lines.filter((line) => line.trimStart().startsWith("-")).length;
	return renderBodyLine([
		span(`+${additions}`, { fg: activeThemeColors().states.idle }),
		span(" "),
		span(`-${removals}`, { fg: activeThemeColors().states.approval }),
	], width, roles);
}

function renderDiffSummaryText(text: string, width: number, roles: ActivityLedgerRoles): string {
	const additions = text.match(/\+(\d+)/)?.[0];
	const removals = text.match(/-(\d+)/)?.[0];
	const rest = text.replace(/\+\d+|-\d+/g, "").trim();
	return renderBodyLine([
		...(additions ? [span(additions, { fg: activeThemeColors().states.idle }), span(" ")] : []),
		...(removals ? [span(removals, { fg: activeThemeColors().states.approval }), span(" ")] : []),
		span(rest, { fg: roles.bodyMuted }),
	], width, roles);
}

function renderDiffBody(activity: ActivitySnapshot, width: number, roles: ActivityLedgerRoles): string[] {
	if (activity.body?.kind !== "diff") return [];
	const allLines = contentLines(activity.body.text);
	if (allLines.length === 0) return [renderBodyLine([span(emptyText(activity), { fg: roles.bodyMuted })], width, roles)];
	if (allLines.length === 1 && /^\+\d+\s+-\d+/.test(allLines[0]!.trim())) return [renderDiffSummaryText(allLines[0]!, width, roles)];
	const declaredMarkers = allLines.filter((line) => /^…\s+.*collapsed$/i.test(line.trim()));
	const lines = allLines.filter((line) => !/^…\s+.*collapsed$/i.test(line.trim()));
	const looksLikeDiff = lines.some((line) => /^[+-]/.test(line.trimStart()));
	if (!looksLikeDiff) {
		const rows = lines.slice(0, BODY_MAX_SOURCE_LINES).map((line) => renderBodyLine([span(line, { fg: roles.bodyMuted })], width, roles));
		const hidden = lines.length - Math.min(lines.length, BODY_MAX_SOURCE_LINES);
		const marker = collapseMarker([...declaredMarkers.map((line) => line.replace(/^…\s*/, "")), ...(hidden > 0 ? [`${hidden} lines collapsed`] : [])], width);
		if (marker) rows.push(renderBodyLine([span(marker, { fg: roles.bodyMuted })], width, roles));
		return rows;
	}
	const visible = lines.slice(0, BODY_MAX_SOURCE_LINES);
	const rows = [diffSummary(lines, width, roles), ...visible.map((line) => {
		const trimmed = line.trimStart();
		const fg = trimmed.startsWith("+") ? activeThemeColors().states.idle
			: trimmed.startsWith("-") ? activeThemeColors().states.approval
			: roles.bodyMuted;
		return renderBodyLine([span(line, { fg })], width, roles);
	})];
	const hidden = lines.length - visible.length;
	const marker = collapseMarker([...declaredMarkers.map((line) => line.replace(/^…\s*/, "")), ...(hidden > 0 ? [`${hidden} lines collapsed`] : [])], width);
	if (marker) rows.push(renderBodyLine([span(marker, { fg: roles.bodyMuted })], width, roles));
	return rows;
}

function styledTerminalLine(line: string, roles: ActivityLedgerRoles): readonly (Span | string)[] {
	const trimmed = line.trimStart();
	const indent = line.slice(0, line.length - trimmed.length);
	if (trimmed.startsWith("✓")) return [span(`${indent}✓`, { fg: activeThemeColors().states.idle }), span(trimmed.slice(1))];
	if (trimmed.startsWith("✗")) return [span(`${indent}✗`, { fg: activeThemeColors().states.approval }), span(trimmed.slice(1))];
	if (!trimmed.startsWith(">")) return [span(line, { fg: roles.bodyMuted })];
	return [line];
}

function renderStreamBody(activity: ActivitySnapshot, width: number, roles: ActivityLedgerRoles, includeInvocation: boolean): string[] {
	const body = activity.body;
	const rows: string[] = [];
	const reasons: string[] = [];
	const invocation = includeInvocation
		? body?.kind === "terminal" && body.command
			? body.command
			: activity.invocation === undefined ? undefined : safeValuePreview(activity.invocation, { maxChars: 2_000 })
		: undefined;
	if (invocation) {
		const rendered = renderBodyLines([`> ${invocation}`], width, roles, INVOCATION_MAX_ROWS);
		rows.push(...rendered.rows);
		if (rendered.truncated) reasons.push("invocation rows collapsed");
	}

	const candidates = body
		? [body.text, activity.outputTail]
		: [activity.currentStep, activity.outputTail, activity.result?.error, activity.result?.summary];
	const seen = new Set<string>();
	const bodyText = candidates.flatMap((value): string[] => {
		if (!value) return [];
		const sanitized = sanitizeActivityText(value);
		if (sanitized.length === 0 || sanitized === invocation || seen.has(sanitized)) return [];
		seen.add(sanitized);
		return [sanitized];
	}).join("\n");
	const allLines = contentLines(bodyText);
	const lines = allLines.slice(0, BODY_MAX_SOURCE_LINES);
	const sourceLineCount = allLines.length;
	let displayRowsCollapsed = false;
	for (let index = 0; index < lines.length; index += 1) {
		const available = Math.max(0, BODY_MAX_ROWS - rows.length - 1);
		if (available === 0) {
			displayRowsCollapsed = true;
			break;
		}
		const remainingLines = lines.length - index - 1;
		const reserved = Math.min(remainingLines, Math.max(0, available - 1));
		const rowBudget = Math.max(1, available - reserved);
		const parts = body?.kind === "terminal" ? styledTerminalLine(lines[index]!, roles) : [span(lines[index]!, { fg: roles.bodyMuted })];
		const rendered = renderBodyLines(parts, width, roles, rowBudget);
		rows.push(...rendered.rows);
		displayRowsCollapsed ||= rendered.truncated;
	}
	if (sourceLineCount > BODY_MAX_SOURCE_LINES) reasons.push(`${sourceLineCount - BODY_MAX_SOURCE_LINES} lines collapsed`);
	if (displayRowsCollapsed) reasons.push("display rows collapsed");
	if (rows.length === 0) rows.push(renderBodyLine([span(emptyText(activity), { fg: roles.bodyMuted })], width, roles));
	const marker = collapseMarker(reasons, width);
	if (marker) {
		if (rows.length >= BODY_MAX_ROWS) rows.pop();
		rows.push(renderBodyLine([span(marker, { fg: roles.bodyMuted })], width, roles));
	}
	return rows;
}

function renderActivityBody(activity: ActivitySnapshot, width: number, roles: ActivityLedgerRoles): string[] {
	if (activity.body?.kind === "source") return renderSourceBody(activity, width, roles);
	if (activity.body?.kind === "diff") return renderDiffBody(activity, width, roles);
	if (activity.body?.kind === "terminal") return renderStreamBody(activity, width, roles, true);
	return renderStreamBody(activity, width, roles, true);
}

export function renderActivityLedgerRows(activity: ActivitySnapshot, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (safeWidth < 20) return [padAnsi(renderCompactActivityPill(activity), safeWidth)];
	const roles = activeThemeApplicationRoles().toolLedger;
	const body = renderActivityBody(activity, safeWidth, roles).slice(0, BODY_MAX_ROWS);
	return [renderHeader(activity, safeWidth, roles), ...body, renderBottom(safeWidth, roles)];
}

export function renderActivityBlockRows(activity: ActivitySnapshot, width: number, options: { readonly expanded?: boolean } = {}): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return options.expanded === false
		? [padAnsi(renderCompactActivityPill(activity), safeWidth)]
		: renderActivityLedgerRows(activity, safeWidth);
}
