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
}

const MAX_PANES_PER_TAB = 4;

const splitDirection = (paneCount: number): SplitDirection => paneCount % 2 === 0 ? "right" : "down";

export function planPlacement(input: PlacementInput): Placement {
	if (input.hostKind !== "herdr") return { kind: "fallback-split", direction: "right" };
	if (input.isolated) return { kind: "workspace" };
	if (!input.sessionTabId) {
		const tabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
		return { kind: "new-tab", label: tabNumber === 1 ? "subagents" : `subagents ${tabNumber}` };
	}

	const panesInSessionTab = input.visiblePanes.filter((pane) => pane.tabId === input.sessionTabId).length;
	if (panesInSessionTab < MAX_PANES_PER_TAB) {
		return {
			kind: "tab",
			tabId: input.sessionTabId,
			direction: splitDirection(panesInSessionTab),
		};
	}

	const nextTabNumber = Math.floor(input.visiblePanes.length / MAX_PANES_PER_TAB) + 1;
	return { kind: "new-tab", label: `subagents ${nextTabNumber}` };
}
