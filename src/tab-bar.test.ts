import { describe, expect, it } from "vitest";
import { renderTabBar, type TabBarSnapshot } from "./tab-bar.js";
import { CATHEDRAL_TOKENS, SUMOCODE_STATES, type SumoCodeState } from "./tokens.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<TabBarSnapshot> = {}): TabBarSnapshot {
	return {
		activeLabel: "work-20260424",
		state: "idle",
		inactiveLabels: [],
		...overrides,
	};
}

describe("renderTabBar", () => {
	it("wraps the active session in burnt-orange double-line ║…║", () => {
		const line = renderTabBar(snapshot(), 120);
		const plain = stripAnsi(line);

		expect(plain).toMatch(/^\s*║\s*●\s*work-20260424\s*║/);
		// #D97706 -> 217;119;6
		expect(line).toContain("\u001b[38;2;217;119;6m");
	});

	it.each(SUMOCODE_STATES)("colors the active state dot for %s", (state: SumoCodeState) => {
		const line = renderTabBar(snapshot({ state }), 120);
		const expected = CATHEDRAL_TOKENS.colors.states[state];
		const n = expected.replace("#", "");
		const r = Number.parseInt(n.slice(0, 2), 16);
		const g = Number.parseInt(n.slice(2, 4), 16);
		const b = Number.parseInt(n.slice(4, 6), 16);

		expect(line).toContain(`\u001b[38;2;${r};${g};${b}m`);
	});

	it("renders inactive sessions separated by │ in dim", () => {
		const line = renderTabBar(snapshot({
			inactiveLabels: ["readyx-20260423", "sumocode-20260420"],
		}), 160);
		const plain = stripAnsi(line);

		expect(plain).toContain("│ readyx-20260423");
		expect(plain).toContain("│ sumocode-20260420");
	});

	it("ends with '│ + new' in dim", () => {
		const line = renderTabBar(snapshot(), 160);
		const plain = stripAnsi(line);

		expect(plain).toMatch(/│\s*\+\s*new/);
	});

	it("pads the rendered line to exactly the requested width", () => {
		const width = 120;
		const line = renderTabBar(snapshot({
			inactiveLabels: ["one", "two"],
		}), width);

		expect(stripAnsi(line).length).toBe(width);
	});

	it("truncates the active label with an ellipsis when it would overflow", () => {
		const line = renderTabBar(snapshot({
			activeLabel: "extremely-long-session-name-that-cannot-fit-on-narrow-terminals",
		}), 40);
		const plain = stripAnsi(line);

		expect(plain.length).toBe(40);
		expect(plain).toContain("…");
	});
});
