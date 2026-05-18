import { describe, expect, it, vi } from "vitest";
import {
	ALTSCREEN_ENTER_SEQUENCE,
	CURSOR_COLOR_RESET,
	CURSOR_COLOR_SET,
	defaultTerminalSessionOwner,
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
		expect(output.writes[0]).toBe(
			"\x1b[?1049h\x1b[?2004h\x1b[>7u\x1b[>4;2m\x1b[?25h\x1b[H\x1b]11;#1A1511\x1b\\",
		);
		// Bracketed paste, kitty keyboard, and modifyOtherKeys must all be pushed
		// on altscreen entry so modified Enter keys (Shift+Enter, Alt+Enter, etc.)
		// remain distinguishable inside altscreen. Pi-tui pushes these on the main
		// screen at startup; without re-pushing here the altscreen stack starts
		// at flags=0 and Shift+Enter collapses to plain `\r`.
		expect(output.writes[0]).toContain("\x1b[>7u");
		expect(output.writes[0]).toContain("\x1b[>4;2m");
		expect(output.writes[0]).toContain("\x1b[?2004h");
		expect(output.writes[0]).not.toContain("\x1b]12;");
	});

	it("altscreen enter/cleanup pair is symmetric for keyboard modes (#201)", () => {
		// Regression guard for the Shift+Enter altscreen-entry bug. Kitty keyboard
		// mode and xterm modifyOtherKeys are per-screen; cleanup pops them on the
		// way out of altscreen, so the enter sequence must push them on the way
		// in. Without this pairing, modified Enter keys collapse to plain `\r`
		// inside altscreen and Shift+Enter silently submits.
		expect(ALTSCREEN_ENTER_SEQUENCE).toContain("\x1b[>7u");
		expect(TERMINAL_CLEANUP_SEQUENCE).toContain("\x1b[<u");
		expect(ALTSCREEN_ENTER_SEQUENCE).toContain("\x1b[>4;2m");
		expect(TERMINAL_CLEANUP_SEQUENCE).toContain("\x1b[>4;0m");
		expect(ALTSCREEN_ENTER_SEQUENCE).toContain("\x1b[?2004h");
		expect(TERMINAL_CLEANUP_SEQUENCE).toContain("\x1b[?2004l");
	});

	it("defaultTerminalSessionOwner is a globalThis-pinned singleton (#199)", () => {
		// Regression guard: jiti can evaluate this module multiple times per
		// process, and a plain module-level `const` would give each evaluation
		// its own `defaultTerminalSessionOwner` with its own `restored` flag.
		// The lifecycle would call `exitTerminal` on instance A while the
		// OwnedShellRenderer rendered through instance B, and PR #200's guard
		// would silently miss the leak.
		//
		// The contract is "the value is stored on globalThis under a stable
		// key, so any future module evaluation finds and reuses it". Verify
		// directly: the export must be the same object globalThis holds, and
		// re-evaluating the export expression must yield that same object.
		const pinned = (globalThis as { __sumoDefaultTerminalSessionOwner?: TerminalSessionOwner })
			.__sumoDefaultTerminalSessionOwner;
		expect(pinned).toBeDefined();
		expect(pinned).toBe(defaultTerminalSessionOwner);
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
		expect(output.writes[0]).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
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

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[2;1H\x1b[Khello\x1b[3;5H\x1b[?25h\x1b[?2026l"]);
	});

	it("drops writes after exitTerminal so post-cleanup renders cannot leak into main screen", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.startRetainedSession();
		terminal.exitTerminal();
		output.writes.length = 0;

		terminal.writeFramePatches([{ row: 0, ansi: "splash bytes" }], { row: 0, col: 0 });
		expect(terminal.writeChatViewport(0, 0, ["chat line"])).toBe(false);
		expect(terminal.writeClipboardSequence("\x1b]52;c;abc\x1b\\")).toBe(false);

		expect(output.writes).toEqual([]);
	});

	it("clears full-row patches before drawing so the final column is not erased", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([{ row: 0, ansi: "abc" }], null);

		expect(output.writes[0]).toContain("\x1b[1;1H\x1b[Kabc");
		expect(output.writes[0]).not.toContain("abc\x1b[K");
	});

	it("emits a partial-row patch without \\x1b[K when startCol > 0", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([{ row: 1, startCol: 4, ansi: "DEF" }], { row: 0, col: 0 });

		// Partial patches MUST skip clear-to-end-of-line so cells right of the
		// change region survive untouched. Cursor position 5 (= startCol + 1).
		expect(output.writes).toEqual(["\x1b[?2026h\x1b[2;5HDEF\x1b[1;1H\x1b[?25h\x1b[?2026l"]);
		expect(output.writes[0]).not.toContain("\x1b[K");
	});

	it("emits scroll patches without line clearing", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([{ row: 0, type: "scroll", ansi: "\x1b[1;3r\x1b[1S\x1b[r" }], { row: 0, col: 0 });

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[1;1H\x1b[1;3r\x1b[1S\x1b[r\x1b[1;1H\x1b[?25h\x1b[?2026l"]);
		expect(output.writes[0]).not.toContain("\x1b[K");
	});

	it("hides the cursor when a null-cursor frame has no patches", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([], null);

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[?25l\x1b[?2026l"]);
		output.writes.length = 0;

		// Once hidden, a repeated no-patch/null-cursor frame is a true no-op.
		terminal.writeFramePatches([], null);
		expect(output.writes).toEqual([]);
	});

	it("lazy frame-start: emits zero bytes when the cursor lands on its last-emitted position", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// First call emits the cursor; cache lastEmittedCursor = (2, 4).
		terminal.writeFramePatches([], { row: 2, col: 4 });
		expect(output.writes.length).toBe(1);

		// Second call with same cursor + no patches → no bytes.
		terminal.writeFramePatches([], { row: 2, col: 4 });
		expect(output.writes.length).toBe(1);
	});

	it("re-emits cursor after every patch frame even when the logical cursor is unchanged", () => {
		// Correctness gate: the patch loop physically moves the terminal cursor
		// to each patched row via `\x1b[r;cH`, so skipping the final cursor
		// reposition would leave the caret parked at the end of the last patch.
		// Cursor-write elision is only safe for true no-op frames.
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([{ row: 0, ansi: "hello" }], { row: 2, col: 4 });
		output.writes.length = 0;

		terminal.writeFramePatches([{ row: 1, ansi: "world" }], { row: 2, col: 4 });

		// The cursor reposition (`\x1b[3;5H\x1b[?25h`) MUST appear even though
		// the logical cursor didn't move, because the patch above moved the
		// terminal cursor to row 2.
		expect(output.writes).toEqual(["\x1b[?2026h\x1b[2;1H\x1b[Kworld\x1b[3;5H\x1b[?25h\x1b[?2026l"]);
	});

	it("emits ONLY cursor reposition when patches=0 but cursor moved (no wrapper savings, but no patches either)", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// Seed lastEmittedCursor with the first call, then move cursor only.
		terminal.writeFramePatches([], { row: 0, col: 0 });
		output.writes.length = 0;

		terminal.writeFramePatches([], { row: 5, col: 10 });

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[6;11H\x1b[?25h\x1b[?2026l"]);
	});

	it("invalidates the cursor cache when emitting a null cursor", () => {
		// Regression: the terminal cursor can be hidden while the logical cursor
		// cache still points at the previous visible editor cursor. Failing to
		// invalidate `lastEmittedCursor` here would let the next frame (with a
		// cursor matching the stale cache) early-return and leave the caret hidden
		// or parked at the end of the last patch.
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// Frame A: seed the cache with cursor (5, 10).
		terminal.writeFramePatches([{ row: 0, ansi: "a" }], { row: 5, col: 10 });

		// Frame B: patches with null cursor. Patch loop moves the terminal
		// cursor; logical cursor isn't tracked. Cache MUST be invalidated.
		terminal.writeFramePatches([{ row: 1, ansi: "b" }], null);
		output.writes.length = 0;

		// Frame C: same logical cursor as frame A. With the bug, this would
		// early-return because cursorMoved=false against the stale cache.
		// With the fix, cache was nulled by frame B, so cursorMoved=true and
		// we re-emit the cursor reposition.
		terminal.writeFramePatches([], { row: 5, col: 10 });

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[6;11H\x1b[?25h\x1b[?2026l"]);
	});

	it("invalidates the cursor cache when a null-cursor frame has no patches", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// Frame A: seed a visible cursor.
		terminal.writeFramePatches([], { row: 3, col: 7 });
		output.writes.length = 0;

		// Frame B: metadata-only transition to no cursor. Must hide and invalidate
		// even though the cell buffer did not change.
		terminal.writeFramePatches([], null);
		expect(output.writes).toEqual(["\x1b[?2026h\x1b[?25l\x1b[?2026l"]);
		output.writes.length = 0;

		// Frame C: same cursor position as frame A. Must re-show/reposition; if the
		// cache was stale, this would incorrectly early-return.
		terminal.writeFramePatches([], { row: 3, col: 7 });
		expect(output.writes).toEqual(["\x1b[?2026h\x1b[4;8H\x1b[?25h\x1b[?2026l"]);
	});

	it("writes patches on subsequent overlay frames after cursor is already hidden", () => {
		// Regression: when `hardwareCursorVisible` is already false (cursor hidden
		// by a previous overlay frame), the null-cursor branch must still write
		// frame content. Early-returning would drop all patch bytes, freezing
		// overlay updates after the first frame.
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// Frame A: patch with null cursor — hides cursor, writes "overlay A".
		terminal.writeFramePatches([{ row: 5, ansi: "overlay A" }], null);
		expect(output.writes[0]).toContain("\x1b[?25l");
		expect(output.writes[0]).toContain("overlay A");
		output.writes.length = 0;

		// Frame B: patch with null cursor, already hidden. Must still write.
		terminal.writeFramePatches([{ row: 5, ansi: "overlay B" }], null);
		expect(output.writes).toHaveLength(1);
		expect(output.writes[0]).toContain("overlay B");
		expect(output.writes[0]).not.toContain("\x1b[?25l"); // no redundant hide
	});

	it("resets hardwareCursorVisible on terminal exit so next session doesn't skip hide", () => {
		// exitTerminal() emits \x1b[?25h in its cleanup sequence but wasn't
		// syncing hardwareCursorVisible. A prior session that hid the cursor
		// leaves the flag stale, so the next session's first overlay frame
		// skips \x1b[?25l (thinking it's already hidden) and the cursor bleeds.
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		// Simulate a session that hid the cursor.
		terminal.writeFramePatches([{ row: 5, ansi: "x" }], null);
		expect(output.writes[0]).toContain("\x1b[?25l");
		terminal.exitTerminal();
		output.writes.length = 0;

		// New session: first frame with null cursor — must emit hide.
		terminal.enterAltscreen();
		output.writes.length = 0;
		terminal.writeFramePatches([{ row: 1, ansi: "fresh" }], null);
		expect(output.writes).toHaveLength(1);
		expect(output.writes[0]).toContain("\x1b[?25l");
	});

	it("re-emits cursor after exitTerminal clears lastEmittedCursor", () => {
		const output = outputStub();
		const terminal = new TerminalSessionOwner({ output });

		terminal.writeFramePatches([], { row: 2, col: 4 });
		terminal.exitTerminal();
		// After exit, lastEmittedCursor must be reset so re-entering altscreen
		// re-emits cursor sequences.
		output.writes.length = 0;

		// Simulate fresh session re-entering: re-set isTTY by creating a new
		// owner referencing the same output. (`exitTerminal` flips internal
		// state; we just want to confirm a subsequent write emits cursor.)
		const next = new TerminalSessionOwner({ output });
		next.writeFramePatches([], { row: 2, col: 4 });

		expect(output.writes).toEqual(["\x1b[?2026h\x1b[3;5H\x1b[?25h\x1b[?2026l"]);
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

	it.each(["EPIPE", "EIO", "ENOTTY"] as const)("catches %s silently and suppresses later writes (EC-5.5)", (code) => {
		const write = vi.fn(() => {
			const error = new Error(code) as NodeJS.ErrnoException;
			error.code = code;
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
