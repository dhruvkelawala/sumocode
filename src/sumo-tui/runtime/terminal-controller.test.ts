import { describe, expect, it, vi } from "vitest";
import {
	ALTSCREEN_ENTER_SEQUENCE,
	CURSOR_COLOR_RESET,
	CURSOR_COLOR_SET,
	MOUSE_SGR_ENABLE_SEQUENCE,
	TERMINAL_BG_RESET,
	TERMINAL_BG_SET,
	TERMINAL_CLEANUP_SEQUENCE,
	TerminalController,
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

describe("TerminalController", () => {
	it("enterAltscreen emits altscreen bytes followed by cathedral cursor color", () => {
		const output = outputStub();
		const controller = new TerminalController({ output });

		controller.enterAltscreen();

		expect(output.writes).toEqual([`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}${CURSOR_COLOR_SET}`]);
		expect(output.writes[0]).toBe("\x1b[?1049h\x1b[?25h\x1b[H\x1b]11;#1A1511\x1b\\\x1b]12;#D97706\x1b\\");
	});

	it("enableMouseSGR emits click/wheel SGR bytes without any-event motion tracking", () => {
		const output = outputStub();
		const controller = new TerminalController({ output });

		controller.enableMouseSGR();

		expect(output.writes).toEqual([MOUSE_SGR_ENABLE_SEQUENCE]);
		expect(output.writes[0]).toBe("\x1b[?1000h\x1b[?1006h");
	});

	it("exitTerminal resets cursor color before the full cleanup bytes (EC-5.1)", () => {
		const output = outputStub();
		const controller = new TerminalController({ output });

		controller.exitTerminal();

		expect(output.writes).toEqual([`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`]);
		expect(output.writes[0]).toBe("\x1b]112\x1b\\\x1b]111\x1b\\\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[?25h\x1b[0m");
		expect(controller.restored).toBe(true);
	});

	it("double cleanup is a no-op after the restored flag is set", () => {
		const output = outputStub();
		const controller = new TerminalController({ output });

		controller.exitTerminal();
		controller.exitTerminal();

		expect(output.writes).toEqual([`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`]);
	});

	it("re-entering terminal modes clears the restored flag for the next cleanup", () => {
		const output = outputStub();
		const controller = new TerminalController({ output });

		controller.exitTerminal();
		controller.enterAltscreen();
		controller.enableMouseSGR();
		controller.exitTerminal();

		expect(output.writes).toEqual([
			`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`,
			`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}${CURSOR_COLOR_SET}`,
			MOUSE_SGR_ENABLE_SEQUENCE,
			`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`,
		]);
	});

	it("isTTY=false skips enter and cleanup writes gracefully (EC-10.1)", () => {
		const output = outputStub(false);
		const controller = new TerminalController({ output });

		controller.enterAltscreen();
		controller.enableMouseSGR();
		controller.exitTerminal();

		expect(controller.isTTY()).toBe(false);
		expect(output.writes).toEqual([]);
		expect(controller.restored).toBe(true);
	});

	it("catches EPIPE silently and suppresses later writes (EC-5.5)", () => {
		const write = vi.fn(() => {
			const error = new Error("broken pipe") as NodeJS.ErrnoException;
			error.code = "EPIPE";
			throw error;
		});
		const output: TerminalOutput = { isTTY: true, write };
		const controller = new TerminalController({ output });

		expect(() => controller.exitTerminal()).not.toThrow();
		controller.enterAltscreen();

		expect(write).toHaveBeenCalledTimes(1);
		expect(controller.restored).toBe(false);
	});
});
