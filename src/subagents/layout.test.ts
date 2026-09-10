import { describe, expect, it } from "vitest";
import type { SubagentPaneRef } from "./domain.js";
import { planPlacement } from "./layout.js";

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

	it("prefers a live under-capacity tab over the empty caller tab", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		const olderTab = [pane("w1:t1", 5), pane("w1:t1", 6)];
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: [...cachedTab, ...olderTab], sessionTabId: "w1:t2", callerTabId: "w1:t0" })).toEqual({
			kind: "tab",
			tabId: "w1:t1",
			direction: "right",
		});
	});

	it("does not seed a caller tab from another workspace", () => {
		const cachedTab = Array.from({ length: 4 }, (_, index) => pane("w1:t2", index + 1));
		expect(planPlacement({ hostKind: "herdr", isolated: false, visiblePanes: cachedTab, sessionTabId: "w1:t2", callerTabId: "w9:t0" })).toEqual({ kind: "new-tab", label: "subagents 2" });
	});
});
