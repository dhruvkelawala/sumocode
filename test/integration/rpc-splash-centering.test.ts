import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { INPUT_FRAME_HINT_KEYBINDS } from "../../src/cathedral/input-frame.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

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

const EXPECTED_100X30_SPLASH = {
	catTopRow: 1,
	catBottomRow: 10,
	wordmarkTopRow: 14,
	wordmarkBottomRow: 18,
	inputFrameTopRow: 22,
	hintRow: 26,
	versionRow: 28,
};

function rowIndexes(lines: readonly string[], predicate: (line: string) => boolean): number[] {
	return lines.flatMap((line, row) => predicate(line) ? [row] : []);
}

function containsCatFaceGlyph(line: string): boolean {
	return /[▗▆▄▁▐▏▀▂▕▍▇▙▃▊▟▞▜▛▘▔]/.test(line);
}

describe("sumocode RPC splash centering", () => {
	it("keeps the empty-state splash vertically centered at 100x30", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-splash-child-");
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-splash-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		await app.waitForOutput("SUMOCODE V", 5_000);

		const lines = await replayTerminalRows(app.getOutput(), cols, rows);
		const catRows = rowIndexes(lines, containsCatFaceGlyph);
		const wordmarkEdgeRows = rowIndexes(lines, (line) => line.includes("█████ █"));
		const invocationRow = lines.findIndex((line) => line.includes("DIVINE INVOCATION"));
		const hintRow = lines.findIndex((line) => line.includes("╰─") && line.includes(INPUT_FRAME_HINT_KEYBINDS));
		const versionRow = lines.findIndex((line) => line.includes("SUMOCODE V"));
		const wordmarkTopRow = Math.min(...wordmarkEdgeRows);
		const wordmarkBottomRow = Math.max(...wordmarkEdgeRows);
		const heroTopRow = Math.min(...catRows, wordmarkTopRow);
		const heroBottomRow = Math.max(...catRows, wordmarkBottomRow);

		expect(catRows.at(0)).toBe(EXPECTED_100X30_SPLASH.catTopRow);
		expect(catRows.at(-1)).toBe(EXPECTED_100X30_SPLASH.catBottomRow);
		expect(wordmarkTopRow).toBe(EXPECTED_100X30_SPLASH.wordmarkTopRow);
		expect(wordmarkBottomRow).toBe(EXPECTED_100X30_SPLASH.wordmarkBottomRow);
		expect(invocationRow).toBe(EXPECTED_100X30_SPLASH.inputFrameTopRow);
		expect(hintRow).toBe(EXPECTED_100X30_SPLASH.hintRow);
		expect(versionRow).toBe(EXPECTED_100X30_SPLASH.versionRow);
		expect(heroTopRow).toBe(EXPECTED_100X30_SPLASH.catTopRow);
		expect(heroBottomRow).toBe(EXPECTED_100X30_SPLASH.wordmarkBottomRow);
		expect(invocationRow - heroBottomRow).toBe(4);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(true);
	}, 30_000);
});
