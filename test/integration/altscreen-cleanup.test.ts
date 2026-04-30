import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_COLOR_RESET, CURSOR_COLOR_SET, TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

describe("sumo-tui altscreen cleanup integration", () => {
	it("exits altscreen, pops kitty keyboard, and shows cursor after SIGINT (EC-5.1)", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({ env: { PI_CODING_AGENT_DIR: agentDir } });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		app.sendSignal("SIGINT");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);

		const output = app.getOutput();
		const state = app.getCurrentTerminalState();
		// V2 Bible Element 4: accent cursor is applied on retained start and
		// must be reset on exit so the host shell regains its preferred cursor.
		expect(output).toContain(CURSOR_COLOR_SET);
		expect(output).toContain(CURSOR_COLOR_RESET);
		expect(state.cleanupSequenceSeen).toBe(true);
		expect(state.altscreenActive).toBe(false);
		expect(state.kittyKeyboardPopped).toBe(true);
		expect(state.cursorVisible).toBe(true);
	});
});
