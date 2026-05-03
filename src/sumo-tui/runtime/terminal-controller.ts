/**
 * Terminal lifecycle owner for sumo-tui.
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
 * Enable click/wheel/drag mouse reporting in SGR format without xterm any-event
 * motion tracking. `?1003h` makes Mac trackpads feel "captured" because mere
 * finger hover/movement is turned into app mouse events even when the editor
 * does not support pointer placement. `?1000h` + `?1002h` + `?1006h` preserves
 * wheel scroll and button-drag selection while leaving trackpad cursoring usable.
 */
export const MOUSE_SGR_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_SGR_DISABLE_SEQUENCE = "\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l";
export const TERMINAL_CLEANUP_SEQUENCE =
	"\x1b[<u" + // kitty keyboard pop
	"\x1b[>4;0m" + // xterm modifyOtherKeys off
	"\x1b[?2004l" + // bracketed paste off
	MOUSE_SGR_DISABLE_SEQUENCE + // mouse off
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
	/**
	 * Column offset (0-indexed) where this patch starts. Defaults to 0 for
	 * full-row repaints. When > 0 the writer emits ONLY the slice and skips
	 * line clearing so unchanged cells to the right are preserved.
	 */
	readonly startCol?: number;
	readonly ansi: string;
	/** Scroll-region patches carry cursor/control sequences, not row content. */
	readonly type?: "row" | "scroll";
}

export interface TerminalSessionOwnerOptions {
	readonly output?: TerminalOutput;
	/** Paint the terminal default bg via OSC 11 while retained mode is active. */
	readonly paintBackground?: boolean;
}

export interface TerminalSessionOwnerState {
	readonly altscreenActive: boolean;
	readonly mouseSGREnabled: boolean;
	readonly backgroundPainted: boolean;
	readonly cursorColorOverridden: boolean;
	readonly restored: boolean;
}

function isBrokenPipeError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPIPE";
}

function cursorColorSetSequence(hex: string): string {
	return `\x1b]12;${hex}\x1b\\`;
}

/**
 * Single state machine for retained terminal lifecycle.
 *
 * It owns altscreen, mouse mode, terminal background paint, explicit cursor
 * color overrides, and cleanup. Multiple callers may request retained mode
 * (the Pi lifecycle shim and the retained runtime currently both do during the
 * hybrid phase), but duplicate writes are suppressed until cleanup runs.
 */
export class TerminalSessionOwner {
	public restored = false;
	private readonly output: TerminalOutput;
	private readonly paintBackground: boolean;
	private brokenPipe = false;
	private altscreenActive = false;
	private mouseSGREnabled = false;
	private backgroundPainted = false;
	private cursorColorOverridden = false;
	private lastCursorColor: string | undefined;
	/**
	 * Last cursor position we emitted to the terminal. Used to skip redundant
	 * cursor-reposition writes when the frame doesn't move the cursor. Reset
	 * on `exitTerminal` so a re-entered altscreen always re-emits.
	 *
	 * Borrowed from OpenTUI's renderer (`zig/renderer.zig` ~1180): a
	 * "lastEmittedCursor" cache that pairs with the lazy frame-start to
	 * suppress no-op ticks entirely.
	 */
	private lastEmittedCursor: TerminalCursor | null = null;
	/** Tracks whether we last emitted \x1b[?25h or \x1b[?25l so we don't re-emit the same. */
	private hardwareCursorVisible = true;

	public constructor(options: TerminalSessionOwnerOptions = {}) {
		this.output = options.output ?? process.stdout;
		this.paintBackground = options.paintBackground ?? true;
	}

	/** Edge case 10.1: no-op terminal ownership when stdout is not a TTY. */
	public isTTY(): boolean {
		return this.output.isTTY === true;
	}

	public getState(): TerminalSessionOwnerState {
		return {
			altscreenActive: this.altscreenActive,
			mouseSGREnabled: this.mouseSGREnabled,
			backgroundPainted: this.backgroundPainted,
			cursorColorOverridden: this.cursorColorOverridden,
			restored: this.restored,
		};
	}

	public startRetainedSession(): void {
		this.enterAltscreen();
		this.enableMouseSGR();
		// V2 Bible Element 4 calls for an accent-colored cursor block. Apply OSC 12
		// at startup so the runtime matches the mockup; users can opt out via
		// `/sumo:cursor reset` which restores the terminal default.
		this.setCursorColor();
	}

	public enterAltscreen(): void {
		if (!this.isTTY() || this.altscreenActive) return;
		this.restored = false;
		let output = ALTSCREEN_ENTER_SEQUENCE;
		if (this.paintBackground) {
			output += TERMINAL_BG_SET;
			this.backgroundPainted = true;
		}
		// V2 contract: do not emit OSC 12 cursor color during normal startup.
		this.write(output);
		this.altscreenActive = true;
	}

	public enableMouseSGR(): void {
		if (!this.isTTY() || this.mouseSGREnabled) return;
		this.restored = false;
		this.write(MOUSE_SGR_ENABLE_SEQUENCE);
		this.mouseSGREnabled = true;
	}

	/** Explicit cursor-color override hook for `/sumo:cursor accent`. */
	public setCursorColor(hex = "#D97706"): void {
		if (!this.isTTY()) return;
		this.restored = false;
		if (this.cursorColorOverridden && this.lastCursorColor === hex) return;
		this.write(cursorColorSetSequence(hex));
		this.cursorColorOverridden = true;
		this.lastCursorColor = hex;
	}

	/** Explicit cursor-color reset hook for `/sumo:cursor reset`. */
	public resetCursorColor(): void {
		if (!this.isTTY()) return;
		this.write(CURSOR_COLOR_RESET);
		this.cursorColorOverridden = false;
		this.lastCursorColor = undefined;
	}

	public writeChatViewport(top: number, left: number, lines: readonly string[]): boolean {
		if (!this.isTTY() || this.restored || lines.length === 0) return false;
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

	public writeClipboardSequence(sequence: string): boolean {
		if (!this.isTTY() || this.restored || sequence.length === 0) return false;
		this.write(sequence);
		return true;
	}

	public writeFramePatches(patches: readonly TerminalPatch[], cursor: TerminalCursor | null): void {
		if (!this.isTTY() || this.restored) return;
		// Lazy frame-start (OpenTUI port, see `lastEmittedCursor` comment): if no
		// cells changed AND the cursor would land where it already is, emit zero
		// bytes. Otherwise wrap the patches in `\x1b[?2026h … \x1b[?2026l` for a
		// synchronized atomic frame.
		const cursorMoved = cursor !== null && (
			this.lastEmittedCursor === null ||
			cursor.row !== this.lastEmittedCursor.row ||
			cursor.col !== this.lastEmittedCursor.col
		);
		const shouldHideCursor = cursor === null && this.hardwareCursorVisible;
		if (patches.length === 0 && !cursorMoved && !shouldHideCursor) return;

		let output = "\x1b[?2026h";
		for (const patch of patches) {
			const startCol = patch.startCol ?? 0;
			output += `\x1b[${patch.row + 1};${startCol + 1}H`;
			// Full-row content patches still benefit from clearing stale cells, but
			// the clear must happen BEFORE the row is drawn. Clearing after drawing a
			// retained row that reaches the final terminal column can erase that final
			// styled cell in pending-wrap state, leaving a one-column black strip at the
			// right edge of owned-shell surfaces (sidebar/input). Partial-row patches
			// (`startCol > 0`) MUST NOT clear or they would wipe correct cells to the
			// right. Scroll patches carry terminal control sequences, not row content.
			if (startCol === 0 && patch.type !== "scroll") output += "\x1b[K";
			output += patch.ansi;
		}
		// Cursor-write elision is safe ONLY for true no-op frames. When
		// `patches.length > 0`, every `\x1b[r;c+1H<ansi>` in the loop above
		// physically moved the terminal cursor; skipping the reposition here
		// would leave the visible caret parked at the end of the last patch
		// instead of at `cursor`. Always re-emit when patches were written.
		if (cursor && (patches.length > 0 || cursorMoved)) {
			output += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
			this.lastEmittedCursor = { row: cursor.row, col: cursor.col };
			this.hardwareCursorVisible = true;
		} else if (cursor === null) {
			// No logical cursor is present (for example an overlay frame). Invalidate
			// the cache even without patches: the next non-null cursor frame must
			// re-emit its position/visibility, even if it matches the last visible
			// editor cursor.
			this.lastEmittedCursor = null;
			if (this.hardwareCursorVisible) {
				output += "\x1b[?25l";
				this.hardwareCursorVisible = false;
			}
		}
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
		const shouldResetCursorColor = this.cursorColorOverridden;
		const shouldResetBackground = this.backgroundPainted;
		this.altscreenActive = false;
		this.mouseSGREnabled = false;
		this.backgroundPainted = false;
		this.cursorColorOverridden = false;
		this.lastCursorColor = undefined;
		this.lastEmittedCursor = null;
		this.hardwareCursorVisible = true;
		if (!this.isTTY()) return;
		let output = "";
		if (shouldResetCursorColor) output += CURSOR_COLOR_RESET;
		if (shouldResetBackground) output += TERMINAL_BG_RESET;
		output += TERMINAL_CLEANUP_SEQUENCE;
		this.write(output);
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

/**
 * Backwards-compatible name for the old low-level seam. New code should depend
 * on `TerminalSessionOwner`; this alias remains for existing imports/tests.
 */
export class TerminalController extends TerminalSessionOwner {}

export const defaultTerminalSessionOwner = new TerminalSessionOwner();
