/**
 * Altscreen mode for SumoCode (Pi-runtime hack).
 *
 * Pi renders inline in the terminal scrollback by default — the cathedral
 * UI ends up filling only the rows it actively renders, leaving the rest of
 * the terminal blank. OpenCode and other full-screen TUIs use the alternate
 * screen buffer (`\x1b[?1049h`) to take over the entire terminal viewport.
 *
 * Important: in altscreen, many terminals enable xterm alternate-scroll mode
 * (DEC private mode 1007), translating mouse-wheel scroll into cursor-up /
 * cursor-down keypresses. Pi's editor treats those keys as prompt-history
 * navigation. Disable 1007 while SumoCode owns fullscreen, then restore the
 * terminal default on exit.
 *
 * This module enables altscreen on session_start and restores normal screen
 * on session_shutdown / process exit. Pi's renderer happens to tolerate
 * being inside altscreen mode because it uses absolute cursor positioning,
 * not scroll-relative.
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
 * If altscreen ever causes display corruption, comment out the
 * `installAltscreen(pi)` call in extension.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ALTSCREEN_ENTER = "\x1b[?1049h\x1b[?1007l\x1b[H";

/**
 * Reset enhanced keyboard protocols for the currently active screen buffer.
 *
 * - `CSI < u` pops one kitty keyboard-protocol stack entry.
 * - `CSI = 0 u` hard-resets kitty progressive enhancement flags to zero.
 * - `CSI > 4 ; 0 m` disables xterm modifyOtherKeys mode 2.
 */
const KEYBOARD_RESTORE = "\x1b[<u\x1b[=0u\x1b[>4;0m";

/**
 * Full mode-restoration sequence. Sent on every shutdown path, even multiple
 * times — every pop is idempotent. Order:
 *
 *   1. `KEYBOARD_RESTORE` — reset kitty/modifyOtherKeys in alt screen
 *   2. `\x1b[?2004l`     — disable bracketed paste mode (Pi enables it)
 *   3. `\x1b[?1003l`     — disable any-event mouse tracking
 *   4. `\x1b[?1006l`     — disable SGR-extended mouse coords
 *   5. `\x1b[?1007h`     — restore xterm alternate-scroll default
 *   6. `\x1b[?1049l`     — exit alternate screen buffer
 *   7. `KEYBOARD_RESTORE` — reset kitty/modifyOtherKeys in main screen
 *   8. `\x1b[?25h`       — show cursor (in case anyone hid it)
 *   9. `\x1b[0m`         — reset SGR (clear any leaked colors)
 *
 * Without (1) the shell receives kitty-encoded key events as garbled text.
 */
const TERMINAL_RESTORE = `${KEYBOARD_RESTORE}\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[?1007h\x1b[?1049l${KEYBOARD_RESTORE}\x1b[?25h\x1b[0m`;

let installed = false;
let restored = false;

function restoreTerminal(): void {
	if (restored) return;
	restored = true;
	try {
		process.stdout.write(TERMINAL_RESTORE);
	} catch {
		// Ignore write errors during shutdown
	}
}

export function installAltscreen(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Reset the latched flag so we restore again on the *next* shutdown
		// even if a previous session in the same process already restored.
		restored = false;
		process.stdout.write(ALTSCREEN_ENTER);
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
