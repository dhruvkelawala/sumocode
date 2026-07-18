import { afterEach, describe, expect, it, vi } from "vitest";
import { resetThemeRegistryForTests, setActiveTheme } from "../themes/index.js";
import { registerCursorCommand } from "./cursor.js";
import { CURSOR_COLOR_RESET, CURSOR_COLOR_SET, TerminalSessionOwner, type TerminalOutput } from "../sumo-tui/runtime/terminal-controller.js";

function outputStub(): TerminalOutput & { writes: string[] } {
	return {
		isTTY: true,
		writes: [],
		write(data: string) {
			this.writes.push(data);
			return true;
		},
	};
}

describe("registerCursorCommand", () => {
	// Cursor tests mutate the shared theme registry; restore Cathedral so the
	// suite stays order-independent.
	afterEach(() => resetThemeRegistryForTests());

	it("registers /sumo:cursor on the pi API", () => {
		const registerCommand = vi.fn();
		registerCursorCommand({ registerCommand } as never, new TerminalSessionOwner({ output: outputStub() }));
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:cursor",
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	it("/sumo:cursor accent explicitly sets OSC 12", async () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const notify = vi.fn();

		registerCursorCommand({ registerCommand } as never, terminal);
		await handler!("accent", { hasUI: true, ui: { notify } } as never);

		expect(output.writes).toEqual([CURSOR_COLOR_SET]);
		expect(terminal.getState().cursorColorOverridden).toBe(true);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("accent"), "info");
	});

	it("/sumo:cursor accent uses the ACTIVE theme accent, not a Cathedral constant", async () => {
		setActiveTheme("herdr");
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const notify = vi.fn();

		registerCursorCommand({ registerCommand } as never, terminal);
		await handler!("accent", { hasUI: true, ui: { notify } } as never);

		expect(output.writes).toEqual(["\x1b]12;#39FF14\x1b\\"]);
		expect(terminal.getState().cursorColorOverridden).toBe(true);
		expect(notify).toHaveBeenCalledWith("cursor color: theme accent", "info");
	});

	it("deprecated orange/cathedral aliases resolve the current theme accent", async () => {
		setActiveTheme("herdr");
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const notify = vi.fn();

		registerCursorCommand({ registerCommand } as never, terminal);
		await handler!("orange", { hasUI: true, ui: { notify } } as never);

		expect(output.writes).toEqual(["\x1b]12;#39FF14\x1b\\"]);
	});

	it("/sumo:cursor reset restores the terminal default cursor color", async () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const notify = vi.fn();

		registerCursorCommand({ registerCommand } as never, terminal);
		await handler!("accent", { hasUI: true, ui: { notify } } as never);
		await handler!("reset", { hasUI: true, ui: { notify } } as never);

		expect(output.writes).toEqual([CURSOR_COLOR_SET, CURSOR_COLOR_RESET]);
		expect(terminal.getState().cursorColorOverridden).toBe(false);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("terminal default"), "info");
	});

	it("/sumo:cursor status reports without changing OSC state", async () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const notify = vi.fn();

		registerCursorCommand({ registerCommand } as never, terminal);
		await handler!("", { hasUI: true, ui: { notify } } as never);

		expect(output.writes).toEqual([]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("terminal default"), "info");
	});
});
