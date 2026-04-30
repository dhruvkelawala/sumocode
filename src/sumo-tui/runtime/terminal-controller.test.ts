import { describe, expect, it, vi } from "vitest";
import {
	ALTSCREEN_ENTER_SEQUENCE,
	CURSOR_COLOR_RESET,
	CURSOR_COLOR_SET,
	MOUSE_SGR_DISABLE_SEQUENCE,
	MOUSE_SGR_ENABLE_SEQUENCE,
	TERMINAL_BG_RESET,
	TERMINAL_BG_SET,
	TERMINAL_CLEANUP_SEQUENCE,
	TerminalSessionOwner,
	type TerminalOutput,
} from "./terminal-controller.js";

function outputStub(isTTY = true): TerminalOutput & { writes: string[] } {
	return {
		isTTY,
		writes: [],
		write(data: string) {
			this.writes.push(data);
			return true;
		},
	};
}

describe("TerminalSessionOwner", () => {
	it("startRetainedSession owns altscreen, mouse mode, and accent cursor (Bible Element 4)", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.startRetainedSession();

		expect(output.writes).toEqual([
			`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`,
			MOUSE_SGR_ENABLE_SEQUENCE,
			CURSOR_COLOR_SET,
		]);
		expect(terminal.getState()).toMatchObject({
			altscreenActive: true,
			mouseSGREnabled: true,
			backgroundPainted: true,
			cursorColorOverridden: true,
			restored: false,
		});
	});

	it("suppresses duplicate retained lifecycle requests until cleanup", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.startRetainedSession();
		terminal.startRetainedSession();
		terminal.enterAltscreen();
		terminal.enableMouseSGR();

		expect(output.writes).toEqual([
			`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`,
			MOUSE_SGR_ENABLE_SEQUENCE,
			CURSOR_COLOR_SET,
		]);
	});

	it("enterAltscreen emits altscreen bytes and terminal background only", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.enterAltscreen();

		expect(output.writes).toEqual([`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`]);
		expect(output.writes[0]).toBe("\x1b[?1049h\x1b[?25h\x1b[H\x1b]11;#1A1511\x1b\\");
		expect(output.writes[0]).not.toContain("\x1b]12;");
	});

	it("setCursorColor is idempotent for the active accent and resets on cleanup", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.startRetainedSession();
		// Re-applying the same accent must not duplicate the OSC 12 write.
		terminal.setCursorColor();
		terminal.exitTerminal();

		expect(output.writes).toEqual([
			`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`,
			MOUSE_SGR_ENABLE_SEQUENCE,
			CURSOR_COLOR_SET,
			`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`,
		]);
	});

	it("enableMouseSGR emits click/wheel SGR bytes without any-event motion tracking", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.enableMouseSGR();

		expect(output.writes).toEqual([MOUSE_SGR_ENABLE_SEQUENCE]);
		expect(output.writes[0]).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
	});

	it("writes absolute chat viewport rows behind the terminal ownership seam", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		expect(terminal.writeChatViewport(2, 3, ["one", "two"])).toBe(true);

		expect(output.writes).toEqual(["\x1b[?2026h\x1b7\x1b[3;4Hone\x1b[4;4Htwo\x1b8\x1b[?2026l"]);
	});

	it("writes full-frame patches and hardware cursor behind the terminal ownership seam", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([{ row: 1, ansi: "hello" }], { row: 2, col: 4 });

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[2;1Hhello\x1b[K\x1b[3;5H\x1b[?25h\x1b[?2026l"]);
	});

	it("exitTerminal emits cleanup without cursor or bg reset when retained mode was never entered", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.exitTerminal();

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
		expect(output.writes[0]).toBe(`\x1b[<u\x1b[>4;0m\x1b[?2004l${MOUSE_SGR_DISABLE_SEQUENCE}\x1b[?1049l\x1b[?25h\x1b[0m`);
		expect(output.writes[0]).not.toContain("\x1b]12;");
		expect(output.writes[0]).not.toContain(CURSOR_COLOR_RESET);
		expect(terminal.restored).toBe(true);
	});

	it("exitTerminal restores bg and accent cursor after retained mode was active", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.startRetainedSession();
		terminal.exitTerminal();

		expect(output.writes).toEqual([
			`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`,
			MOUSE_SGR_ENABLE_SEQUENCE,
			CURSOR_COLOR_SET,
			`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`,
		]);
	});

	it("double cleanup is a no-op after the restored flag is set", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.exitTerminal();
		terminal.exitTerminal();

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
	});

	it("re-entering terminal modes clears the restored flag for the next cleanup", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.exitTerminal();
		terminal.enterAltscreen();
		terminal.enableMouseSGR();
		terminal.exitTerminal();

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE, `${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`, MOUSE_SGR_ENABLE_SEQUENCE, `${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`]);
	});

	it("isTTY=false skips enter and cleanup writes gracefully (EC-10.1)", () => {
		const output = outputStub(false);
		const terminal = new TerminalSessionOwner({ output });

		terminal.enterAltscreen();
		terminal.enableMouseSGR();
		terminal.exitTerminal();

		expect(terminal.isTTY()).toBe(false);
		expect(output.writes).toEqual([]);
		expect(terminal.restored).toBe(true);
	});

	it("catches EPIPE silently and suppresses later writes (EC-5.5)", () => {
		const write = vi.fn(() => {
			const error = new Error("broken pipe") as NodeJS.ErrnoException;
			error.code = "EPIPE";
			throw error;
		});
		const output: TerminalOutput = { isTTY: true, write };
		const terminal = new TerminalSessionOwner({ output });

		expect(() => terminal.exitTerminal()).not.toThrow();
		terminal.enterAltscreen();

		expect(write).toHaveBeenCalledTimes(1);
		expect(terminal.restored).toBe(false);
	});
});
