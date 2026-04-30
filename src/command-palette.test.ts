import { describe, expect, it, vi } from "vitest";
import { Key } from "@mariozechner/pi-tui";
import {
	COMMAND_PALETTE_HINT_ROW,
	COMMAND_PALETTE_MODE_ROWS,
	COMMAND_PALETTE_OVERLAY_OPTIONS,
	COMMAND_PALETTE_SHORTCUT,
	CommandPaletteComponent,
	buildPaletteSnapshot,
	filterPaletteRows,
	handlePaletteSelection,
	installCommandPalette,
	renderCommandPalette,
	resolveCommandPaletteWidth,
	updateCommandPaletteSnapshot,
	type CommandPaletteSnapshot,
} from "./command-palette.js";

const ANSI = /\u001b\[[0-9;]*m/g;

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI, ""));
}

function snapshot(overrides: Partial<CommandPaletteSnapshot> = {}): CommandPaletteSnapshot {
	return {
		searchQuery: "",
		activeIndex: 0,
		rows: COMMAND_PALETTE_MODE_ROWS,
		...overrides,
	};
}

describe("renderCommandPalette", () => {
	it("renders the six Scriptorium mode rows in fixed order", () => {
		const lines = plain(renderCommandPalette(snapshot(), 80)).join("\n");
		expect(lines.indexOf("SESSION")).toBeLessThan(lines.indexOf("MODEL"));
		expect(lines.indexOf("MODEL")).toBeLessThan(lines.indexOf("THINKING"));
		expect(lines.indexOf("THINKING")).toBeLessThan(lines.indexOf("MEMORY"));
		expect(lines.indexOf("MEMORY")).toBeLessThan(lines.indexOf("THEME"));
		expect(lines.indexOf("THEME")).toBeLessThan(lines.indexOf("SETTINGS"));
	});

	it("renders the Scriptorium title, search prompt, and 17-row panel", () => {
		const lines = plain(renderCommandPalette(snapshot({ activeIndex: 1 }), 80));
		expect(lines).toHaveLength(17);
		expect(lines.join("\n")).toContain("✾  COMMAND PALETTE  ✾");
		expect(lines.join("\n")).toContain("❯   what shall we attend to…");
		expect(lines.every((line) => line.length === 80)).toBe(true);
	});

	it("marks the active row with the Scriptorium accent floret", () => {
		const lines = renderCommandPalette(snapshot({ activeIndex: 1 }), 80);
		const activeLine = lines.find((line) => line.replace(ANSI, "").includes("MODEL"));
		expect(activeLine).toContain("\u001b[38;2;217;119;6m❈");
		expect(activeLine?.replace(ANSI, "")).toContain("❈   MODEL");
	});

	it("uses the Bible contrast divider color for ornamental rules", () => {
		const lines = renderCommandPalette(snapshot({ activeIndex: 1 }), 80);
		const dividerLine = lines.find((line) => line.replace(ANSI, "").includes("────") && line.replace(ANSI, "").includes("·"));
		expect(dividerLine).toContain("\u001b[38;2;90;77;60m─");
		expect(dividerLine).toContain("\u001b[38;2;90;77;60m·");
	});

	it("filters rows by label substring case-insensitively", () => {
		const rows = filterPaletteRows(COMMAND_PALETTE_MODE_ROWS, "thin");
		expect(rows.map((row) => row.label)).toEqual(["THINKING"]);
	});

	it("renders the footer hint row", () => {
		const lines = plain(renderCommandPalette(snapshot(), 80));
		expect(lines.join("\n")).toContain(COMMAND_PALETTE_HINT_ROW);
	});
});

describe("updateCommandPaletteSnapshot", () => {
	it("moves focus down and up", () => {
		const afterDown = updateCommandPaletteSnapshot(snapshot(), "\u001b[B");
		expect(afterDown.snapshot.activeIndex).toBe(1);

		const afterUp = updateCommandPaletteSnapshot(afterDown.snapshot, "\u001b[A");
		expect(afterUp.snapshot.activeIndex).toBe(0);
	});

	it("escape closes with no selection", () => {
		const result = updateCommandPaletteSnapshot(snapshot(), Key.escape);
		expect(result.done).toBe(true);
		expect(result.selection).toBeUndefined();
	});

	it("enter selects the active filtered row", () => {
		const result = updateCommandPaletteSnapshot(snapshot({ activeIndex: 2 }), Key.enter);
		expect(result.done).toBe(true);
		expect(result.selection).toBe("THINKING");
	});

	it("typing changes the search query and resets focus", () => {
		const result = updateCommandPaletteSnapshot(snapshot({ activeIndex: 3 }), "m");
		expect(result.snapshot.searchQuery).toBe("m");
		expect(result.snapshot.activeIndex).toBe(0);
		expect(filterPaletteRows(result.snapshot.rows, result.snapshot.searchQuery).map((row) => row.label)).toEqual([
			"MODEL",
			"MEMORY",
			"THEME",
		]);
	});
});

describe("CommandPaletteComponent", () => {
	it("escape closes the overlay", () => {
		const done = vi.fn();
		const component = new CommandPaletteComponent(snapshot(), done);
		component.handleInput?.(Key.escape);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("enter triggers the selected row", () => {
		const done = vi.fn();
		const component = new CommandPaletteComponent(snapshot({ activeIndex: 1 }), done);
		component.handleInput?.(Key.enter);
		expect(done).toHaveBeenCalledWith("MODEL");
	});
});

describe("resolveCommandPaletteWidth", () => {
	it("uses the Bible 80-col panel width and clamps to the terminal", () => {
		expect(resolveCommandPaletteWidth(40)).toBe(40);
		expect(resolveCommandPaletteWidth(100)).toBe(80);
		expect(resolveCommandPaletteWidth(200)).toBe(80);
	});
});

describe("installCommandPalette", () => {
	it("registers Ctrl+/ for the palette without stealing Pi/TUI built-in model/editing shortcuts", () => {
		const registerShortcut = vi.fn();
		const registerCommand = vi.fn();
		installCommandPalette({ registerShortcut, registerCommand } as never);

		expect(registerCommand).not.toHaveBeenCalled();
		expect(registerShortcut).toHaveBeenCalledTimes(1);
		expect(registerShortcut).toHaveBeenCalledWith(COMMAND_PALETTE_SHORTCUT, expect.objectContaining({ handler: expect.any(Function) }));
		expect(registerShortcut).not.toHaveBeenCalledWith("ctrl+p", expect.anything());
		expect(registerShortcut).not.toHaveBeenCalledWith("ctrl+k", expect.anything());
	});

	it("Ctrl+/ opens a centered 80-col overlay", async () => {
		let handler: ((ctx: unknown) => Promise<void> | void) | undefined;
		const registerShortcut = vi.fn((key: string, options: { handler: typeof handler }) => {
			if (key === COMMAND_PALETTE_SHORTCUT) handler = options.handler;
		});
		const registerCommand = vi.fn();
		installCommandPalette({
			registerShortcut,
			registerCommand,
			getThinkingLevel: () => "xhigh",
		} as never);

		const custom = vi.fn(() => Promise.resolve(undefined));
		await handler?.({
			hasUI: true,
			ui: { custom, theme: { name: "cathedral" } },
			sessionManager: { getSessionName: () => "refactor-auth-flow", getSessionId: () => "019dcbf5" },
			model: { id: "claude-opus-4-7" },
		} as never);

		expect(custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true,
			overlayOptions: COMMAND_PALETTE_OVERLAY_OPTIONS,
		});
	});
});

describe("buildPaletteSnapshot", () => {
	it("builds current values from context", () => {
		const snap = buildPaletteSnapshot({
			sessionManager: { getSessionName: () => "refactor-auth-flow", getSessionId: () => "019dcbf5" },
			model: { id: "claude-opus-4-7" },
			getThinkingLevel: () => "xhigh",
			ui: { theme: { name: "cathedral" } },
		} as never);

		expect(snap.activeIndex).toBe(1);
		expect(snap.rows.map((row) => `${row.label}:${row.currentValue}`)).toEqual([
			"SESSION:refactor-auth-flow",
			"MODEL:claude-opus-4-7",
			"THINKING:xhigh",
			"MEMORY:55 facts",
			"THEME:cathedral",
			"SETTINGS:",
		]);
	});
});

describe("handlePaletteSelection", () => {
	it("MODEL opens a model selector", async () => {
		const selectedModel = { id: "claude-sonnet-4-5" };
		const setModel = vi.fn();
		const select = vi.fn(() => Promise.resolve("claude-sonnet-4-5"));
		await handlePaletteSelection("MODEL", {
			modelRegistry: { getAvailable: () => [{ id: "claude-opus-4-7" }, selectedModel] },
			ui: { select },
		} as never, { setModel } as never);

		expect(select).toHaveBeenCalledWith("MODEL", ["claude-opus-4-7", "claude-sonnet-4-5"]);
		expect(setModel).toHaveBeenCalledWith(selectedModel);
	});

	it("THINKING opens a thinking selector", async () => {
		const setThinkingLevel = vi.fn();
		const select = vi.fn(() => Promise.resolve("xhigh"));
		await handlePaletteSelection("THINKING", { ui: { select } } as never, { setThinkingLevel } as never);
		expect(select).toHaveBeenCalledWith("THINKING", ["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
	});
});
