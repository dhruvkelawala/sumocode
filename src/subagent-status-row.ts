import { getActiveTheme } from "./themes/index.js";
import { lineToAnsi, span, textLine, truncateLine } from "./sumo-tui/render/primitives.js";

const LEFT_PADDING = "  ";
const NAMESPACED_SUBAGENT_ID = /^sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d+)$/;

function ageLabel(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m`;
}

/**
 * Collapses a namespaced subagent id (`sa-<uuid>-<n>`) to its readable
 * sequence suffix (`sa-<n>`). Already-short ids (`sa-1`) and non-sa ids pass
 * through unchanged; the full id stays the entry identity for actions.
 */
export function shortId(id: string): string {
	const match = NAMESPACED_SUBAGENT_ID.exec(id);
	return match === null ? id : `sa-${match[1]}`;
}

/** Whitespace-normalized title, or the generic fallback when it is empty. */
function titleLabel(title: string): string {
	return title.replace(/\s+/g, " ").trim() || "subagent";
}

/** One running subagent summarized in the footer status row. */
export interface SubagentStatusRunningEntry {
	readonly id: string;
	readonly roleId?: string;
	readonly title: string;
	readonly ageMs: number;
}

export function renderSubagentStatusRow(options: {
	readonly width: number;
	readonly running: readonly SubagentStatusRunningEntry[];
	readonly queuedCount: number;
}): string[] {
	const theme = getActiveTheme();
	const width = Math.max(0, Math.floor(options.width));
	const segments: string[] = [];
	if (options.running.length > 0) segments.push(`${options.running.length} running`);
	if (options.queuedCount > 0) segments.push(`${options.queuedCount} queued`);
	segments.push(
		...options.running.map((subagent) => {
			const role = subagent.roleId === undefined ? "" : ` ${subagent.roleId}`;
			return `${titleLabel(subagent.title)} ${shortId(subagent.id)}${role} ${ageLabel(subagent.ageMs)}`;
		}),
	);
	const suffix = segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
	const row = textLine([
		span(LEFT_PADDING),
		span("◈", { fg: theme.tokens.colors.accent }),
		span(` subagents${suffix}`, { fg: theme.tokens.colors.foregroundDim }),
	]);
	return [lineToAnsi(truncateLine(row, width))];
}
