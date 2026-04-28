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
export const CURSOR_COLOR_SET = "\x1b]12;#D97706\x1b\\";
export const CURSOR_COLOR_RESET = "\x1b]112\x1b\\";
// OSC 11 sets the terminal's default background color. Without this, cells
// outside our retained renderer's reach (Pi noise output, terminal cursor
// row, scrollback before altscreen, etc.) show as the terminal's own default
// (often pure black `#000000`), which makes the cathedral palette look wrong.
// Setting OSC 11 to cathedral `bg` (#1A1511) ensures every cell shares the
// same base, and the sidebar's `surface` (#241D17) reads as elevated above it.
// Reset on exit via OSC 111 so the user's normal terminal bg is restored.
export const TERMINAL_BG_SET = "\x1b]11;#1A1511\x1b\\";
export const TERMINAL_BG_RESET = "\x1b]111\x1b\\";
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

export interface TerminalCursor {
	readonly row: number;
	readonly col: number;
}

export interface TerminalPatch {
	readonly row: number;
	readonly ansi: string;
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

	public startRetainedSession(): void {
		this.enterAltscreen();
		this.enableMouseSGR();
	}

	public enterAltscreen(): void {
		if (!this.isTTY()) return;
		this.restored = false;
		// Order matters: enter altscreen first, set terminal-wide bg before any
		// content writes so empty regions read as cathedral bg, then set cursor
		// color so the input caret is accent orange.
		this.write(`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}${CURSOR_COLOR_SET}`);
	}

	public enableMouseSGR(): void {
		if (!this.isTTY()) return;
		this.restored = false;
		this.write(MOUSE_SGR_ENABLE_SEQUENCE);
	}

	public writeChatViewport(top: number, left: number, lines: readonly string[]): boolean {
		if (!this.isTTY() || lines.length === 0) return false;
		const safeTop = Math.max(0, Math.floor(top));
		const safeLeft = Math.max(0, Math.floor(left));
		let output = "\x1b[?2026h\x1b7";
		for (let row = 0; row < lines.length; row += 1) {
			output += `\x1b[${safeTop + row + 1};${safeLeft + 1}H${lines[row] ?? ""}`;
		}
		output += "\x1b8\x1b[?2026l";
		this.write(output);
		return true;
	}

	public writeFramePatches(patches: readonly TerminalPatch[], cursor: TerminalCursor | null): void {
		if (!this.isTTY() || (patches.length === 0 && !cursor)) return;
		let output = "\x1b[?2026h";
		for (const patch of patches) {
			output += `\x1b[${patch.row + 1};1H${patch.ansi}\x1b[K`;
		}
		if (cursor) output += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
		output += "\x1b[?2026l";
		this.write(output);
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
		// Reset cursor + bg colors before the rest of the cleanup so the user's
		// shell returns to its native palette.
		this.write(`${CURSOR_COLOR_RESET}${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`);
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
