import { describe, expect, it } from "vitest";
import type { SubagentPaneRef } from "./domain.js";
import { chooseSplitAnchor, planPlacement } from "./layout.js";

const pane = (tabId: string, index: number): SubagentPaneRef => ({
	agentName: `worker-${index}`,
	workspaceId: "w1",
	tabId,
	paneId: `w1:p${index}`,
});

describe("planPlacement", () => {
	it("uses the degraded split fallback without a host", () => {
		expect(planPlacement({ hostKind: "none", isolated: false, visiblePanes: [] })).toEqual({ kind: "fallback-split", direction: "right" });
		expect(planPlacement({ hostKind: "none", isolated: true, visiblePanes: [] })).toEqual({ kind: "fallback-split", direction: "right" });
	});

	it("uses a workspace for isolated Herdr children only when no caller tab is available", () => {
		expect(planPlacement({ hostKind: "herdr", isolated: true, visiblePanes: [] })).toEqual({ kind: "workspace" });
		expect(planPlacement({ hostKind: "herdr", isolated: true, visiblePanes: [], sessionTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "right",
		});
	});

	it("creates the first subagents tab when no session tab exists", () => {
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [] })).toEqual({ kind: "new-tab", label: "subagents" });
	});

	it.each([
		{ count: 0, direction: "right" },
		{ count: 1, direction: "down" },
		{ count: 2, direction: "right" },
		{ count: 3, direction: "down" },
	] as const)("alternates the split direction with $count panes", ({ count, direction }) => {
		const visiblePanes = Array.from({ length: count }, (_, index) => pane("w1:t1", index + 1));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes, sessionTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction,
		});
	});

	it("counts only panes in the active subagents tab", () => {
		const visiblePanes = [pane("w1:t0", 1), pane("w1:t1", 2)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes, sessionTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "down",
		});
	});

	it("opens incremented tabs after each group of four", () => {
		const firstTab = Array.from({ length: 4 }, (_, index) => pane("w1:t1", index + 1));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: firstTab, sessionTabId: "w1:t1" })).toEqual({ kind: "new-tab", label: "subagents 2" });

		const secondTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 5));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...firstTab, ...secondTab], sessionTabId: "w1:t2" })).toEqual({ kind: "new-tab", label: "subagents 3" });
	});

	it("reclaims a vacancy in another live shared tab when the cached tab is full", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		const olderTab = Array.from({ length: 3 }, (_, index) => pane("w1:t1", index + 5));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...cachedTab, ...olderTab], sessionTabId: "w1:t2" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "down",
		});
	});

	it("never reclaims an excluded workspace tab as a shared destination", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		const workspacePane = pane("w9:t1", 9);
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...cachedTab, workspacePane], sessionTabId: "w1:t2", excludedTabIds: ["w9:t1"] })).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("ignores tabs in other workspaces when looking for a vacancy", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		const foreignTab = [pane("w2:t1", 5), pane("w2:t1", 6)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...cachedTab, ...foreignTab], sessionTabId: "w1:t2" })).toEqual({ kind: "new-tab", label: "subagents 2" });
	});

	it("returns to the empty caller tab when the cached tab is full and no other vacancy exists", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: cachedTab, sessionTabId: "w1:t2", callerTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "right",
		});
	});

	it("prefers the caller tab over a live under-capacity tab when both have room", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		const olderTab = [pane("w1:t1", 5), pane("w1:t1", 6)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...cachedTab, ...olderTab], sessionTabId: "w1:t2", callerTabId: "w1:t0" })).toEqual({
			kind: "tab",
			tabId: "w1:t0",
			direction: "right",
		});
	});

	it("reclaims the caller tab while the cached overflow tab still has room", () => {
		// Four children filled the caller tab and overflowed into w1:t2, which
		// the attach cache now points at. The caller-tab children have settled
		// but the parent session pane keeps w1:t1 alive.
		const overflowTab = [pane("w1:t2", 1), pane("w1:t2", 2)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: overflowTab, sessionTabId: "w1:t2", callerTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "right",
		});
	});

	it("keeps counting the caller tab's live children toward its capacity", () => {
		const callerTab = [pane("w1:t1", 1), pane("w1:t1", 2), pane("w1:t1", 3)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: callerTab, sessionTabId: "w1:t2", callerTabId: "w1:t1" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "down",
		});
	});

	it("does not seed a caller tab from another workspace", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: cachedTab, sessionTabId: "w1:t2", callerTabId: "w9:t0" })).toEqual({ kind: "new-tab", label: "subagents 2" });
	});
});

const rect = (paneId: string, x: number, y: number, width: number, height: number) => ({ paneId, x, y, width, height });

describe("chooseSplitAnchor", () => {
	it("splits the largest pane along its longer axis", () => {
		// Issue #519's four-child layout: p7 is the full-width bottom half and the
		// largest pane, so it is the next anchor. At 104x50 the width is at least
		// twice the height, so the new child lands to the right.
		expect(chooseSplitAnchor([
			rect("p8", 52, 0, 52, 56),
			rect("p6", 0, 0, 52, 28),
			rect("p9", 0, 28, 52, 28),
			rect("p7", 0, 56, 104, 50),
		])).toEqual({ paneId: "p7", direction: "right" });
	});

	it("splits down when the pane is less than twice as wide as it is tall", () => {
		// The issue's rendered rects: p7 is 104x55. Splitting right would leave
		// 52x55 children taller than they are wide, so the axis flips to rows.
		expect(chooseSplitAnchor([
			rect("p8", 52, 0, 52, 56),
			rect("p6", 0, 0, 52, 28),
			rect("p9", 0, 28, 52, 28),
			rect("p7", 0, 56, 104, 55),
		])).toEqual({ paneId: "p7", direction: "down" });
	});

	it("breaks equal-area ties in reading order, not list order", () => {
		expect(chooseSplitAnchor([
			rect("right", 110, 0, 110, 55),
			rect("left", 0, 0, 110, 55),
		])).toEqual({ paneId: "left", direction: "right" });
	});

	it("returns undefined without a usable pane", () => {
		expect(chooseSplitAnchor([])).toBeUndefined();
	});
});
