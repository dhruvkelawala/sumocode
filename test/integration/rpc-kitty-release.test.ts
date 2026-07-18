import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

// Regression test for the Kitty keyboard-protocol double-insertion bug: the
// terminal controller pushes Kitty flags 1+2+4 (report event types included,
// WITHOUT flag 8 "report all keys as escape codes"). Under that flag
// combination a real Kitty-protocol terminal still sends printable key
// PRESSES as plain characters (flag 8 is what would upgrade presses to
// CSI-u); only releases and repeats of printable keys are escalated to CSI-u
// (`\x1b[<codepoint>;<mods>:<event>u`). pi-tui's own TUI input loop drops
// releases (`tui.js`: "Filter out key release events unless component opts
// in"), but the RPC host bypasses that loop and reads stdin directly through
// SharedInputRouter, which had no equivalent filter. Because
// `Editor.handleInput` decodes CSI-u sequences via `decodePrintableKey` /
// `decodeKittyPrintable` — which extracts the codepoint and ignores the
// event-type suffix — an unfiltered release sequence decodes to the *same*
// character as its press and gets inserted a second time.
//
// Plain byte injection (as most integration tests use) never exercises this:
// only a plain-char press followed by an explicit CSI-u release, as a real
// Kitty terminal at flags 1+2+4 would send, can reproduce it.

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a Kitty CSI-u release sequence (flag 2 report-event-types, event=3). */
function kittyRelease(char: string): string {
	return `\x1b[${char.charCodeAt(0)};1:3u`;
}

/**
 * Type a word as plain-char press + CSI-u release pairs, exactly as a real
 * Kitty terminal at flags 1+2+4 (no flag 8) would send for printable keys.
 */
function typeWordAsPlainPressWithKittyRelease(app: SpawnedPiPty, word: string): void {
	for (const char of word) {
		app.sendInput(char);
		app.sendInput(kittyRelease(char));
	}
}

describe("sumocode RPC host Kitty key-release filtering", () => {
	it("does not double-insert characters when the terminal sends a plain press followed by a Kitty release", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-kitty-release-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);

		typeWordAsPlainPressWithKittyRelease(app, "hello");
		const screen = await waitForScreen(app, ({ text }) => text.includes("hello"), { cols: 100, rows: 30, timeoutMs: 5_000 });
		await delay(300);

		// The doubled form ("hheelllloo") must never appear; only the exact
		// single-typed word should be present in the rendered draft. Assert the
		// replayed screen rather than raw ANSI bytes because the retained renderer
		// can repaint the draft as "he" + cursor update + "llo".
		expect(screen.text).not.toContain("hheelllloo");
		expect(screen.text).toContain("hello");
	}, 30_000);

	it("still delivers a key press and does not leak raw escape garbage from a release/repeat sequence", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-kitty-repeat-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);

		// Plain press, then two CSI-u repeat events (event type 2), then a
		// CSI-u release. Whether the repeats themselves insert additional
		// characters requires kitty-active CSI-u decoding of printable keys,
		// which is out of scope here — that is plan 030's job. This test only
		// asserts the scope of this plan: the initial press lands, the
		// release contributes nothing, and no raw escape text leaks onto the
		// screen.
		app.sendInput("h");
		app.sendInput(`\x1b[104;1:2u`);
		app.sendInput(`\x1b[104;1:2u`);
		app.sendInput(kittyRelease("h"));
		const screen = await waitForScreen(app, ({ text }) => text.includes("h"), { cols: 100, rows: 30, timeoutMs: 5_000 });
		await delay(300);

		expect(screen.text).toContain("h");
		expect(screen.text).not.toContain("[104");
		expect(screen.text).not.toContain(":2u");
	}, 30_000);
});
