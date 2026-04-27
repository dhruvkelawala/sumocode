/**
 * Terminal lifecycle controller for sumo-tui Phase 1.
 *
 * The sequence choices are taken from the accepted sumo-tui ADR and Phase 1
 * plan, which in turn follow the OpenCode/OpenTUI pattern of application-owned
 * alternate screen rendering (`docs/adr/0001-sumo-tui-framework.md`,
 * `docs/research/sumo-tui-spike/IMPLEMENTATION_PLAN.md`, and
 * `docs/research/sumo-tui-spike/01-opencode.md` section 2).
 */

export const ALTSCREEN_ENTER_SEQUENCE = "\x1b[?1049h\x1b[?25h\x1b[H";
/**
 * Enable click/wheel mouse reporting in SGR format without xterm any-event
 * motion tracking. `?1003h` makes Mac trackpads feel "captured" because mere
 * finger hover/movement is turned into app mouse events even when the editor
 * does not support pointer placement. `?1000h` + `?1006h` preserves wheel
 * scroll for chat/history while leaving trackpad cursoring usable.
 */
export const MOUSE_SGR_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1006h";
export const TERMINAL_CLEANUP_SEQUENCE =
	"\x1b[<u" + // kitty keyboard pop
	"\x1b[>4;0m" + // xterm modifyOtherKeys off
	"\x1b[?2004l" + // bracketed paste off
	"\x1b[?1003l\x1b[?1006l\x1b[?1000l" + // mouse off
	"\x1b[?1049l" + // altscreen off
	"\x1b[?25h\x1b[0m"; // cursor visible + SGR reset

export interface TerminalOutput {
	readonly isTTY?: boolean;
	write(data: string): unknown;
}

export interface TerminalControllerOptions {
	readonly output?: TerminalOutput;
}

function isBrokenPipeError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPIPE";
}

/**
 * Owns the byte-level terminal mode transitions for sumo-tui.
 */
export class TerminalController {
	public restored = false;
	private readonly output: TerminalOutput;
	private brokenPipe = false;

	public constructor(options: TerminalControllerOptions = {}) {
		this.output = options.output ?? process.stdout;
	}

	/** Edge case 10.1: no-op terminal ownership when stdout is not a TTY. */
	public isTTY(): boolean {
		return this.output.isTTY === true;
	}

	public enterAltscreen(): void {
		if (!this.isTTY()) return;
		this.restored = false;
		this.write(ALTSCREEN_ENTER_SEQUENCE);
	}

	public enableMouseSGR(): void {
		if (!this.isTTY()) return;
		this.restored = false;
		this.write(MOUSE_SGR_ENABLE_SEQUENCE);
	}

	/**
	 * Restore every terminal mode that Pi/sumo-tui may have enabled. The order is
	 * intentional and covered by tests because Ctrl+C leakage has historically
	 * left shells in kitty keyboard / modifyOtherKeys mode.
	 */
	public exitTerminal(): void {
		if (this.restored) return;
		this.restored = true;
		if (!this.isTTY()) return;
		this.write(TERMINAL_CLEANUP_SEQUENCE);
	}

	private write(data: string): void {
		if (this.brokenPipe) return;
		try {
			this.output.write(data);
		} catch (error) {
			// Edge case 5.5: terminal/PTY disconnected. Nothing useful can be
			// written after EPIPE, so silence it and make future writes no-ops.
			if (isBrokenPipeError(error)) {
				this.brokenPipe = true;
				return;
			}
			throw error;
		}
	}
}
