import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSumocodePty, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { INPUT_FRAME_HINT_KEYBINDS } from "../../src/cathedral/input-frame.js";

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

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

		await waitForScreenText(app, "DIVINE INVOCATION", 15_000);
		await waitForScreenText(app, /CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		// The layout assertions read the settled frame the last wait observed, so
		// they cannot see a mid-repaint frame from an extra replay.
		const { rows: lines } = await waitForScreenText(app, "SUMOCODE V", 5_000);
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
