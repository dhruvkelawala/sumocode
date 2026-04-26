/**
 * Altscreen mode for SumoCode (Pi-runtime hack).
 *
 * Pi renders inline in the terminal scrollback by default — the cathedral
 * UI ends up filling only the rows it actively renders, leaving the rest of
 * the terminal blank. OpenCode and other full-screen TUIs use the alternate
 * screen buffer (`\x1b[?1049h`) to take over the entire terminal viewport.
 *
 * This module enables altscreen on session_start and restores normal screen
 * on session_shutdown / process exit. Pi's renderer happens to tolerate
 * being inside altscreen mode because it uses absolute cursor positioning,
 * not scroll-relative.
 *
 * Safety:
 *   - session_shutdown handler restores normal screen
 *   - process.on("exit") restores on normal exit
 *   - SIGINT / SIGTERM handlers restore before re-raising the signal
 *
 * If altscreen ever causes display corruption, comment out the
 * `installAltscreen(pi)` call in extension.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ALTSCREEN_ENTER = "\x1b[?1049h\x1b[H";
const ALTSCREEN_EXIT = "\x1b[?1049l";

let installed = false;

function exitAltscreen(): void {
	try {
		process.stdout.write(ALTSCREEN_EXIT);
	} catch {
		// Ignore write errors during shutdown
	}
}

export function installAltscreen(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		process.stdout.write(ALTSCREEN_ENTER);
	});

	pi.on("session_shutdown", () => {
		exitAltscreen();
	});

	if (installed) return;
	installed = true;

	process.on("exit", exitAltscreen);

	// Handle Ctrl+C, kill, etc. — restore screen before re-raising the signal
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
		process.on(signal, () => {
			exitAltscreen();
			// Re-raise so Pi's own handlers can do their cleanup
			process.kill(process.pid, signal);
		});
	}

	// Catch crashes too
	process.on("uncaughtException", (err) => {
		exitAltscreen();
		// Let the normal handler print the error
		throw err;
	});
}
