import { getActiveTheme } from "./themes/index.js";
import { lineToAnsi, span, textLine, truncateLine } from "./sumo-tui/render/primitives.js";

const TITLE_PREFIX_MAX = 18;

function ageLabel(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m`;
}

function fallbackTitle(title: string): string {
	const normalized = title.replace(/\s+/g, " ").trim() || "subagent";
	return normalized.length <= TITLE_PREFIX_MAX ? normalized : `${normalized.slice(0, TITLE_PREFIX_MAX - 1)}…`;
}

export function renderSubagentStatusRow(options: {
	readonly width: number;
	readonly running: readonly { id: string; roleId?: string; title: string; ageMs: number }[];
	readonly queuedCount: number;
}): string[] {
	const theme = getActiveTheme();
	const width = Math.max(0, Math.floor(options.width));
	const segments: string[] = [];
	if (options.running.length > 0) segments.push(`${options.running.length} running`);
	if (options.queuedCount > 0) segments.push(`${options.queuedCount} queued`);
	segments.push(
		...options.running.map((subagent) => `${subagent.id} ${subagent.roleId ?? fallbackTitle(subagent.title)} ${ageLabel(subagent.ageMs)}`),
	);
	const suffix = segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
	const row = textLine([
		span("◈", { fg: theme.tokens.colors.accent }),
		span(` subagents${suffix}`, { fg: theme.tokens.colors.foregroundDim }),
	]);
	return [lineToAnsi(truncateLine(row, width))];
}
