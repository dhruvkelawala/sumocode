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
	it("uses the custom-component path in tui mode", async () => {
		const custom = vi.fn(async () => "review:model");
		const result = await showSearchPalette({ mode: "tui", ui: { custom } } as never, {
			title: "SUBAGENT ROLES",
			placeholder: "what shall we tune…",
			rows: ROWS,
		});

		expect(custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true,
			overlayOptions: expect.objectContaining({ anchor: "center", width: 80 }),
		});
		expect(result).toBe("review:model");
	});

	it("falls back to ctx.ui.select in rpc mode because custom() is a documented no-op there", async () => {
		const custom = vi.fn(async () => undefined);
		const labels: string[] = [];
		const select = vi.fn(async (_title: string, options: readonly string[]) => {
			labels.push(...options);
			return options[1];
		});
		const result = await showSearchPalette({ mode: "rpc", ui: { custom, select } } as never, {
			title: "SUBAGENT ROLES",
			placeholder: "what shall we tune…",
			rows: ROWS,
		});

		expect(custom).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(labels[0]).toContain(ROWS[0]!.label);
		expect(result).toBe(ROWS[1]!.id);
	});

	it("returns undefined when the rpc select is cancelled", async () => {
		const select = vi.fn(async () => undefined);
		const result = await showSearchPalette({ mode: "rpc", ui: { select } } as never, {
			title: "SUBAGENT ROLES",
			placeholder: "what shall we tune…",
			rows: ROWS,
		});
		expect(result).toBeUndefined();
	});
});
