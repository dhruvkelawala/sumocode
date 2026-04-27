/**
 * Terminal mode cleanup for SumoCode.
 *
 * Pi renders inline in terminal scrollback by default. That is intentional:
 * Pi does not currently provide OpenCode-style in-app scroll handling, so using
 * the alternate screen buffer (`\x1b[?1049h`) makes mouse-wheel scroll appear
 * broken. Keep normal scrollback as the default.
 *
 * Optional escape hatch: set `SUMOCODE_ALTSCREEN=1` to re-enable the previous
 * full-terminal altscreen takeover for local experimentation.
 *
 * Important: in altscreen, many terminals enable xterm alternate-scroll mode
 * (DEC private mode 1007), translating mouse-wheel scroll into cursor-up /
 * cursor-down keypresses. Pi's editor treats those keys as prompt-history
 * navigation. Disable 1007 while SumoCode owns fullscreen, then restore the
 * terminal default on exit.
 *
 * This module always restores terminal keyboard modes on session_shutdown /
 * process exit. That cleanup is needed even without altscreen because Pi enables
 * kitty keyboard protocol and xterm modifyOtherKeys while the TUI is active.
 *
 * Cleanup is belt-and-suspenders: on exit we send EVERY mode-pop sequence Pi's
 * terminal might have enabled (kitty keyboard, modifyOtherKeys, bracketed paste,
 * mouse tracking), restore alternate-scroll, then exit altscreen, then repeat
 * the keyboard cleanup on the main screen. Kitty keyboard mode stacks are
 * separate for main and alternate screens; Pi enables kitty before extensions
 * enter altscreen, so cleaning only inside altscreen leaves the shell in raw
 * kitty-keyboard mode. That causes input like `asd` to be rewritten as
 * `asd7;1:3u5;1:3u0;...` after exit.
 *
 * Safety:
 *   - session_shutdown handler restores normal screen + modes
 *   - process.on("exit") restores on normal exit
 *   - SIGINT / SIGTERM handlers restore before re-raising the signal
 *
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ALTSCREEN_ENTER = "\x1b[?1049h\x1b[?1007l\x1b[H";
const ALTSCREEN_ENABLED = process.env.SUMOCODE_ALTSCREEN === "1";

/**
 * Reset enhanced keyboard protocols for the currently active screen buffer.
 *
 * - `CSI < u` pops one kitty keyboard-protocol stack entry.
 * - `CSI = 0 u` hard-resets kitty progressive enhancement flags to zero.
 * - `CSI > 4 ; 0 m` disables xterm modifyOtherKeys mode 2.
 */
const KEYBOARD_RESTORE = "\x1b[<u\x1b[=0u\x1b[>4;0m";

/**
 * Mode restoration is sent on every shutdown path, even multiple times — every
 * pop is idempotent. In altscreen mode we must clean keyboard state twice:
 * once in the alternate screen and once after returning to the main screen.
 *
 * Without the main-screen `KEYBOARD_RESTORE`, the shell receives kitty-encoded
 * key events as garbled text after `/exit`.
 */
const COMMON_RESTORE = "\x1b[?2004l\x1b[?1003l\x1b[?1006l";
const MAIN_SCREEN_RESTORE = `${KEYBOARD_RESTORE}${COMMON_RESTORE}\x1b[?25h\x1b[0m`;

function terminalRestoreSequence(wasInAltscreen: boolean): string {
	if (!wasInAltscreen) return MAIN_SCREEN_RESTORE;
	return `${KEYBOARD_RESTORE}${COMMON_RESTORE}\x1b[?1007h\x1b[?1049l${MAIN_SCREEN_RESTORE}`;
}

let installed = false;
let restored = false;
let altscreenActive = false;

function restoreTerminal(): void {
	if (restored) return;
	try {
		process.stdout.write(terminalRestoreSequence(altscreenActive));
	} catch {
		// Ignore write errors during shutdown
	} finally {
		altscreenActive = false;
		restored = true;
	}
}

export function installAltscreen(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Reset the latched flag so we restore again on the *next* shutdown
		// even if a previous session in the same process already restored.
		restored = false;
		altscreenActive = ALTSCREEN_ENABLED;
		if (altscreenActive) process.stdout.write(ALTSCREEN_ENTER);
	});

	pi.on("session_shutdown", () => {
		restoreTerminal();
	});

	if (installed) return;
	installed = true;

	process.on("exit", restoreTerminal);

	// Handle Ctrl+C, kill, etc. — restore screen before re-raising the signal
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
		process.on(signal, () => {
			restoreTerminal();
			// Re-raise so Pi's own handlers can do their cleanup
			process.kill(process.pid, signal);
		});
	}

	// Catch crashes too
	process.on("uncaughtException", (err) => {
		restoreTerminal();
		// Let the normal handler print the error
		throw err;
	});
}
