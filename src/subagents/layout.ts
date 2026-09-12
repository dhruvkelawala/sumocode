import type { SubagentPaneRef } from "./domain.js";
import type { SplitDirection, TerminalHostKind } from "../terminal-host/types.js";

export type Placement =
	| { kind: "workspace" }
	| { kind: "tab"; tabId: string; direction: SplitDirection }
	| { kind: "new-tab"; label: string }
	| { kind: "fallback-split"; direction: SplitDirection };

export interface PlacementInput {
	hostKind: TerminalHostKind;
	isolated: boolean;
	visiblePanes: readonly SubagentPaneRef[];
	sessionTabId?: string;
	/** Tab ids that must never be used as shared destinations (isolated workspace tabs). */
	excludedTabIds?: readonly string[];
	/** The parent session's caller tab; it survives child exits because it holds the parent pane. */
	callerTabId?: string;
}

const MAX_PANES_PER_TAB = 4;

const splitDirection = (paneCount: number): SplitDirection => paneCount % 2 === 0 ? "right" : "down";

export function planPlacement(input: PlacementInput): Placement {
	if (input.hostKind !== "herdr") return { kind: "fallback-split", direction: "right" };
	// A live caller tab wins even for worktree-backed children: the pane can run
	// from the isolated cwd without hiding the work behind another workspace.
	// Without a caller tab, isolated children retain the workspace fallback.
	if (!input.sessionTabId) {
		if (input.isolated) return { kind: "workspace" };
		const tabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
		return { kind: "new-tab", label: tabNumber === 1 ? "subagents" : `subagents ${tabNumber}` };
	}

	const panesIn = (tabId: string) => input.visiblePanes.filter((pane) => pane.tabId === tabId).length;
	const workspaceId = input.sessionTabId.split(":")[0];
	const excluded = new Set(input.excludedTabIds ?? []);

	// The caller tab holds the parent session pane, so it survives its children
	// exiting while a generated overflow tab does not. Prefer it whenever it has
	// a free slot: the attach cache re-points at every pane, so after the first
	// overflow the session tab is the overflow tab, and only this check brings
	// later children home. Isolated workspace tabs and tabs in other workspaces
	// are never shared destinations.
	if (
		input.callerTabId !== undefined
		&& !excluded.has(input.callerTabId)
		&& input.callerTabId.split(":")[0] === workspaceId
	) {
		const panesInCallerTab = panesIn(input.callerTabId);
		if (panesInCallerTab < MAX_PANES_PER_TAB) {
			return { kind: "tab", tabId: input.callerTabId, direction: splitDirection(panesInCallerTab) };
		}
	}

	const panesInSessionTab = panesIn(input.sessionTabId);
	if (panesInSessionTab < MAX_PANES_PER_TAB) {
		return {
			kind: "tab",
			tabId: input.sessionTabId,
			direction: splitDirection(panesInSessionTab),
		};
	}

	// Both anchors are full. Before provisioning a duplicate, look for a live
	// shared tab in the same workspace that has lost a child; its free slot is
	// reclaimed instead of left unused.
	const vacancies = new Map<string, number>();
	for (const pane of input.visiblePanes) {
		const tabId = pane.tabId;
		if (!tabId || tabId === input.sessionTabId) continue;
		if (excluded.has(tabId)) continue;
		if (tabId.split(":")[0] !== workspaceId) continue;
		vacancies.set(tabId, (vacancies.get(tabId) ?? 0) + 1);
	}
	const candidate = [...vacancies.entries()].find(([, count]) => count < MAX_PANES_PER_TAB);
	if (candidate !== undefined) {
		return { kind: "tab", tabId: candidate[0], direction: splitDirection(candidate[1]) };
	}

	const nextTabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
	return { kind: "new-tab", label: `subagents ${nextTabNumber}` };
}

/** A pane's cell geometry as reported by the terminal host's layout query. */
export interface PaneRect {
	paneId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PaneSplitChoice {
	paneId: string;
	direction: SplitDirection;
}

/**
 * Tiling rule: split the largest pane along its longer axis. A terminal cell is
 * roughly twice as tall as it is wide, so splitting along the width keeps
 * readable columns only while `width >= 2 * height`; below that the axis flips
 * to rows. Equal areas keep the first pane in reading order. Returns undefined
 * when no pane reports a usable rect, and the caller keeps its planned
 * direction.
 */
export function chooseSplitAnchor(panes: readonly PaneRect[]): PaneSplitChoice | undefined {
	let anchor: PaneRect | undefined;
	// Hosts report panes in tree order, not reading order, so sort a copy before
	// the first-wins tie-break instead of trusting the input order.
	for (const pane of [...panes].sort((a, b) => a.y - b.y || a.x - b.x)) {
		if (!(pane.width > 0) || !(pane.height > 0)) continue;
		if (anchor === undefined || pane.width * pane.height > anchor.width * anchor.height) anchor = pane;
	}
	if (anchor === undefined) return undefined;
	return { paneId: anchor.paneId, direction: anchor.width >= 2 * anchor.height ? "right" : "down" };
}
