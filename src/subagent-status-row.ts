import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { slugifyBranch } from "./git/worktree.js";
import { getActiveTheme } from "./themes/index.js";
import { lineToAnsi, span, textLine, truncateLine } from "./sumo-tui/render/primitives.js";

const LEFT_PADDING = "  ";
/** Ceiling for a per-title bound; a narrow row shrinks it further so id, role, and age survive. */
const TITLE_MAX = 48;
const LEGACY_NAMESPACED_SUBAGENT_ID = /^sa-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d+)$/;
const READABLE_SUBAGENT_ID = /^sa-([a-z0-9]+(?:-[a-z0-9]+)*?)-(\d+)(?:-([0-9a-f]{4}))?$/;

function ageLabel(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m`;
}

/**
 * Display identity for one subagent id. `short` is the compact form used while
 * it is unambiguous (`sa-<n>` for both namespaced shapes); `distinct` widens it
 * only when another visible entry would render the same short form. The full id
 * stays the entry identity for actions and tool output.
 */
interface DisplayId {
	readonly short: string;
	readonly distinct: string;
}

/**
 * Sequence and optional retention namespace after the manager's own slug. The
 * manager builds `sa-<slugifyBranch(title)>-<n>[-<ns4>]`, so a title that still
 * reproduces that slug locates the boundary exactly — which matters for ids
 * whose slug ends in a number (`sa-fix-471-1000` is sequence 1000, not 471).
 * Adopted retained records carry their id as the title, hence the id-shape
 * fallback below.
 */
function tailAfterSlug(id: string, title: string): { readonly sequence: string; readonly namespace?: string } | undefined {
	const prefix = `sa-${slugifyBranch(title)}-`;
	if (!id.startsWith(prefix)) return undefined;
	const rest = id.slice(prefix.length);
	const separator = rest.indexOf("-");
	const sequence = separator === -1 ? rest : rest.slice(0, separator);
	const namespace = separator === -1 ? undefined : rest.slice(separator + 1);
	if (!/^\d+$/.test(sequence)) return undefined;
	if (namespace !== undefined && !/^[0-9a-f]{4}$/.test(namespace)) return undefined;
	return namespace === undefined ? { sequence } : { sequence, namespace };
}

/** Compact form derived from an id's own shape, with no title to anchor the slug. */
function idOnlyDisplayId(id: string): DisplayId {
	const legacy = LEGACY_NAMESPACED_SUBAGENT_ID.exec(id);
	if (legacy !== null) return { short: `sa-${legacy[2]}`, distinct: `sa-${legacy[1]}-${legacy[2]}` };
	const readable = READABLE_SUBAGENT_ID.exec(id);
	if (readable === null) return { short: id, distinct: id };
	// Retained ids keep their 4-char namespace when widening; an unnamespaced id
	// has no fragment to widen with, so it falls back to the full id.
	return {
		short: `sa-${readable[2]}`,
		distinct: readable[3] === undefined ? id : `sa-${readable[2]}-${readable[3]}`,
	};
}

function displayId(id: string, title: string): DisplayId {
	const derived = tailAfterSlug(id, title);
	if (derived === undefined) return idOnlyDisplayId(id);
	return {
		short: `sa-${derived.sequence}`,
		distinct: derived.namespace === undefined ? id : `sa-${derived.sequence}-${derived.namespace}`,
	};
}

/**
 * Collapses a namespaced subagent id to its readable sequence suffix. Legacy
 * `sa-<uuid>-<n>` ids and readable `sa-<slug>-<n>[-<ns4>]` ids both render as
 * `sa-<n>`; already-short ids (`sa-1`) and non-sa ids pass through unchanged.
 */
export function shortId(id: string): string {
	return idOnlyDisplayId(id).short;
}

/** Whitespace-normalized, control-char-free title, or the generic fallback when empty. */
function normalizedTitle(title: string): string {
	// oxlint-disable-next-line no-control-regex -- intentional strip of C0 controls/DEL so titles can never emit terminal bytes
	const clean = title.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
	return clean.replace(/\s+/g, " ").trim() || "subagent";
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
	const counts: string[] = [];
	if (options.running.length > 0) counts.push(`${options.running.length} running`);
	if (options.queuedCount > 0) counts.push(`${options.queuedCount} queued`);
	const suffix = counts.length > 0 ? ` · ${counts.join(" · ")}` : "";
	// Cells already spent before the first entry, so each title can shrink to keep
	// its own id, role, and age inside the row instead of being clipped away.
	const prefixWidth = visibleWidth(`${LEFT_PADDING}◈ subagents${suffix} · `);
	const parsed = options.running.map((subagent) => ({ subagent, id: displayId(subagent.id, subagent.title) }));
	const shortIdCounts = new Map<string, number>();
	for (const { id } of parsed) shortIdCounts.set(id.short, (shortIdCounts.get(id.short) ?? 0) + 1);
	const entries = parsed.map(({ subagent, id }) => {
		const display = (shortIdCounts.get(id.short) ?? 0) > 1 ? id.distinct : id.short;
		const title = normalizedTitle(subagent.title);
		const role = subagent.roleId === undefined || subagent.roleId === title ? "" : ` ${subagent.roleId}`;
		const age = ageLabel(subagent.ageMs);
		const budget = Math.min(TITLE_MAX, width - prefixWidth - visibleWidth(` ${display}${role} ${age}`));
		return `${truncateToWidth(title, Math.max(1, budget), "…")} ${display}${role} ${age}`;
	});
	const row = textLine([
		span(LEFT_PADDING),
		span("◈", { fg: theme.tokens.colors.accent }),
		span(` subagents${suffix}${entries.length > 0 ? ` · ${entries.join(" · ")}` : ""}`, { fg: theme.tokens.colors.foregroundDim }),
	]);
	return [lineToAnsi(truncateLine(row, width))];
}
