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
	it.each(["cmux", "none"] as const)("uses the degraded split fallback on %s", (hostKind) => {
		expect(planPlacement({ hostKind, isolated: false, visiblePanes: [] })).toEqual({ kind: "fallback-split", direction: "right" });
		expect(planPlacement({ hostKind, isolated: true, visiblePanes: [] })).toEqual({ kind: "fallback-split", direction: "right" });
	});

	it("classifies isolated herdr children as workspace placements", () => {
		expect(planPlacement({ hostKind: "herdr", isolated: true, visiblePanes: [] })).toEqual({ kind: "workspace" });
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
});
