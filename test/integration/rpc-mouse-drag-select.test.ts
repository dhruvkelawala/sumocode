import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const OSC52_PATTERN = /\x1b\]52;c;/;

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

async function replayTerminalRows(output: string, cols: number, rows: number): Promise<string[]> {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(output, () => resolve()));
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		let text = "";
		for (let col = 0; col < cols; col += 1) text += line?.getCell(col)?.getChars() ?? " ";
		lines.push(text);
	}
	return lines;
}

/** Locate the first (row, col) where `needle` starts in the replayed screen. */
function findAnchor(lines: readonly string[], needle: string): { row: number; col: number } {
	for (let row = 0; row < lines.length; row += 1) {
		const col = stripAnsi(lines[row] ?? "").indexOf(needle);
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

		const rowsBefore = await replayTerminalRows(app.getOutput(), cols, rows);
		const anchor = findAnchor(rowsBefore, "select proof anchor 05");
		const start = { row: anchor.row, col: anchor.col };
		const end = { row: anchor.row, col: anchor.col + "select proof anchor 05".length - 1 };

		app.sendInput(sgrPress(start.col, start.row));
		await delay(50);
		app.sendInput(sgrDrag(end.col, end.row));
		await delay(50);
		app.sendInput(sgrRelease(end.col, end.row));
		await delay(300);

		const rawOutput = app.getOutput();
		expect(rawOutput).toMatch(OSC52_PATTERN);

		const rowsAfter = await replayTerminalRows(app.getOutput(), cols, rows);
		// The drag must not have scrolled the transcript: the same anchor text
		// (the last, bottom-most message) is still on screen at the same row.
		const anchorAfter = findAnchor(rowsAfter, "select proof anchor 05");
		expect(anchorAfter.row).toBe(anchor.row);
		expect(app.getCurrentTerminalState().mouseSGRActive).toBe(true);
	});
});
