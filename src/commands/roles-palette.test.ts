import { describe, expect, it, vi } from "vitest";
import { Key } from "@earendil-works/pi-tui";
import {
	filterRows,
	showSearchPalette,
	updatePaletteState,
	type SearchPaletteState,
} from "./roles-palette.js";

const ROWS = [
	{ id: "research:model", label: "research model", value: "inherit" },
	{ id: "review:model", label: "review model", value: "anthropic/claude-opus" },
	{ id: "research:tools", label: "research tools", value: "read-only" },
] as const;

function state(overrides: Partial<SearchPaletteState> = {}): SearchPaletteState {
	return {
		searchQuery: "",
		activeIndex: 0,
		rows: ROWS,
		...overrides,
	};
}

describe("filterRows", () => {
	it("matches label and value case-insensitively", () => {
		expect(filterRows(ROWS, "RESEARCH").map((row) => row.id)).toEqual(["research:model", "research:tools"]);
		expect(filterRows(ROWS, "OpUs").map((row) => row.id)).toEqual(["review:model"]);
	});
});

describe("updatePaletteState", () => {
	it("removes the final search character on backspace", () => {
		const result = updatePaletteState(state({ searchQuery: "model", activeIndex: 1 }), Key.backspace);
		expect(result.state).toMatchObject({ searchQuery: "mode", activeIndex: 0 });
	});

	it("wraps navigation in both directions and supports tab", () => {
		expect(updatePaletteState(state({ activeIndex: 2 }), Key.down).state.activeIndex).toBe(0);
		expect(updatePaletteState(state(), Key.up).state.activeIndex).toBe(2);
		expect(updatePaletteState(state({ activeIndex: 2 }), Key.tab).state.activeIndex).toBe(0);
	});

	it("returns the active row id on enter", () => {
		const result = updatePaletteState(state({ activeIndex: 1 }), Key.enter);
		expect(result).toMatchObject({ done: true, selection: "review:model" });
	});

	it("returns undefined on escape", () => {
		const result = updatePaletteState(state(), Key.escape);
		expect(result.done).toBe(true);
		expect(result.selection).toBeUndefined();
	});
});

describe("showSearchPalette", () => {
	it("maps the RPC selector label back to its row id", async () => {
		const select = vi.fn(async () => "review model  anthropic/claude-opus");
		const result = await showSearchPalette({ mode: "rpc", ui: { select } } as never, {
			title: "SUBAGENT ROLES",
			placeholder: "what shall we tune…",
			rows: ROWS,
		});

		expect(select).toHaveBeenCalledWith("SUBAGENT ROLES", [
			"research model  inherit",
			"review model  anthropic/claude-opus",
			"research tools  read-only",
		]);
		expect(result).toBe("review:model");
	});
});
