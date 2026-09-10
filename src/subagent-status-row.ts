import { truncateToWidth } from "@earendil-works/pi-tui";
import { getActiveTheme } from "./themes/index.js";
import { lineToAnsi, span, textLine, truncateLine } from "./sumo-tui/render/primitives.js";

const LEFT_PADDING = "  ";
/** Per-title bound so one long title cannot push the id out of the row. */
const TITLE_MAX = 48;
const NAMESPACED_SUBAGENT_ID = /^sa-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d+)$/;

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
	return match === null ? id : `sa-${match[2]}`;
}

/**
 * Adds a compact namespace fragment (`sa-<uuid prefix>-<n>`) for entries whose
 * short ids collide across retained namespaces. Non-namespaced ids have no
 * fragment to add and pass through unchanged.
 */
function namespacedShortId(id: string): string {
	const match = NAMESPACED_SUBAGENT_ID.exec(id);
	return match === null ? id : `sa-${match[1]}-${match[2]}`;
}

/** Whitespace-normalized, control-char-free, cell-width-bounded title, or the generic fallback when empty. */
function titleLabel(title: string): string {
	// oxlint-disable-next-line no-control-regex -- intentional strip of C0 controls/DEL so titles can never emit terminal bytes
	const clean = title.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
	const normalized = clean.replace(/\s+/g, " ").trim() || "subagent";
	return truncateToWidth(normalized, TITLE_MAX, "…");
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
	const shortIdCounts = new Map<string, number>();
	for (const subagent of options.running) {
		const short = shortId(subagent.id);
		shortIdCounts.set(short, (shortIdCounts.get(short) ?? 0) + 1);
	}
	segments.push(
		...options.running.map((subagent) => {
			const short = shortId(subagent.id);
			const id = (shortIdCounts.get(short) ?? 0) > 1 ? namespacedShortId(subagent.id) : short;
			const title = titleLabel(subagent.title);
			const role = subagent.roleId === undefined || subagent.roleId === title ? "" : ` ${subagent.roleId}`;
			return `${title} ${id}${role} ${ageLabel(subagent.ageMs)}`;
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
