import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { replayScreenRows, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

const OSC52_PATTERN = /\x1b\]52;c;/;

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

/** Locate the first (row, col) where `needle` starts in the replayed screen. */
function findAnchor(lines: readonly string[], needle: string): { row: number; col: number } {
	for (let row = 0; row < lines.length; row += 1) {
		const col = (lines[row] ?? "").indexOf(needle);
		if (col >= 0) return { row, col };
	}
	throw new Error(`anchor not found on screen: ${needle}`);
}

/** SGR mouse press/drag/release sequences (1-based row/col per the SGR protocol). */
function sgrPress(col: number, row: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}
function sgrDrag(col: number, row: number): string {
	return `\x1b[<32;${col + 1};${row + 1}M`;
}
function sgrRelease(col: number, row: number): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

describe("sumocode RPC mouse drag-select + OSC52 clipboard", () => {
	it("turns an SGR drag press/move/release over a chat text row into an OSC52 clipboard write, and does not scroll", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-drag-child-", {
			sessionName: "Drag Fixture",
			messages: transcriptMessages(6, "select proof"),
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-drag-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(MOUSE_SGR_ENABLE_SEQUENCE, 15_000);
		await app.waitForOutput("select proof anchor 05", 15_000);

		const rowsBefore = await replayScreenRows(app.getOutput(), cols, rows);
		const anchor = findAnchor(rowsBefore, "select proof anchor 05");
		const start = { row: anchor.row, col: anchor.col };
		const end = { row: anchor.row, col: anchor.col + "select proof anchor 05".length - 1 };

		// The selection state machine consumes press/drag/release in input
		// order even when they arrive in one PTY read, so no pacing sleeps
		// are needed between the three events.
		app.sendInput(sgrPress(start.col, start.row));
		app.sendInput(sgrDrag(end.col, end.row));
		app.sendInput(sgrRelease(end.col, end.row));

		// The OSC52 clipboard write happens as the release is processed --
		// wait for the sequence itself instead of sleeping.
		await app.waitForOutput(OSC52_PATTERN, 5_000);

		// The drag must not have scrolled the transcript: the same anchor text
		// (the last, bottom-most message) is still on screen at the same row
		// on a frame that stayed stable for two consecutive polls.
		const settled = await waitForScreen(
			app,
			(screen) => screen.rows.some((row) => row.includes("select proof anchor 05")),
			{ cols, rows, timeoutMs: 5_000 },
		);
		const anchorAfter = findAnchor(settled.rows, "select proof anchor 05");
		expect(anchorAfter.row).toBe(anchor.row);
		expect(app.getCurrentTerminalState().mouseSGRActive).toBe(true);
	});
});
