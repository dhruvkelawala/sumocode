import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

interface ReplayedCursor {
	readonly row: number;
	readonly col: number;
}

async function replayCursor(output: string, cols = 100, rows = 30): Promise<ReplayedCursor> {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(output, () => resolve()));
	const buffer = term.buffer.active;
	return { row: buffer.cursorY, col: buffer.cursorX };
}

async function waitForCursorVisible(pty: SpawnedPiPty): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (pty.getCurrentTerminalState().cursorVisible) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for hardware cursor to become visible. Last output: ${JSON.stringify(pty.getOutput().slice(-1200))}`);
}

async function waitForCursorAdvance(pty: SpawnedPiPty, previousColumn: number, text: string): Promise<number> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const output = pty.getOutput();
		const { col } = await replayCursor(output);
		// Replay-based cursor extraction is deterministic regardless of whether
		// the renderer paints via Pi's `\x1b[<col>G` form or SumoTUI's owned-shell
		// `\x1b[<row>;<col>H` synchronized patches.
		if (col > previousColumn) return col;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for visible cursor after ${JSON.stringify(text)}. Last output: ${JSON.stringify(pty.getOutput().slice(-1200))}`);
}

describe("sumo-tui cursor visibility integration", () => {
	it("shows the hardware cursor and advances it with each typed character", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_HARDWARE_CURSOR: "1",
				SUMO_TUI: "1",
				SUMO_TUI_HIDE_PI_NOISE: "1",
				SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
			},
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);
		await waitForCursorVisible(app);
		expect(app.getCurrentTerminalState().cursorVisible).toBe(true);

		// Warm up: the empty editor renders with placeholder text
		// ("Ask anything... \"Refactor the auth flow.\"") which sits past the
		// prompt prefix. The cursor starts at the END of the placeholder. The
		// first real keystroke clears the placeholder and the cursor snaps back
		// to the start of the line. Subsequent keystrokes move the cursor right.
		app.sendInput("_");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const output = app.getOutput();
		let previousColumn = await replayCursor(output).then((c) => c.col);
		expect(previousColumn).toBeGreaterThan(0);

		let typed = "_";
		for (const char of "ZQXJW") {
			typed += char;
			app.sendInput(char);
			const nextColumn = await waitForCursorAdvance(app, previousColumn, typed);
			expect(nextColumn).toBeGreaterThan(previousColumn);
			previousColumn = nextColumn;
			expect(app.getCurrentTerminalState().cursorVisible).toBe(true);
		}
	}, 30_000);
});
